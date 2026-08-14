package gateway

import (
	"errors"
	"math"
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
		{100, 0, false, true, "reorged"},
		{0, 0, false, true, "reorged"},
	}
	for _, test := range cases {
		got := deriveStatus(big.NewInt(test.received), big.NewInt(test.confirmed), expected, test.expired, test.reorged)
		if got != test.want {
			t.Fatalf("deriveStatus() = %q, want %q", got, test.want)
		}
	}
}

func TestAmountBoundaries(t *testing.T) {
	maxUint256 := new(big.Int).Sub(new(big.Int).Lsh(big.NewInt(1), 256), big.NewInt(1))
	if amount, units, err := parseAmount(maxUint256.String(), 0); err != nil || amount != maxUint256.String() || units.Cmp(maxUint256) != 0 {
		t.Fatalf("maximum uint256 amount was rejected: %q %v %v", amount, units, err)
	}
	tooLarge := new(big.Int).Add(maxUint256, big.NewInt(1))
	if _, _, err := parseAmount(tooLarge.String(), 0); err == nil {
		t.Fatal("amount above uint256 was accepted")
	}

	invalid := []string{"", "0", "-1", ".1", "1.", "1e3", "+1", "1..0"}
	for _, value := range invalid {
		if _, _, err := parseAmount(value, 6); err == nil {
			t.Fatalf("invalid amount %q was accepted", value)
		}
	}
	if amount, units, err := parseAmount(" 000.000001 ", 6); err != nil || amount != "0.000001" || units.Cmp(big.NewInt(1)) != 0 {
		t.Fatalf("smallest token unit did not round trip: %q %v %v", amount, units, err)
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
	dirtyAddressData := encodeTokenTransfer(treasury, amount)
	dirtyAddressData[4] = 1
	dirtyAddressSweep, _, err := signLegacyTransaction(8453, 9, token, big.NewInt(0), 60000, big.NewInt(1_000_000), dirtyAddressData, key)
	if err != nil {
		t.Fatal(err)
	}
	if _, _, _, err := validateSignedSweepTransaction(network, deposit.Hex(), token.Hex(), big.NewInt(1e16), "sweep", dirtyAddressSweep); err == nil {
		t.Fatal("non-canonical ERC-20 address calldata was accepted")
	}

	contractSweep, _, err := signLegacyTransaction(8453, 10, treasury, amount, 75000, big.NewInt(1_000_000), nil, key)
	if err != nil {
		t.Fatal(err)
	}
	if _, _, _, err := validateSignedSweepTransaction(network, deposit.Hex(), "", big.NewInt(1e16), "sweep", contractSweep); err != nil {
		t.Fatalf("buffered native contract-wallet sweep was rejected: %v", err)
	}
	oversizedSweep, _, err := signLegacyTransaction(8453, 11, treasury, amount, maxNativeSweepGas+1, big.NewInt(1_000_000), nil, key)
	if err != nil {
		t.Fatal(err)
	}
	if _, _, _, err := validateSignedSweepTransaction(network, deposit.Hex(), "", big.NewInt(1e16), "sweep", oversizedSweep); err == nil {
		t.Fatal("native sweep above the gas safety ceiling was accepted")
	}
}

func TestSweepRetryAndFundingLimits(t *testing.T) {
	historical := zeroBalanceOutcome(false)
	if !historical.External || historical.Complete {
		t.Fatal("historical zero balance was not classified as externally swept")
	}
	confirmed := zeroBalanceOutcome(true)
	if !confirmed.Complete || confirmed.External {
		t.Fatal("confirmed zero balance was not completed")
	}
	feeSpike := nativeFeeOutcome(false, big.NewInt(100))
	if feeSpike.Complete || feeSpike.External || feeSpike.DelaySeconds == 0 {
		t.Fatal("initial native balance was stranded during a transient fee spike")
	}
	postSweepDust := nativeFeeOutcome(true, big.NewInt(100))
	if !postSweepDust.Complete {
		t.Fatal("post-sweep native dust was not completed")
	}

	used, err := gasFundingUsed([]sweepTransactionPayload{
		{Kind: "gas", Status: "confirmed", AmountUnits: "40"},
		{Kind: "gas", Status: "submitted", AmountUnits: "30"},
		{Kind: "gas", Status: "failed", AmountUnits: "1000"},
		{Kind: "sweep", Status: "confirmed", AmountUnits: "500"},
	})
	if err != nil || used.Cmp(big.NewInt(70)) != 0 {
		t.Fatalf("cumulative gas funding is wrong: %v %v", used, err)
	}
	if requiresGasKey(Network{}) {
		t.Fatal("native-only network unexpectedly requires a gas key")
	}
	if !requiresGasKey(Network{Tokens: map[string]TokenConfig{"USDC": {}}}) {
		t.Fatal("token network did not require a gas key")
	}
	if _, err := gasFundingUsed([]sweepTransactionPayload{{Kind: "gas", Status: "prepared", AmountUnits: "0"}}); err == nil {
		t.Fatal("zero gas funding history was accepted")
	}
	if _, err := gasFundingUsed([]sweepTransactionPayload{{Kind: "gas", Status: "submitted", AmountUnits: "not-a-number"}}); err == nil {
		t.Fatal("malformed gas funding history was accepted")
	}
	if bufferedUint64(math.MaxUint64, 20000) != math.MaxUint64 {
		t.Fatal("gas buffering overflowed instead of saturating")
	}
	if !knownTransactionError(errors.New("already known")) || !knownTransactionError(errors.New("known transaction: 0x1234")) {
		t.Fatal("known transaction errors were not recognized")
	}
	if knownTransactionError(errors.New("unknown transaction type")) {
		t.Fatal("unknown transaction error was mistaken for an idempotent broadcast")
	}
}

func FuzzParseAmountRoundTrip(f *testing.F) {
	for _, seed := range []string{"1", "0.000001", "0010.250000", "-1", "1e18", strings.Repeat("9", 78)} {
		f.Add(seed, uint8(6))
	}
	f.Fuzz(func(t *testing.T, value string, decimals uint8) {
		normalized, units, err := parseAmount(value, decimals)
		if err != nil {
			return
		}
		if units.Sign() <= 0 || units.BitLen() > 256 {
			t.Fatalf("accepted units outside uint256: %s", units)
		}
		reparsed, reparsedUnits, err := parseAmount(normalized, decimals)
		if err != nil || reparsed != normalized || reparsedUnits.Cmp(units) != 0 {
			t.Fatalf("normalized amount did not round trip: %q -> %q/%s: %v", normalized, reparsed, reparsedUnits, err)
		}
	})
}

func FuzzDecodeTokenTransferCanonical(f *testing.F) {
	treasury := common.HexToAddress("0x1234567890123456789012345678901234567890")
	f.Add(encodeTokenTransfer(treasury, big.NewInt(123)))
	f.Add([]byte{})
	f.Add(bytesOf(68, 1))
	f.Fuzz(func(t *testing.T, data []byte) {
		to, amount, ok := decodeTokenTransfer(data)
		if !ok {
			return
		}
		if len(data) != 68 {
			t.Fatal("accepted malformed token calldata")
		}
		if string(encodeTokenTransfer(to, amount)) != string(data) {
			t.Fatal("accepted non-canonical token calldata")
		}
	})
}

func bytesOf(size int, value byte) []byte {
	result := make([]byte, size)
	for i := range result {
		result[i] = value
	}
	return result
}
