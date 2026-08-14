package gateway

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"math/big"
	"strings"
	"time"

	"github.com/ethereum/go-ethereum"
	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/core/types"
	"github.com/ethereum/go-ethereum/crypto"
	"github.com/pocketbase/dbx"
	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tools/security"
)

var transferTopic = crypto.Keccak256Hash([]byte("Transfer(address,address,uint256)"))

type observedPayment struct {
	IntentID       string
	Chain          string
	TxHash         string
	EventIndex     int
	Asset          string
	From           string
	To             string
	AmountUnits    string
	BlockNumber    uint64
	BlockHash      string
	BlockTimestamp uint64
}

func (s *Service) runOnce(ctx context.Context) {
	for name, chain := range s.chains {
		chain.mu.Lock()
		syncCtx, cancel := context.WithTimeout(ctx, 45*time.Second)
		err := s.syncChain(syncCtx, name, chain)
		cancel()
		chain.mu.Unlock()
		if err != nil && !errors.Is(err, context.Canceled) {
			s.app.Logger().Error("chain sync failed", "chain", name, "error", err)
			head := uint64(0)
			if last, ok, stateErr := s.lastScanned(name); stateErr == nil && ok && last > 0 {
				head = uint64(last)
			}
			if recalcErr := s.recalculateChain(name, head, nil); recalcErr != nil {
				s.app.Logger().Error("payment expiry update failed", "chain", name, "error", recalcErr)
			}
		}
	}
	if err := s.deliverWebhooks(ctx); err != nil && !errors.Is(err, context.Canceled) {
		s.app.Logger().Error("webhook delivery failed", "error", err)
	}
}

func (s *Service) syncChain(ctx context.Context, name string, chain *chainRuntime) error {
	intents, err := s.intentsForChain(name)
	if err != nil || len(intents) == 0 {
		return err
	}
	latest, err := chain.client.BlockNumber(ctx)
	if err != nil {
		return err
	}
	last, hasState, err := s.lastScanned(name)
	if err != nil {
		return err
	}
	reorged := map[string]bool{}
	if !hasState {
		last = earliestStartBlock(intents) - 1
	} else if last >= 0 {
		stored, err := s.findBlock(name, uint64(last))
		if err != nil {
			return err
		}
		header, err := chain.client.HeaderByNumber(ctx, big.NewInt(last))
		if err != nil {
			return err
		}
		if stored == nil || !strings.EqualFold(stored.GetString("block_hash"), header.Hash().Hex()) {
			ancestor := last - 1
			floor := last - int64(s.config.ReorgHistoryBlocks)
			for ancestor >= 0 && ancestor >= floor {
				candidate, err := s.findBlock(name, uint64(ancestor))
				if err != nil {
					return err
				}
				remote, err := chain.client.HeaderByNumber(ctx, big.NewInt(ancestor))
				if err != nil {
					return err
				}
				if candidate != nil && strings.EqualFold(candidate.GetString("block_hash"), remote.Hash().Hex()) {
					break
				}
				ancestor--
			}
			if ancestor < floor || ancestor < 0 {
				ancestor = earliestStartBlock(intents) - 1
			}
			reorged, err = s.rewind(name, ancestor+1)
			if err != nil {
				return err
			}
			last = ancestor
			if len(reorged) > 0 {
				head := uint64(0)
				if ancestor > 0 {
					head = uint64(ancestor)
				}
				if err := s.recalculateChain(name, head, reorged); err != nil {
					return err
				}
			}
		}
	}

	// Rescan the tip so an intent created while the previous scan was running cannot miss its first payment.
	start := last + 1
	if hasState && last >= 0 {
		start = last
	}
	if start < 0 {
		start = 0
	}
	for number := uint64(start); number <= latest; number++ {
		intents, err = s.intentsForChain(name)
		if err != nil {
			return err
		}
		header, err := chain.client.HeaderByNumber(ctx, new(big.Int).SetUint64(number))
		if err != nil {
			return err
		}
		payments, err := s.paymentsInBlock(ctx, chain, header, intents)
		if err != nil {
			return err
		}
		if err := s.saveBlock(name, header, payments); err != nil {
			return err
		}
	}
	if err := s.recalculateChain(name, latest, reorged); err != nil {
		return err
	}
	return s.pruneBlocks(name, latest)
}

func (s *Service) intentsForChain(chain string) ([]*core.Record, error) {
	// ponytail: a single PocketBase process is capped at 100k intents per chain; shard the gateway if this becomes real.
	return s.app.FindRecordsByFilter("payment_intents", "chain = {:chain}", "derivation_index", 100000, 0, dbx.Params{"chain": chain})
}

func earliestStartBlock(intents []*core.Record) int64 {
	earliest := int64(intents[0].GetFloat("start_block"))
	for _, intent := range intents[1:] {
		if block := int64(intent.GetFloat("start_block")); block < earliest {
			earliest = block
		}
	}
	return earliest
}

func (s *Service) lastScanned(chain string) (int64, bool, error) {
	record, err := s.app.FindFirstRecordByData("chain_states", "chain", chain)
	if errors.Is(err, sql.ErrNoRows) {
		return 0, false, nil
	}
	if err != nil {
		return 0, false, err
	}
	return int64(record.GetFloat("last_scanned")), true, nil
}

func (s *Service) findBlock(chain string, number uint64) (*core.Record, error) {
	record, err := s.app.FindFirstRecordByFilter(
		"chain_blocks", "chain = {:chain} && block_number = {:number}", dbx.Params{"chain": chain, "number": number},
	)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	return record, err
}

func (s *Service) paymentsInBlock(ctx context.Context, chain *chainRuntime, header *types.Header, intents []*core.Record) ([]observedPayment, error) {
	addresses := make(map[string]*core.Record, len(intents))
	nativeAddresses := map[string]*core.Record{}
	tokenAddresses := map[common.Address]bool{}
	for _, intent := range intents {
		address := strings.ToLower(intent.GetString("deposit_address"))
		addresses[address] = intent
		if intent.GetString("token_address") == "" {
			nativeAddresses[address] = intent
		} else {
			tokenAddresses[common.HexToAddress(intent.GetString("token_address"))] = true
		}
	}
	payments := []observedPayment{}
	if len(nativeAddresses) > 0 {
		block, err := chain.client.BlockByHash(ctx, header.Hash())
		if err != nil {
			return nil, err
		}
		signer := types.LatestSignerForChainID(big.NewInt(chain.config.ChainID))
		for _, tx := range block.Transactions() {
			if tx.To() == nil || tx.Value().Sign() <= 0 {
				continue
			}
			intent := nativeAddresses[strings.ToLower(tx.To().Hex())]
			if intent == nil {
				continue
			}
			receipt, err := chain.client.TransactionReceipt(ctx, tx.Hash())
			if err != nil {
				return nil, err
			}
			if receipt.Status != types.ReceiptStatusSuccessful {
				continue
			}
			from, err := types.Sender(signer, tx)
			if err != nil {
				return nil, err
			}
			payments = append(payments, observedPayment{
				IntentID: intent.Id, Chain: chain.config.Name, TxHash: tx.Hash().Hex(), EventIndex: -1,
				Asset: intent.GetString("asset"), From: from.Hex(), To: tx.To().Hex(), AmountUnits: tx.Value().String(),
				BlockNumber: header.Number.Uint64(), BlockHash: header.Hash().Hex(), BlockTimestamp: header.Time,
			})
		}
	}
	for token := range tokenAddresses {
		hash := header.Hash()
		logs, err := chain.client.FilterLogs(ctx, ethereum.FilterQuery{
			BlockHash: &hash, Addresses: []common.Address{token}, Topics: [][]common.Hash{{transferTopic}},
		})
		if err != nil {
			return nil, err
		}
		for _, event := range logs {
			if len(event.Topics) < 3 || len(event.Data) != 32 {
				continue
			}
			to := common.BytesToAddress(event.Topics[2].Bytes()).Hex()
			intent := addresses[strings.ToLower(to)]
			if intent == nil || !strings.EqualFold(intent.GetString("token_address"), token.Hex()) {
				continue
			}
			payments = append(payments, observedPayment{
				IntentID: intent.Id, Chain: chain.config.Name, TxHash: event.TxHash.Hex(), EventIndex: int(event.Index),
				Asset: intent.GetString("asset"), From: common.BytesToAddress(event.Topics[1].Bytes()).Hex(), To: to,
				AmountUnits: new(big.Int).SetBytes(event.Data).String(), BlockNumber: header.Number.Uint64(),
				BlockHash: header.Hash().Hex(), BlockTimestamp: header.Time,
			})
		}
	}
	return payments, nil
}

func (s *Service) saveBlock(chain string, header *types.Header, payments []observedPayment) error {
	return s.app.RunInTransaction(func(txApp core.App) error {
		block, err := txApp.FindFirstRecordByFilter(
			"chain_blocks", "chain = {:chain} && block_number = {:number}", dbx.Params{"chain": chain, "number": header.Number.Uint64()},
		)
		if errors.Is(err, sql.ErrNoRows) {
			collection, err := txApp.FindCollectionByNameOrId("chain_blocks")
			if err != nil {
				return err
			}
			block = core.NewRecord(collection)
		} else if err != nil {
			return err
		}
		block.Load(map[string]any{
			"chain": chain, "block_number": header.Number.Uint64(), "block_hash": header.Hash().Hex(),
			"parent_hash": header.ParentHash.Hex(), "block_timestamp": header.Time,
		})
		if err := txApp.Save(block); err != nil {
			return err
		}

		transactionCollection, err := txApp.FindCollectionByNameOrId("payment_transactions")
		if err != nil {
			return err
		}
		for _, payment := range payments {
			record, findErr := txApp.FindFirstRecordByFilter(
				"payment_transactions", "chain = {:chain} && tx_hash = {:hash} && event_index = {:index}",
				dbx.Params{"chain": chain, "hash": payment.TxHash, "index": payment.EventIndex},
			)
			if errors.Is(findErr, sql.ErrNoRows) {
				record = core.NewRecord(transactionCollection)
			} else if findErr != nil {
				return findErr
			}
			record.Load(map[string]any{
				"payment_intent": payment.IntentID, "chain": payment.Chain, "tx_hash": payment.TxHash,
				"event_index": payment.EventIndex, "asset": payment.Asset, "from_address": payment.From,
				"to_address": payment.To, "amount_units": payment.AmountUnits, "block_number": payment.BlockNumber,
				"block_hash": payment.BlockHash, "block_timestamp": payment.BlockTimestamp, "canonical": true,
			})
			if err := txApp.Save(record); err != nil {
				return err
			}
		}

		state, err := txApp.FindFirstRecordByData("chain_states", "chain", chain)
		if errors.Is(err, sql.ErrNoRows) {
			collection, err := txApp.FindCollectionByNameOrId("chain_states")
			if err != nil {
				return err
			}
			state = core.NewRecord(collection)
		} else if err != nil {
			return err
		}
		state.Set("chain", chain)
		state.Set("last_scanned", header.Number.Uint64())
		return txApp.Save(state)
	})
}

func (s *Service) rewind(chain string, fromBlock int64) (map[string]bool, error) {
	affected := map[string]bool{}
	records, err := s.app.FindRecordsByFilter(
		"payment_transactions", "chain = {:chain} && block_number >= {:block} && canonical = true", "", 100000, 0,
		dbx.Params{"chain": chain, "block": fromBlock},
	)
	if err != nil {
		return nil, err
	}
	for _, record := range records {
		intent, err := s.app.FindRecordById("payment_intents", record.GetString("payment_intent"))
		if err == nil && intent.GetString("status") == "paid" {
			affected[intent.Id] = true
		}
	}
	err = s.app.RunInTransaction(func(txApp core.App) error {
		params := dbx.Params{"chain": chain, "block": fromBlock}
		if _, err := txApp.DB().NewQuery("UPDATE payment_transactions SET canonical = FALSE WHERE chain = {:chain} AND block_number >= {:block} AND canonical = TRUE").Bind(params).Execute(); err != nil {
			return err
		}
		if _, err := txApp.DB().NewQuery("DELETE FROM chain_blocks WHERE chain = {:chain} AND block_number >= {:block}").Bind(params).Execute(); err != nil {
			return err
		}
		state, err := txApp.FindFirstRecordByData("chain_states", "chain", chain)
		if errors.Is(err, sql.ErrNoRows) {
			return nil
		}
		if err != nil {
			return err
		}
		if fromBlock <= 0 {
			return txApp.Delete(state)
		}
		state.Set("last_scanned", fromBlock-1)
		return txApp.Save(state)
	})
	return affected, err
}

func (s *Service) recalculateChain(chain string, latest uint64, reorged map[string]bool) error {
	intents, err := s.intentsForChain(chain)
	if err != nil {
		return err
	}
	for _, intent := range intents {
		transactions, err := s.app.FindRecordsByFilter(
			"payment_transactions", "payment_intent = {:id} && canonical = true", "block_number,event_index", 10000, 0, dbx.Params{"id": intent.Id},
		)
		if err != nil {
			return err
		}
		received, confirmed := new(big.Int), new(big.Int)
		hashes := make([]string, 0, len(transactions))
		expires := int64(intent.GetFloat("expires_at")) + int64(s.config.PaymentGrace)
		for _, transaction := range transactions {
			if int64(transaction.GetFloat("block_timestamp")) > expires {
				continue
			}
			amount := bigFromString(transaction.GetString("amount_units"))
			received.Add(received, amount)
			block := uint64(transaction.GetFloat("block_number"))
			if latest >= block && latest-block+1 >= uint64(intent.GetInt("confirmations")) {
				confirmed.Add(confirmed, amount)
			}
			hashes = append(hashes, transaction.GetString("tx_hash"))
		}
		expected := bigFromString(intent.GetString("expected_units"))
		status := deriveStatus(
			received, confirmed, expected, time.Now().Unix() > int64(intent.GetFloat("expires_at")),
			reorged[intent.Id] || intent.GetString("status") == "reorged",
		)
		if status == "reorged" {
			removed, err := s.app.FindRecordsByFilter(
				"payment_transactions", "payment_intent = {:id} && canonical = false", "block_number,event_index", 10000, 0, dbx.Params{"id": intent.Id},
			)
			if err != nil {
				return err
			}
			for _, transaction := range removed {
				hashes = append(hashes, transaction.GetString("tx_hash"))
			}
		}
		if err := s.updatePayment(intent.Id, received.String(), confirmed.String(), status, hashes); err != nil {
			return err
		}
	}
	return nil
}

func (s *Service) updatePayment(id, received, confirmed, status string, hashes []string) error {
	return s.app.RunInTransaction(func(txApp core.App) error {
		intent, err := txApp.FindRecordById("payment_intents", id)
		if err != nil {
			return err
		}
		oldStatus := intent.GetString("status")
		if oldStatus == status && intent.GetString("received_units") == received && intent.GetString("confirmed_units") == confirmed {
			return nil
		}
		intent.Set("received_units", received)
		intent.Set("confirmed_units", confirmed)
		intent.Set("status", status)
		if err := txApp.Save(intent); err != nil {
			return err
		}
		eventType := ""
		if status == "paid" && oldStatus != "paid" {
			eventType = "payment.succeeded"
		} else if status == "reorged" && oldStatus == "paid" {
			eventType = "payment.reorged"
		}
		if eventType == "" {
			return nil
		}
		eventID := "evt_" + security.RandomString(32)
		body, err := json.Marshal(map[string]any{
			"id": eventID, "type": eventType, "createdAt": time.Now().UTC().Format(time.RFC3339),
			"data": map[string]any{"paymentIntent": map[string]any{
				"id": intent.Id, "externalId": intent.GetString("external_id"), "kind": intent.GetString("kind"),
				"chain": intent.GetString("chain"), "chainId": intent.GetInt("chain_id"), "asset": intent.GetString("asset"),
				"expectedAmount": intent.GetString("expected_amount"), "receivedUnits": received, "confirmedUnits": confirmed,
				"depositAddress": intent.GetString("deposit_address"), "status": status, "transactionHashes": hashes,
			}},
		})
		if err != nil {
			return err
		}
		collection, err := txApp.FindCollectionByNameOrId("webhook_events")
		if err != nil {
			return err
		}
		event := core.NewRecord(collection)
		event.Load(map[string]any{
			"event_id": eventID, "type": eventType, "payment_intent": intent.Id, "body": string(body),
			"status": "pending", "attempts": 0, "next_attempt_at": time.Now().Unix(),
		})
		return txApp.Save(event)
	})
}

func (s *Service) pruneBlocks(chain string, latest uint64) error {
	if latest <= uint64(s.config.ReorgHistoryBlocks) {
		return nil
	}
	_, err := s.app.DB().NewQuery(
		"DELETE FROM chain_blocks WHERE chain = {:chain} AND block_number < {:floor}",
	).Bind(dbx.Params{"chain": chain, "floor": latest - uint64(s.config.ReorgHistoryBlocks)}).Execute()
	return err
}
