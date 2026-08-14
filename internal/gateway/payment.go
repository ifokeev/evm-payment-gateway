package gateway

import (
	"errors"
	"fmt"
	"math/big"
	"strings"

	"github.com/ethereum/go-ethereum/crypto"
	"github.com/tyler-smith/go-bip32"
)

func parseAmount(value string, decimals uint8) (string, *big.Int, error) {
	value = strings.TrimSpace(value)
	parts := strings.Split(value, ".")
	if len(parts) > 2 || parts[0] == "" || !digits(parts[0]) {
		return "", nil, errors.New("amount must be a positive decimal string")
	}
	fraction := ""
	if len(parts) == 2 {
		fraction = parts[1]
		if fraction == "" || !digits(fraction) || len(fraction) > int(decimals) {
			return "", nil, fmt.Errorf("amount supports at most %d decimal places", decimals)
		}
	}
	whole := new(big.Int)
	whole.SetString(parts[0], 10)
	scale := new(big.Int).Exp(big.NewInt(10), big.NewInt(int64(decimals)), nil)
	units := new(big.Int).Mul(whole, scale)
	if fraction != "" {
		fraction += strings.Repeat("0", int(decimals)-len(fraction))
		fractionUnits := new(big.Int)
		fractionUnits.SetString(fraction, 10)
		units.Add(units, fractionUnits)
	}
	if units.Sign() <= 0 {
		return "", nil, errors.New("amount must be greater than zero")
	}
	if units.BitLen() > 256 {
		return "", nil, errors.New("amount exceeds uint256")
	}
	return formatUnits(units, decimals), units, nil
}

func digits(value string) bool {
	for _, char := range value {
		if char < '0' || char > '9' {
			return false
		}
	}
	return value != ""
}

func formatUnits(units *big.Int, decimals uint8) string {
	if decimals == 0 {
		return units.String()
	}
	digits := units.String()
	for len(digits) <= int(decimals) {
		digits = "0" + digits
	}
	cut := len(digits) - int(decimals)
	fraction := strings.TrimRight(digits[cut:], "0")
	if fraction == "" {
		return digits[:cut]
	}
	return digits[:cut] + "." + fraction
}

func deriveAddress(root *bip32.Key, index uint32) (string, error) {
	child, err := root.NewChildKey(index)
	if err != nil {
		return "", err
	}
	publicKey, err := crypto.DecompressPubkey(child.PublicKey().Key)
	if err != nil {
		return "", err
	}
	return crypto.PubkeyToAddress(*publicKey).Hex(), nil
}

func paymentURI(network Network, asset, tokenAddress, depositAddress, units string) string {
	if tokenAddress == "" {
		return fmt.Sprintf("ethereum:%s@%d?value=%s", depositAddress, network.ChainID, units)
	}
	return fmt.Sprintf("ethereum:%s@%d/transfer?address=%s&uint256=%s", tokenAddress, network.ChainID, depositAddress, units)
}

func deriveStatus(received, confirmed, expected *big.Int, expired, reorged bool) string {
	if confirmed.Cmp(expected) >= 0 {
		return "paid"
	}
	if reorged {
		return "reorged"
	}
	if received.Cmp(expected) >= 0 {
		return "confirming"
	}
	if received.Sign() > 0 {
		return "underpaid"
	}
	if expired {
		return "expired"
	}
	return "pending"
}
