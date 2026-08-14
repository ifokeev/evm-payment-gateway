package gateway

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	_ "evm-payment-gateway/migrations"

	"github.com/pocketbase/dbx"
	"github.com/pocketbase/pocketbase/core"
	pbtests "github.com/pocketbase/pocketbase/tests"
)

func TestTerminalSweepReopensAfterSameValueReplacement(t *testing.T) {
	app := newTestApp(t)
	for index, terminal := range []string{"complete", "external"} {
		t.Run(terminal, func(t *testing.T) {
			intent := newTestIntent(t, app, index)
			if err := syncSweepJob(app, intent, "100", true); err != nil {
				t.Fatal(err)
			}
			job, err := app.FindFirstRecordByData("sweep_jobs", "payment_intent", intent.Id)
			if err != nil {
				t.Fatal(err)
			}
			job.Set("status", terminal)
			job.Set("completed_at", time.Now().Unix())
			if err := app.Save(job); err != nil {
				t.Fatal(err)
			}

			// The original deposit is reorged out, then a different deposit for the
			// same amount becomes canonical.
			if err := syncSweepJob(app, intent, "0", false); err != nil {
				t.Fatal(err)
			}
			job, _ = app.FindRecordById("sweep_jobs", job.Id)
			if job.GetString("status") != terminal || job.GetString("observed_units") != "0" {
				t.Fatalf("reorged terminal job was not reconciled: status=%s observed=%s", job.GetString("status"), job.GetString("observed_units"))
			}
			if err := syncSweepJob(app, intent, "100", true); err != nil {
				t.Fatal(err)
			}
			job, _ = app.FindRecordById("sweep_jobs", job.Id)
			if job.GetString("status") != "queued" || job.GetFloat("completed_at") != 0 {
				t.Fatalf("replacement deposit did not reopen terminal job: status=%s completed=%v", job.GetString("status"), job.GetFloat("completed_at"))
			}
		})
	}
}

func TestPaymentWebhookTransitionsAreIdempotent(t *testing.T) {
	app := newTestApp(t)
	intent := newTestIntent(t, app, 20)
	service := &Service{app: app, config: Config{SweeperMinTokenBPS: 5000}}

	if err := service.updatePayment(intent.Id, "100", "100", "paid", []string{"0xpaid"}, "100", true); err != nil {
		t.Fatal(err)
	}
	if err := service.updatePayment(intent.Id, "100", "100", "paid", []string{"0xpaid"}, "100", true); err != nil {
		t.Fatal(err)
	}
	if err := service.updatePayment(intent.Id, "150", "150", "paid", []string{"0xpaid", "0xextra"}, "150", true); err != nil {
		t.Fatal(err)
	}
	assertEventCount(t, app, "payment.succeeded", 1)

	if err := service.updatePayment(intent.Id, "0", "0", "reorged", []string{"0xpaid"}, "0", false); err != nil {
		t.Fatal(err)
	}
	if err := service.updatePayment(intent.Id, "0", "0", "reorged", []string{"0xpaid"}, "0", false); err != nil {
		t.Fatal(err)
	}
	assertEventCount(t, app, "payment.reorged", 1)

	if err := service.updatePayment(intent.Id, "100", "100", "paid", []string{"0xreplacement"}, "100", true); err != nil {
		t.Fatal(err)
	}
	assertEventCount(t, app, "payment.succeeded", 2)
}

func TestRecalculateConfirmationsAndLateTokenRecovery(t *testing.T) {
	app := newTestApp(t)
	service := &Service{app: app, config: Config{PaymentGrace: 60, SweeperMinTokenBPS: 5000}}
	intent := newTestIntent(t, app, 25)
	newPaymentTransaction(t, app, intent, "0x01", 100, 10, time.Now().Unix(), true)
	if err := service.recalculateChain("test", 10, nil); err != nil {
		t.Fatal(err)
	}
	intent, _ = app.FindRecordById("payment_intents", intent.Id)
	if intent.GetString("status") != "confirming" {
		t.Fatalf("one-confirmation payment status = %s, want confirming", intent.GetString("status"))
	}
	assertEventCount(t, app, "payment.succeeded", 0)
	if err := service.recalculateChain("test", 11, nil); err != nil {
		t.Fatal(err)
	}
	intent, _ = app.FindRecordById("payment_intents", intent.Id)
	if intent.GetString("status") != "paid" || intent.GetString("confirmed_units") != "100" {
		t.Fatalf("confirmed payment was not paid: status=%s confirmed=%s", intent.GetString("status"), intent.GetString("confirmed_units"))
	}
	assertEventCount(t, app, "payment.succeeded", 1)
	if err := service.recalculateChain("test", 12, nil); err != nil {
		t.Fatal(err)
	}
	assertEventCount(t, app, "payment.succeeded", 1)

	late := newTestIntent(t, app, 26)
	late.Set("token_address", "0x9999999999999999999999999999999999999999")
	late.Set("asset", "USDC")
	late.Set("decimals", 6)
	late.Set("expires_at", time.Now().Add(-2*time.Minute).Unix())
	if err := app.Save(late); err != nil {
		t.Fatal(err)
	}
	lateAt := time.Now().Unix()
	newPaymentTransaction(t, app, late, "0x02", 49, 10, lateAt, true)
	if err := service.recalculateChain("test", 12, nil); err != nil {
		t.Fatal(err)
	}
	if _, err := app.FindFirstRecordByData("sweep_jobs", "payment_intent", late.Id); err == nil {
		t.Fatal("late token dust below the recovery threshold queued a sweep")
	}
	newPaymentTransaction(t, app, late, "0x03", 1, 11, lateAt, true)
	if err := service.recalculateChain("test", 12, nil); err != nil {
		t.Fatal(err)
	}
	job, err := app.FindFirstRecordByData("sweep_jobs", "payment_intent", late.Id)
	if err != nil || job.GetString("observed_units") != "50" || job.GetString("status") != "queued" {
		t.Fatalf("recoverable late token payment was not queued: observed=%s status=%s err=%v", job.GetString("observed_units"), job.GetString("status"), err)
	}
}

func TestRewindReopensConfirmedSweep(t *testing.T) {
	app := newTestApp(t)
	intent := newTestIntent(t, app, 27)
	intent.Set("status", "paid")
	if err := app.Save(intent); err != nil {
		t.Fatal(err)
	}
	newPaymentTransaction(t, app, intent, "0x04", 100, 20, time.Now().Unix(), true)
	if err := syncSweepJob(app, intent, "100", true); err != nil {
		t.Fatal(err)
	}
	job, _ := app.FindFirstRecordByData("sweep_jobs", "payment_intent", intent.Id)
	job.Set("status", "complete")
	job.Set("completed_at", time.Now().Unix())
	if err := app.Save(job); err != nil {
		t.Fatal(err)
	}
	newSweepTransaction(t, app, job, 21)
	stateCollection, _ := app.FindCollectionByNameOrId("chain_states")
	state := core.NewRecord(stateCollection)
	state.Load(map[string]any{"chain": "test", "last_scanned": 21})
	if err := app.Save(state); err != nil {
		t.Fatal(err)
	}

	service := &Service{app: app}
	affected, err := service.rewind("test", 20)
	if err != nil {
		t.Fatal(err)
	}
	job, _ = app.FindRecordById("sweep_jobs", job.Id)
	sweep, _ := app.FindFirstRecordByData("sweep_transactions", "sweep_job", job.Id)
	payment, _ := app.FindFirstRecordByData("payment_transactions", "payment_intent", intent.Id)
	state, _ = app.FindRecordById("chain_states", state.Id)
	if !affected[intent.Id] || job.GetString("status") != "queued" || sweep.GetString("status") != "submitted" || sweep.GetInt("block_number") != 0 || payment.GetBool("canonical") || state.GetInt("last_scanned") != 19 {
		t.Fatalf("rewind did not restore retryable state: affected=%v job=%s sweep=%s/%d canonical=%v last=%d", affected[intent.Id], job.GetString("status"), sweep.GetString("status"), sweep.GetInt("block_number"), payment.GetBool("canonical"), state.GetInt("last_scanned"))
	}
}

func TestWebhookRetryKeepsStableIdAndValidSignature(t *testing.T) {
	app := newTestApp(t)
	intent := newTestIntent(t, app, 30)
	secret := "test-webhook-secret-at-least-24-characters"
	body := `{"id":"evt_test","type":"payment.succeeded"}`
	requestCount := 0
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		requestCount++
		received, err := io.ReadAll(request.Body)
		if err != nil {
			t.Error(err)
		}
		if string(received) != body || request.Header.Get("Webhook-Id") != "evt_test" {
			t.Errorf("webhook identity changed on attempt %d", requestCount)
		}
		timestamp := request.Header.Get("Webhook-Timestamp")
		mac := hmac.New(sha256.New, []byte(secret))
		mac.Write([]byte(timestamp + "." + body))
		want := "v1," + hex.EncodeToString(mac.Sum(nil))
		if request.Header.Get("Webhook-Signature") != want {
			t.Errorf("invalid webhook signature on attempt %d", requestCount)
		}
		if requestCount == 1 {
			response.WriteHeader(http.StatusServiceUnavailable)
			return
		}
		response.WriteHeader(http.StatusNoContent)
	}))
	defer server.Close()

	collection, err := app.FindCollectionByNameOrId("webhook_events")
	if err != nil {
		t.Fatal(err)
	}
	event := core.NewRecord(collection)
	event.Load(map[string]any{
		"event_id": "evt_test", "type": "payment.succeeded", "payment_intent": intent.Id,
		"body": body, "status": "pending", "attempts": 0, "next_attempt_at": time.Now().Unix(),
	})
	if err := app.Save(event); err != nil {
		t.Fatal(err)
	}
	service := &Service{app: app, config: Config{WebhookURL: server.URL, WebhookSecret: secret}}
	if err := service.deliverWebhooks(t.Context()); err != nil {
		t.Fatal(err)
	}
	event, _ = app.FindRecordById("webhook_events", event.Id)
	if event.GetString("status") != "pending" || event.GetInt("attempts") != 1 || event.GetString("last_error") == "" {
		t.Fatalf("failed webhook was not scheduled for retry: status=%s attempts=%d", event.GetString("status"), event.GetInt("attempts"))
	}
	event.Set("next_attempt_at", time.Now().Add(-time.Second).Unix())
	if err := app.Save(event); err != nil {
		t.Fatal(err)
	}
	if err := service.deliverWebhooks(t.Context()); err != nil {
		t.Fatal(err)
	}
	event, _ = app.FindRecordById("webhook_events", event.Id)
	if requestCount != 2 || event.GetString("status") != "delivered" || event.GetInt("attempts") != 2 {
		t.Fatalf("webhook retry did not complete: requests=%d status=%s attempts=%d", requestCount, event.GetString("status"), event.GetInt("attempts"))
	}
}

func newTestApp(t *testing.T) *pbtests.TestApp {
	t.Helper()
	app, err := pbtests.NewTestApp(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(app.Cleanup)
	return app
}

func newTestIntent(t *testing.T, app core.App, index int) *core.Record {
	t.Helper()
	collection, err := app.FindCollectionByNameOrId("payment_intents")
	if err != nil {
		t.Fatal(err)
	}
	record := core.NewRecord(collection)
	record.Load(map[string]any{
		"idempotency_key": fmt.Sprintf("intent-%d", index), "request_hash": strings.Repeat(fmt.Sprint(index%10), 64),
		"kind": "credit_pack", "external_id": fmt.Sprintf("order-%d", index), "chain": "test", "chain_id": 1337,
		"asset": "ETH", "decimals": 18, "expected_amount": "0.0000000000000001", "expected_units": "100",
		"received_units": "0", "confirmed_units": "0", "deposit_address": fmt.Sprintf("0x%040x", index+1),
		"derivation_index": index, "start_block": 1, "confirmations": 2, "status": "pending",
		"expires_at": time.Now().Add(time.Hour).Unix(), "metadata": map[string]any{},
	})
	if err := app.Save(record); err != nil {
		t.Fatal(err)
	}
	return record
}

func assertEventCount(t *testing.T, app core.App, eventType string, want int) {
	t.Helper()
	records, err := app.FindRecordsByFilter("webhook_events", "type = {:type}", "", 0, 0, dbx.Params{"type": eventType})
	if err != nil {
		t.Fatal(err)
	}
	if len(records) != want {
		t.Fatalf("%s event count = %d, want %d", eventType, len(records), want)
	}
}

func newPaymentTransaction(t *testing.T, app core.App, intent *core.Record, hash string, amount, block uint64, timestamp int64, canonical bool) *core.Record {
	t.Helper()
	collection, err := app.FindCollectionByNameOrId("payment_transactions")
	if err != nil {
		t.Fatal(err)
	}
	record := core.NewRecord(collection)
	record.Load(map[string]any{
		"payment_intent": intent.Id, "chain": intent.GetString("chain"), "tx_hash": hash, "event_index": -1,
		"asset": intent.GetString("asset"), "from_address": "0x1111111111111111111111111111111111111111",
		"to_address": intent.GetString("deposit_address"), "amount_units": fmt.Sprint(amount), "block_number": block,
		"block_hash": fmt.Sprintf("0x%064x", block), "block_timestamp": timestamp, "canonical": canonical,
	})
	if err := app.Save(record); err != nil {
		t.Fatal(err)
	}
	return record
}

func newSweepTransaction(t *testing.T, app core.App, job *core.Record, block uint64) *core.Record {
	t.Helper()
	collection, err := app.FindCollectionByNameOrId("sweep_transactions")
	if err != nil {
		t.Fatal(err)
	}
	record := core.NewRecord(collection)
	record.Load(map[string]any{
		"sweep_job": job.Id, "chain": job.GetString("chain"), "kind": "sweep", "tx_hash": fmt.Sprintf("0x%064x", block),
		"raw_tx": "0x01", "from_address": "0x1111111111111111111111111111111111111111",
		"to_address": "0x2222222222222222222222222222222222222222", "amount_units": "100",
		"nonce": 0, "status": "confirmed", "block_number": block,
	})
	if err := app.Save(record); err != nil {
		t.Fatal(err)
	}
	return record
}
