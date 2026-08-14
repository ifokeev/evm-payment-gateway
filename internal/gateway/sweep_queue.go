package gateway

import (
	"database/sql"
	"errors"
	"time"

	"github.com/pocketbase/pocketbase/core"
)

func syncSweepJob(app core.App, intent *core.Record, observedUnits string, eligible bool) error {
	job, err := app.FindFirstRecordByData("sweep_jobs", "payment_intent", intent.Id)
	if errors.Is(err, sql.ErrNoRows) {
		if !eligible {
			return nil
		}
		collection, err := app.FindCollectionByNameOrId("sweep_jobs")
		if err != nil {
			return err
		}
		job = core.NewRecord(collection)
		job.Load(map[string]any{
			"payment_intent":  intent.Id,
			"chain":           intent.GetString("chain"),
			"observed_units":  observedUnits,
			"remaining_units": "0",
			"status":          "queued",
			"attempts":        0,
			"next_attempt_at": time.Now().Unix(),
		})
		return app.Save(job)
	}
	if err != nil {
		return err
	}

	if !eligible {
		if !terminalSweepStatus(job.GetString("status")) && job.GetString("status") != "paused" {
			job.Set("status", "paused")
			job.Set("lock_owner", "")
			job.Set("locked_until", 0)
			return app.Save(job)
		}
		return nil
	}

	previous := job.GetString("observed_units")
	changed := previous != observedUnits
	if changed {
		job.Set("observed_units", observedUnits)
	}
	if job.GetString("status") == "paused" || (terminalSweepStatus(job.GetString("status")) && previous != observedUnits) {
		job.Set("status", "queued")
		job.Set("next_attempt_at", time.Now().Unix())
		job.Set("completed_at", 0)
		changed = true
	}
	if !changed {
		return nil
	}
	return app.Save(job)
}

func terminalSweepStatus(status string) bool {
	return status == "complete" || status == "external"
}
