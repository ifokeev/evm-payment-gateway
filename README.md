# Cloudflare-native EVM payment gateway

The gateway uses two Cloudflare Workers, D1, Queues, and a one-minute Cron
trigger. There is no VM, container, persistent disk, or polling daemon to
operate.

The public Worker creates and polls payment intents, monitors canonical EVM
blocks, stores history in D1, and signs webhooks. It has only the watch-only
xpub. The private queue Worker has the xprv and gas-wallet keys; after a payment
is confirmed, it transfers the complete deposit balance to that network's
configured `treasuryAddress` (your main wallet).

## Deploy

Requirements: Node.js 22+, Cloudflare Workers Paid, an EVM RPC URL, and a
dedicated BIP-32 account xpub/xprv pair at `m/44'/60'/0'/0`. D1 and Queues have
free allowances, but the Free plan's 10 ms Worker CPU limit is too small for a
meaningful scanner-and-sweeper test.

```bash
npm ci
cp .api.secrets.example .api.secrets
cp .sweeper.secrets.example .sweeper.secrets
# Edit both files. Keep the API and sweeper files separate.
npx wrangler login
npm run deploy
```

`npm run deploy` deploys the public Worker first, lets Wrangler provision D1
and the Queue, applies D1 migrations, and then deploys the isolated sweeper.
The API URL is printed by Wrangler. Re-running the same command upgrades the
deployment without creating new stateful resources.

Use `wrangler dev --config wrangler.api.jsonc --env-file .api.secrets` for local
API development. The `secrets.required` allowlists ensure that payment API and
webhook credentials are never injected into the sweeper Worker.

## Treasury flow

Each intent receives a unique child deposit address. After the configured
confirmations:

1. Native ETH/BNB deposits pay their own transfer fee and are swept to
   `treasuryAddress`. Gas is estimated, so a contract treasury such as a Safe is
   supported.
2. USDC/USDT deposits receive only the missing ETH/BNB from the low-balance gas
   wallet, then the entire token balance is swept to `treasuryAddress`.
3. The API validates every signed raw sweep against the chain, token, deposit
   address, treasury, and cumulative gas-funding cap before retaining it.

Use a separate treasury per chain if desired. The same address can also be used
on all EVM networks. Never use the gas wallet as the treasury.

## Configuration

Both Workers receive a JSON network list because their secrets must remain
isolated. The non-key fields must match exactly. A network object is:

```json
{
  "name": "base-sepolia",
  "chainId": 84532,
  "rpcUrl": "https://your-private-rpc",
  "treasuryAddress": "0xYourMainWallet",
  "confirmations": 3,
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

The sweeper copy adds `gasPrivateKey` only on networks with configured tokens.
That key should control a deliberately low-balance wallet. Native-only networks
do not need it. `networks.example.json` contains presets for Ethereum, Base, and
BNB Chain mainnets/testnets; replace every RPC URL and treasury address, delete
unused networks, then minify it into `NETWORKS_JSON`. Verify token contracts
against their issuers before using mainnet.

The API contract remains `/api/payments/v1`: create an intent with `POST
/intents`, poll with `GET /intents/{id}`, inspect `/transactions` and `/sweep`,
and use `/health` for scanner state. Crypto subscriptions remain manual monthly
`subscription_invoice` intents; the gateway never pulls funds automatically.

Create a Base Sepolia native-token test intent with the URL printed by
Wrangler:

```bash
curl -X POST "$GATEWAY_URL/api/payments/v1/intents" \
  -H "Authorization: Bearer $PAYMENT_API_KEY" \
  -H "Idempotency-Key: smoke-test-001" \
  -H "Content-Type: application/json" \
  -d '{
    "kind": "credit_pack",
    "externalId": "smoke-test-001",
    "chain": "base-sepolia",
    "asset": "ETH",
    "amount": "0.0001",
    "expiresInSeconds": 1800,
    "metadata": { "accountId": "test-account" }
  }'
```

Pay the returned `paymentUri` or QR code, then poll
`GET /api/payments/v1/intents/{id}` with the same bearer token.

## Deploy button

Cloudflare's deploy button currently requires a public GitHub/GitLab repository
and deploys only one Worker from a multi-Worker repository. This repository is
private and the signer must remain a separate Worker, so a button would be
incomplete today. Add it when the project becomes public and Cloudflare supports
multi-Worker deploy buttons; until then `npm run deploy` is the complete path.

## Verify

```bash
npm run check
```

Tests execute in Cloudflare's `workerd` runtime with a real local D1 database.

## Test on Cloudflare

Start on Base Sepolia with disposable keys and no real funds. You need:

- a Cloudflare login or scoped API token;
- a Base Sepolia RPC URL;
- a dedicated test xpub/xprv pair;
- a test treasury address;
- a low-balance gas-wallet key plus test ETH for USDC sweeps;
- a staging webhook URL and two random secrets for API and webhook signing.

Put only the public values in `.api.secrets`; put the xprv and gas-wallet key in
`.sweeper.secrets`. Then run `npm run deploy`. Wrangler provisions the D1
database and Queue, applies the schema, and deploys both Workers.

For the first end-to-end run, create a small native-ETH intent, pay it, and
verify `pending -> confirming -> paid`, one signed webhook, and a completed
sweep into the treasury. Repeat with test USDC to exercise automatic gas
funding, then check underpayment and expiry. Reorg behavior stays in the local
deterministic suite because a public testnet reorg cannot be safely forced.
