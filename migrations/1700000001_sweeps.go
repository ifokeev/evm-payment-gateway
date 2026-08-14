package migrations

import (
	"github.com/pocketbase/pocketbase/core"
	m "github.com/pocketbase/pocketbase/migrations"
)

func init() {
	m.Register(func(app core.App) error {
		intents, err := app.FindCollectionByNameOrId("payment_intents")
		if err != nil {
			return err
		}

		jobs := core.NewBaseCollection("sweep_jobs")
		addTimestamps(jobs)
		jobs.Fields.Add(
			&core.RelationField{Name: "payment_intent", Required: true, MaxSelect: 1, CollectionId: intents.Id, CascadeDelete: true},
			&core.TextField{Name: "chain", Required: true, Max: 80},
			&core.TextField{Name: "observed_units", Required: true, Max: 100},
			&core.TextField{Name: "remaining_units", Required: true, Max: 100},
			&core.TextField{Name: "status", Required: true, Max: 20},
			&core.NumberField{Name: "attempts", OnlyInt: true, Min: floatPtr(0)},
			&core.NumberField{Name: "next_attempt_at", Required: true, OnlyInt: true, Min: floatPtr(0)},
			&core.TextField{Name: "last_error", Max: 1000},
			&core.TextField{Name: "lock_owner", Max: 80, Hidden: true},
			&core.NumberField{Name: "locked_until", OnlyInt: true, Min: floatPtr(0), Hidden: true},
			&core.NumberField{Name: "completed_at", OnlyInt: true, Min: floatPtr(0)},
		)
		jobs.AddIndex("idx_sweep_jobs_intent", true, "payment_intent", "")
		jobs.AddIndex("idx_sweep_jobs_due", false, "chain, status, next_attempt_at", "")
		if err := app.Save(jobs); err != nil {
			return err
		}

		transactions := core.NewBaseCollection("sweep_transactions")
		addTimestamps(transactions)
		transactions.Fields.Add(
			&core.RelationField{Name: "sweep_job", Required: true, MaxSelect: 1, CollectionId: jobs.Id, CascadeDelete: true},
			&core.TextField{Name: "chain", Required: true, Max: 80},
			&core.TextField{Name: "kind", Required: true, Max: 20},
			&core.TextField{Name: "tx_hash", Required: true, Max: 66},
			&core.TextField{Name: "raw_tx", Required: true, Max: 262144, Hidden: true},
			&core.TextField{Name: "from_address", Required: true, Max: 42},
			&core.TextField{Name: "to_address", Required: true, Max: 42},
			&core.TextField{Name: "amount_units", Required: true, Max: 100},
			&core.NumberField{Name: "nonce", OnlyInt: true, Min: floatPtr(0)},
			&core.TextField{Name: "status", Required: true, Max: 20},
			&core.NumberField{Name: "block_number", OnlyInt: true, Min: floatPtr(0)},
			&core.TextField{Name: "last_error", Max: 1000},
		)
		transactions.AddIndex("idx_sweep_transactions_hash", true, "chain, tx_hash", "")
		transactions.AddIndex("idx_sweep_transactions_job", false, "sweep_job, created", "")
		return app.Save(transactions)
	}, func(app core.App) error {
		for _, name := range []string{"sweep_transactions", "sweep_jobs"} {
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
