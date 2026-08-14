package gateway

import (
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestDecodeLimitedJSONRejectsBoundaryBypasses(t *testing.T) {
	tests := []struct {
		name string
		body string
		ok   bool
	}{
		{name: "valid", body: `{"value":"ok"}`, ok: true},
		{name: "unknown field", body: `{"value":"ok","extra":true}`},
		{name: "second object", body: `{"value":"ok"}{}`},
		{name: "oversized trailing data", body: `{"value":"ok"}` + strings.Repeat(" ", 256<<10) + `{}`},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			request := httptest.NewRequest("POST", "/", strings.NewReader(test.body))
			var destination struct {
				Value string `json:"value"`
			}
			err := decodeLimitedJSON(request, &destination, 256<<10)
			if test.ok && (err != nil || destination.Value != "ok") {
				t.Fatalf("valid body was rejected: value=%q err=%v", destination.Value, err)
			}
			if !test.ok && err == nil {
				t.Fatal("invalid body was accepted")
			}
		})
	}
}

func TestLoadNetworksRejectsBurnAddresses(t *testing.T) {
	path := filepath.Join(t.TempDir(), "networks.json")
	t.Setenv("NETWORKS_FILE", path)
	t.Setenv("TEST_TREASURY", "0x0000000000000000000000000000000000000000")
	writeNetworkConfig(t, path, `{}`)
	if _, err := loadNetworks(); err == nil {
		t.Fatal("zero treasury address was accepted")
	}

	t.Setenv("TEST_TREASURY", "0x1234567890123456789012345678901234567890")
	writeNetworkConfig(t, path, `{"USDC":{"address":"0x0000000000000000000000000000000000000000","decimals":6}}`)
	if _, err := loadNetworks(); err == nil {
		t.Fatal("zero token address was accepted")
	}
}

func writeNetworkConfig(t *testing.T, path, tokens string) {
	t.Helper()
	data := `{"test":{"chainId":1337,"rpcUrl":"http://127.0.0.1:8545","treasuryAddressEnv":"TEST_TREASURY","gasPrivateKeyEnv":"TEST_GAS_KEY","confirmations":1,"nativeAsset":"ETH","tokens":` + tokens + `}}`
	if err := os.WriteFile(path, []byte(data), 0o600); err != nil {
		t.Fatal(err)
	}
}
