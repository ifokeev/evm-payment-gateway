package gateway

import (
	"math/big"
	"strings"
	"testing"

	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/core/types"
	"github.com/ethereum/go-ethereum/crypto"
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
	privateKey, err := deriveChildPrivateKey(master, 0, common.HexToAddress(first))
	if err != nil || crypto.PubkeyToAddress(privateKey.PublicKey).Hex() != first {
		t.Fatalf("private child does not match watch-only address: %v", err)
	}
	network := Network{ChainID: 8453}
	uri := paymentURI(network, "USDC", "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", first, "10000000")
	if !strings.Contains(uri, "@8453/transfer") || !strings.Contains(uri, "uint256=10000000") {
		t.Fatalf("invalid EIP-681 URI: %s", uri)
	}
}

func TestSweepTransactionEncodingAndThreshold(t *testing.T) {
	treasury := common.HexToAddress("0x1234567890123456789012345678901234567890")
	amount := big.NewInt(1234567)
	to, decoded, ok := decodeTokenTransfer(encodeTokenTransfer(treasury, amount))
	if !ok || to != treasury || decoded.Cmp(amount) != 0 {
		t.Fatal("ERC-20 transfer calldata did not round trip")
	}
	if bufferedUint64(50000, 12000) != 60000 {
		t.Fatal("gas buffer calculation is incorrect")
	}
	if eligibleForSweep(true, "underpaid", big.NewInt(49), big.NewInt(100), true, 5000) {
		t.Fatal("token dust below the configured invoice ratio became sweepable")
	}
	if !eligibleForSweep(true, "underpaid", big.NewInt(50), big.NewInt(100), true, 5000) {
		t.Fatal("eligible expired token underpayment was not sweepable")
	}
	if !eligibleForSweep(false, "underpaid", big.NewInt(1), big.NewInt(100), true, 5000) {
		t.Fatal("native underpayment should fund its own sweep")
	}

	key, err := crypto.GenerateKey()
	if err != nil {
		t.Fatal(err)
	}
	transaction, raw, err := signLegacyTransaction(8453, 7, treasury, amount, 21000, big.NewInt(1_000_000), nil, key)
	if err != nil || len(raw) == 0 {
		t.Fatalf("could not sign sweep transaction: %v", err)
	}
	from, err := types.Sender(types.LatestSignerForChainID(big.NewInt(8453)), transaction)
	if err != nil || from != crypto.PubkeyToAddress(key.PublicKey) || transaction.To() == nil || *transaction.To() != treasury {
		t.Fatalf("signed transaction has the wrong sender or destination: %v", err)
	}

	token := common.HexToAddress("0x9999999999999999999999999999999999999999")
	deposit := crypto.PubkeyToAddress(key.PublicKey)
	network := Network{ChainID: 8453, TreasuryAddress: treasury.Hex()}
	tokenSweep, _, err := signLegacyTransaction(8453, 8, token, big.NewInt(0), 60000, big.NewInt(1_000_000), encodeTokenTransfer(treasury, amount), key)
	if err != nil {
		t.Fatal(err)
	}
	if _, _, validatedAmount, err := validateSignedSweepTransaction(network, deposit.Hex(), token.Hex(), big.NewInt(1e16), "sweep", tokenSweep); err != nil || validatedAmount.Cmp(amount) != 0 {
		t.Fatalf("valid token treasury sweep was rejected: %v", err)
	}
	wrongTreasurySweep, _, err := signLegacyTransaction(8453, 8, token, big.NewInt(0), 60000, big.NewInt(1_000_000), encodeTokenTransfer(common.HexToAddress("0x8888888888888888888888888888888888888888"), amount), key)
	if err != nil {
		t.Fatal(err)
	}
	if _, _, _, err := validateSignedSweepTransaction(network, deposit.Hex(), token.Hex(), big.NewInt(1e16), "sweep", wrongTreasurySweep); err == nil {
		t.Fatal("token sweep to a non-treasury address was accepted")
	}
}

func bytesOf(size int, value byte) []byte {
	result := make([]byte, size)
	for i := range result {
		result[i] = value
	}
	return result
}
