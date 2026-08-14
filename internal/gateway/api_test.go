package gateway

import (
	"bytes"
	"crypto/ecdsa"
	"encoding/hex"
	"encoding/json"
	"math/big"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/crypto"
	"github.com/pocketbase/dbx"
	"github.com/pocketbase/pocketbase/apis"
	"github.com/pocketbase/pocketbase/core"
)

func TestSweepTransactionAPIEnforcesFundingLimitAndIdempotency(t *testing.T) {
	app := newTestApp(t)
	network := Network{Name: "test", ChainID: 1337, TreasuryAddress: "0x2222222222222222222222222222222222222222"}
	service := &Service{
		app: app,
		config: Config{
			SweeperAPIKey: "test-sweeper-key-at-least-24-characters", SweeperMaxGasWei: big.NewInt(100),
			Networks: map[string]Network{"test": network},
		},
		chains: map[string]*chainRuntime{"test": {config: network}},
	}
	router, err := apis.NewRouter(app)
	if err != nil {
		t.Fatal(err)
	}
	service.RegisterRoutes(router)
	mux, err := router.BuildMux()
	if err != nil {
		t.Fatal(err)
	}
	key, err := crypto.GenerateKey()
	if err != nil {
		t.Fatal(err)
	}

	tokenIntent := newTestIntent(t, app, 40)
	tokenIntent.Set("token_address", "0x9999999999999999999999999999999999999999")
	if err := app.Save(tokenIntent); err != nil {
		t.Fatal(err)
	}
	tokenJob := processingSweepJob(t, app, tokenIntent, "worker-1")
	first := signedRaw(t, key, tokenIntent.GetString("deposit_address"), 0, 60)
	second := signedRaw(t, key, tokenIntent.GetString("deposit_address"), 1, 40)
	if status := postSweepTransaction(t, mux, service.config.SweeperAPIKey, tokenJob.Id, "worker-1", first); status != http.StatusCreated {
		t.Fatalf("first gas funding status = %d, want 201", status)
	}
	if status := postSweepTransaction(t, mux, service.config.SweeperAPIKey, tokenJob.Id, "worker-1", first); status != http.StatusOK {
		t.Fatalf("idempotent gas funding replay status = %d, want 200", status)
	}
	if status := postSweepTransaction(t, mux, service.config.SweeperAPIKey, tokenJob.Id, "worker-1", second); status != http.StatusCreated {
		t.Fatalf("exact-limit gas funding status = %d, want 201", status)
	}
	overLimit := signedRaw(t, key, tokenIntent.GetString("deposit_address"), 2, 1)
	if status := postSweepTransaction(t, mux, service.config.SweeperAPIKey, tokenJob.Id, "worker-1", overLimit); status != http.StatusBadRequest {
		t.Fatalf("over-limit gas funding status = %d, want 400", status)
	}
	records, err := app.FindRecordsByFilter("sweep_transactions", "sweep_job = {:id}", "", 0, 0, dbx.Params{"id": tokenJob.Id})
	if err != nil || len(records) != 2 {
		t.Fatalf("stored gas transaction count = %d, want 2: %v", len(records), err)
	}

	nativeIntent := newTestIntent(t, app, 41)
	nativeJob := processingSweepJob(t, app, nativeIntent, "worker-2")
	nativeFunding := signedRaw(t, key, nativeIntent.GetString("deposit_address"), 3, 1)
	if status := postSweepTransaction(t, mux, service.config.SweeperAPIKey, nativeJob.Id, "worker-2", nativeFunding); status != http.StatusBadRequest {
		t.Fatalf("native-deposit gas funding status = %d, want 400", status)
	}
}

func processingSweepJob(t *testing.T, app core.App, intent *core.Record, owner string) *core.Record {
	t.Helper()
	if err := syncSweepJob(app, intent, "100", true); err != nil {
		t.Fatal(err)
	}
	job, err := app.FindFirstRecordByData("sweep_jobs", "payment_intent", intent.Id)
	if err != nil {
		t.Fatal(err)
	}
	job.Set("status", "processing")
	job.Set("lock_owner", owner)
	job.Set("locked_until", time.Now().Add(time.Minute).Unix())
	if err := app.Save(job); err != nil {
		t.Fatal(err)
	}
	return job
}

func signedRaw(t *testing.T, key *ecdsa.PrivateKey, destination string, nonce uint64, amount int64) []byte {
	t.Helper()
	_, raw, err := signLegacyTransaction(1337, nonce, common.HexToAddress(destination), big.NewInt(amount), 21000, big.NewInt(1), nil, key)
	if err != nil {
		t.Fatal(err)
	}
	return raw
}

func postSweepTransaction(t *testing.T, handler http.Handler, apiKey, jobID, owner string, raw []byte) int {
	t.Helper()
	body, _ := json.Marshal(map[string]any{"kind": "gas", "rawTransaction": "0x" + hex.EncodeToString(raw)})
	request := httptest.NewRequest(http.MethodPost, "/api/payments/v1/internal/sweeps/"+jobID+"/transactions", bytes.NewReader(body))
	request.Header.Set("Authorization", "Bearer "+apiKey)
	request.Header.Set("Sweeper-Id", owner)
	request.Header.Set("Content-Type", "application/json")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	return response.Code
}
