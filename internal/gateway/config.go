package gateway

import (
	"encoding/json"
	"errors"
	"fmt"
	"math/big"
	"net/url"
	"os"
	"strconv"
	"strings"

	"github.com/ethereum/go-ethereum/common"
)

type Config struct {
	APIKey              string
	DepositXPub         string
	WebhookURL          string
	WebhookSecret       string
	SweeperAPIKey       string
	SweeperMinTokenBPS  int
	SweeperMaxGasWei    *big.Int
	PollIntervalSeconds int
	DefaultExpiry       int
	MaxExpiry           int
	PaymentGrace        int
	ReorgHistoryBlocks  int
	Networks            map[string]Network
}

type Network struct {
	Name               string                 `json:"-"`
	ChainID            int64                  `json:"chainId"`
	RPCURL             string                 `json:"rpcUrl,omitempty"`
	RPCEnv             string                 `json:"rpcEnv,omitempty"`
	Confirmations      uint64                 `json:"confirmations"`
	NativeAsset        string                 `json:"nativeAsset"`
	ExplorerURL        string                 `json:"explorerUrl,omitempty"`
	TreasuryAddress    string                 `json:"-"`
	TreasuryAddressEnv string                 `json:"treasuryAddressEnv"`
	GasPrivateKeyEnv   string                 `json:"gasPrivateKeyEnv"`
	Tokens             map[string]TokenConfig `json:"tokens,omitempty"`
}

type TokenConfig struct {
	Address  string `json:"address"`
	Decimals uint8  `json:"decimals"`
}

func LoadConfig() (Config, error) {
	cfg := Config{
		APIKey:              os.Getenv("PAYMENT_API_KEY"),
		DepositXPub:         os.Getenv("DEPOSIT_XPUB"),
		WebhookURL:          os.Getenv("PAYMENT_WEBHOOK_URL"),
		WebhookSecret:       os.Getenv("PAYMENT_WEBHOOK_SECRET"),
		SweeperAPIKey:       os.Getenv("SWEEPER_API_KEY"),
		SweeperMinTokenBPS:  envInt("SWEEPER_MIN_TOKEN_PAYMENT_BPS", 5000),
		PollIntervalSeconds: envInt("POLL_INTERVAL_SECONDS", 5),
		DefaultExpiry:       envInt("DEFAULT_EXPIRY_SECONDS", 1800),
		MaxExpiry:           envInt("MAX_EXPIRY_SECONDS", 86400),
		PaymentGrace:        envInt("PAYMENT_GRACE_SECONDS", 60),
		ReorgHistoryBlocks:  envInt("REORG_HISTORY_BLOCKS", 256),
	}
	if len(cfg.APIKey) < 24 || len(cfg.WebhookSecret) < 24 || len(cfg.SweeperAPIKey) < 24 {
		return cfg, errors.New("PAYMENT_API_KEY, PAYMENT_WEBHOOK_SECRET, and SWEEPER_API_KEY must be at least 24 characters")
	}
	maxGasWei, err := envBigInt("SWEEPER_MAX_GAS_FUNDING_WEI", "10000000000000000")
	if err != nil {
		return cfg, err
	}
	cfg.SweeperMaxGasWei = maxGasWei
	if !strings.HasPrefix(cfg.DepositXPub, "xpub") {
		return cfg, errors.New("DEPOSIT_XPUB must be a watch-only xpub")
	}
	if parsed, err := url.ParseRequestURI(cfg.WebhookURL); err != nil || (parsed.Scheme != "http" && parsed.Scheme != "https") || parsed.Host == "" {
		return cfg, errors.New("PAYMENT_WEBHOOK_URL must be an absolute http(s) URL")
	}
	if cfg.PollIntervalSeconds < 1 || cfg.DefaultExpiry < 300 || cfg.MaxExpiry < cfg.DefaultExpiry || cfg.PaymentGrace < 0 || cfg.ReorgHistoryBlocks < 32 || cfg.SweeperMinTokenBPS < 1 || cfg.SweeperMinTokenBPS > 10000 {
		return cfg, errors.New("invalid polling or expiry settings")
	}

	cfg.Networks, err = loadNetworks()
	if err != nil {
		return cfg, err
	}
	return cfg, nil
}

func loadNetworks() (map[string]Network, error) {
	file := os.Getenv("NETWORKS_FILE")
	if file == "" {
		file = "config/networks.json"
	}
	data, err := os.ReadFile(file)
	if err != nil {
		return nil, fmt.Errorf("read networks config: %w", err)
	}
	var networks map[string]Network
	if err := json.Unmarshal(data, &networks); err != nil {
		return nil, fmt.Errorf("parse networks config: %w", err)
	}
	enabled := make(map[string]Network)
	for name, network := range networks {
		if network.RPCURL == "" && network.RPCEnv != "" {
			network.RPCURL = os.Getenv(network.RPCEnv)
		}
		if network.RPCURL == "" {
			continue
		}
		if network.ChainID < 1 || network.Confirmations < 1 || network.NativeAsset == "" {
			return nil, fmt.Errorf("invalid network %q", name)
		}
		network.Name = name
		network.NativeAsset = strings.ToUpper(network.NativeAsset)
		network.ExplorerURL = strings.TrimSuffix(network.ExplorerURL, "/")
		network.TreasuryAddress = os.Getenv(network.TreasuryAddressEnv)
		if !common.IsHexAddress(network.TreasuryAddress) {
			return nil, fmt.Errorf("invalid or missing treasury address for %s (%s)", name, network.TreasuryAddressEnv)
		}
		network.TreasuryAddress = common.HexToAddress(network.TreasuryAddress).Hex()
		cleanTokens := make(map[string]TokenConfig, len(network.Tokens))
		for symbol, token := range network.Tokens {
			if !common.IsHexAddress(token.Address) {
				return nil, fmt.Errorf("invalid token address for %s/%s", name, symbol)
			}
			token.Address = common.HexToAddress(token.Address).Hex()
			cleanTokens[strings.ToUpper(symbol)] = token
		}
		network.Tokens = cleanTokens
		enabled[name] = network
	}
	if len(enabled) == 0 {
		return nil, errors.New("no networks enabled; set at least one configured RPC environment variable")
	}
	return enabled, nil
}

func envInt(name string, fallback int) int {
	raw := os.Getenv(name)
	if raw == "" {
		return fallback
	}
	value, err := strconv.Atoi(raw)
	if err != nil {
		return -1
	}
	return value
}

func envString(name, fallback string) string {
	if value := os.Getenv(name); value != "" {
		return value
	}
	return fallback
}

func envBigInt(name, fallback string) (*big.Int, error) {
	value, ok := new(big.Int).SetString(envString(name, fallback), 10)
	if !ok || value.Sign() <= 0 {
		return nil, fmt.Errorf("%s must be a positive integer", name)
	}
	return value, nil
}
