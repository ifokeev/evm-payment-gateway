# Cloudflare-native EVM payment gateway

The gateway uses two Cloudflare Workers, D1, Queues, and a one-minute Cron
trigger. There is no VM, container, persistent disk, or polling daemon to
operate.

The public Worker creates and polls payment intents, monitors canonical EVM
blocks, stores history in D1, allocates Turnkey wallet accounts, and signs
webhooks. The private queue Worker asks Turnkey to sign policy-approved sweeps;
the deposit seed and deposit private keys never enter Cloudflare. After a
payment is confirmed, it transfers the complete deposit balance to that
network's configured `treasuryAddress` (your main wallet).

See the [application integration guide](INTEGRATION.md) for backend checkout,
status polling, signed webhooks, idempotent fulfillment, reorg handling, and
monthly subscription invoices.

## Deploy

Requirements: Node.js 22+, Cloudflare Workers Paid, an EVM RPC URL, and a
Turnkey organization with one dedicated HD wallet. D1 and Queues have free
allowances, but the Free plan's 10 ms Worker CPU limit is too small for a
meaningful scanner-and-sweeper test.

Before deployment, create two different non-root Turnkey API credentials:

1. An address allocator used only by the API Worker.
2. A transaction signer used only by the sweeper Worker.

Install the policies in [`turnkey/policies.example.json`](turnkey/policies.example.json)
before placing either credential in Cloudflare. Replace every placeholder and
duplicate the native policy per network and the token policy per configured
token. Keep policy administration, wallet export, and root quorum restricted to
human-controlled passkeys; neither Worker credential may be a root credential.

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
webhook credentials are never injected into the sweeper Worker. The two files
must contain different Turnkey API key pairs.

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

## Production key management

Turnkey generates the BIP-32 `secp256k1` deposit wallet and derives one account
at `m/44'/60'/0'/0/{index}` per intent. The API Worker can allocate accounts but
cannot sign. The sweeper can request Ethereum transaction signatures but cannot
create credentials, change policies, or export the wallet. Every returned raw
transaction is independently decoded and validated by the API Worker before it
is stored or broadcast.

Cloudflare still holds extractable Turnkey API credentials, so Turnkey policies
are mandatory: they must restrict signing to configured chain IDs, treasury
addresses, token contracts, ERC-20 `transfer` calldata, gas limits, and
`maxGasPriceWei`. A compromised Worker can then request only the same constrained
sweeps it was intended to request.

For production:

- Send every sweep to a Safe or other multisig treasury. Never give the Worker
  treasury owner keys.
- Use a separate, deliberately low-balance gas wallet per chain. The normal
  gateway flow funds only confirmed deposit addresses and enforces the
  cumulative cap, but a compromised sweeper can drain the gas wallet directly.
- Keep Turnkey recovery material and API credential backups in 1Password with
  restricted human access. Do not store or fetch an exported deposit seed from
  1Password at runtime.
- Sweep frequently, monitor failed jobs and gas-wallet balances, and keep the
  configured cumulative gas-funding cap small.

1Password is a suitable backup and operational vault, but not an EVM HSM/MPC
signer. Its non-extractable SSH agent does not sign EVM transactions. See the
[Turnkey signing API](https://docs.turnkey.com/api-reference/activities/sign-transaction),
[Turnkey EVM policy examples](https://docs.turnkey.com/features/policies/examples/ethereum),
and [Cloudflare secret documentation](https://developers.cloudflare.com/workers/configuration/secrets/)
for the relevant security boundaries.

Do not upgrade an installation with funded legacy xprv-derived addresses until
those addresses are drained or the original mnemonic has been imported into
Turnkey and every derived address has been verified. New installations should
let Turnkey generate a new wallet and should never export it.

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

All RPC and explorer URLs, and `PAYMENT_WEBHOOK_URL`, must use HTTPS. The API
Worker's `NETWORKS_JSON` must never contain `gasPrivateKey`; the sweeper copy
adds it only on networks with configured tokens. That key should control a
deliberately low-balance wallet. Native-only networks do not need it.
`maxGasPriceWei` is a hard signing and validation ceiling; choose a chain-specific
operational maximum and use the same value in the matching Turnkey policies.
`networks.example.json` contains presets for Ethereum, Base, and BNB Chain
mainnets/testnets; replace every RPC URL and treasury address, delete unused
networks, then minify it into `NETWORKS_JSON`. Verify token contracts against
their issuers before using mainnet.

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
- a dedicated Turnkey test wallet;
- separate non-root allocator and signer API credentials with the example
  policies installed;
- a test treasury address;
- a low-balance gas-wallet key plus test ETH for USDC sweeps;
- a staging webhook URL and two random secrets for API and webhook signing.

Put the allocator credential in `.api.secrets`; put the signer credential and
gas-wallet key in `.sweeper.secrets`. Then run `npm run deploy`. Wrangler
provisions the D1 database and Queue, applies the schema, and deploys both
Workers. The Turnkey wallet seed is not placed in either file.

For the first end-to-end run, create a small native-ETH intent, pay it, and
verify `pending -> confirming -> paid`, one signed webhook, and a completed
sweep into the treasury. Repeat with test USDC to exercise automatic gas
funding, then check underpayment and expiry. Reorg behavior stays in the local
deterministic suite because a public testnet reorg cannot be safely forced.
