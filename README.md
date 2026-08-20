<div align="center">

# EVM Payment Gateway

**Serverless CREATE2 crypto payments in your own Cloudflare account.**

The gateway creates exact payment intents with deterministic keyless addresses.
It waits for EVM confirmations, sends signed webhooks, and collects funds in
your treasury. You do not operate servers or manage deposit keys.

[Live testnet demo](https://evm-payment-gateway-showcase-testnet.ivan-23c.workers.dev) ·
[Quick start](#quick-start) · [How it works](#how-it-works) · [API](#api) ·
[Security](#security) · [Integration guide](INTEGRATION.md)

[![CI](https://img.shields.io/github/actions/workflow/status/ifokeev/evm-payment-gateway/ci.yml?branch=main&style=for-the-badge&label=CI)](https://github.com/ifokeev/evm-payment-gateway/actions/workflows/ci.yml)
![Cloudflare Workers](https://img.shields.io/badge/Cloudflare_Workers-F38020?style=for-the-badge&logo=cloudflare&logoColor=white)
![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?style=for-the-badge&logo=typescript&logoColor=white)
![Solidity](https://img.shields.io/badge/Solidity-363636?style=for-the-badge&logo=solidity&logoColor=white)
[![MIT license](https://img.shields.io/badge/License-MIT-2EA44F?style=for-the-badge)](LICENSE)

</div>

> [!IMPORTANT]
> The gateway detects and collects payments. Your application remains
> responsible for orders, credits, subscriptions, donations, refunds, and every
> other form of fulfillment. Recurring payments require a new manual invoice.
> The gateway never withdraws from a payer's wallet.

> [!WARNING]
> The contracts have extensive automated tests but no external audit. Use
> testnets first. Mainnet deployment requires an explicit
> `ALLOW_UNAUDITED_MAINNET=true` acknowledgement.

## Features

| Capability | Behavior |
| --- | --- |
| Exact checkout | Unique CREATE2 address, decimal amount, EIP-681 wallet link, and SVG QR code per intent. |
| Payment state | Polling, expiry, partial payments, remaining-amount top-ups, confirmations, overpayments, and transaction history. |
| Reorg recovery | Canonical block tracking reverses orphaned payments and treasury-collection accounting. Then the scanner retries. |
| Treasury collection | Immutable CREATE2 forwarders route native tokens and ERC-20 balances to one configured treasury. |
| Signed events | HMAC-SHA256 webhooks retry with stable event IDs for idempotent application handling. |
| Serverless deployment | Cloudflare Workers, D1, Queues, Cron Triggers, and service bindings. No VM or container is necessary. |
| Analytics | Exact integer totals for requested, received, confirmed, collected, fees, statuses, and webhooks. |

## Supported networks

Networks and assets are configuration, not hard-coded product behavior.

| Network | Mainnet | Testnet | Native | Included token examples |
| --- | --- | --- | --- | --- |
| Ethereum | Ethereum | Sepolia | ETH | USDC, USDT |
| Base | Base | Base Sepolia | ETH | USDC |
| BNB Chain | BNB Chain | BNB Testnet | BNB / TBNB | Binance-Peg BSC-USD on mainnet |

Validate every production token address and decimal count against issuer data.
The included BNB token example has contract symbol `USDT`, but it is the
18-decimal Binance-Peg BSC-USD token rather than issuer-native Tether USDt.

## How it works

```mermaid
flowchart LR
    App["Application backend"]
    Payer["Payer wallet"]
    Webhook["Webhook receiver"]
    Chain["EVM network"]
    Factory["Immutable factory"]
    Forwarder["CREATE2 forwarder"]
    Treasury["Treasury wallet"]

    subgraph CF["Your Cloudflare account"]
        API["API Worker"]
        DB[(D1)]
        Cron["Cron scanner"]
        Queue[[Collection queue]]
        Relayer["Private relayer Worker"]
    end

    App -->|"Create and poll intent"| API
    API <--> DB
    API -->|"Signed event"| Webhook
    Cron --> API
    API <-->|"Read canonical blocks"| Chain
    Payer -->|"Send exact amount"| Forwarder
    API --> Queue --> Relayer
    Relayer -->|"deployAndCollect"| Factory
    Factory --> Forwarder
    Forwarder -->|"Only destination"| Treasury
    Factory --> Chain
```

1. The API generates a random salt and calculates the CREATE2 address committed
   to the factory, treasury, and asset. No private key exists for this address.
2. The payer sends the exact amount to that address. Funds accumulate there
   until the configured confirmation count is reached.
3. The relayer pays gas to call `deployAndCollect`. The factory deploys the
   immutable forwarder at the predicted address and collects its full balance.
4. Native payments sent after deployment forward immediately. Another
   permissionless relayer call collects later ERC-20 payments.
5. The application receives `payment.succeeded` independently of treasury
   collection, so relayer downtime never changes payment truth.

Anyone can collect unexpected native or ERC-20 assets. The immutable treasury
remains the only destination for these assets.

The payer never interacts with the factory directly and never needs extra gas
beyond the transfer itself. The deposit address never needs ETH or BNB for an
ERC-20 collection.

```mermaid
stateDiagram-v2
    [*] --> pending
    pending --> underpaid: Partial payment
    pending --> confirming: Full amount observed
    underpaid --> confirming: Timely top-up
    pending --> expired: No timely payment
    expired --> confirming: Timely transfer found during grace
    confirming --> paid: Confirmations reached
    paid --> reorged: Transfer becomes non-canonical
    reorged --> paid: Payment reconfirmed
```

## Quick start

### Requirements

Install or obtain these requirements:

- Node.js 22+
- [Foundry](https://getfoundry.sh/introduction/installation/)
- A Cloudflare account with Workers, D1, Queues, and Cron Triggers
- An HTTPS EVM RPC endpoint
- A treasury address and a separate low-balance relayer account.

### Deploy to testnet

```bash
git clone https://github.com/ifokeev/evm-payment-gateway.git
cd evm-payment-gateway
npm ci
cp .api.secrets.example .api.testnet.secrets
cp .sweeper.secrets.example .sweeper.testnet.secrets
npx wrangler login
```

Deploy the stateless factory once on each enabled chain:

```bash
FACTORY_RPC_URL="https://your-testnet-rpc.example" \
FACTORY_DEPLOYER_PRIVATE_KEY="0x..." \
npm run deploy:factory -- testnet 84532
```

The command runs the contract suite and deploys the factory. It prints the
factory address and runtime code hash. The deployer has no special contract
permissions after deployment.

Add the factory address and runtime code hash to the API and relayer network
JSON.

Generate a separate relayer key with `cast wallet new`. Add its public address
to both network configurations. Add its private key only to
`.sweeper.testnet.secrets`. Fund the relayer with a small amount of testnet
native token. Replace the remaining placeholders. Then deploy the testnet
stack:

```bash
npm run deploy -- testnet
```

Wrangler uses isolated resource names for the two environments:

| Resource | Testnet | Mainnet |
| --- | --- | --- |
| API Worker | `evm-payment-gateway-api-testnet` | `evm-payment-gateway-api-mainnet` |
| Relayer Worker | `evm-payment-gateway-sweeper-testnet` | `evm-payment-gateway-sweeper-mainnet` |
| D1 database | `evm-payment-gateway-testnet` | `evm-payment-gateway-mainnet` |
| Scan queue | `evm-payment-gateway-scans-testnet` | `evm-payment-gateway-scans-mainnet` |
| Collection queue | `evm-payment-gateway-sweeps-testnet` | `evm-payment-gateway-sweeps-mainnet` |

Use separate RPC credentials, treasuries, relayer keys, API keys, and webhook
secrets for testnet and mainnet.

## Configuration

The API Worker receives payment and webhook secrets plus public network
configuration. The private relayer Worker receives only its network JSON and
relayer key. It never receives the payment API key or webhook secret.

```json
{
  "name": "base-sepolia",
  "chainId": 84532,
  "rpcUrls": ["https://your-primary-rpc.example", "https://your-fallback-rpc.example"],
  "treasuryAddress": "0xYourTreasury",
  "factoryAddress": "0xDeployedFactory",
  "factoryCodeHash": "0xRuntimeCodeHash",
  "relayerAddress": "0xLowBalanceRelayer",
  "confirmations": 3,
  "maxGasPriceWei": "5000000000",
  "nativeAsset": "ETH",
  "explorerUrl": "https://sepolia.basescan.org",
  "tokens": {
    "USDC": {
      "address": "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
      "decimals": 6
    }
  }
}
```

Copy only the networks you enable from
[`networks.example.json`](networks.example.json). The
`rpcUrls` field is an ordered failover list.

Keep separate lists in the testnet and mainnet Cloudflare secrets. Do not commit
provider credentials. Copy the same list to `SWEEPER_NETWORKS_JSON`. Add
`relayerPrivateKey` only to that list. The API rejects that field.

Use HTTPS for all URLs. Make sure that all configured addresses are distinct.
Make sure that the private key matches `relayerAddress`.

| Setting | Purpose |
| --- | --- |
| `DEFAULT_EXPIRY_SECONDS` | Default checkout lifetime. |
| `MAX_EXPIRY_SECONDS` | Maximum caller-selected lifetime. |
| `PAYMENT_GRACE_SECONDS` | Time after expiry in which a mined transfer still qualifies. |
| `REORG_HISTORY_BLOCKS` | Canonical block window retained for reorg recovery. |
| `SWEEPER_MIN_TOKEN_PAYMENT_BPS` | Minimum expired token underpayment that qualifies for collection. |
| `SWEEPER_GAS_BUFFER_BPS` | Buffer applied to estimated collection gas. |
| `SWEEPER_RETRY_SECONDS` | Delay between collection attempts. |

The minute scanner queues only chains with open payments or confirmed payments
still inside the configured reorg window. Chains with older history receive a
maintenance scan every 15 minutes. This schedule recovers late transfers and
limits operations on idle queues.

## API

All payment routes use `/api/payments/v1`. Only `GET /health` is public. Every
other route requires the server-side bearer key.

```bash
curl -X POST "$GATEWAY_URL/api/payments/v1/intents" \
  -H "Authorization: Bearer $PAYMENT_API_KEY" \
  -H "Idempotency-Key: payment-attempt-001" \
  -H "Content-Type: application/json" \
  -d '{
    "kind": "payment",
    "externalId": "order-001",
    "chain": "base-sepolia",
    "asset": "USDC",
    "amount": "10.25",
    "expiresInSeconds": 1800,
    "metadata": { "accountId": "account-001" }
  }'
```

`kind` is the generic settlement behavior: `payment` for a charge and `invoice`
for a payable invoice. Donations, account deposits, purchases, and subscription
periods remain application concepts stored in `externalId` or metadata.

| Method | Route | Purpose |
| --- | --- | --- |
| `POST` | `/intents` | Create or idempotently replay an intent. |
| `GET` | `/intents/{id}` | Poll state and included transactions. |
| `GET` | `/intents/{id}/transactions` | Read payment transaction history. |
| `GET` | `/intents/{id}/sweep` | Read treasury-collection history. |
| `GET` | `/analytics/summary` | Read exact aggregate payment and collection metrics. |
| `GET` | `/health` | Read scanner progress by network. |

Successful payments emit `payment.succeeded`. An orphaned success emits
`payment.reorged`. Collected expired underpayments emit the
informational `payment.recovered` event but never become paid. See the
[application integration guide](INTEGRATION.md) for webhook verification,
idempotent fulfillment, partial payments, recurring invoices, and examples.

## Demo

The optional demo Worker shows real Base Sepolia, Ethereum Sepolia, and BNB
Testnet payments with polling, signed webhook receipt, and treasury collection.
A private service binding keeps the API key out of browser code.

[Open the live testnet demo](https://evm-payment-gateway-showcase-testnet.ivan-23c.workers.dev)

```bash
cp .demo.secrets.example .demo.secrets
npm run deploy:demo
```

Create a Turnstile widget for the demo hostname. Fill the secrets file. Set the
API Worker webhook URL to the demo `/webhooks/payment` endpoint.

Dummy Turnstile keys are for local and automated tests only.

## Security

The gateway uses these security controls:

- `PaymentForwarder` has no owner, proxy, upgrade path, arbitrary destination,
  `delegatecall`, or `selfdestruct`. Treasury and asset are immutable.
- The API and relayer validate the configured factory runtime code hash. Then
  they calculate addresses or sign collection transactions.
- The treasury key never enters Cloudflare. A multisig treasury is preferable
  for real funds.
- The relayer key can spend only its own native balance. It cannot sign for a
  deposit address or redirect a forwarder. A low balance limits its exposure.
- The API rejects relayer private keys and independently validates registered
  collection transactions. The relayer Worker never receives payment or webhook
  credentials.
- Webhooks sign the exact body and timestamp, never follow redirects, and retry
  with stable event IDs.
- Token configuration is an allowlist. Trusted token contracts are the only
  permitted entries.

Before production use, read [`SECURITY.md`](SECURITY.md). This design reduces the
impact of a compromised Worker but does not make unaudited code risk-free.

## Development

```bash
npm ci
npm run check
```

`npm run check` runs Solidity formatting, unit/fuzz/invariant tests, generated
bytecode verification, Biome, TypeScript, Worker/D1 tests, and Wrangler dry-run
builds. The pre-commit hook runs the same contract checks plus staged linting.

| Command | Purpose |
| --- | --- |
| `npm run contracts:check` | Validate Solidity formatting, tests, invariants, and generated bytecode. |
| `npm run dev` | Start the API Worker locally. |
| `npm run dev:demo` | Start the demo Worker locally. |
| `npm run format` | Format supported files with Biome. |
| `npm run lint` | Lint the codebase with Biome. |
| `npm test` | Run Worker and D1 tests. |
| `npm run deploy:dry-run` | Build every Worker environment. Do not deploy. |
| `npm run deploy -- testnet` | Deploy the isolated testnet stack. |
| `npm run deploy:factory -- testnet 84532` | Test and deploy the factory on Base Sepolia. |

Before mainnet, complete a testnet payment for each enabled native or token
pair. Validate the treasury receipt and signed webhook for each payment.
Exercise RPC failure recovery. Review every configured address. Mainnet
commands require `ALLOW_UNAUDITED_MAINNET=true`.

Test Base Sepolia ETH and USDC. Test Ethereum Sepolia ETH and USDC. Test BNB
Testnet TBNB.

This matrix has no issuer-native Tether test token. Fork-test the exact Ethereum
USDT and BNB BSC-USD contracts. Before you enable either token publicly, run a
minimum-value mainnet canary.

## Contributing

Issues and pull requests are welcome. Keep changes focused. Add a regression
test for payment or security behavior. Run `npm run check`. Report
vulnerabilities through GitHub private vulnerability reporting.

## License

Released under the [MIT License](LICENSE).
