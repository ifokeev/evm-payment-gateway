package gateway

import (
	"errors"
	"testing"

	"github.com/ethereum/go-ethereum/common/hexutil"
	"github.com/ethereum/go-ethereum/ethclient"
	"github.com/ethereum/go-ethereum/rpc"
	"github.com/tyler-smith/go-bip32"
)

func TestCreateIntentIsAtomicAndIdempotent(t *testing.T) {
	app := newTestApp(t)
	rpcServer := rpc.NewServer()
	if err := rpcServer.RegisterName("eth", testEthAPI{block: 123}); err != nil {
		t.Fatal(err)
	}
	rpcClient := rpc.DialInProc(rpcServer)
	client := ethclient.NewClient(rpcClient)
	t.Cleanup(func() {
		client.Close()
		rpcServer.Stop()
	})
	master, err := bip32.NewMasterKey(bytesOf(32, 9))
	if err != nil {
		t.Fatal(err)
	}
	network := Network{Name: "test", ChainID: 1337, Confirmations: 2, NativeAsset: "ETH"}
	service := &Service{
		app: app, root: master.PublicKey(), config: Config{DefaultExpiry: 1800, MaxExpiry: 86400},
		chains: map[string]*chainRuntime{"test": {config: network, client: client}},
	}
	request := createRequest{Kind: "credit_pack", ExternalID: "order-1", Chain: "test", Asset: "eth", Amount: "0010.250000"}
	first, created, err := service.createIntent(t.Context(), "same-key", request)
	if err != nil || !created {
		t.Fatalf("first intent was not created: created=%v err=%v", created, err)
	}
	if first.GetString("expected_amount") != "10.25" || first.GetString("expected_units") != "10250000000000000000" || first.GetInt("start_block") != 123 {
		t.Fatalf("intent was not normalized correctly: amount=%s units=%s block=%d", first.GetString("expected_amount"), first.GetString("expected_units"), first.GetInt("start_block"))
	}

	repeated := request
	repeated.Amount = "10.25"
	second, created, err := service.createIntent(t.Context(), "same-key", repeated)
	if err != nil || created || second.Id != first.Id {
		t.Fatalf("idempotent replay created a second intent: created=%v err=%v", created, err)
	}
	repeated.Amount = "10.26"
	if _, _, err := service.createIntent(t.Context(), "same-key", repeated); !errors.Is(err, errIdempotencyConflict) {
		t.Fatalf("changed idempotent request was not rejected: %v", err)
	}

	type result struct {
		recordID string
		created  bool
		err      error
	}
	results := make(chan result, 8)
	concurrent := request
	concurrent.ExternalID = "order-concurrent"
	for range 8 {
		go func() {
			record, created, err := service.createIntent(t.Context(), "concurrent-key", concurrent)
			id := ""
			if record != nil {
				id = record.Id
			}
			results <- result{recordID: id, created: created, err: err}
		}()
	}
	createdCount := 0
	concurrentID := ""
	for range 8 {
		result := <-results
		if result.err != nil {
			t.Fatalf("concurrent idempotent request failed: %v", result.err)
		}
		if result.created {
			createdCount++
		}
		if concurrentID == "" {
			concurrentID = result.recordID
		} else if result.recordID != concurrentID {
			t.Fatalf("concurrent idempotent requests returned different intents: %s and %s", concurrentID, result.recordID)
		}
	}
	if createdCount != 1 {
		t.Fatalf("concurrent idempotent request was created %d times", createdCount)
	}

	request.ExternalID = "order-2"
	third, created, err := service.createIntent(t.Context(), "other-key", request)
	if err != nil || !created || third.GetString("deposit_address") == first.GetString("deposit_address") || third.GetInt("derivation_index") != 2 {
		t.Fatalf("second intent did not receive the next address: created=%v index=%d err=%v", created, third.GetInt("derivation_index"), err)
	}
	counter, err := app.FindFirstRecordByData("gateway_state", "key", "next_derivation_index")
	if err != nil || counter.GetInt("value") != 3 {
		t.Fatalf("derivation counter = %d, want 3: %v", counter.GetInt("value"), err)
	}
}

type testEthAPI struct{ block uint64 }

func (api testEthAPI) BlockNumber() hexutil.Uint64 { return hexutil.Uint64(api.block) }
