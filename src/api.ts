import { WorkerEntrypoint } from "cloudflare:workers";
import { renderSVG } from "uqr";
import {
  createPublicClient,
  decodeFunctionData,
  encodeFunctionData,
  erc20Abi,
  getAddress,
  http,
  isAddressEqual,
  keccak256,
  parseTransaction,
  recoverTransactionAddress,
  type Address,
  type Hex,
  type TransactionSerialized,
} from "viem";
import {
  formatUnits,
  intSetting,
  loadNetworks,
  parseAmount,
  paymentUri,
  remainingGasFunding,
  stableStringify,
} from "./domain";
import { all, errorText, randomId, runScheduled, safeErrorText, unixNow } from "./monitor";
import { allocateTurnkeyAddress } from "./turnkey";
import type {
  ApiEnv,
  IntentRow,
  NetworkConfig,
  PaymentTransactionRow,
  SweepJob,
  SweepOutcome,
  SweepTransaction,
} from "./types";

const API_ROOT = "/api/payments/v1";
const MAX_NATIVE_SWEEP_GAS = 1_000_000n;
const MAX_TOKEN_SWEEP_GAS = 500_000n;

export default {
  async fetch(request: Request, env: ApiEnv): Promise<Response> {
    try {
      return await route(request, env);
    } catch (error) {
      if (error instanceof HttpError) return json({ error: error.message }, error.status);
      console.error("request failed", safeErrorText(error));
      return json({ error: "internal server error" }, 500);
    }
  },
  async scheduled(_controller: ScheduledController, env: ApiEnv, context: ExecutionContext): Promise<void> {
    context.waitUntil(runScheduled(env));
  },
};

async function route(request: Request, env: ApiEnv): Promise<Response> {
  const url = new URL(request.url);
  if (request.method === "GET" && url.pathname === `${API_ROOT}/health`) return health(env);
  if (!(await authorized(request, env.PAYMENT_API_KEY))) throw new HttpError(401, "invalid API key");

  if (request.method === "POST" && url.pathname === `${API_ROOT}/intents`) return createIntent(request, env);
  const match = url.pathname.match(/^\/api\/payments\/v1\/intents\/([A-Za-z0-9_-]+)(?:\/(transactions|sweep))?$/);
  if (!match || request.method !== "GET") throw new HttpError(404, "not found");
  const intent = await env.DB.prepare("SELECT * FROM payment_intents WHERE id = ?").bind(match[1]).first<IntentRow>();
  if (!intent) throw new HttpError(404, "payment intent not found");
  const networks = loadNetworks(env.NETWORKS_JSON);
  const network = networks.get(intent.chain);
  if (!network) throw new Error(`network ${intent.chain} is no longer configured`);
  if (match[2] === "transactions") return json({ items: await transactionResponses(env, intent, network) });
  if (match[2] === "sweep") return json(await publicSweepResponse(env, intent, network));
  return json(await intentResponse(env, intent, network));
}

async function health(env: ApiEnv): Promise<Response> {
  const networks = loadNetworks(env.NETWORKS_JSON);
  const states = await all<{ chain: string; last_scanned: number }>(env.DB, "SELECT chain, last_scanned FROM chain_states");
  const scanned = new Map(states.map((state) => [state.chain, state.last_scanned]));
  return json({
    ok: true,
    time: new Date().toISOString(),
    networks: Object.fromEntries([...networks.keys()].map((name) => [name, { lastScannedBlock: scanned.get(name) ?? null }])),
  });
}

async function createIntent(request: Request, env: ApiEnv): Promise<Response> {
  if (env.PAYMENT_API_KEY.length < 24) throw new Error("PAYMENT_API_KEY must be at least 24 characters");
  const idempotencyKey = request.headers.get("Idempotency-Key")?.trim() ?? "";
  if (!idempotencyKey || idempotencyKey.length > 200) throw new HttpError(400, "Idempotency-Key is required and must be at most 200 characters");
  const body = await readObject(request, ["kind", "externalId", "chain", "asset", "amount", "expiresInSeconds", "metadata"]);
  const kind = requiredString(body, "kind");
  const externalId = requiredString(body, "externalId").trim();
  const chainName = requiredString(body, "chain").trim();
  const asset = requiredString(body, "asset").trim().toUpperCase();
  const rawAmount = requiredString(body, "amount");
  if (kind !== "credit_pack" && kind !== "subscription_invoice") throw new HttpError(400, "kind must be credit_pack or subscription_invoice");
  if (!externalId || externalId.length > 200) throw new HttpError(400, "externalId is required and must be at most 200 characters");
  if (rawAmount.trim().length > 100) throw new HttpError(400, "amount must be at most 100 characters");

  const networks = loadNetworks(env.NETWORKS_JSON);
  const network = networks.get(chainName);
  if (!network) throw new HttpError(400, "unsupported chain");
  const token = asset === network.nativeAsset ? undefined : network.tokens[asset];
  if (asset !== network.nativeAsset && !token) throw new HttpError(400, "unsupported asset for chain");
  let parsedAmount: ReturnType<typeof parseAmount>;
  try {
    parsedAmount = parseAmount(rawAmount, token?.decimals ?? 18);
  } catch (error) {
    throw new HttpError(400, errorText(error));
  }
  const defaultExpiry = intSetting(env.DEFAULT_EXPIRY_SECONDS, "DEFAULT_EXPIRY_SECONDS", 300, 86_400);
  const maxExpiry = intSetting(env.MAX_EXPIRY_SECONDS, "MAX_EXPIRY_SECONDS", defaultExpiry, 604_800);
  const expiresIn = body.expiresInSeconds === undefined ? defaultExpiry : body.expiresInSeconds;
  if (!Number.isInteger(expiresIn) || (expiresIn as number) < 300 || (expiresIn as number) > maxExpiry) {
    throw new HttpError(400, `expiresInSeconds must be between 300 and ${maxExpiry}`);
  }
  const metadata = body.metadata ?? {};
  if (!isObject(metadata)) throw new HttpError(400, "metadata must be an object");
  const metadataJson = stableStringify(metadata);
  if (new TextEncoder().encode(metadataJson).length > 65_536) throw new HttpError(400, "metadata is too large");
  const normalized = {
    kind,
    externalId,
    chain: chainName,
    asset,
    amount: parsedAmount.amount,
    expiresInSeconds: expiresIn,
    metadata,
  };
  const requestHash = await sha256(stableStringify(normalized));
  const existing = await env.DB.prepare("SELECT * FROM payment_intents WHERE idempotency_key = ?").bind(idempotencyKey).first<IntentRow>();
  if (existing) {
    if (existing.request_hash !== requestHash) throw new HttpError(409, "idempotency key was already used with a different request");
    return json(await intentResponse(env, existing, network));
  }

  const client = createPublicClient({ transport: http(network.rpcUrl, { timeout: 15_000 }) });
  let latest: bigint;
  try {
    const [chainId, block] = await Promise.all([client.getChainId(), client.getBlockNumber()]);
    if (chainId !== network.chainId) throw new Error("RPC chain ID mismatch");
    latest = block;
  } catch {
    throw new HttpError(503, "network RPC unavailable");
  }
  const counter = await env.DB.prepare(`UPDATE gateway_state SET value = value + 1 WHERE key = 'next_derivation_index'
    RETURNING value - 1 AS derivation_index`).first<{ derivation_index: number }>();
  if (!counter) throw new Error("derivation counter is missing");
  let depositAddress: Address;
  try {
    depositAddress = await allocateTurnkeyAddress(env, counter.derivation_index);
  } catch (error) {
    console.error("Turnkey address allocation failed", safeErrorText(error));
    throw new HttpError(503, "deposit signer unavailable");
  }
  const now = unixNow();
  const intent: IntentRow = {
    id: randomId("pi"),
    idempotency_key: idempotencyKey,
    request_hash: requestHash,
    kind,
    external_id: externalId,
    chain: chainName,
    chain_id: network.chainId,
    asset,
    token_address: token?.address ?? "",
    decimals: token?.decimals ?? 18,
    expected_amount: parsedAmount.amount,
    expected_units: parsedAmount.units.toString(),
    received_units: "0",
    confirmed_units: "0",
    deposit_address: depositAddress,
    derivation_index: counter.derivation_index,
    start_block: Number(latest),
    confirmations: network.confirmations,
    status: "pending",
    expires_at: now + (expiresIn as number),
    metadata: metadataJson,
    created_at: now,
    updated_at: now,
  };
  try {
    await env.DB.prepare(`INSERT INTO payment_intents
      (id, idempotency_key, request_hash, kind, external_id, chain, chain_id, asset, token_address, decimals,
       expected_amount, expected_units, received_units, confirmed_units, deposit_address, derivation_index,
       start_block, confirmations, status, expires_at, metadata, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '0', '0', ?, ?, ?, ?, 'pending', ?, ?, ?, ?)`)
      .bind(intent.id, idempotencyKey, requestHash, kind, externalId, chainName, network.chainId, asset,
        intent.token_address, intent.decimals, intent.expected_amount, intent.expected_units, depositAddress,
        intent.derivation_index, intent.start_block, intent.confirmations, intent.expires_at, metadataJson, now, now).run();
  } catch (error) {
    const winner = await env.DB.prepare("SELECT * FROM payment_intents WHERE idempotency_key = ?").bind(idempotencyKey).first<IntentRow>();
    if (!winner) throw error;
    if (winner.request_hash !== requestHash) throw new HttpError(409, "idempotency key was already used with a different request");
    return json(await intentResponse(env, winner, network));
  }
  return json(await intentResponse(env, intent, network), 201);
}

async function intentResponse(env: ApiEnv, intent: IntentRow, network: NetworkConfig): Promise<Record<string, unknown>> {
  const expectedUnits = BigInt(intent.expected_units);
  const receivedUnits = BigInt(intent.received_units);
  const remainingUnits = expectedUnits > receivedUnits ? expectedUnits - receivedUnits : 0n;
  const expired = unixNow() > intent.expires_at;
  const uri = paymentUri(network, intent.token_address, intent.deposit_address, intent.expected_units);
  const svg = renderSVG(uri, { ecc: "M", pixelSize: 4, border: 4 });
  const qrCodeDataUrl = `data:image/svg+xml;base64,${btoa(svg)}`;
  const canTopUp = !expired && remainingUnits > 0n && (intent.status === "pending" || intent.status === "underpaid");
  const topUpPaymentUri = canTopUp
    ? paymentUri(network, intent.token_address, intent.deposit_address, remainingUnits.toString())
    : null;
  const topUpQrCodeDataUrl = !topUpPaymentUri ? null : topUpPaymentUri === uri
    ? qrCodeDataUrl
    : `data:image/svg+xml;base64,${btoa(renderSVG(topUpPaymentUri, { ecc: "M", pixelSize: 4, border: 4 }))}`;
  return {
    id: intent.id,
    kind: intent.kind,
    externalId: intent.external_id,
    chain: intent.chain,
    chainId: intent.chain_id,
    asset: intent.asset,
    expectedAmount: intent.expected_amount,
    expectedUnits: intent.expected_units,
    receivedAmount: formatUnits(receivedUnits, intent.decimals),
    confirmedAmount: formatUnits(BigInt(intent.confirmed_units), intent.decimals),
    remainingAmount: formatUnits(remainingUnits, intent.decimals),
    remainingUnits: remainingUnits.toString(),
    depositAddress: intent.deposit_address,
    paymentUri: uri,
    qrCodeDataUrl,
    topUpPaymentUri,
    topUpQrCodeDataUrl,
    requiredConfirmations: intent.confirmations,
    status: intent.status,
    expiresAt: new Date(intent.expires_at * 1_000).toISOString(),
    expired,
    metadata: JSON.parse(intent.metadata),
    transactions: await transactionResponses(env, intent, network),
    createdAt: new Date(intent.created_at * 1_000).toISOString(),
    updatedAt: new Date(intent.updated_at * 1_000).toISOString(),
  };
}

async function transactionResponses(env: ApiEnv, intent: IntentRow, network: NetworkConfig): Promise<Record<string, unknown>[]> {
  const transactions = await all<PaymentTransactionRow>(env.DB,
    "SELECT * FROM payment_transactions WHERE payment_intent = ? ORDER BY block_number, event_index LIMIT 10000", intent.id);
  const state = await env.DB.prepare("SELECT last_scanned FROM chain_states WHERE chain = ?").bind(intent.chain).first<{ last_scanned: number }>();
  const grace = intSetting(env.PAYMENT_GRACE_SECONDS, "PAYMENT_GRACE_SECONDS", 0, 86_400);
  return transactions.map((transaction) => {
    const confirmations = transaction.canonical && state && state.last_scanned >= transaction.block_number
      ? state.last_scanned - transaction.block_number + 1 : 0;
    return {
      hash: transaction.tx_hash,
      eventIndex: transaction.event_index,
      asset: transaction.asset,
      from: transaction.from_address,
      to: transaction.to_address,
      amountUnits: transaction.amount_units,
      blockNumber: transaction.block_number,
      blockHash: transaction.block_hash,
      confirmations,
      canonical: Boolean(transaction.canonical),
      confirmed: confirmations >= intent.confirmations,
      late: transaction.block_timestamp > intent.expires_at + grace,
      ...(network.explorerUrl ? { explorerUrl: `${network.explorerUrl}/tx/${transaction.tx_hash}` } : {}),
    };
  });
}

async function publicSweepResponse(env: ApiEnv, intent: IntentRow, network: NetworkConfig): Promise<Record<string, unknown>> {
  const job = await env.DB.prepare("SELECT * FROM sweep_jobs WHERE payment_intent = ?").bind(intent.id).first<{
    id: string; status: string; observed_units: string; remaining_units: string; last_error: string; completed_at: number | null;
  }>();
  if (!job) return { status: "not_queued", transactions: [] };
  const transactions = await sweepTransactions(env.DB, job.id, network, false);
  return {
    status: job.status,
    observedUnits: job.observed_units,
    remainingUnits: job.remaining_units,
    lastError: job.last_error,
    completedAt: job.completed_at ? new Date(job.completed_at * 1_000).toISOString() : null,
    transactions,
  };
}

export class SweepCoordinator extends WorkerEntrypoint<ApiEnv> {
  async claimSweep(jobId: string, owner: string): Promise<SweepJob | null> {
    validateLeaseInput(jobId, owner);
    const now = unixNow();
    const job = await this.env.DB.prepare(`UPDATE sweep_jobs SET status = 'processing', lock_owner = ?, locked_until = ?, updated_at = ?
      WHERE id = ? AND next_attempt_at <= ? AND (status = 'queued' OR (status = 'processing' AND (locked_until <= ? OR lock_owner = ?)))
      RETURNING *`).bind(owner, now + 300, now, jobId, now, now, owner).first<{
        id: string; payment_intent: string; chain: string; observed_units: string; status: string; attempts: number;
      }>();
    if (!job) return null;
    const intent = await this.env.DB.prepare("SELECT * FROM payment_intents WHERE id = ?").bind(job.payment_intent).first<IntentRow>();
    if (!intent) throw new Error("payment intent is missing");
    const network = loadNetworks(this.env.NETWORKS_JSON).get(job.chain);
    if (!network) throw new Error(`network ${job.chain} is not configured`);
    return {
      id: job.id,
      chain: job.chain,
      chainId: network.chainId,
      asset: intent.asset,
      tokenAddress: intent.token_address,
      depositAddress: intent.deposit_address,
      derivationIndex: intent.derivation_index,
      treasuryAddress: network.treasuryAddress,
      confirmations: network.confirmations,
      maxGasPriceWei: network.maxGasPriceWei.toString(),
      observedUnits: job.observed_units,
      status: job.status,
      attempts: job.attempts,
      transactions: await sweepTransactions(this.env.DB, job.id, network, true),
    };
  }

  async registerSweepTransaction(jobId: string, owner: string, kind: "gas" | "sweep", rawTransaction: Hex): Promise<SweepTransaction> {
    validateLeaseInput(jobId, owner);
    if (kind !== "gas" && kind !== "sweep") throw new Error("kind must be gas or sweep");
    if (!/^0x[0-9a-fA-F]+$/.test(rawTransaction) || rawTransaction.length > 262_146) throw new Error("invalid raw transaction");
    const locked = await this.lockedJob(jobId, owner);
    const networks = loadNetworks(this.env.NETWORKS_JSON);
    const network = networks.get(locked.chain);
    if (!network) throw new Error(`network ${locked.chain} is not configured`);
    const transaction = parseTransaction(rawTransaction);
    const hash = keccak256(rawTransaction);
    const existing = await this.env.DB.prepare("SELECT * FROM sweep_transactions WHERE chain = ? AND tx_hash = ?")
      .bind(network.name, hash).first<SweepTransactionRow>();
    if (existing) {
      if (existing.sweep_job !== jobId || existing.kind !== kind) throw new Error("transaction already belongs to another sweep");
      return sweepTransactionResponse(existing, network, true);
    }
    if (transaction.type !== "legacy" || transaction.chainId !== network.chainId || !transaction.to || transaction.nonce === undefined
      || transaction.gas === undefined || transaction.gasPrice === undefined || transaction.gasPrice <= 0n
      || transaction.gasPrice > network.maxGasPriceWei) {
      throw new Error("transaction chain or destination mismatch");
    }
    const from = await recoverTransactionAddress({ serializedTransaction: rawTransaction as TransactionSerialized });
    const data = transaction.data ?? "0x";
    const value = transaction.value ?? 0n;
    let amount: bigint;
    if (kind === "gas") {
      const maxFunding = BigInt(this.env.SWEEPER_MAX_GAS_FUNDING_WEI);
      if (!locked.token_address || !isAddressEqual(transaction.to, locked.deposit_address) || data !== "0x" || transaction.gas !== 21_000n || value <= 0n || value > maxFunding) {
        throw new Error("invalid gas funding transaction");
      }
      const prior = await all<{ amount_units: string }>(this.env.DB,
        "SELECT amount_units FROM sweep_transactions WHERE sweep_job = ? AND kind = 'gas' AND status != 'failed'", jobId);
      remainingGasFunding(maxFunding, prior.map((item) => item.amount_units), value);
      amount = value;
    } else {
      if (!isAddressEqual(from, locked.deposit_address)) throw new Error("sweep must be signed by the deposit address");
      if (!locked.token_address) {
        if (!isAddressEqual(transaction.to, network.treasuryAddress) || data !== "0x" || transaction.gas < 21_000n || transaction.gas > MAX_NATIVE_SWEEP_GAS || value <= 0n) {
          throw new Error("invalid native sweep transaction");
        }
        amount = value;
      } else {
        let decoded: ReturnType<typeof decodeFunctionData>;
        try {
          decoded = decodeFunctionData({ abi: erc20Abi, data });
        } catch {
          throw new Error("invalid token sweep transaction");
        }
        if (decoded.functionName !== "transfer" || decoded.args.length !== 2) throw new Error("invalid token sweep transaction");
        const [recipient, tokenAmount] = decoded.args as readonly [Address, bigint];
        const canonicalData = encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [recipient, tokenAmount] });
        if (!isAddressEqual(transaction.to, locked.token_address) || value !== 0n || transaction.gas < 21_000n
          || transaction.gas > MAX_TOKEN_SWEEP_GAS || data.toLowerCase() !== canonicalData.toLowerCase()
          || !isAddressEqual(recipient, network.treasuryAddress) || tokenAmount <= 0n) throw new Error("invalid token sweep transaction");
        amount = tokenAmount;
      }
    }
    const now = unixNow();
    const row: SweepTransactionRow = {
      id: randomId("stx"),
      sweep_job: jobId,
      chain: network.name,
      kind,
      tx_hash: hash,
      raw_tx: rawTransaction,
      from_address: from,
      to_address: getAddress(transaction.to),
      amount_units: amount.toString(),
      nonce: transaction.nonce,
      status: "prepared",
      block_number: null,
      last_error: "",
      created_at: now,
      updated_at: now,
    };
    await this.env.DB.prepare(`INSERT INTO sweep_transactions
      (id, sweep_job, chain, kind, tx_hash, raw_tx, from_address, to_address, amount_units, nonce, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'prepared', ?, ?)`)
      .bind(row.id, row.sweep_job, row.chain, row.kind, row.tx_hash, row.raw_tx, row.from_address, row.to_address,
        row.amount_units, row.nonce, row.created_at, row.updated_at).run();
    return sweepTransactionResponse(row, network, true);
  }

  async reportSweepTransaction(
    id: string,
    owner: string,
    status: "submitted" | "confirmed" | "failed",
    blockNumber: number,
    error: string,
  ): Promise<void> {
    if (!id || id.length > 80 || !owner || owner.length > 80) throw new Error("invalid transaction lease");
    if (!Number.isSafeInteger(blockNumber) || blockNumber < 0 || !["submitted", "confirmed", "failed"].includes(status)) throw new Error("invalid transaction result");
    const row = await this.env.DB.prepare("SELECT sweep_job, status FROM sweep_transactions WHERE id = ?").bind(id)
      .first<{ sweep_job: string; status: string }>();
    if (!row) throw new Error("sweep transaction not found");
    await this.lockedJob(row.sweep_job, owner);
    if (row.status === "confirmed" && status !== "confirmed") throw new Error("confirmed transaction cannot be downgraded");
    await this.env.DB.prepare("UPDATE sweep_transactions SET status = ?, block_number = ?, last_error = ?, updated_at = ? WHERE id = ?")
      .bind(status, blockNumber || null, error.slice(0, 1_000), unixNow(), id).run();
  }

  async releaseSweep(jobId: string, owner: string, outcome: SweepOutcome): Promise<{ delaySeconds: number }> {
    validateLeaseInput(jobId, owner);
    await this.lockedJob(jobId, owner);
    if (!["queued", "complete", "external"].includes(outcome.status)) throw new Error("invalid sweep status");
    let remaining: bigint;
    try {
      remaining = BigInt(outcome.remainingUnits);
    } catch {
      throw new Error("remainingUnits must be a non-negative integer");
    }
    if (remaining < 0n) throw new Error("remainingUnits must be a non-negative integer");
    const now = unixNow();
    const job = await this.env.DB.prepare("SELECT attempts FROM sweep_jobs WHERE id = ?").bind(jobId).first<{ attempts: number }>();
    if (!job) throw new Error("sweep job not found");
    const attempts = outcome.error ? job.attempts + 1 : job.attempts;
    const delay = outcome.status === "queued"
      ? outcome.error ? Math.min(300, 2 ** Math.min(attempts, 8)) : Math.max(1, Math.min(outcome.delaySeconds, 300))
      : 0;
    const result = await this.env.DB.prepare(`UPDATE sweep_jobs SET status = ?, remaining_units = ?, attempts = ?, next_attempt_at = ?,
      last_error = ?, lock_owner = '', locked_until = 0, completed_at = ?, updated_at = ? WHERE id = ? AND status = 'processing' AND lock_owner = ?`)
      .bind(outcome.status, remaining.toString(), attempts, now + delay, outcome.error.slice(0, 1_000),
        outcome.status === "queued" ? null : now, now, jobId, owner).run();
    if (!result.meta.changes) throw new Error("sweep lease is not held");
    return { delaySeconds: delay };
  }

  private async lockedJob(jobId: string, owner: string): Promise<{
    id: string; chain: string; payment_intent: string; token_address: Address | ""; deposit_address: Address;
  }> {
    const row = await this.env.DB.prepare(`SELECT j.id, j.chain, j.payment_intent, i.token_address, i.deposit_address
      FROM sweep_jobs j JOIN payment_intents i ON i.id = j.payment_intent
      WHERE j.id = ? AND j.status = 'processing' AND j.lock_owner = ? AND j.locked_until >= ?`)
      .bind(jobId, owner, unixNow()).first<{
        id: string; chain: string; payment_intent: string; token_address: Address | ""; deposit_address: Address;
      }>();
    if (!row) throw new Error("sweep lease is not held");
    return row;
  }
}

type SweepTransactionRow = {
  id: string;
  sweep_job: string;
  chain: string;
  kind: "gas" | "sweep";
  tx_hash: Hex;
  raw_tx: Hex;
  from_address: Address;
  to_address: Address;
  amount_units: string;
  nonce: number;
  status: "prepared" | "submitted" | "confirmed" | "failed";
  block_number: number | null;
  last_error: string;
  created_at: number;
  updated_at: number;
};

async function sweepTransactions(db: D1Database, jobId: string, network: NetworkConfig, includeRaw: boolean): Promise<SweepTransaction[]> {
  const rows = await all<SweepTransactionRow>(db, "SELECT * FROM sweep_transactions WHERE sweep_job = ? ORDER BY created_at", jobId);
  return rows.map((row) => sweepTransactionResponse(row, network, includeRaw));
}

function sweepTransactionResponse(row: SweepTransactionRow, network: NetworkConfig, includeRaw: boolean): SweepTransaction {
  return {
    id: row.id,
    kind: row.kind,
    hash: row.tx_hash,
    rawTransaction: includeRaw ? row.raw_tx : "0x",
    from: row.from_address,
    to: row.to_address,
    amountUnits: row.amount_units,
    nonce: row.nonce,
    status: row.status,
    ...(row.block_number ? { blockNumber: row.block_number } : {}),
    ...(row.last_error ? { lastError: row.last_error } : {}),
    ...(network.explorerUrl ? { explorerUrl: `${network.explorerUrl}/tx/${row.tx_hash}` } : {}),
    createdAt: new Date(row.created_at * 1_000).toISOString(),
  };
}

async function authorized(request: Request, expected: string): Promise<boolean> {
  const authorization = request.headers.get("Authorization") ?? "";
  if (!authorization.startsWith("Bearer ") || expected.length < 24) return false;
  const supplied = authorization.slice(7);
  const [left, right] = await Promise.all([crypto.subtle.digest("SHA-256", new TextEncoder().encode(supplied)), crypto.subtle.digest("SHA-256", new TextEncoder().encode(expected))]);
  const a = new Uint8Array(left);
  const b = new Uint8Array(right);
  let difference = supplied.length ^ expected.length;
  for (let index = 0; index < a.length; index++) difference |= a[index] ^ b[index];
  return difference === 0;
}

async function readObject(request: Request, allowedKeys: string[]): Promise<Record<string, unknown>> {
  const contentType = request.headers.get("Content-Type")?.split(";", 1)[0].trim().toLowerCase();
  if (contentType !== "application/json") throw new HttpError(415, "Content-Type must be application/json");
  const text = await request.text();
  if (new TextEncoder().encode(text).length > 65_536) throw new HttpError(413, "request body is too large");
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new HttpError(400, "invalid JSON body");
  }
  if (!isObject(value) || Object.keys(value).some((key) => !allowedKeys.includes(key))) throw new HttpError(400, "invalid JSON body");
  return value;
}

function requiredString(object: Record<string, unknown>, key: string): string {
  if (typeof object[key] !== "string") throw new HttpError(400, `${key} is required`);
  return object[key];
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function validateLeaseInput(jobId: string, owner: string): void {
  if (!jobId || jobId.length > 80 || !owner || owner.length > 80) throw new Error("invalid sweep lease");
}

function json(value: unknown, status = 200): Response {
  return Response.json(value, { status, headers: { "Cache-Control": "no-store" } });
}

class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}
