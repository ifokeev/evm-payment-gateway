package gateway

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"math/big"
	"strings"
	"sync"
	"time"

	"github.com/ethereum/go-ethereum/ethclient"
	"github.com/pocketbase/dbx"
	"github.com/pocketbase/pocketbase/core"
	"github.com/skip2/go-qrcode"
	"github.com/tyler-smith/go-bip32"
)

type Service struct {
	app      core.App
	config   Config
	root     *bip32.Key
	chains   map[string]*chainRuntime
	cancel   context.CancelFunc
	stopOnce sync.Once
}

type chainRuntime struct {
	config Network
	client *ethclient.Client
	mu     sync.Mutex
}

type createRequest struct {
	Kind             string         `json:"kind"`
	ExternalID       string         `json:"externalId"`
	Chain            string         `json:"chain"`
	Asset            string         `json:"asset"`
	Amount           string         `json:"amount"`
	ExpiresInSeconds int            `json:"expiresInSeconds,omitempty"`
	Metadata         map[string]any `json:"metadata,omitempty"`
}

type normalizedRequest struct {
	Kind             string         `json:"kind"`
	ExternalID       string         `json:"externalId"`
	Chain            string         `json:"chain"`
	Asset            string         `json:"asset"`
	Amount           string         `json:"amount"`
	ExpiresInSeconds int            `json:"expiresInSeconds"`
	Metadata         map[string]any `json:"metadata"`
}

func New(app core.App, config Config) (*Service, error) {
	root, err := bip32.B58Deserialize(config.DepositXPub)
	if err != nil {
		return nil, fmt.Errorf("parse DEPOSIT_XPUB: %w", err)
	}
	service := &Service{app: app, config: config, root: root, chains: make(map[string]*chainRuntime)}
	for name, network := range config.Networks {
		client, err := ethclient.Dial(network.RPCURL)
		if err != nil {
			service.closeClients()
			return nil, fmt.Errorf("connect %s RPC: %w", name, err)
		}
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		chainID, err := client.ChainID(ctx)
		cancel()
		if err != nil || chainID.Int64() != network.ChainID {
			client.Close()
			service.closeClients()
			return nil, fmt.Errorf("%s RPC chain id mismatch: got %v, expected %d", name, chainID, network.ChainID)
		}
		service.chains[name] = &chainRuntime{config: network, client: client}
	}
	return service, nil
}

func (s *Service) Start() {
	ctx, cancel := context.WithCancel(context.Background())
	s.cancel = cancel
	go func() {
		s.runOnce(ctx)
		ticker := time.NewTicker(time.Duration(s.config.PollIntervalSeconds) * time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				s.runOnce(ctx)
			}
		}
	}()
}

func (s *Service) Stop() {
	s.stopOnce.Do(func() {
		if s.cancel != nil {
			s.cancel()
		}
		s.closeClients()
	})
}

func (s *Service) closeClients() {
	for _, chain := range s.chains {
		chain.client.Close()
	}
}

func (s *Service) createIntent(ctx context.Context, idempotencyKey string, request createRequest) (*core.Record, bool, error) {
	request.Kind = strings.TrimSpace(request.Kind)
	request.ExternalID = strings.TrimSpace(request.ExternalID)
	request.Asset = strings.ToUpper(strings.TrimSpace(request.Asset))
	if request.Kind != "credit_pack" && request.Kind != "subscription_invoice" {
		return nil, false, errors.New("kind must be credit_pack or subscription_invoice")
	}
	if request.ExternalID == "" || len(request.ExternalID) > 200 {
		return nil, false, errors.New("externalId is required and must be at most 200 characters")
	}
	if len(strings.TrimSpace(request.Amount)) > 100 {
		return nil, false, errors.New("amount must be at most 100 characters")
	}
	chain, ok := s.chains[request.Chain]
	if !ok {
		return nil, false, errors.New("unsupported chain")
	}

	decimals := uint8(18)
	tokenAddress := ""
	if request.Asset != chain.config.NativeAsset {
		token, ok := chain.config.Tokens[request.Asset]
		if !ok {
			return nil, false, errors.New("unsupported asset for chain")
		}
		decimals, tokenAddress = token.Decimals, token.Address
	}
	amount, units, err := parseAmount(request.Amount, decimals)
	if err != nil {
		return nil, false, err
	}
	expires := request.ExpiresInSeconds
	if expires == 0 {
		expires = s.config.DefaultExpiry
	}
	if expires < 300 || expires > s.config.MaxExpiry {
		return nil, false, fmt.Errorf("expiresInSeconds must be between 300 and %d", s.config.MaxExpiry)
	}
	if request.Metadata == nil {
		request.Metadata = map[string]any{}
	}
	normalized := normalizedRequest{
		Kind: request.Kind, ExternalID: request.ExternalID, Chain: request.Chain,
		Asset: request.Asset, Amount: amount, ExpiresInSeconds: expires, Metadata: request.Metadata,
	}
	hashInput, _ := json.Marshal(normalized)
	hash := sha256.Sum256(hashInput)
	requestHash := hex.EncodeToString(hash[:])

	latest, err := chain.client.BlockNumber(ctx)
	if err != nil {
		return nil, false, fmt.Errorf("read latest block: %w", err)
	}
	var result *core.Record
	created := false
	err = s.app.RunInTransaction(func(txApp core.App) error {
		existing, findErr := txApp.FindFirstRecordByData("payment_intents", "idempotency_key", idempotencyKey)
		if findErr == nil {
			if existing.GetString("request_hash") != requestHash {
				return errIdempotencyConflict
			}
			result = existing
			return nil
		}
		if !errors.Is(findErr, sql.ErrNoRows) {
			return findErr
		}

		counter, err := txApp.FindFirstRecordByData("gateway_state", "key", "next_derivation_index")
		if err != nil {
			return err
		}
		index := counter.GetInt("value")
		if index < 0 || uint64(index) >= uint64(math.MaxInt32) {
			return errors.New("deposit address space exhausted")
		}
		address, err := deriveAddress(s.root, uint32(index))
		if err != nil {
			return err
		}
		collection, err := txApp.FindCollectionByNameOrId("payment_intents")
		if err != nil {
			return err
		}
		now := time.Now().Unix()
		record := core.NewRecord(collection)
		record.Load(map[string]any{
			"idempotency_key": idempotencyKey, "request_hash": requestHash,
			"kind": request.Kind, "external_id": request.ExternalID,
			"chain": request.Chain, "chain_id": chain.config.ChainID,
			"asset": request.Asset, "token_address": tokenAddress, "decimals": decimals,
			"expected_amount": amount, "expected_units": units.String(),
			"received_units": "0", "confirmed_units": "0",
			"deposit_address": address, "derivation_index": index,
			"start_block": latest, "confirmations": chain.config.Confirmations,
			"status": "pending", "expires_at": now + int64(expires), "metadata": request.Metadata,
		})
		if err := txApp.Save(record); err != nil {
			return err
		}
		counter.Set("value", index+1)
		if err := txApp.Save(counter); err != nil {
			return err
		}
		created, result = true, record
		return nil
	})
	return result, created, err
}

var errIdempotencyConflict = errors.New("idempotency key was already used with a different request")

func (s *Service) intentResponse(record *core.Record) (map[string]any, error) {
	network := s.config.Networks[record.GetString("chain")]
	uri := paymentURI(network, record.GetString("asset"), record.GetString("token_address"), record.GetString("deposit_address"), record.GetString("expected_units"))
	qr, err := qrcode.Encode(uri, qrcode.Medium, 256)
	if err != nil {
		return nil, err
	}
	var metadata map[string]any
	if err := record.UnmarshalJSONField("metadata", &metadata); err != nil {
		metadata = map[string]any{}
	}
	transactions, err := s.transactionResponses(record)
	if err != nil {
		return nil, err
	}
	received := bigFromString(record.GetString("received_units"))
	confirmed := bigFromString(record.GetString("confirmed_units"))
	expiresAt := int64(record.GetFloat("expires_at"))
	return map[string]any{
		"id": record.Id, "kind": record.GetString("kind"), "externalId": record.GetString("external_id"),
		"chain": record.GetString("chain"), "chainId": record.GetInt("chain_id"), "asset": record.GetString("asset"),
		"expectedAmount": record.GetString("expected_amount"), "expectedUnits": record.GetString("expected_units"),
		"receivedAmount":  formatUnits(received, uint8(record.GetInt("decimals"))),
		"confirmedAmount": formatUnits(confirmed, uint8(record.GetInt("decimals"))),
		"depositAddress":  record.GetString("deposit_address"), "paymentUri": uri,
		"qrCodeDataUrl":         "data:image/png;base64," + base64.StdEncoding.EncodeToString(qr),
		"requiredConfirmations": record.GetInt("confirmations"), "status": record.GetString("status"),
		"expiresAt": time.Unix(expiresAt, 0).UTC().Format(time.RFC3339), "expired": time.Now().Unix() > expiresAt,
		"metadata": metadata, "transactions": transactions,
		"createdAt": record.GetDateTime("created").Time().UTC().Format(time.RFC3339),
		"updatedAt": record.GetDateTime("updated").Time().UTC().Format(time.RFC3339),
	}, nil
}

func (s *Service) transactionResponses(intent *core.Record) ([]map[string]any, error) {
	records, err := s.app.FindRecordsByFilter(
		"payment_transactions", "payment_intent = {:id}", "block_number,event_index", 10000, 0, dbx.Params{"id": intent.Id},
	)
	if err != nil {
		return nil, err
	}
	lastScanned := int64(-1)
	if state, err := s.app.FindFirstRecordByData("chain_states", "chain", intent.GetString("chain")); err == nil {
		lastScanned = int64(state.GetFloat("last_scanned"))
	}
	network := s.config.Networks[intent.GetString("chain")]
	expiresWithGrace := int64(intent.GetFloat("expires_at")) + int64(s.config.PaymentGrace)
	result := make([]map[string]any, 0, len(records))
	for _, record := range records {
		blockNumber := int64(record.GetFloat("block_number"))
		confirmations := int64(0)
		canonical := record.GetBool("canonical")
		if canonical && lastScanned >= blockNumber {
			confirmations = lastScanned - blockNumber + 1
		}
		txHash := record.GetString("tx_hash")
		item := map[string]any{
			"hash": txHash, "eventIndex": record.GetInt("event_index"),
			"asset": record.GetString("asset"), "from": record.GetString("from_address"), "to": record.GetString("to_address"),
			"amountUnits": record.GetString("amount_units"), "blockNumber": blockNumber,
			"blockHash": record.GetString("block_hash"), "confirmations": confirmations,
			"canonical": canonical,
			"confirmed": confirmations >= int64(intent.GetInt("confirmations")),
			"late":      int64(record.GetFloat("block_timestamp")) > expiresWithGrace,
		}
		if network.ExplorerURL != "" {
			item["explorerUrl"] = network.ExplorerURL + "/tx/" + txHash
		}
		result = append(result, item)
	}
	return result, nil
}

func bigFromString(value string) *big.Int {
	result := new(big.Int)
	result.SetString(value, 10)
	return result
}
