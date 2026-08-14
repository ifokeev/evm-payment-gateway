package gateway

import (
	"math/big"
	"strings"
	"testing"

	"github.com/ethereum/go-ethereum/common"
	"github.com/tyler-smith/go-bip32"
)

func TestMoneyAndPaymentState(t *testing.T) {
	amount, units, err := parseAmount("0010.250000", 6)
	if err != nil || amount != "10.25" || units.String() != "10250000" {
		t.Fatalf("unexpected amount conversion: %q %v %v", amount, units, err)
	}
	if _, _, err := parseAmount("10.0000001", 6); err == nil {
		t.Fatal("accepted more precision than the token supports")
	}

	expected := big.NewInt(100)
	cases := []struct {
		received, confirmed int64
		expired, reorged    bool
		want                string
	}{
		{0, 0, false, false, "pending"},
		{0, 0, true, false, "expired"},
		{50, 0, false, false, "underpaid"},
		{100, 0, false, false, "confirming"},
		{100, 100, false, false, "paid"},
		{0, 0, false, true, "reorged"},
	}
	for _, test := range cases {
		got := deriveStatus(big.NewInt(test.received), big.NewInt(test.confirmed), expected, test.expired, test.reorged)
		if got != test.want {
			t.Fatalf("deriveStatus() = %q, want %q", got, test.want)
		}
	}
}

func TestWatchOnlyAddressesAndURI(t *testing.T) {
	master, err := bip32.NewMasterKey(bytesOf(32, 7))
	if err != nil {
		t.Fatal(err)
	}
	root := master.PublicKey()
	first, err := deriveAddress(root, 0)
	if err != nil || !common.IsHexAddress(first) {
		t.Fatalf("invalid first address: %q %v", first, err)
	}
	second, err := deriveAddress(root, 1)
	if err != nil || first == second {
		t.Fatalf("child addresses are not unique: %q %q %v", first, second, err)
	}
	network := Network{ChainID: 8453}
	uri := paymentURI(network, "USDC", "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", first, "10000000")
	if !strings.Contains(uri, "@8453/transfer") || !strings.Contains(uri, "uint256=10000000") {
		t.Fatalf("invalid EIP-681 URI: %s", uri)
	}
}

func bytesOf(size int, value byte) []byte {
	result := make([]byte, size)
	for i := range result {
		result[i] = value
	}
	return result
}
