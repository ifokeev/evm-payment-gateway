package gateway

import (
	"bytes"
	"context"
	"crypto/ecdsa"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"math/big"
	"net/http"
	"net/url"
	"os"
	"os/signal"
	"sort"
	"strings"
	"syscall"
	"time"

	"github.com/ethereum/go-ethereum"
	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/core/types"
	"github.com/ethereum/go-ethereum/crypto"
	"github.com/ethereum/go-ethereum/ethclient"
	"github.com/spf13/cobra"
	"github.com/tyler-smith/go-bip32"
)

var (
	balanceOfSelector  = crypto.Keccak256([]byte("balanceOf(address)"))[:4]
	transferSelector   = crypto.Keccak256([]byte("transfer(address,uint256)"))[:4]
	l1UpperBoundSelect = crypto.Keccak256([]byte("getL1FeeUpperBound(uint256)"))[:4]
	baseGasOracle      = common.HexToAddress("0x420000000000000000000000000000000000000F")
)

const maxNativeSweepGas = uint64(1_000_000)

type sweeperConfig struct {
	GatewayURL   string
	APIKey       string
	Root         *bip32.Key
	PollInterval time.Duration
	GasBufferBPS int64
	MaxGasWei    *big.Int
	Networks     map[string]*sweeperNetwork
}

type sweeperNetwork struct {
	Network
	Client *ethclient.Client
	GasKey *ecdsa.PrivateKey
}

type automaticSweeper struct {
	config     sweeperConfig
	client     *http.Client
	instanceID string
}

type sweepOutcome struct {
	Complete       bool
	External       bool
	RemainingUnits string
	DelaySeconds   int
}

func RegisterSweeperCommand(root *cobra.Command) {
	root.AddCommand(&cobra.Command{
		Use:   "sweeper",
		Short: "Runs the isolated automatic treasury sweeper",
		Args:  cobra.NoArgs,
		RunE: func(command *cobra.Command, _ []string) error {
			config, err := loadSweeperConfig()
			if err != nil {
				return err
			}
			worker := newAutomaticSweeper(config)
			ctx, stop := signal.NotifyContext(command.Context(), os.Interrupt, syscall.SIGTERM)
			defer stop()
			defer worker.close()
			return worker.run(ctx)
		},
	})
}

func loadSweeperConfig() (sweeperConfig, error) {
	gatewayURL := strings.TrimSuffix(os.Getenv("GATEWAY_URL"), "/")
	parsedURL, err := url.Parse(gatewayURL)
	if err != nil || (parsedURL.Scheme != "http" && parsedURL.Scheme != "https") || parsedURL.Host == "" {
		return sweeperConfig{}, errors.New("GATEWAY_URL must be an absolute http(s) URL")
	}
	root, err := bip32.B58Deserialize(os.Getenv("DEPOSIT_XPRV"))
	if err != nil || !root.IsPrivate {
		return sweeperConfig{}, errors.New("DEPOSIT_XPRV must be the private counterpart of DEPOSIT_XPUB")
	}
	if root.PublicKey().B58Serialize() != os.Getenv("DEPOSIT_XPUB") {
		return sweeperConfig{}, errors.New("DEPOSIT_XPRV does not match DEPOSIT_XPUB")
	}
	apiKey := os.Getenv("SWEEPER_API_KEY")
	if len(apiKey) < 24 {
		return sweeperConfig{}, errors.New("SWEEPER_API_KEY must be at least 24 characters")
	}
	maxGasWei, err := envBigInt("SWEEPER_MAX_GAS_FUNDING_WEI", "10000000000000000")
	if err != nil {
		return sweeperConfig{}, err
	}
	bufferBPS := envInt("SWEEPER_GAS_BUFFER_BPS", 12000)
	pollSeconds := envInt("SWEEPER_POLL_INTERVAL_SECONDS", 5)
	if bufferBPS < 10000 || bufferBPS > 20000 || pollSeconds < 1 {
		return sweeperConfig{}, errors.New("invalid sweeper gas buffer or poll interval")
	}

	configuredNetworks, err := loadNetworks()
	if err != nil {
		return sweeperConfig{}, err
	}
	networks := make(map[string]*sweeperNetwork, len(configuredNetworks))
	for name, network := range configuredNetworks {
		var gasKey *ecdsa.PrivateKey
		if requiresGasKey(network) {
			keyText := strings.TrimPrefix(strings.TrimSpace(os.Getenv(network.GasPrivateKeyEnv)), "0x")
			gasKey, err = crypto.HexToECDSA(keyText)
			if err != nil {
				return sweeperConfig{}, fmt.Errorf("invalid or missing gas private key for %s (%s)", name, network.GasPrivateKeyEnv)
			}
		}
		client, err := ethclient.Dial(network.RPCURL)
		if err != nil {
			return sweeperConfig{}, fmt.Errorf("connect %s RPC: %w", name, err)
		}
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		chainID, chainErr := client.ChainID(ctx)
		cancel()
		if chainErr != nil || chainID.Int64() != network.ChainID {
			client.Close()
			return sweeperConfig{}, fmt.Errorf("%s RPC chain id mismatch: got %v, expected %d", name, chainID, network.ChainID)
		}
		networks[name] = &sweeperNetwork{Network: network, Client: client, GasKey: gasKey}
	}
	return sweeperConfig{
		GatewayURL: gatewayURL, APIKey: apiKey, Root: root,
		PollInterval: time.Duration(pollSeconds) * time.Second,
		GasBufferBPS: int64(bufferBPS), MaxGasWei: maxGasWei, Networks: networks,
	}, nil
}

func newAutomaticSweeper(config sweeperConfig) *automaticSweeper {
	random := make([]byte, 12)
	_, _ = rand.Read(random)
	return &automaticSweeper{
		config: config, client: &http.Client{Timeout: 45 * time.Second},
		instanceID: "sweeper_" + hex.EncodeToString(random),
	}
}

func (s *automaticSweeper) close() {
	for _, network := range s.config.Networks {
		network.Client.Close()
	}
}

func (s *automaticSweeper) run(ctx context.Context) error {
	// ponytail: run one replica; add chain-scoped gas-wallet nonce leases before horizontal scaling.
	names := make([]string, 0, len(s.config.Networks))
	for name := range s.config.Networks {
		names = append(names, name)
	}
	sort.Strings(names)
	log.Printf("automatic sweeper started for %s", strings.Join(names, ", "))
	for {
		for _, name := range names {
			if ctx.Err() != nil {
				return nil
			}
			job, err := s.claim(ctx, name)
			if err != nil {
				log.Printf("claim sweep on %s: %v", name, err)
				continue
			}
			if job == nil {
				continue
			}
			outcome, processErr := s.process(ctx, *job, s.config.Networks[name])
			if processErr != nil {
				outcome = sweepOutcome{RemainingUnits: "0", DelaySeconds: 5}
			}
			if err := s.release(ctx, job.ID, outcome, processErr); err != nil {
				log.Printf("release sweep %s: %v", job.ID, err)
			}
		}
		timer := time.NewTimer(s.config.PollInterval)
		select {
		case <-ctx.Done():
			timer.Stop()
			return nil
		case <-timer.C:
		}
	}
}

func (s *automaticSweeper) process(ctx context.Context, job sweepJobPayload, network *sweeperNetwork) (sweepOutcome, error) {
	confirmedSweep := false
	for _, transaction := range job.SweepTransactions {
		if transaction.Kind == "sweep" && transaction.Status == "confirmed" {
			confirmedSweep = true
		}
		if transaction.Status != "prepared" && transaction.Status != "submitted" {
			continue
		}
		confirmed, waiting, err := s.reconcile(ctx, job, transaction, network)
		if err != nil {
			return sweepOutcome{}, err
		}
		if confirmed && transaction.Kind == "sweep" {
			confirmedSweep = true
		}
		if waiting {
			return sweepOutcome{RemainingUnits: "0", DelaySeconds: int(s.config.PollInterval.Seconds())}, nil
		}
	}

	deposit := common.HexToAddress(job.DepositAddress)
	treasury := common.HexToAddress(job.TreasuryAddress)
	key, err := deriveChildPrivateKey(s.config.Root, job.DerivationIndex, deposit)
	if err != nil {
		return sweepOutcome{}, err
	}
	if job.TokenAddress == "" {
		return s.processNative(ctx, job, network, key, deposit, treasury, confirmedSweep)
	}
	return s.processToken(ctx, job, network, key, deposit, treasury, confirmedSweep)
}

func (s *automaticSweeper) processNative(ctx context.Context, job sweepJobPayload, network *sweeperNetwork, key *ecdsa.PrivateKey, deposit, treasury common.Address, confirmedSweep bool) (sweepOutcome, error) {
	balance, err := network.Client.BalanceAt(ctx, deposit, nil)
	if err != nil {
		return sweepOutcome{}, err
	}
	if balance.Sign() == 0 {
		return zeroBalanceOutcome(confirmedSweep), nil
	}
	gasPrice, err := network.Client.SuggestGasPrice(ctx)
	if err != nil {
		return sweepOutcome{}, err
	}
	nonce, err := network.Client.PendingNonceAt(ctx, deposit)
	if err != nil {
		return sweepOutcome{}, err
	}
	value := big.NewInt(1)
	gasLimit := uint64(21000)
	var transaction *types.Transaction
	var raw []byte
	for range 2 {
		estimatedGas, err := network.Client.EstimateGas(ctx, ethereum.CallMsg{From: deposit, To: &treasury, Value: value})
		if err != nil {
			return sweepOutcome{}, fmt.Errorf("estimate native treasury transfer gas: %w", err)
		}
		gasLimit = bufferedUint64(estimatedGas, s.config.GasBufferBPS)
		if gasLimit < 21000 || gasLimit > maxNativeSweepGas {
			return sweepOutcome{}, fmt.Errorf("estimated native treasury transfer gas %d is outside the allowed range", gasLimit)
		}
		executionFee := new(big.Int).Mul(new(big.Int).SetUint64(gasLimit), gasPrice)
		if balance.Cmp(executionFee) <= 0 {
			return nativeFeeOutcome(confirmedSweep, balance), nil
		}
		value.Sub(balance, executionFee)
		transaction, raw, err = signLegacyTransaction(network.ChainID, nonce, treasury, value, gasLimit, gasPrice, nil, key)
		if err != nil {
			return sweepOutcome{}, err
		}
		l1Fee, err := network.l1FeeUpperBound(ctx, len(raw)+16)
		if err != nil {
			return sweepOutcome{}, err
		}
		totalFee := new(big.Int).Add(executionFee, l1Fee)
		if balance.Cmp(totalFee) <= 0 {
			return nativeFeeOutcome(confirmedSweep, balance), nil
		}
		value.Sub(balance, totalFee)
	}
	transaction, raw, err = signLegacyTransaction(network.ChainID, nonce, treasury, value, gasLimit, gasPrice, nil, key)
	if err != nil {
		return sweepOutcome{}, err
	}
	if err := s.prepareAndBroadcast(ctx, job.ID, "sweep", transaction, raw, network); err != nil {
		return sweepOutcome{}, err
	}
	return sweepOutcome{RemainingUnits: balance.String(), DelaySeconds: int(s.config.PollInterval.Seconds())}, nil
}

func (s *automaticSweeper) processToken(ctx context.Context, job sweepJobPayload, network *sweeperNetwork, key *ecdsa.PrivateKey, deposit, treasury common.Address, confirmedSweep bool) (sweepOutcome, error) {
	token := common.HexToAddress(job.TokenAddress)
	balance, err := network.tokenBalance(ctx, token, deposit)
	if err != nil {
		return sweepOutcome{}, err
	}
	if balance.Sign() == 0 {
		if confirmedSweep {
			nativeBalance, _ := network.Client.BalanceAt(ctx, deposit, nil)
			remaining := "0"
			if nativeBalance != nil {
				remaining = nativeBalance.String()
			}
			return sweepOutcome{Complete: true, RemainingUnits: remaining}, nil
		}
		return zeroBalanceOutcome(false), nil
	}
	data := encodeTokenTransfer(treasury, balance)
	estimatedGas, err := network.Client.EstimateGas(ctx, ethereum.CallMsg{From: deposit, To: &token, Data: data})
	if err != nil {
		return sweepOutcome{}, fmt.Errorf("estimate token transfer gas: %w", err)
	}
	gasLimit := bufferedUint64(estimatedGas, s.config.GasBufferBPS)
	gasPrice, err := network.Client.SuggestGasPrice(ctx)
	if err != nil {
		return sweepOutcome{}, err
	}
	nonce, err := network.Client.PendingNonceAt(ctx, deposit)
	if err != nil {
		return sweepOutcome{}, err
	}
	transaction, raw, err := signLegacyTransaction(network.ChainID, nonce, token, big.NewInt(0), gasLimit, gasPrice, data, key)
	if err != nil {
		return sweepOutcome{}, err
	}
	l1Fee, err := network.l1FeeUpperBound(ctx, len(raw)+16)
	if err != nil {
		return sweepOutcome{}, err
	}
	required := new(big.Int).Add(new(big.Int).Mul(new(big.Int).SetUint64(gasLimit), gasPrice), l1Fee)
	nativeBalance, err := network.Client.BalanceAt(ctx, deposit, nil)
	if err != nil {
		return sweepOutcome{}, err
	}
	if nativeBalance.Cmp(required) < 0 {
		shortfall := new(big.Int).Sub(required, nativeBalance)
		used, err := gasFundingUsed(job.SweepTransactions)
		if err != nil {
			return sweepOutcome{}, err
		}
		remainingAllowance := new(big.Int).Sub(s.config.MaxGasWei, used)
		if remainingAllowance.Sign() < 0 {
			remainingAllowance.SetInt64(0)
		}
		if remainingAllowance.Sign() == 0 || shortfall.Cmp(remainingAllowance) > 0 {
			return sweepOutcome{}, fmt.Errorf("required gas funding %s exceeds remaining sweep allowance %s", shortfall, remainingAllowance)
		}
		if err := s.fundGas(ctx, job.ID, network, deposit, shortfall); err != nil {
			return sweepOutcome{}, err
		}
		return sweepOutcome{RemainingUnits: balance.String(), DelaySeconds: int(s.config.PollInterval.Seconds())}, nil
	}
	if err := s.prepareAndBroadcast(ctx, job.ID, "sweep", transaction, raw, network); err != nil {
		return sweepOutcome{}, err
	}
	return sweepOutcome{RemainingUnits: balance.String(), DelaySeconds: int(s.config.PollInterval.Seconds())}, nil
}

func (s *automaticSweeper) fundGas(ctx context.Context, jobID string, network *sweeperNetwork, deposit common.Address, amount *big.Int) error {
	if network.GasKey == nil {
		return errors.New("gas wallet is not configured for this network")
	}
	from := crypto.PubkeyToAddress(network.GasKey.PublicKey)
	nonce, err := network.Client.PendingNonceAt(ctx, from)
	if err != nil {
		return err
	}
	gasPrice, err := network.Client.SuggestGasPrice(ctx)
	if err != nil {
		return err
	}
	transaction, raw, err := signLegacyTransaction(network.ChainID, nonce, deposit, amount, 21000, gasPrice, nil, network.GasKey)
	if err != nil {
		return err
	}
	l1Fee, err := network.l1FeeUpperBound(ctx, len(raw)+16)
	if err != nil {
		return err
	}
	required := new(big.Int).Add(amount, new(big.Int).Mul(big.NewInt(21000), gasPrice))
	required.Add(required, l1Fee)
	balance, err := network.Client.BalanceAt(ctx, from, nil)
	if err != nil {
		return err
	}
	if balance.Cmp(required) < 0 {
		return fmt.Errorf("gas wallet %s has insufficient balance", from.Hex())
	}
	return s.prepareAndBroadcast(ctx, jobID, "gas", transaction, raw, network)
}

func (s *automaticSweeper) reconcile(ctx context.Context, job sweepJobPayload, record sweepTransactionPayload, network *sweeperNetwork) (bool, bool, error) {
	raw, err := hex.DecodeString(strings.TrimPrefix(record.Raw, "0x"))
	if err != nil {
		return false, false, err
	}
	transaction := new(types.Transaction)
	if err := transaction.UnmarshalBinary(raw); err != nil {
		return false, false, err
	}
	receipt, err := network.Client.TransactionReceipt(ctx, transaction.Hash())
	if err == nil {
		if receipt.Status != types.ReceiptStatusSuccessful {
			if reportErr := s.reportTransaction(ctx, record.ID, "failed", receipt.BlockNumber.Uint64(), "transaction reverted"); reportErr != nil {
				return false, false, reportErr
			}
			return false, false, nil
		}
		head, err := network.Client.BlockNumber(ctx)
		if err != nil {
			return false, false, err
		}
		required := uint64(1)
		if record.Kind == "sweep" {
			required = job.Confirmations
		}
		confirmations := uint64(0)
		if head >= receipt.BlockNumber.Uint64() {
			confirmations = head - receipt.BlockNumber.Uint64() + 1
		}
		if confirmations < required {
			_ = s.reportTransaction(ctx, record.ID, "submitted", receipt.BlockNumber.Uint64(), "")
			return false, true, nil
		}
		if err := s.reportTransaction(ctx, record.ID, "confirmed", receipt.BlockNumber.Uint64(), ""); err != nil {
			return false, false, err
		}
		return true, false, nil
	}
	if !errors.Is(err, ethereum.NotFound) {
		return false, false, err
	}
	if _, pending, lookupErr := network.Client.TransactionByHash(ctx, transaction.Hash()); lookupErr == nil {
		// ponytail: one suggested-fee transaction waits for inclusion; add same-nonce fee replacement if this becomes an operational issue.
		_ = pending
		if err := s.reportTransaction(ctx, record.ID, "submitted", 0, ""); err != nil {
			return false, false, err
		}
		return false, true, nil
	} else if !errors.Is(lookupErr, ethereum.NotFound) {
		return false, false, lookupErr
	}
	if err := network.Client.SendTransaction(ctx, transaction); err != nil && !knownTransactionError(err) {
		return false, false, err
	}
	if err := s.reportTransaction(ctx, record.ID, "submitted", 0, ""); err != nil {
		return false, false, err
	}
	return false, true, nil
}

func (s *automaticSweeper) prepareAndBroadcast(ctx context.Context, jobID, kind string, transaction *types.Transaction, raw []byte, network *sweeperNetwork) error {
	record, err := s.registerTransaction(ctx, jobID, kind, raw)
	if err != nil {
		return err
	}
	if err := network.Client.SendTransaction(ctx, transaction); err != nil && !knownTransactionError(err) {
		return err
	}
	return s.reportTransaction(ctx, record.ID, "submitted", 0, "")
}

func (s *automaticSweeper) claim(ctx context.Context, chain string) (*sweepJobPayload, error) {
	var response sweepJobPayload
	status, err := s.request(ctx, http.MethodPost, "/api/payments/v1/internal/sweeps/claim", map[string]any{"chain": chain}, &response)
	if status == http.StatusNoContent {
		return nil, nil
	}
	return &response, err
}

func (s *automaticSweeper) registerTransaction(ctx context.Context, jobID, kind string, raw []byte) (sweepTransactionPayload, error) {
	var response sweepTransactionPayload
	_, err := s.request(ctx, http.MethodPost, "/api/payments/v1/internal/sweeps/"+url.PathEscape(jobID)+"/transactions", map[string]any{
		"kind": kind, "rawTransaction": "0x" + hex.EncodeToString(raw),
	}, &response)
	return response, err
}

func (s *automaticSweeper) reportTransaction(ctx context.Context, id, status string, block uint64, transactionError string) error {
	_, err := s.request(ctx, http.MethodPost, "/api/payments/v1/internal/sweeps/transactions/"+url.PathEscape(id)+"/result", map[string]any{
		"status": status, "blockNumber": block, "error": transactionError,
	}, nil)
	return err
}

func (s *automaticSweeper) release(ctx context.Context, id string, outcome sweepOutcome, processErr error) error {
	status := "queued"
	if outcome.Complete {
		status = "complete"
	} else if outcome.External {
		status = "external"
	}
	errorText := ""
	if processErr != nil {
		errorText = processErr.Error()
		log.Printf("sweep %s deferred: %v", id, processErr)
	}
	_, err := s.request(ctx, http.MethodPost, "/api/payments/v1/internal/sweeps/"+url.PathEscape(id)+"/release", map[string]any{
		"status": status, "remainingUnits": outcome.RemainingUnits, "error": errorText, "delaySeconds": outcome.DelaySeconds,
	}, nil)
	return err
}

func (s *automaticSweeper) request(ctx context.Context, method, path string, body any, destination any) (int, error) {
	encoded, err := json.Marshal(body)
	if err != nil {
		return 0, err
	}
	request, err := http.NewRequestWithContext(ctx, method, s.config.GatewayURL+path, bytes.NewReader(encoded))
	if err != nil {
		return 0, err
	}
	request.Header.Set("Authorization", "Bearer "+s.config.APIKey)
	request.Header.Set("Sweeper-Id", s.instanceID)
	request.Header.Set("Content-Type", "application/json")
	response, err := s.client.Do(request)
	if err != nil {
		return 0, err
	}
	defer response.Body.Close()
	if response.StatusCode == http.StatusNoContent {
		return response.StatusCode, nil
	}
	data, err := io.ReadAll(io.LimitReader(response.Body, 1<<20))
	if err != nil {
		return response.StatusCode, err
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return response.StatusCode, fmt.Errorf("gateway returned HTTP %d: %s", response.StatusCode, truncate(string(data), 1000))
	}
	if destination != nil && len(data) > 0 {
		if err := json.Unmarshal(data, destination); err != nil {
			return response.StatusCode, err
		}
	}
	return response.StatusCode, nil
}

func (n *sweeperNetwork) tokenBalance(ctx context.Context, token, account common.Address) (*big.Int, error) {
	data := append(append([]byte{}, balanceOfSelector...), common.LeftPadBytes(account.Bytes(), 32)...)
	response, err := n.Client.CallContract(ctx, ethereum.CallMsg{To: &token, Data: data}, nil)
	if err != nil {
		return nil, err
	}
	if len(response) != 32 {
		return nil, errors.New("token balanceOf returned invalid data")
	}
	return new(big.Int).SetBytes(response), nil
}

func (n *sweeperNetwork) l1FeeUpperBound(ctx context.Context, transactionSize int) (*big.Int, error) {
	if n.ChainID != 8453 && n.ChainID != 84532 {
		return new(big.Int), nil
	}
	data := append(append([]byte{}, l1UpperBoundSelect...), common.LeftPadBytes(big.NewInt(int64(transactionSize)).Bytes(), 32)...)
	response, err := n.Client.CallContract(ctx, ethereum.CallMsg{To: &baseGasOracle, Data: data}, nil)
	if err != nil {
		return nil, fmt.Errorf("estimate Base L1 fee: %w", err)
	}
	if len(response) != 32 {
		return nil, errors.New("Base gas oracle returned invalid data")
	}
	return new(big.Int).SetBytes(response), nil
}

func deriveChildPrivateKey(root *bip32.Key, index uint32, expected common.Address) (*ecdsa.PrivateKey, error) {
	child, err := root.NewChildKey(index)
	if err != nil {
		return nil, err
	}
	key, err := crypto.ToECDSA(child.Key)
	if err != nil {
		return nil, err
	}
	if crypto.PubkeyToAddress(key.PublicKey) != expected {
		return nil, errors.New("derived private key does not match deposit address")
	}
	return key, nil
}

func signLegacyTransaction(chainID int64, nonce uint64, to common.Address, value *big.Int, gas uint64, gasPrice *big.Int, data []byte, key *ecdsa.PrivateKey) (*types.Transaction, []byte, error) {
	transaction := types.NewTx(&types.LegacyTx{Nonce: nonce, To: &to, Value: value, Gas: gas, GasPrice: gasPrice, Data: data})
	signed, err := types.SignTx(transaction, types.LatestSignerForChainID(big.NewInt(chainID)), key)
	if err != nil {
		return nil, nil, err
	}
	raw, err := signed.MarshalBinary()
	return signed, raw, err
}

func encodeTokenTransfer(to common.Address, amount *big.Int) []byte {
	data := make([]byte, 4+32+32)
	copy(data[:4], transferSelector)
	copy(data[4+12:4+32], to.Bytes())
	amount.FillBytes(data[4+32 : 4+64])
	return data
}

func decodeTokenTransfer(data []byte) (common.Address, *big.Int, bool) {
	if len(data) != 68 || !bytes.Equal(data[:4], transferSelector) {
		return common.Address{}, nil, false
	}
	for _, value := range data[4:16] {
		if value != 0 {
			return common.Address{}, nil, false
		}
	}
	return common.BytesToAddress(data[4:36]), new(big.Int).SetBytes(data[36:68]), true
}

func bufferedUint64(value uint64, bps int64) uint64 {
	result := new(big.Int).Mul(new(big.Int).SetUint64(value), big.NewInt(bps))
	result.Add(result, big.NewInt(9999))
	result.Div(result, big.NewInt(10000))
	if !result.IsUint64() {
		return ^uint64(0)
	}
	return result.Uint64()
}

func nativeFeeOutcome(confirmedSweep bool, balance *big.Int) sweepOutcome {
	if confirmedSweep {
		return sweepOutcome{Complete: true, RemainingUnits: balance.String()}
	}
	return sweepOutcome{RemainingUnits: balance.String(), DelaySeconds: 60}
}

func zeroBalanceOutcome(confirmedSweep bool) sweepOutcome {
	return sweepOutcome{Complete: confirmedSweep, External: !confirmedSweep, RemainingUnits: "0"}
}

func requiresGasKey(network Network) bool {
	return len(network.Tokens) > 0
}

func gasFundingUsed(transactions []sweepTransactionPayload) (*big.Int, error) {
	total := new(big.Int)
	for _, transaction := range transactions {
		if transaction.Kind != "gas" || transaction.Status == "failed" {
			continue
		}
		amount, ok := new(big.Int).SetString(transaction.AmountUnits, 10)
		if !ok || amount.Sign() <= 0 {
			return nil, errors.New("sweep history contains an invalid gas funding amount")
		}
		total.Add(total, amount)
	}
	return total, nil
}

func knownTransactionError(err error) bool {
	message := strings.ToLower(err.Error())
	if strings.Contains(message, "already known") {
		return true
	}
	index := strings.Index(message, "known transaction")
	return index == 0 || index > 0 && (message[index-1] < 'a' || message[index-1] > 'z')
}
