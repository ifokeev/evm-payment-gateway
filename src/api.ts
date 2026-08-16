import { WorkerEntrypoint } from "cloudflare:workers";
import { renderSVG } from "uqr";
import {
  type Address,
  createPublicClient,
  getAddress,
  type Hex,
  isAddressEqual,
  keccak256,
  parseTransaction,
  recoverTransactionAddress,
  type TransactionSerialized,
} from "viem";
import { collectionCall, counterfactualAddress, newIntentSalt } from "./create2";
import {
  formatUnits,
  intSetting,
  loadNetworks,
  parseAmount,
  paymentUri,
  stableStringify,
} from "./domain";
import { all, errorText, randomId, runScheduled, safeErrorText, unixNow } from "./monitor";
import { rpcTransport } from "./rpc";
import type {
  ApiEnv,
  IntentRow,
  NetworkConfig,
  PaymentStatus,
  PaymentTransactionRow,
  SweepJob,
  SweepOutcome,
  SweepTransaction,
} from "./types";

const API_ROOT = "/api/payments/v1";
const MAX_COLLECTION_GAS = 1_000_000n;

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
  async scheduled(
    _controller: ScheduledController,
    env: ApiEnv,
    context: ExecutionContext,
  ): Promise<void> {
    context.waitUntil(runScheduled(env));
  },
};

async function route(request: Request, env: ApiEnv): Promise<Response> {
  const url = new URL(request.url);
  if (request.method === "GET" && url.pathname === `${API_ROOT}/health`) return health(env);
  if (!(await authorized(request, env.PAYMENT_API_KEY)))
    throw new HttpError(401, "invalid API key");

  if (request.method === "POST" && url.pathname === `${API_ROOT}/intents`)
    return createIntent(request, env);
  if (request.method === "GET" && url.pathname === `${API_ROOT}/analytics/summary`)
    return json(await analyticsSummary(env));
  const match = url.pathname.match(
    /^\/api\/payments\/v1\/intents\/([A-Za-z0-9_-]+)(?:\/(transactions|sweep))?$/,
  );
  if (!match || request.method !== "GET") throw new HttpError(404, "not found");
  const intent = await env.DB.prepare("SELECT * FROM payment_intents WHERE id = ?")
    .bind(match[1])
    .first<IntentRow>();
  if (!intent) throw new HttpError(404, "payment intent not found");
  const networks = loadNetworks(env.NETWORKS_JSON);
  const network = networks.get(intent.chain);
  if (!network) throw new Error(`network ${intent.chain} is no longer configured`);
  if (match[2] === "transactions")
    return json({ items: await transactionResponses(env, intent, network) });
  if (match[2] === "sweep") return json(await publicSweepResponse(env, intent, network));
  return json(await intentResponse(env, intent, network));
}

async function health(env: ApiEnv): Promise<Response> {
  const networks = loadNetworks(env.NETWORKS_JSON);
  const states = await all<{ chain: string; last_scanned: number }>(
    env.DB,
    "SELECT chain, last_scanned FROM chain_states",
  );
  const scanned = new Map(states.map((state) => [state.chain, state.last_scanned]));
  return json({
    ok: true,
    time: new Date().toISOString(),
    networks: Object.fromEntries(
      [...networks.keys()].map((name) => [name, { lastScannedBlock: scanned.get(name) ?? null }]),
    ),
  });
}

async function analyticsSummary(env: ApiEnv): Promise<Record<string, unknown>> {
  type Bucket = {
    chain: string;
    asset: string;
    intents: number;
    statuses: Record<string, number>;
    requested: bigint;
    received: bigint;
    confirmed: bigint;
    collected: bigint;
    overpaid: number;
    expired: number;
  };
  const buckets = new Map<string, Bucket>();
  const bucket = (chain: string, asset: string): Bucket => {
    const key = `${chain}\0${asset}`;
    let value = buckets.get(key);
    if (!value) {
      value = {
        chain,
        asset,
        intents: 0,
        statuses: {},
        requested: 0n,
        received: 0n,
        confirmed: 0n,
        collected: 0n,
        overpaid: 0,
        expired: 0,
      };
      buckets.set(key, value);
    }
    return value;
  };
  let cursor = "";
  for (;;) {
    const rows = await all<{
      id: string;
      chain: string;
      asset: string;
      status: string;
      expected_units: string;
      received_units: string;
      confirmed_units: string;
      expires_at: number;
    }>(
      env.DB,
      `SELECT id, chain, asset, status, expected_units, received_units, confirmed_units, expires_at
      FROM payment_intents WHERE id > ? ORDER BY id LIMIT 1000`,
      cursor,
    );
    for (const row of rows) {
      const value = bucket(row.chain, row.asset);
      const requested = BigInt(row.expected_units);
      const received = BigInt(row.received_units);
      value.intents++;
      value.statuses[row.status] = (value.statuses[row.status] ?? 0) + 1;
      value.requested += requested;
      value.received += received;
      value.confirmed += BigInt(row.confirmed_units);
      if (received > requested) value.overpaid++;
      if (row.expires_at < unixNow()) value.expired++;
    }
    if (rows.length < 1000) break;
    cursor = rows[rows.length - 1].id;
  }

  cursor = "";
  for (;;) {
    const rows = await all<{
      id: string;
      chain: string;
      asset: string;
      collected_units: string;
    }>(
      env.DB,
      `SELECT j.id, i.chain, i.asset, j.collected_units FROM sweep_jobs j
      JOIN payment_intents i ON i.id = j.payment_intent WHERE j.id > ? ORDER BY j.id LIMIT 1000`,
      cursor,
    );
    for (const row of rows) bucket(row.chain, row.asset).collected += BigInt(row.collected_units);
    if (rows.length < 1000) break;
    cursor = rows[rows.length - 1].id;
  }

  const feesByChain: Record<string, bigint> = {};
  cursor = "";
  for (;;) {
    const rows = await all<{ id: string; chain: string; fee_wei: string }>(
      env.DB,
      "SELECT id, chain, fee_wei FROM sweep_transactions WHERE id > ? ORDER BY id LIMIT 1000",
      cursor,
    );
    for (const row of rows)
      feesByChain[row.chain] = (feesByChain[row.chain] ?? 0n) + BigInt(row.fee_wei);
    if (rows.length < 1000) break;
    cursor = rows[rows.length - 1].id;
  }

  const webhookRows = await all<{ type: string; status: string; count: number }>(
    env.DB,
    "SELECT type, status, COUNT(*) AS count FROM webhook_events GROUP BY type, status",
  );
  return {
    generatedAt: new Date().toISOString(),
    assets: [...buckets.values()]
      .sort((left, right) =>
        `${left.chain}/${left.asset}`.localeCompare(`${right.chain}/${right.asset}`),
      )
      .map((value) => ({
        chain: value.chain,
        asset: value.asset,
        intents: value.intents,
        statuses: value.statuses,
        requestedUnits: value.requested.toString(),
        receivedUnits: value.received.toString(),
        confirmedUnits: value.confirmed.toString(),
        collectedUnits: value.collected.toString(),
        overpaidIntents: value.overpaid,
        expiredIntents: value.expired,
      })),
    collectionFeesWei: Object.fromEntries(
      Object.entries(feesByChain).map(([chain, amount]) => [chain, amount.toString()]),
    ),
    webhooks: webhookRows,
  };
}

async function createIntent(request: Request, env: ApiEnv): Promise<Response> {
  if (env.PAYMENT_API_KEY.length < 24)
    throw new Error("PAYMENT_API_KEY must be at least 24 characters");
  const idempotencyKey = request.headers.get("Idempotency-Key")?.trim() ?? "";
  if (!idempotencyKey || idempotencyKey.length > 200)
    throw new HttpError(400, "Idempotency-Key is required and must be at most 200 characters");
  const body = await readObject(request, [
    "kind",
    "externalId",
    "chain",
    "asset",
    "amount",
    "expiresInSeconds",
    "metadata",
  ]);
  const kind = requiredString(body, "kind").trim();
  const externalId = requiredString(body, "externalId").trim();
  const chainName = requiredString(body, "chain").trim();
  const asset = requiredString(body, "asset").trim().toUpperCase();
  const rawAmount = requiredString(body, "amount");
  if (kind !== "payment" && kind !== "invoice")
    throw new HttpError(400, "kind must be payment or invoice");
  if (!externalId || externalId.length > 200)
    throw new HttpError(400, "externalId is required and must be at most 200 characters");
  if (rawAmount.trim().length > 100)
    throw new HttpError(400, "amount must be at most 100 characters");

  const networks = loadNetworks(env.NETWORKS_JSON);
  const network = networks.get(chainName);
  if (!network) throw new HttpError(400, "unsupported chain");
  const token = asset === network.nativeAsset ? undefined : network.tokens[asset];
  if (asset !== network.nativeAsset && !token)
    throw new HttpError(400, "unsupported asset for chain");
  let parsedAmount: ReturnType<typeof parseAmount>;
  try {
    parsedAmount = parseAmount(rawAmount, token?.decimals ?? 18);
  } catch (error) {
    throw new HttpError(400, errorText(error));
  }
  const defaultExpiry = intSetting(
    env.DEFAULT_EXPIRY_SECONDS,
    "DEFAULT_EXPIRY_SECONDS",
    300,
    86_400,
  );
  const maxExpiry = intSetting(
    env.MAX_EXPIRY_SECONDS,
    "MAX_EXPIRY_SECONDS",
    defaultExpiry,
    604_800,
  );
  const expiresIn = body.expiresInSeconds === undefined ? defaultExpiry : body.expiresInSeconds;
  if (
    !Number.isInteger(expiresIn) ||
    (expiresIn as number) < 300 ||
    (expiresIn as number) > maxExpiry
  ) {
    throw new HttpError(400, `expiresInSeconds must be between 300 and ${maxExpiry}`);
  }
  const metadata = body.metadata ?? {};
  if (!isObject(metadata)) throw new HttpError(400, "metadata must be an object");
  if (isTooDeep(metadata, 32)) throw new HttpError(400, "metadata is too deeply nested");
  const metadataJson = stableStringify(metadata);
  if (new TextEncoder().encode(metadataJson).length > 65_536)
    throw new HttpError(400, "metadata is too large");
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
  const existing = await env.DB.prepare("SELECT * FROM payment_intents WHERE idempotency_key = ?")
    .bind(idempotencyKey)
    .first<IntentRow>();
  if (existing) {
    if (existing.request_hash !== requestHash)
      throw new HttpError(409, "idempotency key was already used with a different request");
    return json(await intentResponse(env, existing, network));
  }

  const client = createPublicClient({
    transport: rpcTransport(network.rpcUrls, { timeout: 15_000 }),
  });
  let latest: bigint;
  try {
    const [chainId, block, factoryCode] = await Promise.all([
      client.getChainId(),
      client.getBlockNumber(),
      client.getCode({ address: network.factoryAddress }),
    ]);
    if (chainId !== network.chainId) throw new Error("RPC chain ID mismatch");
    if (!factoryCode || keccak256(factoryCode).toLowerCase() !== network.factoryCodeHash)
      throw new Error("factory code hash mismatch");
    latest = block;
  } catch {
    throw new HttpError(503, "network RPC or factory unavailable");
  }
  const intentSalt = newIntentSalt();
  const { address: depositAddress, initCodeHash } = counterfactualAddress(
    network.factoryAddress,
    intentSalt,
    network.treasuryAddress,
    token?.address ?? "",
  );
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
    intent_salt: intentSalt,
    factory_address: network.factoryAddress,
    forwarder_init_code_hash: initCodeHash,
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
       expected_amount, expected_units, received_units, confirmed_units, deposit_address, intent_salt,
       factory_address, forwarder_init_code_hash,
       start_block, confirmations, status, expires_at, metadata, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '0', '0', ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?)`)
      .bind(
        intent.id,
        idempotencyKey,
        requestHash,
        kind,
        externalId,
        chainName,
        network.chainId,
        asset,
        intent.token_address,
        intent.decimals,
        intent.expected_amount,
        intent.expected_units,
        depositAddress,
        intent.intent_salt,
        intent.factory_address,
        intent.forwarder_init_code_hash,
        intent.start_block,
        intent.confirmations,
        intent.expires_at,
        metadataJson,
        now,
        now,
      )
      .run();
  } catch (error) {
    const winner = await env.DB.prepare("SELECT * FROM payment_intents WHERE idempotency_key = ?")
      .bind(idempotencyKey)
      .first<IntentRow>();
    if (!winner) throw error;
    if (winner.request_hash !== requestHash)
      throw new HttpError(409, "idempotency key was already used with a different request");
    return json(await intentResponse(env, winner, network));
  }
  return json(await intentResponse(env, intent, network), 201);
}

async function intentResponse(
  env: ApiEnv,
  intent: IntentRow,
  network: NetworkConfig,
): Promise<Record<string, unknown>> {
  const expectedUnits = BigInt(intent.expected_units);
  const receivedUnits = BigInt(intent.received_units);
  const remainingUnits = expectedUnits > receivedUnits ? expectedUnits - receivedUnits : 0n;
  const expired = unixNow() > intent.expires_at;
  const uri = paymentUri(
    network,
    intent.token_address,
    intent.deposit_address,
    intent.expected_units,
  );
  const svg = renderSVG(uri, { ecc: "M", pixelSize: 4, border: 4 });
  const qrCodeDataUrl = `data:image/svg+xml;base64,${btoa(svg)}`;
  const canTopUp =
    !expired &&
    remainingUnits > 0n &&
    (intent.status === "pending" || intent.status === "underpaid");
  const topUpPaymentUri = canTopUp
    ? paymentUri(network, intent.token_address, intent.deposit_address, remainingUnits.toString())
    : null;
  const topUpQrCodeDataUrl = !topUpPaymentUri
    ? null
    : topUpPaymentUri === uri
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

async function transactionResponses(
  env: ApiEnv,
  intent: IntentRow,
  network: NetworkConfig,
): Promise<Record<string, unknown>[]> {
  const transactions = await all<PaymentTransactionRow>(
    env.DB,
    "SELECT * FROM payment_transactions WHERE payment_intent = ? ORDER BY block_number, event_index LIMIT 10000",
    intent.id,
  );
  const state = await env.DB.prepare("SELECT last_scanned FROM chain_states WHERE chain = ?")
    .bind(intent.chain)
    .first<{ last_scanned: number }>();
  const grace = intSetting(env.PAYMENT_GRACE_SECONDS, "PAYMENT_GRACE_SECONDS", 0, 86_400);
  return transactions.map((transaction) => {
    const confirmations =
      transaction.canonical && state && state.last_scanned >= transaction.block_number
        ? state.last_scanned - transaction.block_number + 1
        : 0;
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
      ...(network.explorerUrl
        ? { explorerUrl: `${network.explorerUrl}/tx/${transaction.tx_hash}` }
        : {}),
    };
  });
}

async function publicSweepResponse(
  env: ApiEnv,
  intent: IntentRow,
  network: NetworkConfig,
): Promise<Record<string, unknown>> {
  const job = await env.DB.prepare("SELECT * FROM sweep_jobs WHERE payment_intent = ?")
    .bind(intent.id)
    .first<{
      id: string;
      status: string;
      observed_units: string;
      collected_units: string;
      remaining_units: string;
      last_error: string;
      completed_at: number | null;
    }>();
  if (!job) return { status: "not_queued", transactions: [] };
  const transactions = await sweepTransactions(env.DB, job.id, network, false);
  return {
    status: job.status,
    observedUnits: job.observed_units,
    collectedUnits: job.collected_units,
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
    const job =
      await this.env.DB.prepare(`UPDATE sweep_jobs SET status = 'processing', lock_owner = ?, locked_until = ?, updated_at = ?
      WHERE id = ? AND next_attempt_at <= ? AND (status = 'queued' OR (status = 'processing' AND (locked_until <= ? OR lock_owner = ?)))
      RETURNING *`)
        .bind(owner, now + 300, now, jobId, now, now, owner)
        .first<{
          id: string;
          payment_intent: string;
          chain: string;
          observed_units: string;
          status: string;
          attempts: number;
        }>();
    if (!job) return null;
    const intent = await this.env.DB.prepare("SELECT * FROM payment_intents WHERE id = ?")
      .bind(job.payment_intent)
      .first<IntentRow>();
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
      intentSalt: intent.intent_salt,
      factoryAddress: intent.factory_address,
      factoryCodeHash: network.factoryCodeHash,
      forwarderInitCodeHash: intent.forwarder_init_code_hash,
      relayerAddress: network.relayerAddress,
      treasuryAddress: network.treasuryAddress,
      confirmations: network.confirmations,
      maxGasPriceWei: network.maxGasPriceWei.toString(),
      observedUnits: job.observed_units,
      status: job.status,
      attempts: job.attempts,
      transactions: await sweepTransactions(this.env.DB, job.id, network, true),
    };
  }

  async registerSweepTransaction(
    jobId: string,
    owner: string,
    kind: "deploy_collect" | "collect",
    rawTransaction: Hex,
  ): Promise<SweepTransaction> {
    validateLeaseInput(jobId, owner);
    if (kind !== "deploy_collect" && kind !== "collect")
      throw new Error("invalid collection transaction kind");
    if (!/^0x[0-9a-fA-F]+$/.test(rawTransaction) || rawTransaction.length > 262_146)
      throw new Error("invalid raw transaction");
    const locked = await this.lockedJob(jobId, owner);
    const networks = loadNetworks(this.env.NETWORKS_JSON);
    const network = networks.get(locked.chain);
    if (!network) throw new Error(`network ${locked.chain} is not configured`);
    const transaction = parseTransaction(rawTransaction);
    const hash = keccak256(rawTransaction);
    const existing = await this.env.DB.prepare(
      "SELECT * FROM sweep_transactions WHERE chain = ? AND tx_hash = ?",
    )
      .bind(network.name, hash)
      .first<SweepTransactionRow>();
    if (existing) {
      if (existing.sweep_job !== jobId || existing.kind !== kind)
        throw new Error("transaction already belongs to another sweep");
      return sweepTransactionResponse(existing, network, true);
    }
    if (
      transaction.type !== "legacy" ||
      transaction.chainId !== network.chainId ||
      !transaction.to ||
      transaction.nonce === undefined ||
      transaction.gas === undefined ||
      transaction.gasPrice === undefined ||
      transaction.gasPrice <= 0n ||
      transaction.gasPrice > network.maxGasPriceWei
    ) {
      throw new Error("transaction chain or destination mismatch");
    }
    const from = await recoverTransactionAddress({
      serializedTransaction: rawTransaction as TransactionSerialized,
    });
    const data = transaction.data ?? "0x";
    const value = transaction.value ?? 0n;
    const expected = counterfactualAddress(
      network.factoryAddress,
      locked.intent_salt,
      network.treasuryAddress,
      locked.token_address,
    );
    const canonicalData = collectionCall(
      locked.intent_salt,
      network.treasuryAddress,
      locked.token_address,
    );
    if (
      !isAddressEqual(from, network.relayerAddress) ||
      !isAddressEqual(transaction.to, network.factoryAddress) ||
      !isAddressEqual(expected.address, locked.deposit_address) ||
      expected.initCodeHash.toLowerCase() !== locked.forwarder_init_code_hash.toLowerCase() ||
      locked.factory_address.toLowerCase() !== network.factoryAddress.toLowerCase() ||
      value !== 0n ||
      transaction.gas < 21_000n ||
      transaction.gas > MAX_COLLECTION_GAS ||
      data.toLowerCase() !== canonicalData.toLowerCase()
    ) {
      throw new Error("invalid collection transaction");
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
      amount_units: "0",
      fee_wei: "0",
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
      .bind(
        row.id,
        row.sweep_job,
        row.chain,
        row.kind,
        row.tx_hash,
        row.raw_tx,
        row.from_address,
        row.to_address,
        row.amount_units,
        row.nonce,
        row.created_at,
        row.updated_at,
      )
      .run();
    return sweepTransactionResponse(row, network, true);
  }

  async reportSweepTransaction(
    id: string,
    owner: string,
    status: "submitted" | "confirmed" | "failed",
    blockNumber: number,
    error: string,
    amountUnits: string,
    feeWei: string,
  ): Promise<void> {
    if (!id || id.length > 80 || !owner || owner.length > 80)
      throw new Error("invalid transaction lease");
    if (
      !Number.isSafeInteger(blockNumber) ||
      blockNumber < 0 ||
      !["submitted", "confirmed", "failed"].includes(status)
    )
      throw new Error("invalid transaction result");
    let amount: bigint;
    try {
      amount = BigInt(amountUnits);
    } catch {
      throw new Error("invalid collected amount");
    }
    if (amount < 0n || (status !== "confirmed" && amount !== 0n))
      throw new Error("invalid collected amount");
    let fee: bigint;
    try {
      fee = BigInt(feeWei);
    } catch {
      throw new Error("invalid transaction fee");
    }
    if (fee < 0n || (blockNumber === 0 && fee !== 0n)) throw new Error("invalid transaction fee");
    const row = await this.env.DB.prepare(
      "SELECT sweep_job, status FROM sweep_transactions WHERE id = ?",
    )
      .bind(id)
      .first<{ sweep_job: string; status: string }>();
    if (!row) throw new Error("sweep transaction not found");
    await this.lockedJob(row.sweep_job, owner);
    if (row.status === "confirmed" && status !== "confirmed")
      throw new Error("confirmed transaction cannot be downgraded");
    await this.env.DB.prepare(
      "UPDATE sweep_transactions SET status = ?, block_number = ?, amount_units = ?, fee_wei = ?, last_error = ?, updated_at = ? WHERE id = ?",
    )
      .bind(
        status,
        blockNumber || null,
        amount.toString(),
        fee.toString(),
        error.slice(0, 1_000),
        unixNow(),
        id,
      )
      .run();
  }

  async releaseSweep(
    jobId: string,
    owner: string,
    outcome: SweepOutcome,
  ): Promise<{ delaySeconds: number }> {
    validateLeaseInput(jobId, owner);
    await this.lockedJob(jobId, owner);
    if (!["queued", "complete", "external"].includes(outcome.status))
      throw new Error("invalid sweep status");
    let remaining: bigint;
    try {
      remaining = BigInt(outcome.remainingUnits);
    } catch {
      throw new Error("remainingUnits must be a non-negative integer");
    }
    if (remaining < 0n) throw new Error("remainingUnits must be a non-negative integer");
    const now = unixNow();
    const job =
      await this.env.DB.prepare(`SELECT j.attempts, j.payment_intent, j.observed_units, j.collected_units,
      i.external_id, i.kind, i.chain, i.chain_id, i.asset, i.expected_amount, i.expected_units,
      i.deposit_address, i.status AS payment_status, i.expires_at
      FROM sweep_jobs j JOIN payment_intents i ON i.id = j.payment_intent WHERE j.id = ?`)
        .bind(jobId)
        .first<{
          attempts: number;
          payment_intent: string;
          observed_units: string;
          collected_units: string;
          external_id: string;
          kind: IntentRow["kind"];
          chain: string;
          chain_id: number;
          asset: string;
          expected_amount: string;
          expected_units: string;
          deposit_address: Address;
          payment_status: PaymentStatus;
          expires_at: number;
        }>();
    if (!job) throw new Error("sweep job not found");
    const attempts = outcome.error ? job.attempts + 1 : job.attempts;
    const delay =
      outcome.status === "queued"
        ? outcome.error
          ? Math.min(300, 2 ** Math.min(attempts, 8))
          : Math.max(1, Math.min(outcome.delaySeconds, 300))
        : 0;
    const oldCollected = BigInt(job.collected_units);
    const observed = BigInt(job.observed_units);
    let collected = oldCollected;
    if (outcome.status !== "queued") {
      const rows = await all<{ amount_units: string }>(
        this.env.DB,
        "SELECT amount_units FROM sweep_transactions WHERE sweep_job = ? AND status = 'confirmed'",
        jobId,
      );
      const reported = rows.reduce((total, row) => total + BigInt(row.amount_units), 0n);
      const inferred = observed > remaining ? observed - remaining : 0n;
      collected = [oldCollected, reported, inferred].reduce((largest, value) =>
        value > largest ? value : largest,
      );
    }
    const update =
      this.env.DB.prepare(`UPDATE sweep_jobs SET status = ?, collected_units = ?, remaining_units = ?, attempts = ?, next_attempt_at = ?,
      last_error = ?, lock_owner = '', locked_until = 0, completed_at = ?, updated_at = ? WHERE id = ? AND status = 'processing' AND lock_owner = ?`).bind(
        outcome.status,
        collected.toString(),
        remaining.toString(),
        attempts,
        now + delay,
        outcome.error.slice(0, 1_000),
        outcome.status === "queued" ? null : now,
        now,
        jobId,
        owner,
      );
    const statements: D1PreparedStatement[] = [];
    const grace = intSetting(this.env.PAYMENT_GRACE_SECONDS, "PAYMENT_GRACE_SECONDS", 0, 86_400);
    if (
      collected > oldCollected &&
      (job.payment_status === "underpaid" || job.payment_status === "expired") &&
      now > job.expires_at + grace
    ) {
      const eventId = randomId("evt");
      const expected = BigInt(job.expected_units);
      const missing = expected > observed ? expected - observed : 0n;
      const body = JSON.stringify({
        id: eventId,
        type: "payment.recovered",
        createdAt: new Date(now * 1_000).toISOString(),
        data: {
          paymentIntent: {
            id: job.payment_intent,
            externalId: job.external_id,
            kind: job.kind,
            chain: job.chain,
            chainId: job.chain_id,
            asset: job.asset,
            expectedAmount: job.expected_amount,
            requestedUnits: job.expected_units,
            receivedUnits: observed.toString(),
            missingUnits: missing.toString(),
            collectedUnits: collected.toString(),
            collectedDeltaUnits: (collected - oldCollected).toString(),
            depositAddress: job.deposit_address,
            paymentStatus: job.payment_status,
            settlementStatus: "expired_underpaid_collected",
          },
        },
      });
      statements.push(
        this.env.DB.prepare(`INSERT INTO webhook_events
        (event_id, type, payment_intent, body, status, attempts, next_attempt_at, created_at, updated_at)
        SELECT ?, 'payment.recovered', ?, ?, 'pending', 0, ?, ?, ? FROM sweep_jobs
        WHERE id = ? AND status = 'processing' AND lock_owner = ?`).bind(
          eventId,
          job.payment_intent,
          body,
          now,
          now,
          now,
          jobId,
          owner,
        ),
      );
    }
    statements.push(update);
    const result = (await this.env.DB.batch(statements)).at(-1);
    if (!result?.meta.changes) throw new Error("sweep lease is not held");
    return { delaySeconds: delay };
  }

  private async lockedJob(
    jobId: string,
    owner: string,
  ): Promise<{
    id: string;
    chain: string;
    payment_intent: string;
    token_address: Address | "";
    deposit_address: Address;
    intent_salt: Hex;
    factory_address: Address;
    forwarder_init_code_hash: Hex;
  }> {
    const row =
      await this.env.DB.prepare(`SELECT j.id, j.chain, j.payment_intent, i.token_address, i.deposit_address,
        i.intent_salt, i.factory_address, i.forwarder_init_code_hash
      FROM sweep_jobs j JOIN payment_intents i ON i.id = j.payment_intent
      WHERE j.id = ? AND j.status = 'processing' AND j.lock_owner = ? AND j.locked_until >= ?`)
        .bind(jobId, owner, unixNow())
        .first<{
          id: string;
          chain: string;
          payment_intent: string;
          token_address: Address | "";
          deposit_address: Address;
          intent_salt: Hex;
          factory_address: Address;
          forwarder_init_code_hash: Hex;
        }>();
    if (!row) throw new Error("sweep lease is not held");
    return row;
  }
}

type SweepTransactionRow = {
  id: string;
  sweep_job: string;
  chain: string;
  kind: "deploy_collect" | "collect";
  tx_hash: Hex;
  raw_tx: Hex;
  from_address: Address;
  to_address: Address;
  amount_units: string;
  fee_wei: string;
  nonce: number;
  status: "prepared" | "submitted" | "confirmed" | "failed";
  block_number: number | null;
  last_error: string;
  created_at: number;
  updated_at: number;
};

async function sweepTransactions(
  db: D1Database,
  jobId: string,
  network: NetworkConfig,
  includeRaw: boolean,
): Promise<SweepTransaction[]> {
  const rows = await all<SweepTransactionRow>(
    db,
    "SELECT * FROM sweep_transactions WHERE sweep_job = ? ORDER BY created_at",
    jobId,
  );
  return rows.map((row) => sweepTransactionResponse(row, network, includeRaw));
}

function sweepTransactionResponse(
  row: SweepTransactionRow,
  network: NetworkConfig,
  includeRaw: boolean,
): SweepTransaction {
  return {
    id: row.id,
    kind: row.kind,
    hash: row.tx_hash,
    rawTransaction: includeRaw ? row.raw_tx : "0x",
    from: row.from_address,
    to: row.to_address,
    amountUnits: row.amount_units,
    feeWei: row.fee_wei,
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
  const [left, right] = await Promise.all([
    crypto.subtle.digest("SHA-256", new TextEncoder().encode(supplied)),
    crypto.subtle.digest("SHA-256", new TextEncoder().encode(expected)),
  ]);
  const a = new Uint8Array(left);
  const b = new Uint8Array(right);
  let difference = supplied.length ^ expected.length;
  for (let index = 0; index < a.length; index++) difference |= a[index] ^ b[index];
  return difference === 0;
}

async function readObject(
  request: Request,
  allowedKeys: string[],
): Promise<Record<string, unknown>> {
  const contentType = request.headers.get("Content-Type")?.split(";", 1)[0].trim().toLowerCase();
  if (contentType !== "application/json")
    throw new HttpError(415, "Content-Type must be application/json");
  const text = await request.text();
  if (new TextEncoder().encode(text).length > 65_536)
    throw new HttpError(413, "request body is too large");
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new HttpError(400, "invalid JSON body");
  }
  if (!isObject(value) || Object.keys(value).some((key) => !allowedKeys.includes(key)))
    throw new HttpError(400, "invalid JSON body");
  return value;
}

function requiredString(object: Record<string, unknown>, key: string): string {
  if (typeof object[key] !== "string") throw new HttpError(400, `${key} is required`);
  return object[key];
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isTooDeep(value: unknown, maxDepth: number): boolean {
  const stack = [{ value, depth: 0 }];
  while (stack.length) {
    const current = stack.pop();
    if (!current) break;
    if (current.depth > maxDepth) return true;
    const children = Array.isArray(current.value)
      ? current.value
      : isObject(current.value)
        ? Object.values(current.value)
        : [];
    for (const child of children) stack.push({ value: child, depth: current.depth + 1 });
  }
  return false;
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function validateLeaseInput(jobId: string, owner: string): void {
  if (!jobId || jobId.length > 80 || !owner || owner.length > 80)
    throw new Error("invalid sweep lease");
}

function json(value: unknown, status = 200): Response {
  return Response.json(value, { status, headers: { "Cache-Control": "no-store" } });
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
