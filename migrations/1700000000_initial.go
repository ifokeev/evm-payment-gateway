package migrations

import (
	"github.com/pocketbase/pocketbase/core"
	m "github.com/pocketbase/pocketbase/migrations"
)

func init() {
	m.Register(func(app core.App) error {
		intents := core.NewBaseCollection("payment_intents")
		addTimestamps(intents)
		intents.Fields.Add(
			&core.TextField{Name: "idempotency_key", Required: true, Max: 200, Hidden: true},
			&core.TextField{Name: "request_hash", Required: true, Max: 64, Hidden: true},
			&core.TextField{Name: "kind", Required: true, Max: 40},
			&core.TextField{Name: "external_id", Required: true, Max: 200},
			&core.TextField{Name: "chain", Required: true, Max: 80},
			&core.NumberField{Name: "chain_id", Required: true, OnlyInt: true, Min: floatPtr(1)},
			&core.TextField{Name: "asset", Required: true, Max: 20},
			&core.TextField{Name: "token_address", Max: 42},
			&core.NumberField{Name: "decimals", OnlyInt: true, Min: floatPtr(0)},
			&core.TextField{Name: "expected_amount", Required: true, Max: 100},
			&core.TextField{Name: "expected_units", Required: true, Max: 100},
			&core.TextField{Name: "received_units", Required: true, Max: 100},
			&core.TextField{Name: "confirmed_units", Required: true, Max: 100},
			&core.TextField{Name: "deposit_address", Required: true, Max: 42},
			&core.NumberField{Name: "derivation_index", OnlyInt: true, Min: floatPtr(0)},
			&core.NumberField{Name: "start_block", OnlyInt: true, Min: floatPtr(0)},
			&core.NumberField{Name: "confirmations", Required: true, OnlyInt: true, Min: floatPtr(1)},
			&core.TextField{Name: "status", Required: true, Max: 20},
			&core.NumberField{Name: "expires_at", Required: true, OnlyInt: true, Min: floatPtr(1)},
			&core.JSONField{Name: "metadata", MaxSize: 65536},
		)
		intents.AddIndex("idx_intents_idempotency", true, "idempotency_key", "")
		intents.AddIndex("idx_intents_address", true, "deposit_address", "")
		intents.AddIndex("idx_intents_derivation", true, "derivation_index", "")
		intents.AddIndex("idx_intents_chain", false, "chain", "")
		if err := app.Save(intents); err != nil {
			return err
		}
		gatewayState := core.NewBaseCollection("gateway_state")
		addTimestamps(gatewayState)
		gatewayState.Fields.Add(
			&core.TextField{Name: "key", Required: true, Max: 80},
			&core.NumberField{Name: "value", OnlyInt: true, Min: floatPtr(0)},
		)
		gatewayState.AddIndex("idx_gateway_state_key", true, "key", "")
		if err := app.Save(gatewayState); err != nil {
			return err
		}
		counter := core.NewRecord(gatewayState)
		counter.Set("key", "next_derivation_index")
		counter.Set("value", 0)
		if err := app.Save(counter); err != nil {
			return err
		}

		transactions := core.NewBaseCollection("payment_transactions")
		addTimestamps(transactions)
		transactions.Fields.Add(
			&core.RelationField{Name: "payment_intent", Required: true, MaxSelect: 1, CollectionId: intents.Id, CascadeDelete: true},
			&core.TextField{Name: "chain", Required: true, Max: 80},
			&core.TextField{Name: "tx_hash", Required: true, Max: 66},
			&core.NumberField{Name: "event_index", OnlyInt: true},
			&core.TextField{Name: "asset", Required: true, Max: 20},
			&core.TextField{Name: "from_address", Required: true, Max: 42},
			&core.TextField{Name: "to_address", Required: true, Max: 42},
			&core.TextField{Name: "amount_units", Required: true, Max: 100},
			&core.NumberField{Name: "block_number", OnlyInt: true, Min: floatPtr(0)},
			&core.TextField{Name: "block_hash", Required: true, Max: 66},
			&core.NumberField{Name: "block_timestamp", Required: true, OnlyInt: true, Min: floatPtr(0)},
			&core.BoolField{Name: "canonical", Required: true},
		)
		transactions.AddIndex("idx_transactions_unique", true, "chain, tx_hash, event_index", "")
		transactions.AddIndex("idx_transactions_intent", false, "payment_intent, block_number", "")
		if err := app.Save(transactions); err != nil {
			return err
		}

		blocks := core.NewBaseCollection("chain_blocks")
		addTimestamps(blocks)
		blocks.Fields.Add(
			&core.TextField{Name: "chain", Required: true, Max: 80},
			&core.NumberField{Name: "block_number", OnlyInt: true, Min: floatPtr(0)},
			&core.TextField{Name: "block_hash", Required: true, Max: 66},
			&core.TextField{Name: "parent_hash", Required: true, Max: 66},
			&core.NumberField{Name: "block_timestamp", Required: true, OnlyInt: true, Min: floatPtr(0)},
		)
		blocks.AddIndex("idx_blocks_unique", true, "chain, block_number", "")
		if err := app.Save(blocks); err != nil {
			return err
		}

		states := core.NewBaseCollection("chain_states")
		addTimestamps(states)
		states.Fields.Add(
			&core.TextField{Name: "chain", Required: true, Max: 80},
			&core.NumberField{Name: "last_scanned", OnlyInt: true, Min: floatPtr(0)},
		)
		states.AddIndex("idx_states_chain", true, "chain", "")
		if err := app.Save(states); err != nil {
			return err
		}

		events := core.NewBaseCollection("webhook_events")
		addTimestamps(events)
		events.Fields.Add(
			&core.TextField{Name: "event_id", Required: true, Max: 80},
			&core.TextField{Name: "type", Required: true, Max: 40},
			&core.RelationField{Name: "payment_intent", Required: true, MaxSelect: 1, CollectionId: intents.Id, CascadeDelete: true},
			&core.TextField{Name: "body", Required: true, Max: 65536, Hidden: true},
			&core.TextField{Name: "status", Required: true, Max: 20},
			&core.NumberField{Name: "attempts", OnlyInt: true, Min: floatPtr(0)},
			&core.NumberField{Name: "next_attempt_at", Required: true, OnlyInt: true, Min: floatPtr(0)},
			&core.TextField{Name: "last_error", Max: 1000},
			&core.NumberField{Name: "delivered_at", OnlyInt: true, Min: floatPtr(0)},
		)
		events.AddIndex("idx_webhooks_event", true, "event_id", "")
		events.AddIndex("idx_webhooks_due", false, "status, next_attempt_at", "")
		return app.Save(events)
	}, func(app core.App) error {
		for _, name := range []string{"webhook_events", "chain_states", "chain_blocks", "payment_transactions", "gateway_state", "payment_intents"} {
			collection, err := app.FindCollectionByNameOrId(name)
			if err != nil {
				return err
			}
			if err := app.Delete(collection); err != nil {
				return err
			}
		}
		return nil
	})
}

func floatPtr(value float64) *float64 { return &value }

func addTimestamps(collection *core.Collection) {
	collection.Fields.Add(
		&core.AutodateField{Name: "created", OnCreate: true},
		&core.AutodateField{Name: "updated", OnCreate: true, OnUpdate: true},
	)
}
