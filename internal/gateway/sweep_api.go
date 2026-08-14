package gateway

import (
	"crypto/subtle"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"math/big"
	"net/http"
	"strings"
	"time"

	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/core/types"
	"github.com/pocketbase/dbx"
	"github.com/pocketbase/pocketbase/apis"
	"github.com/pocketbase/pocketbase/core"
)

type sweepJobPayload struct {
	ID                string                    `json:"id"`
	Chain             string                    `json:"chain"`
	ChainID           int64                     `json:"chainId"`
	Asset             string                    `json:"asset"`
	TokenAddress      string                    `json:"tokenAddress,omitempty"`
	DepositAddress    string                    `json:"depositAddress"`
	DerivationIndex   uint32                    `json:"derivationIndex"`
	TreasuryAddress   string                    `json:"treasuryAddress"`
	Confirmations     uint64                    `json:"confirmations"`
	ObservedUnits     string                    `json:"observedUnits"`
	Status            string                    `json:"status"`
	Attempts          int                       `json:"attempts"`
	SweepTransactions []sweepTransactionPayload `json:"transactions"`
}

type sweepTransactionPayload struct {
	ID          string `json:"id"`
	Kind        string `json:"kind"`
	Hash        string `json:"hash"`
	Raw         string `json:"rawTransaction,omitempty"`
	From        string `json:"from"`
	To          string `json:"to"`
	AmountUnits string `json:"amountUnits"`
	Nonce       uint64 `json:"nonce"`
	Status      string `json:"status"`
	BlockNumber uint64 `json:"blockNumber,omitempty"`
	LastError   string `json:"lastError,omitempty"`
	ExplorerURL string `json:"explorerUrl,omitempty"`
	CreatedAt   string `json:"createdAt"`
}

func (s *Service) claimSweepRoute(event *core.RequestEvent) error {
	owner := strings.TrimSpace(event.Request.Header.Get("Sweeper-Id"))
	if owner == "" || len(owner) > 80 {
		return apis.NewBadRequestError("Sweeper-Id is required", nil)
	}
	var request struct {
		Chain string `json:"chain"`
	}
	if err := decodeLimitedJSON(event.Request, &request); err != nil {
		return apis.NewBadRequestError("invalid JSON body", err)
	}
	if _, ok := s.chains[request.Chain]; !ok {
		return apis.NewBadRequestError("unsupported chain", nil)
	}

	var claimed *core.Record
	now := time.Now().Unix()
	err := s.app.RunInTransaction(func(txApp core.App) error {
		record, err := txApp.FindFirstRecordByFilter(
			"sweep_jobs",
			"chain = {:chain} && next_attempt_at <= {:now} && (status = 'queued' || (status = 'processing' && (locked_until <= {:now} || lock_owner = {:owner})))",
			dbx.Params{"chain": request.Chain, "now": now, "owner": owner},
		)
		if err != nil {
			return err
		}
		record.Set("status", "processing")
		record.Set("lock_owner", owner)
		record.Set("locked_until", now+300)
		if err := txApp.Save(record); err != nil {
			return err
		}
		claimed = record
		return nil
	})
	if errors.Is(err, sql.ErrNoRows) {
		return event.NoContent(http.StatusNoContent)
	}
	if err != nil {
		return err
	}
	payload, err := s.sweepJobPayload(claimed, true)
	if err != nil {
		return err
	}
	return event.JSON(http.StatusOK, payload)
}

func (s *Service) registerSweepTransactionRoute(event *core.RequestEvent) error {
	job, err := s.lockedSweepJob(event.Request.PathValue("id"), event.Request.Header.Get("Sweeper-Id"))
	if err != nil {
		return err
	}
	var request struct {
		Kind           string `json:"kind"`
		RawTransaction string `json:"rawTransaction"`
	}
	if err := decodeLimitedJSON(event.Request, &request); err != nil {
		return apis.NewBadRequestError("invalid JSON body", err)
	}
	raw, err := hex.DecodeString(strings.TrimPrefix(request.RawTransaction, "0x"))
	if err != nil || len(raw) == 0 || len(raw) > 128<<10 {
		return apis.NewBadRequestError("invalid raw transaction", nil)
	}
	transaction := new(types.Transaction)
	if err := transaction.UnmarshalBinary(raw); err != nil {
		return apis.NewBadRequestError("invalid raw transaction", err)
	}
	from, to, amount, err := s.validateSweepTransaction(job, request.Kind, transaction)
	if err != nil {
		return apis.NewBadRequestError(err.Error(), nil)
	}

	var record *core.Record
	created := false
	err = s.app.RunInTransaction(func(txApp core.App) error {
		existing, err := txApp.FindFirstRecordByFilter(
			"sweep_transactions", "chain = {:chain} && tx_hash = {:hash}",
			dbx.Params{"chain": job.GetString("chain"), "hash": transaction.Hash().Hex()},
		)
		if err == nil {
			if existing.GetString("sweep_job") != job.Id || existing.GetString("kind") != request.Kind {
				return apis.NewApiError(http.StatusConflict, "transaction already belongs to another sweep", nil)
			}
			record = existing
			return nil
		}
		if !errors.Is(err, sql.ErrNoRows) {
			return err
		}
		if request.Kind == "gas" {
			records, err := txApp.FindRecordsByFilter(
				"sweep_transactions", "sweep_job = {:id}", "", 0, 0, dbx.Params{"id": job.Id},
			)
			if err != nil {
				return err
			}
			history := make([]sweepTransactionPayload, 0, len(records))
			for _, prior := range records {
				history = append(history, sweepTransactionPayload{
					Kind: prior.GetString("kind"), Status: prior.GetString("status"), AmountUnits: prior.GetString("amount_units"),
				})
			}
			used, err := gasFundingUsed(history)
			if err != nil {
				return err
			}
			if used.Add(used, amount).Cmp(s.config.SweeperMaxGasWei) > 0 {
				return apis.NewBadRequestError("gas funding exceeds the sweep job limit", nil)
			}
		}
		collection, err := txApp.FindCollectionByNameOrId("sweep_transactions")
		if err != nil {
			return err
		}
		record = core.NewRecord(collection)
		record.Load(map[string]any{
			"sweep_job": job.Id, "chain": job.GetString("chain"), "kind": request.Kind,
			"tx_hash": transaction.Hash().Hex(), "raw_tx": "0x" + hex.EncodeToString(raw),
			"from_address": from.Hex(), "to_address": to.Hex(), "amount_units": amount.String(),
			"nonce": transaction.Nonce(), "status": "prepared",
		})
		if err := txApp.Save(record); err != nil {
			return err
		}
		created = true
		return nil
	})
	if err != nil {
		return err
	}
	status := http.StatusOK
	if created {
		status = http.StatusCreated
	}
	return event.JSON(status, s.sweepTransactionPayload(record, true))
}

func (s *Service) sweepTransactionResultRoute(event *core.RequestEvent) error {
	record, err := s.app.FindRecordById("sweep_transactions", event.Request.PathValue("id"))
	if err != nil {
		return apis.NewNotFoundError("sweep transaction not found", nil)
	}
	if _, err := s.lockedSweepJob(record.GetString("sweep_job"), event.Request.Header.Get("Sweeper-Id")); err != nil {
		return err
	}
	var request struct {
		Status      string `json:"status"`
		BlockNumber uint64 `json:"blockNumber,omitempty"`
		Error       string `json:"error,omitempty"`
	}
	if err := decodeLimitedJSON(event.Request, &request); err != nil {
		return apis.NewBadRequestError("invalid JSON body", err)
	}
	if request.Status != "submitted" && request.Status != "confirmed" && request.Status != "failed" {
		return apis.NewBadRequestError("invalid transaction status", nil)
	}
	if record.GetString("status") == "confirmed" && request.Status != "confirmed" {
		return apis.NewBadRequestError("confirmed transaction cannot be downgraded", nil)
	}
	record.Set("status", request.Status)
	record.Set("block_number", request.BlockNumber)
	record.Set("last_error", truncate(request.Error, 1000))
	if err := s.app.Save(record); err != nil {
		return err
	}
	return event.JSON(http.StatusOK, s.sweepTransactionPayload(record, true))
}

func (s *Service) releaseSweepRoute(event *core.RequestEvent) error {
	job, err := s.lockedSweepJob(event.Request.PathValue("id"), event.Request.Header.Get("Sweeper-Id"))
	if err != nil {
		return err
	}
	var request struct {
		Status         string `json:"status"`
		RemainingUnits string `json:"remainingUnits"`
		Error          string `json:"error,omitempty"`
		DelaySeconds   int    `json:"delaySeconds,omitempty"`
	}
	if err := decodeLimitedJSON(event.Request, &request); err != nil {
		return apis.NewBadRequestError("invalid JSON body", err)
	}
	if request.Status != "queued" && request.Status != "complete" && request.Status != "external" {
		return apis.NewBadRequestError("status must be queued, complete, or external", nil)
	}
	if value, ok := new(big.Int).SetString(request.RemainingUnits, 10); !ok || value.Sign() < 0 {
		return apis.NewBadRequestError("remainingUnits must be a non-negative integer", nil)
	}
	now := time.Now().Unix()
	job.Set("status", request.Status)
	job.Set("remaining_units", request.RemainingUnits)
	job.Set("last_error", truncate(request.Error, 1000))
	job.Set("lock_owner", "")
	job.Set("locked_until", 0)
	if request.Status == "complete" || request.Status == "external" {
		job.Set("completed_at", now)
		job.Set("next_attempt_at", now)
	} else {
		delay := request.DelaySeconds
		if request.Error != "" {
			attempts := job.GetInt("attempts") + 1
			job.Set("attempts", attempts)
			delay = min(300, 1<<min(attempts, 8))
		}
		delay = max(1, min(delay, 300))
		job.Set("next_attempt_at", now+int64(delay))
	}
	if err := s.app.Save(job); err != nil {
		return err
	}
	return event.JSON(http.StatusOK, map[string]any{"id": job.Id, "status": request.Status})
}

func (s *Service) lockedSweepJob(id, owner string) (*core.Record, error) {
	if owner == "" || len(owner) > 80 {
		return nil, apis.NewBadRequestError("Sweeper-Id is required", nil)
	}
	job, err := s.app.FindRecordById("sweep_jobs", id)
	if err != nil {
		return nil, apis.NewNotFoundError("sweep job not found", nil)
	}
	stored := job.GetString("lock_owner")
	if job.GetString("status") != "processing" || len(stored) != len(owner) || subtle.ConstantTimeCompare([]byte(stored), []byte(owner)) != 1 || int64(job.GetFloat("locked_until")) < time.Now().Unix() {
		return nil, apis.NewApiError(http.StatusConflict, "sweep lease is not held", nil)
	}
	return job, nil
}

func (s *Service) validateSweepTransaction(job *core.Record, kind string, transaction *types.Transaction) (common.Address, common.Address, *big.Int, error) {
	intent, err := s.app.FindRecordById("payment_intents", job.GetString("payment_intent"))
	if err != nil {
		return common.Address{}, common.Address{}, nil, err
	}
	network := s.config.Networks[job.GetString("chain")]
	return validateSignedSweepTransaction(network, intent.GetString("deposit_address"), intent.GetString("token_address"), s.config.SweeperMaxGasWei, kind, transaction)
}

func validateSignedSweepTransaction(network Network, depositAddress, tokenAddress string, maxGasWei *big.Int, kind string, transaction *types.Transaction) (common.Address, common.Address, *big.Int, error) {
	chainID := big.NewInt(network.ChainID)
	if transaction.ChainId().Cmp(chainID) != 0 || transaction.To() == nil {
		return common.Address{}, common.Address{}, nil, errors.New("transaction chain or destination mismatch")
	}
	from, err := types.Sender(types.LatestSignerForChainID(chainID), transaction)
	if err != nil {
		return common.Address{}, common.Address{}, nil, errors.New("transaction signature is invalid")
	}
	to := *transaction.To()
	deposit := common.HexToAddress(depositAddress)
	treasury := common.HexToAddress(network.TreasuryAddress)

	switch kind {
	case "gas":
		if to != deposit || len(transaction.Data()) != 0 || transaction.Gas() != 21000 || transaction.Value().Sign() <= 0 || transaction.Value().Cmp(maxGasWei) > 0 {
			return common.Address{}, common.Address{}, nil, errors.New("invalid gas funding transaction")
		}
		return from, to, transaction.Value(), nil
	case "sweep":
		if from != deposit {
			return common.Address{}, common.Address{}, nil, errors.New("sweep must be signed by the deposit address")
		}
		if tokenAddress == "" {
			if to != treasury || len(transaction.Data()) != 0 || transaction.Gas() < 21000 || transaction.Gas() > maxNativeSweepGas || transaction.Value().Sign() <= 0 {
				return common.Address{}, common.Address{}, nil, errors.New("invalid native sweep transaction")
			}
			return from, to, transaction.Value(), nil
		}
		tokenTo, amount, ok := decodeTokenTransfer(transaction.Data())
		if to != common.HexToAddress(tokenAddress) || transaction.Value().Sign() != 0 || !ok || tokenTo != treasury || amount.Sign() <= 0 {
			return common.Address{}, common.Address{}, nil, errors.New("invalid token sweep transaction")
		}
		return from, to, amount, nil
	default:
		return common.Address{}, common.Address{}, nil, errors.New("kind must be gas or sweep")
	}
}

func (s *Service) sweepJobPayload(job *core.Record, includeRaw bool) (sweepJobPayload, error) {
	intent, err := s.app.FindRecordById("payment_intents", job.GetString("payment_intent"))
	if err != nil {
		return sweepJobPayload{}, err
	}
	network := s.config.Networks[job.GetString("chain")]
	records, err := s.app.FindRecordsByFilter("sweep_transactions", "sweep_job = {:id}", "created", 0, 0, dbx.Params{"id": job.Id})
	if err != nil {
		return sweepJobPayload{}, err
	}
	transactions := make([]sweepTransactionPayload, 0, len(records))
	for _, record := range records {
		transactions = append(transactions, s.sweepTransactionPayload(record, includeRaw))
	}
	return sweepJobPayload{
		ID: job.Id, Chain: job.GetString("chain"), ChainID: network.ChainID,
		Asset: intent.GetString("asset"), TokenAddress: intent.GetString("token_address"),
		DepositAddress: intent.GetString("deposit_address"), DerivationIndex: uint32(intent.GetInt("derivation_index")),
		TreasuryAddress: network.TreasuryAddress, Confirmations: network.Confirmations,
		ObservedUnits: job.GetString("observed_units"), Status: job.GetString("status"),
		Attempts: job.GetInt("attempts"), SweepTransactions: transactions,
	}, nil
}

func (s *Service) sweepTransactionPayload(record *core.Record, includeRaw bool) sweepTransactionPayload {
	network := s.config.Networks[record.GetString("chain")]
	payload := sweepTransactionPayload{
		ID: record.Id, Kind: record.GetString("kind"), Hash: record.GetString("tx_hash"),
		From: record.GetString("from_address"), To: record.GetString("to_address"),
		AmountUnits: record.GetString("amount_units"), Nonce: uint64(record.GetFloat("nonce")),
		Status: record.GetString("status"), BlockNumber: uint64(record.GetFloat("block_number")),
		LastError: record.GetString("last_error"), CreatedAt: record.GetDateTime("created").Time().UTC().Format(time.RFC3339),
	}
	if includeRaw {
		payload.Raw = record.GetString("raw_tx")
	}
	if network.ExplorerURL != "" {
		payload.ExplorerURL = network.ExplorerURL + "/tx/" + payload.Hash
	}
	return payload
}

func (s *Service) publicSweepResponse(intent *core.Record) (map[string]any, error) {
	job, err := s.app.FindFirstRecordByData("sweep_jobs", "payment_intent", intent.Id)
	if errors.Is(err, sql.ErrNoRows) {
		return map[string]any{"status": "not_queued", "transactions": []any{}}, nil
	}
	if err != nil {
		return nil, err
	}
	payload, err := s.sweepJobPayload(job, false)
	if err != nil {
		return nil, err
	}
	return map[string]any{
		"status": payload.Status, "observedUnits": payload.ObservedUnits,
		"remainingUnits": job.GetString("remaining_units"), "lastError": job.GetString("last_error"),
		"completedAt": unixTimeString(job.GetFloat("completed_at")), "transactions": payload.SweepTransactions,
	}, nil
}

func decodeLimitedJSON(request *http.Request, destination any) error {
	decoder := json.NewDecoder(io.LimitReader(request.Body, 256<<10))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(destination); err != nil {
		return err
	}
	if err := decoder.Decode(&struct{}{}); err != io.EOF {
		return errors.New("request body must contain one JSON object")
	}
	return nil
}

func unixTimeString(value float64) any {
	if value <= 0 {
		return nil
	}
	return time.Unix(int64(value), 0).UTC().Format(time.RFC3339)
}

func truncate(value string, length int) string {
	if len(value) > length {
		return value[:length]
	}
	return value
}
