import { type Address, getAddress, isAddress, isAddressEqual } from "viem";
import { formatUnits, intSetting, loadNetworks, parseAmount, stableStringify } from "./domain";
import { randomId, unixNow } from "./monitor";
import type { ApiEnv, IntentRow } from "./types";
import {
  validateWithdrawalDestination,
  WithdrawalHttpError,
  type WithdrawalRow,
  withdrawalResponse,
} from "./withdrawals";

const REFUNDABLE_STATUSES = ["awaiting_signature", "submitted", "confirming", "complete"];

export async function routeRefund(
  request: Request,
  url: URL,
  env: ApiEnv,
  apiRoot: string,
): Promise<Response | null> {
  const match = url.pathname.match(new RegExp(`^${apiRoot}/deposits/([A-Za-z0-9_-]+)/refunds$`));
  if (!match) return null;
  try {
    if (request.method === "POST") return await createRefund(request, env, match[1]);
    if (request.method === "GET") return await listRefunds(env, match[1]);
    return null;
  } catch (error) {
    if (error instanceof WithdrawalHttpError) return json({ error: error.message }, error.status);
    throw error;
  }
}

async function createRefund(request: Request, env: ApiEnv, depositId: string): Promise<Response> {
  const idempotencyKey = request.headers.get("Idempotency-Key")?.trim() ?? "";
  if (!idempotencyKey || idempotencyKey.length > 200) {
    throw new WithdrawalHttpError(
      400,
      "Idempotency-Key is required and must be at most 200 characters",
    );
  }
  const body = await readObject(request, ["amount"]);
  const rawAmount = body.amount === undefined ? undefined : requiredString(body, "amount");
  if (rawAmount !== undefined && rawAmount.trim().length > 100) {
    throw new WithdrawalHttpError(400, "amount must be at most 100 characters");
  }

  const deposit = await env.DB.prepare("SELECT * FROM deposit_intents WHERE id = ?")
    .bind(depositId)
    .first<IntentRow>();
  if (!deposit) throw new WithdrawalHttpError(404, "deposit intent not found");

  const existing = await env.DB.prepare(
    "SELECT * FROM withdrawal_intents WHERE idempotency_key = ?",
  )
    .bind(idempotencyKey)
    .first<WithdrawalRow>();
  if (existing) {
    if (existing.purpose !== "refund" || existing.deposit_intent !== deposit.id) {
      throw new WithdrawalHttpError(
        409,
        "idempotency key was already used with a different request",
      );
    }
    let replayAmount = existing.amount;
    if (rawAmount !== undefined) {
      try {
        replayAmount = parseAmount(rawAmount, existing.decimals).amount;
      } catch {
        throw new WithdrawalHttpError(
          409,
          "idempotency key was already used with a different request",
        );
      }
    }
    const replayHash = await refundRequestHash(
      deposit.id,
      existing.destination_address,
      replayAmount,
    );
    if (existing.request_hash !== replayHash) {
      throw new WithdrawalHttpError(
        409,
        "idempotency key was already used with a different request",
      );
    }
    const network = loadNetworks(env.NETWORKS_JSON).get(existing.chain);
    if (!network) throw new WithdrawalHttpError(409, "refund network configuration changed");
    return json({ refund: await withdrawalResponse(env, existing, network, false) });
  }

  const networks = loadNetworks(env.NETWORKS_JSON);
  const network = networks.get(deposit.chain);
  if (!network || network.chainId !== deposit.chain_id) {
    throw new WithdrawalHttpError(409, "deposit network configuration changed");
  }
  if (deposit.token_address) {
    const token = network.tokens[deposit.asset];
    if (!token || !isAddressEqual(token.address, deposit.token_address)) {
      throw new WithdrawalHttpError(409, "deposit token configuration changed");
    }
  }
  if (deposit.status !== "paid") {
    throw new WithdrawalHttpError(409, "deposit is not paid");
  }

  const payer = await singlePayer(env, deposit);
  await validateWithdrawalDestination(env.DB, network, deposit.token_address, payer);

  const active = await env.DB.prepare(
    `SELECT id FROM withdrawal_intents WHERE purpose = 'refund' AND deposit_intent = ?
     AND status IN ('awaiting_signature','submitted','confirming') LIMIT 1`,
  )
    .bind(deposit.id)
    .first<{ id: string }>();
  if (active) throw new WithdrawalHttpError(409, "a refund is already in progress");

  const confirmed = BigInt(deposit.confirmed_units);
  const refunded = await refundedUnits(env.DB, deposit.id);
  const remaining = confirmed > refunded ? confirmed - refunded : 0n;
  if (remaining <= 0n) throw new WithdrawalHttpError(409, "deposit has no refundable amount");

  let amount: ReturnType<typeof parseAmount>;
  try {
    amount = parseAmount(rawAmount ?? formatUnits(remaining, deposit.decimals), deposit.decimals);
  } catch (error) {
    throw new WithdrawalHttpError(400, error instanceof Error ? error.message : String(error));
  }
  if (amount.units > remaining) {
    throw new WithdrawalHttpError(
      409,
      `refund amount exceeds refundable amount of ${formatUnits(remaining, deposit.decimals)}`,
    );
  }

  const requestHash = await refundRequestHash(deposit.id, payer, amount.amount);
  const now = unixNow();
  const row: WithdrawalRow = {
    id: randomId("wd"),
    idempotency_key: idempotencyKey,
    request_hash: requestHash,
    purpose: "refund",
    external_id: deposit.external_id,
    deposit_intent: deposit.id,
    chain: network.name,
    chain_id: network.chainId,
    asset: deposit.asset,
    token_address: deposit.token_address,
    decimals: deposit.decimals,
    source_address: network.withdrawalSourceAddress,
    destination_address: payer,
    amount: amount.amount,
    amount_units: amount.units.toString(),
    confirmations: network.confirmations,
    max_gas_price_wei: network.maxGasPriceWei.toString(),
    status: "awaiting_signature",
    expires_at: now + intSetting(env.DEFAULT_EXPIRY_SECONDS, "DEFAULT_EXPIRY_SECONDS", 300, 86_400),
    last_error: "",
    completed_at: null,
    created_at: now,
    updated_at: now,
  };

  try {
    await env.DB.prepare(`INSERT INTO withdrawal_intents
      (id,idempotency_key,request_hash,purpose,external_id,deposit_intent,chain,chain_id,asset,
       token_address,decimals,source_address,destination_address,amount,amount_units,confirmations,
       max_gas_price_wei,status,expires_at,created_at,updated_at)
      VALUES (?,?,?,'refund',?,?,?,?,?,?,?,?,?,?,?,?,?,'awaiting_signature',?,?,?)`)
      .bind(
        row.id,
        row.idempotency_key,
        row.request_hash,
        row.external_id,
        row.deposit_intent,
        row.chain,
        row.chain_id,
        row.asset,
        row.token_address,
        row.decimals,
        row.source_address,
        row.destination_address,
        row.amount,
        row.amount_units,
        row.confirmations,
        row.max_gas_price_wei,
        row.expires_at,
        row.created_at,
        row.updated_at,
      )
      .run();
  } catch (error) {
    const winner = await env.DB.prepare(
      "SELECT * FROM withdrawal_intents WHERE idempotency_key = ?",
    )
      .bind(idempotencyKey)
      .first<WithdrawalRow>();
    if (winner) {
      if (
        winner.purpose === "refund" &&
        winner.deposit_intent === deposit.id &&
        winner.request_hash === requestHash
      ) {
        return json({ refund: await withdrawalResponse(env, winner, network, false) });
      }
      throw new WithdrawalHttpError(
        409,
        "idempotency key was already used with a different request",
      );
    }
    const activeRefund = await env.DB.prepare(
      `SELECT id FROM withdrawal_intents WHERE purpose = 'refund' AND deposit_intent = ?
       AND status IN ('awaiting_signature','submitted','confirming') LIMIT 1`,
    )
      .bind(deposit.id)
      .first<{ id: string }>();
    if (activeRefund) throw new WithdrawalHttpError(409, "a refund is already in progress");
    throw error;
  }

  return json({ refund: await withdrawalResponse(env, row, network, false) }, 201);
}

async function singlePayer(env: ApiEnv, deposit: IntentRow): Promise<Address> {
  const grace = intSetting(env.PAYMENT_GRACE_SECONDS, "PAYMENT_GRACE_SECONDS", 0, 86_400);
  const transfers = await all<{ from_address: Address }>(
    env.DB,
    `SELECT DISTINCT from_address FROM deposit_transfers
     WHERE deposit_intent = ? AND canonical = 1 AND amount_units != '0' AND block_timestamp <= ?`,
    deposit.id,
    deposit.expires_at + grace,
  );
  const payers = new Map<string, Address>();
  for (const transfer of transfers) {
    if (!isAddress(transfer.from_address)) continue;
    const payer = getAddress(transfer.from_address);
    payers.set(payer.toLowerCase(), payer);
  }
  if (payers.size === 0) throw new WithdrawalHttpError(409, "deposit has no payer address");
  if (payers.size > 1) {
    throw new WithdrawalHttpError(
      409,
      "deposit has multiple payer addresses; use a withdrawal with an explicit destination",
    );
  }
  return [...payers.values()][0];
}

async function refundedUnits(db: D1Database, depositId: string): Promise<bigint> {
  const rows = await all<{ amount_units: string }>(
    db,
    `SELECT amount_units FROM withdrawal_intents WHERE purpose = 'refund' AND deposit_intent = ?
     AND status IN ('awaiting_signature','submitted','confirming','complete')`,
    depositId,
  );
  return rows.reduce((total, row) => total + BigInt(row.amount_units), 0n);
}

async function listRefunds(env: ApiEnv, depositId: string): Promise<Response> {
  const deposit = await env.DB.prepare("SELECT * FROM deposit_intents WHERE id = ?")
    .bind(depositId)
    .first<IntentRow>();
  if (!deposit) throw new WithdrawalHttpError(404, "deposit intent not found");
  const network = loadNetworks(env.NETWORKS_JSON).get(deposit.chain);
  if (!network) throw new WithdrawalHttpError(409, "deposit network configuration changed");
  const rows = await all<WithdrawalRow>(
    env.DB,
    `SELECT * FROM withdrawal_intents WHERE purpose = 'refund' AND deposit_intent = ?
     ORDER BY created_at DESC, id DESC LIMIT 100`,
    deposit.id,
  );
  const refunded = rows
    .filter((row) => REFUNDABLE_STATUSES.includes(row.status))
    .reduce((total, row) => total + BigInt(row.amount_units), 0n);
  const confirmed = BigInt(deposit.confirmed_units);
  const remaining = confirmed > refunded ? confirmed - refunded : 0n;
  return json({
    items: await Promise.all(rows.map((row) => withdrawalResponse(env, row, network, false))),
    confirmedAmount: formatUnits(confirmed, deposit.decimals),
    refundedAmount: formatUnits(refunded, deposit.decimals),
    refundableAmount: formatUnits(remaining, deposit.decimals),
  });
}

async function readObject(
  request: Request,
  allowedKeys: string[],
): Promise<Record<string, unknown>> {
  const contentType = request.headers.get("Content-Type")?.split(";", 1)[0].trim().toLowerCase();
  if (contentType !== "application/json") {
    throw new WithdrawalHttpError(415, "Content-Type must be application/json");
  }
  const text = await request.text();
  if (new TextEncoder().encode(text).length > 65_536) {
    throw new WithdrawalHttpError(413, "request body is too large");
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new WithdrawalHttpError(400, "invalid JSON body");
  }
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => !allowedKeys.includes(key))
  ) {
    throw new WithdrawalHttpError(400, "invalid JSON body");
  }
  return value as Record<string, unknown>;
}

function requiredString(object: Record<string, unknown>, key: string): string {
  if (typeof object[key] !== "string") {
    throw new WithdrawalHttpError(400, `${key} is required`);
  }
  return object[key];
}

async function refundRequestHash(
  depositIntentId: string,
  destinationAddress: Address,
  amount: string,
): Promise<string> {
  return sha256(stableStringify({ depositIntentId, destinationAddress, amount }));
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function all<T>(db: D1Database, sql: string, ...bindings: unknown[]): Promise<T[]> {
  return (
    await db
      .prepare(sql)
      .bind(...bindings)
      .all<T>()
  ).results;
}

function json(value: unknown, status = 200): Response {
  return Response.json(value, { status, headers: { "Cache-Control": "no-store" } });
}
