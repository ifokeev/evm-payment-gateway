# EVM Payment Gateway

**A small, self-hosted crypto payment gateway built with Go and PocketBase.**

![Go](https://img.shields.io/badge/Go-1.26-00ADD8?style=for-the-badge&logo=go&logoColor=white)
![PocketBase](https://img.shields.io/badge/PocketBase-0.39-8996FF?style=for-the-badge)
![License](https://img.shields.io/badge/License-MIT-green?style=for-the-badge)

EVM Payment Gateway creates payment intents, returns exact amounts with EIP-681
deep links and QR codes, watches EVM chains, waits for confirmations, and sends
signed, retryable webhooks. The application that sells a product remains the
authority for granting access, credits, or subscriptions. An isolated worker
automatically consolidates confirmed deposits to configured treasury wallets.

## Features

- Base, Ethereum, and BNB Chain through configurable mainnet/testnet RPCs
- Native assets and configured ERC-20 tokens such as USDC and USDT
- Unique deposit address per intent from a watch-only xpub
- Exact atomic-unit accounting, partial/underpayment detection, and expiry
- Confirmation tracking, canonical-chain checks, and reorg events
- Persistent transaction and webhook delivery history in PocketBase
- Idempotent intent creation and webhook event IDs
- Automatic native and ERC-20 treasury sweeps with durable retries
- One Go binary with separate `serve` and `sweeper` runtime roles

## Getting started

Requirements: Docker, an EVM RPC URL, and a dedicated BIP-32 account key pair at
`m/44'/60'/0'/0`. The gateway receives the xpub; only the sweeper receives its
matching xprv.

```bash
cp .env.example .env
cp .sweeper.env.example .sweeper.env
# Configure secrets, one RPC URL, its treasury address, and its gas-wallet key.
chmod 600 .env .sweeper.env
docker compose up --build
```

Create the first PocketBase superuser in a separate process:

```bash
docker compose exec gateway ./evm-payment-gateway superuser create admin@example.com 'change-this-password' --dir=/pb_data
```

The payment API listens on `http://localhost:8090`; the PocketBase dashboard is
at `http://localhost:8090/_/`. Put both behind TLS and restrict dashboard access
before a production deployment. The reverse proxy must deny public access to
`/api/payments/v1/internal/`; only the sweeper container should reach it.

## Create a payment intent

```bash
curl -X POST http://localhost:8090/api/payments/v1/intents \
  -H "Authorization: Bearer $PAYMENT_API_KEY" \
  -H "Idempotency-Key: invoice_2026_08_account_123" \
  -H "Content-Type: application/json" \
  -d '{
    "kind": "subscription_invoice",
    "externalId": "invoice_2026_08_account_123",
    "chain": "base-sepolia",
    "asset": "USDC",
    "amount": "19.00",
    "expiresInSeconds": 1800,
    "metadata": { "accountId": "account_123" }
  }'
```

The response contains `expectedAmount`, `expectedUnits`, `depositAddress`,
`paymentUri`, `qrCodeDataUrl`, `status`, expiry, and transaction history.

Poll an intent or its transactions:

```text
GET /api/payments/v1/intents/{id}
GET /api/payments/v1/intents/{id}/transactions
GET /api/payments/v1/intents/{id}/sweep
GET /api/payments/v1/health
```

Supported states:

| Status | Meaning |
| --- | --- |
| `pending` | No on-time payment has been observed. |
| `underpaid` | On-time canonical transfers total less than the expected amount. |
| `confirming` | The amount is sufficient but confirmations are still pending. |
| `paid` | The confirmed canonical total meets or exceeds the expected amount. |
| `expired` | The intent expired without an on-time payment. |
| `reorged` | A previously paid transfer left the canonical chain. |

Late and orphaned transfers remain in transaction history but never count
toward payment. Overpayments count as paid and preserve the full received total.

## Webhooks

The gateway emits `payment.succeeded` and `payment.reorged`. Failed deliveries
retry with exponential backoff. Every retry keeps the same `Webhook-Id` and raw
JSON body.

Headers:

```text
Webhook-Id: evt_...
Webhook-Timestamp: 1786720000
Webhook-Signature: v1,<hex-hmac-sha256>
```

Verify the signature over `<timestamp>.<raw request body>` using
`PAYMENT_WEBHOOK_SECRET`, reject stale timestamps, and store `Webhook-Id` under
a unique constraint before processing. Grant a purchase only once per payment
intent ID. A `payment.reorged` event should move the purchase into the product's
own reconciliation policy rather than silently granting it again.

For manual monthly crypto subscriptions, create a new `subscription_invoice`
intent and external invoice ID each month. The gateway does not perform token
approvals or automatic withdrawals.

## Automatic sweeping

Once a payment has the configured confirmations, the gateway creates a durable
sweep job. The separate `sweeper` process does the following:

1. Derives the intent's child key and verifies it matches the deposit address.
2. For ERC-20 payments, estimates the transfer cost and sends only the missing
   ETH or BNB from a capped gas wallet.
3. Saves the signed raw transaction before broadcasting it.
4. Waits for the funding transaction, sweeps the balance to the allowlisted
   treasury, and waits for the chain's configured confirmations.
5. Reconciles receipts and balances after every restart or retry.

Native payments pay their own fee and need no gas-wallet funding. Base sweeps
also include the chain's L1 security fee using the Base GasPriceOracle upper
bound described in [Base's fee documentation](https://docs.base.org/base-chain/network-information/network-fees).
A small native residue can remain after an ERC-20 sweep because unused
gas is refunded and may itself cost more to transfer than it is worth.

To prevent gas-wallet draining through token dust, paid intents sweep
immediately while expired token underpayments sweep only when they meet
`SWEEPER_MIN_TOKEN_PAYMENT_BPS` of the invoice. Native underpayments sweep after
expiry when their balance exceeds the transfer fee. Run one sweeper replica;
horizontal scaling requires coordinated gas-wallet nonce allocation.

## Configuration

Networks and tokens live in [config/networks.json](config/networks.json). A
network is enabled only when its RPC environment variable is set. Token
addresses and decimals are configuration, so verify them against the issuer and
explorer before enabling mainnet.

The included BNB `USDT` entry is the Binance-Peg token, not a Circle-issued
asset. Base and Ethereum USDC addresses come from Circle's published contract
list; Ethereum USDT uses Tether's published ERC-20 contract.

| Environment variable | Default | Purpose |
| --- | --- | --- |
| `PAYMENT_API_KEY` | required | Server-to-server payment API key, minimum 24 characters. |
| `PAYMENT_WEBHOOK_URL` | required | Single HTTPS event destination. |
| `PAYMENT_WEBHOOK_SECRET` | required | HMAC secret, minimum 24 characters. |
| `SWEEPER_API_KEY` | required | Separate authentication secret for the internal sweeper API. |
| `DEPOSIT_XPUB` | required | Watch-only account xpub. |
| `<NETWORK>_TREASURY_ADDRESS` | required per enabled network | Allowlisted sweep destination. |
| `POLL_INTERVAL_SECONDS` | `5` | Chain polling interval. |
| `DEFAULT_EXPIRY_SECONDS` | `1800` | Default intent lifetime. |
| `PAYMENT_GRACE_SECONDS` | `60` | Block timestamp grace after expiry. |
| `REORG_HISTORY_BLOCKS` | `256` | Recent canonical block hashes retained. |
| `SWEEPER_MIN_TOKEN_PAYMENT_BPS` | `5000` | Minimum expired token payment ratio eligible for automatic recovery. |
| `SWEEPER_MAX_GAS_FUNDING_WEI` | `10000000000000000` | Maximum native top-up per sweep. |

The sweeper-only file contains:

| Environment variable | Default | Purpose |
| --- | --- | --- |
| `GATEWAY_URL` | required | Internal URL of the gateway service. |
| `DEPOSIT_XPRV` | required | Private counterpart of `DEPOSIT_XPUB`. Never give this to the gateway container. |
| `<NETWORK>_GAS_PRIVATE_KEY` | required per enabled token network | Low-balance wallet used only for ERC-20 gas top-ups. |
| `SWEEPER_POLL_INTERVAL_SECONDS` | `5` | Sweep queue polling interval. |
| `SWEEPER_GAS_BUFFER_BPS` | `12000` | Gas-limit buffer; `12000` means 120%. |

## Design boundaries

The caller supplies the exact asset amount. Fiat conversion and quote locking
belong in the commerce application or its chosen price source; this gateway
does not silently choose exchange rates.

Unique derived addresses make partial and underpayments unambiguous. The public
gateway remains watch-only; the online sweeper is deliberately isolated in a
second container with the xprv and low-balance gas keys. Signed transactions are
constrained to the configured deposit address, token, chain, and treasury by the
gateway before they are accepted into durable history. At high payment volume,
an audited payment contract may cost less operationally, but it adds
contract-call/approval UX and smart-contract audit risk.

Native transfers made as top-level wallet transactions are detected. Internal
contract calls that transfer native value require non-standard trace APIs and
are not accepted. ERC-20 transfers are detected from standard `Transfer` logs.

PocketBase is pre-1.0. Pin the version, read its upgrade notes, back up
`/pb_data`, and test migrations before upgrading.

## Development

```bash
docker run --rm -v "$PWD":/app -w /app golang:1.26.5-alpine go test ./...
docker build -t evm-payment-gateway .
```

## License

[MIT](LICENSE)
