import { type Address, createPublicClient, getAddress, type Hex, http, parseAbiItem } from "viem";
import { deriveStatus, eligibleForSweep, intSetting, loadNetworks } from "./domain";
import type {
  ApiEnv,
  IntentRow,
  NetworkConfig,
  PaymentTransactionRow,
  SweepMessage,
} from "./types";

const transferEvent = parseAbiItem(
  "event Transfer(address indexed from, address indexed to, uint256 value)",
);

type ObservedPayment = {
  intentId: string;
  chain: string;
  txHash: Hex;
  eventIndex: number;
  asset: string;
  from: Address;
  to: Address;
  amountUnits: string;
  blockNumber: number;
  blockHash: Hex;
  blockTimestamp: number;
};

export async function runScheduled(env: ApiEnv): Promise<void> {
  const networks = loadNetworks(env.NETWORKS_JSON);
  const results = await Promise.allSettled(
    [...networks.values()].map((network) => syncChain(env, network)),
  );
  for (const [index, result] of results.entries()) {
    if (result.status === "rejected")
      console.error("chain sync failed", [...networks.keys()][index], safeErrorText(result.reason));
  }
  for (const [name, task] of [
    ["intent expiry", () => expirePendingIntents(env.DB)],
    ["webhook delivery", () => deliverWebhooks(env)],
    ["sweep dispatch", () => dispatchSweeps(env)],
  ] as const) {
    try {
      await task();
    } catch (error) {
      console.error(`${name} failed`, safeErrorText(error));
    }
  }
}

export async function syncChain(env: ApiEnv, network: NetworkConfig): Promise<void> {
  const intents = await all<IntentRow>(
    env.DB,
    "SELECT * FROM payment_intents WHERE chain = ? ORDER BY created_at, id",
    network.name,
  );
  if (!intents.length) return;

  const now = unixNow();
  const owner = crypto.randomUUID();
  const earliest = Math.min(...intents.map((intent) => intent.start_block));
  const lease = await env.DB.prepare(`
    INSERT INTO chain_states (chain, last_scanned, lock_owner, locked_until, updated_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(chain) DO UPDATE SET lock_owner = excluded.lock_owner, locked_until = excluded.locked_until, updated_at = excluded.updated_at
    WHERE chain_states.locked_until <= excluded.updated_at
    RETURNING last_scanned
  `)
    .bind(network.name, Math.max(-1, earliest - 1), owner, now + 55, now)
    .first<{ last_scanned: number }>();
  if (!lease) return;

  try {
    const client = createPublicClient({
      transport: http(network.rpcUrl, { batch: { batchSize: 10 }, timeout: 20_000 }),
    });
    const remoteChainId = await client.getChainId();
    if (remoteChainId !== network.chainId)
      throw new Error(`RPC chain ID ${remoteChainId} does not match ${network.chainId}`);
    let last = lease.last_scanned;
    const reorged = new Set<string>();
    if (last >= 0)
      last = await rewindIfNeeded(env, network, client, last, owner, reorged, earliest);

    const depositIntents = new Map(
      intents.map((intent) => [intent.deposit_address.toLowerCase(), intent]),
    );
    const latest = Number(await client.getBlockNumber());
    const nativeAddresses = new Set<string>();
    for (const intent of intents.filter((candidate) => !candidate.token_address)) {
      if (!["paid", "expired"].includes(intent.status) && intent.expires_at >= now) {
        nativeAddresses.add(intent.deposit_address.toLowerCase());
      } else if (
        (await client.getBalance({
          address: getAddress(intent.deposit_address),
          blockNumber: BigInt(latest),
        })) > 0n
      ) {
        nativeAddresses.add(intent.deposit_address.toLowerCase());
      }
    }
    const tokenAddresses = [
      ...new Set(
        intents
          .filter((intent) => intent.token_address)
          .map((intent) => getAddress(intent.token_address)),
      ),
    ];
    const tokenDepositAddresses = intents
      .filter((intent) => intent.token_address)
      .map((intent) => getAddress(intent.deposit_address));
    const start = Math.max(0, earliest, last < 0 ? earliest : last);
    // ponytail: native blocks are CPU-heavy; token logs can safely cover a much larger gap.
    const target = Math.min(latest, start + (nativeAddresses.size ? 39 : 4_999));

    const tokenLogs = tokenAddresses.length
      ? await client.getLogs({
          address: tokenAddresses,
          event: transferEvent,
          args: { to: tokenDepositAddresses },
          fromBlock: BigInt(start),
          toBlock: BigInt(target),
          strict: true,
        })
      : [];
    const logsByBlock = new Map<number, typeof tokenLogs>();
    for (const log of tokenLogs) {
      if (log.blockNumber === null) continue;
      const blockNumber = Number(log.blockNumber);
      const logs = logsByBlock.get(blockNumber) ?? [];
      logs.push(log);
      logsByBlock.set(blockNumber, logs);
    }
    const blockNumbers = nativeAddresses.size
      ? Array.from({ length: target - start + 1 }, (_, index) => start + index)
      : [...new Set([target, ...logsByBlock.keys()])].sort((a, b) => a - b);
    const blocks = [];
    for (let index = 0; index < blockNumbers.length; index += 10) {
      blocks.push(
        ...(await Promise.all(
          blockNumbers.slice(index, index + 10).map((blockNumber) =>
            client.getBlock({
              blockNumber: BigInt(blockNumber),
              includeTransactions: nativeAddresses.size > 0,
            }),
          ),
        )),
      );
    }

    for (const [index, block] of blocks.entries()) {
      const blockNumber = blockNumbers[index];
      if (block.number !== BigInt(blockNumber)) throw new Error("RPC returned the wrong block");
      const payments: ObservedPayment[] = [];

      if (nativeAddresses.size) {
        for (const transaction of block.transactions) {
          if (typeof transaction === "string" || !transaction.to || transaction.value <= 0n)
            continue;
          const intent = depositIntents.get(transaction.to.toLowerCase());
          if (!intent || intent.token_address || intent.start_block > blockNumber) continue;
          const receipt = await client.getTransactionReceipt({ hash: transaction.hash });
          if (receipt.status !== "success" || receipt.blockHash !== block.hash) continue;
          payments.push({
            intentId: intent.id,
            chain: network.name,
            txHash: transaction.hash,
            eventIndex: -1,
            asset: intent.asset,
            from: transaction.from,
            to: getAddress(transaction.to),
            amountUnits: transaction.value.toString(),
            blockNumber,
            blockHash: block.hash,
            blockTimestamp: Number(block.timestamp),
          });
        }
      }

      if (tokenAddresses.length) {
        for (const log of logsByBlock.get(blockNumber) ?? []) {
          if (
            !log.args.to ||
            !log.args.from ||
            log.args.value === undefined ||
            log.blockHash !== block.hash ||
            log.blockNumber === null
          )
            continue;
          const intent = depositIntents.get(log.args.to.toLowerCase());
          if (
            !intent?.token_address ||
            getAddress(intent.token_address) !== getAddress(log.address) ||
            intent.start_block > blockNumber
          )
            continue;
          payments.push({
            intentId: intent.id,
            chain: network.name,
            txHash: log.transactionHash,
            eventIndex: log.logIndex,
            asset: intent.asset,
            from: log.args.from,
            to: log.args.to,
            amountUnits: log.args.value.toString(),
            blockNumber,
            blockHash: block.hash,
            blockTimestamp: Number(block.timestamp),
          });
        }
      }
      await saveBlock(env.DB, network.name, owner, block, payments);
    }

    if (target >= 0) await recalculateChain(env, network, intents, target, reorged);
    const history = intSetting(env.REORG_HISTORY_BLOCKS, "REORG_HISTORY_BLOCKS", 32, 100_000);
    if (target > history)
      await env.DB.prepare("DELETE FROM chain_blocks WHERE chain = ? AND block_number < ?")
        .bind(network.name, target - history)
        .run();
  } finally {
    await env.DB.prepare(
      "UPDATE chain_states SET lock_owner = '', locked_until = 0, updated_at = ? WHERE chain = ? AND lock_owner = ?",
    )
      .bind(unixNow(), network.name, owner)
      .run();
  }
}

async function rewindIfNeeded(
  env: ApiEnv,
  network: NetworkConfig,
  client: ReturnType<typeof createPublicClient>,
  last: number,
  owner: string,
  reorged: Set<string>,
  earliest: number,
): Promise<number> {
  const stored = await env.DB.prepare(
    "SELECT block_hash FROM chain_blocks WHERE chain = ? AND block_number = ?",
  )
    .bind(network.name, last)
    .first<{ block_hash: Hex }>();
  const remote = await client.getBlock({ blockNumber: BigInt(last), includeTransactions: false });
  if (stored?.block_hash.toLowerCase() === remote.hash.toLowerCase()) return last;

  const history = intSetting(env.REORG_HISTORY_BLOCKS, "REORG_HISTORY_BLOCKS", 32, 100_000);
  const floor = Math.max(0, last - history);
  let ancestor = last - 1;
  for (; ancestor >= floor; ancestor--) {
    const candidate = await env.DB.prepare(
      "SELECT block_hash FROM chain_blocks WHERE chain = ? AND block_number = ?",
    )
      .bind(network.name, ancestor)
      .first<{ block_hash: Hex }>();
    if (!candidate) continue;
    const header = await client.getBlock({
      blockNumber: BigInt(ancestor),
      includeTransactions: false,
    });
    if (candidate.block_hash.toLowerCase() === header.hash.toLowerCase()) break;
  }
  if (ancestor < floor) ancestor = earliest - 1;
  const fromBlock = ancestor + 1;
  const affected = await all<{ id: string }>(
    env.DB,
    `
    SELECT DISTINCT i.id FROM payment_intents i
    JOIN payment_transactions t ON t.payment_intent = i.id
    WHERE i.chain = ? AND i.status = 'paid' AND t.canonical = 1 AND t.block_number >= ?
  `,
    network.name,
    fromBlock,
  );
  for (const row of affected) reorged.add(row.id);
  await rewindCollections(env.DB, network.name, fromBlock);
  await env.DB.batch([
    env.DB.prepare(
      "UPDATE payment_transactions SET canonical = 0, updated_at = ? WHERE chain = ? AND block_number >= ? AND canonical = 1",
    ).bind(unixNow(), network.name, fromBlock),
    env.DB.prepare("DELETE FROM chain_blocks WHERE chain = ? AND block_number >= ?").bind(
      network.name,
      fromBlock,
    ),
    env.DB.prepare(
      "UPDATE chain_states SET last_scanned = ?, updated_at = ? WHERE chain = ? AND lock_owner = ?",
    ).bind(ancestor, unixNow(), network.name, owner),
  ]);
  return ancestor;
}

export async function rewindCollections(
  db: D1Database,
  chain: string,
  fromBlock: number,
): Promise<void> {
  const rows = await all<{
    sweep_job: string;
    amount_units: string;
    collected_units: string;
  }>(
    db,
    `SELECT t.sweep_job, t.amount_units, j.collected_units
     FROM sweep_transactions t JOIN sweep_jobs j ON j.id = t.sweep_job
     WHERE t.chain = ? AND t.block_number >= ? AND t.status = 'confirmed'`,
    chain,
    fromBlock,
  );
  if (!rows.length) return;
  const removed = new Map<string, { collected: bigint; amount: bigint }>();
  for (const row of rows) {
    const value = removed.get(row.sweep_job) ?? {
      collected: BigInt(row.collected_units),
      amount: 0n,
    };
    value.amount += BigInt(row.amount_units);
    removed.set(row.sweep_job, value);
  }
  const now = unixNow();
  await db.batch([
    ...[...removed].map(([jobId, value]) =>
      db
        .prepare(`UPDATE sweep_jobs SET status = CASE WHEN status = 'paused' THEN status ELSE 'queued' END,
          collected_units = ?, next_attempt_at = ?, completed_at = NULL, lock_owner = '', locked_until = 0, updated_at = ?
          WHERE id = ?`)
        .bind(
          (value.collected > value.amount ? value.collected - value.amount : 0n).toString(),
          now,
          now,
          jobId,
        ),
    ),
    db
      .prepare(`UPDATE sweep_transactions SET status = 'submitted', block_number = NULL,
        amount_units = '0', fee_wei = '0', updated_at = ?
        WHERE chain = ? AND block_number >= ? AND status = 'confirmed'`)
      .bind(now, chain, fromBlock),
  ]);
}

async function saveBlock(
  db: D1Database,
  chain: string,
  owner: string,
  block: { number: bigint; hash: Hex; parentHash: Hex; timestamp: bigint },
  payments: ObservedPayment[],
): Promise<void> {
  const now = unixNow();
  const statements = [
    db
      .prepare(`INSERT INTO chain_blocks (chain, block_number, block_hash, parent_hash, block_timestamp)
      VALUES (?, ?, ?, ?, ?) ON CONFLICT(chain, block_number) DO UPDATE SET
      block_hash = excluded.block_hash, parent_hash = excluded.parent_hash, block_timestamp = excluded.block_timestamp`)
      .bind(chain, Number(block.number), block.hash, block.parentHash, Number(block.timestamp)),
    ...payments.map((payment) =>
      db
        .prepare(`INSERT INTO payment_transactions
      (id, payment_intent, chain, tx_hash, event_index, asset, from_address, to_address, amount_units, block_number, block_hash, block_timestamp, canonical, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
      ON CONFLICT(chain, tx_hash, event_index) DO UPDATE SET payment_intent = excluded.payment_intent,
      asset = excluded.asset, from_address = excluded.from_address, to_address = excluded.to_address,
      amount_units = excluded.amount_units, block_number = excluded.block_number, block_hash = excluded.block_hash,
      block_timestamp = excluded.block_timestamp, canonical = 1, updated_at = excluded.updated_at`)
        .bind(
          randomId("ptx"),
          payment.intentId,
          payment.chain,
          payment.txHash,
          payment.eventIndex,
          payment.asset,
          payment.from,
          payment.to,
          payment.amountUnits,
          payment.blockNumber,
          payment.blockHash,
          payment.blockTimestamp,
          now,
          now,
        ),
    ),
    db
      .prepare(
        "UPDATE chain_states SET last_scanned = ?, locked_until = ?, updated_at = ? WHERE chain = ? AND lock_owner = ?",
      )
      .bind(Number(block.number), now + 55, now, chain, owner),
  ];
  const result = await db.batch(statements);
  if (!result.at(-1)?.meta.changes) throw new Error(`lost ${chain} scan lease`);
}

export async function recalculateChain(
  env: ApiEnv,
  network: NetworkConfig,
  intents: IntentRow[],
  head: number,
  reorged: Set<string>,
): Promise<void> {
  const transactions = await all<PaymentTransactionRow>(
    env.DB,
    "SELECT * FROM payment_transactions WHERE chain = ? ORDER BY block_number, event_index",
    network.name,
  );
  const byIntent = new Map<string, PaymentTransactionRow[]>();
  for (const transaction of transactions) {
    const list = byIntent.get(transaction.payment_intent) ?? [];
    list.push(transaction);
    byIntent.set(transaction.payment_intent, list);
  }
  const grace = intSetting(env.PAYMENT_GRACE_SECONDS, "PAYMENT_GRACE_SECONDS", 0, 86_400);
  const minTokenBps = intSetting(
    env.SWEEPER_MIN_TOKEN_PAYMENT_BPS,
    "SWEEPER_MIN_TOKEN_PAYMENT_BPS",
    1,
    10_000,
  );
  const now = unixNow();
  for (const intent of intents) {
    let received = 0n;
    let confirmed = 0n;
    let allConfirmed = 0n;
    const hashes: Hex[] = [];
    const orphanedHashes: Hex[] = [];
    for (const transaction of byIntent.get(intent.id) ?? []) {
      if (!transaction.canonical) {
        orphanedHashes.push(transaction.tx_hash);
        continue;
      }
      const amount = BigInt(transaction.amount_units);
      const isConfirmed =
        head >= transaction.block_number &&
        head - transaction.block_number + 1 >= intent.confirmations;
      if (isConfirmed) allConfirmed += amount;
      if (transaction.block_timestamp > intent.expires_at + grace) continue;
      received += amount;
      if (isConfirmed) confirmed += amount;
      hashes.push(transaction.tx_hash);
    }
    const expected = BigInt(intent.expected_units);
    const status = deriveStatus(
      received,
      confirmed,
      expected,
      now > intent.expires_at,
      reorged.has(intent.id) || intent.status === "reorged",
    );
    if (status === "reorged") hashes.push(...orphanedHashes);
    const eligible = eligibleForSweep(
      Boolean(intent.token_address),
      status,
      allConfirmed,
      expected,
      now > intent.expires_at + grace,
      minTokenBps,
    );
    await updatePayment(
      env.DB,
      intent,
      received,
      confirmed,
      allConfirmed,
      status,
      hashes,
      eligible,
    );
    intent.received_units = received.toString();
    intent.confirmed_units = confirmed.toString();
    intent.status = status;
  }
}

export async function expirePendingIntents(db: D1Database): Promise<void> {
  const now = unixNow();
  await db
    .prepare(
      "UPDATE payment_intents SET status = 'expired', updated_at = ? WHERE status = 'pending' AND received_units = '0' AND expires_at < ?",
    )
    .bind(now, now)
    .run();
}

async function updatePayment(
  db: D1Database,
  intent: IntentRow,
  received: bigint,
  confirmed: bigint,
  sweepUnits: bigint,
  status: IntentRow["status"],
  hashes: Hex[],
  sweepEligible: boolean,
): Promise<void> {
  const now = unixNow();
  const changed =
    intent.received_units !== received.toString() ||
    intent.confirmed_units !== confirmed.toString() ||
    intent.status !== status;
  const statements: D1PreparedStatement[] = [];
  if (changed)
    statements.push(
      db
        .prepare(
          `UPDATE payment_intents SET received_units = ?, confirmed_units = ?, status = ?, updated_at = ? WHERE id = ?`,
        )
        .bind(received.toString(), confirmed.toString(), status, now, intent.id),
    );

  const job = await db
    .prepare("SELECT id, observed_units, status FROM sweep_jobs WHERE payment_intent = ?")
    .bind(intent.id)
    .first<{ id: string; observed_units: string; status: string }>();
  if (!job && sweepEligible) {
    statements.push(
      db
        .prepare(`INSERT INTO sweep_jobs
      (id, payment_intent, chain, observed_units, remaining_units, status, attempts, next_attempt_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, '0', 'queued', 0, ?, ?, ?)`)
        .bind(randomId("swp"), intent.id, intent.chain, sweepUnits.toString(), now, now, now),
    );
  } else if (job) {
    if (!sweepEligible && !["complete", "external", "paused"].includes(job.status)) {
      statements.push(
        db
          .prepare(
            "UPDATE sweep_jobs SET observed_units = ?, status = 'paused', lock_owner = '', locked_until = 0, updated_at = ? WHERE id = ?",
          )
          .bind(sweepUnits.toString(), now, job.id),
      );
    } else if (
      sweepEligible &&
      (job.status === "paused" ||
        (["complete", "external"].includes(job.status) &&
          job.observed_units !== sweepUnits.toString()))
    ) {
      statements.push(
        db
          .prepare(`UPDATE sweep_jobs SET observed_units = ?, status = 'queued', next_attempt_at = ?, completed_at = NULL,
        lock_owner = '', locked_until = 0, updated_at = ? WHERE id = ?`)
          .bind(sweepUnits.toString(), now, now, job.id),
      );
    } else if (job.observed_units !== sweepUnits.toString()) {
      statements.push(
        db
          .prepare("UPDATE sweep_jobs SET observed_units = ?, updated_at = ? WHERE id = ?")
          .bind(sweepUnits.toString(), now, job.id),
      );
    }
  }

  let eventType = "";
  if (status === "paid" && intent.status !== "paid") eventType = "payment.succeeded";
  else if (status === "reorged" && intent.status === "paid") eventType = "payment.reorged";
  if (eventType) {
    const eventId = randomId("evt");
    const body = JSON.stringify({
      id: eventId,
      type: eventType,
      createdAt: new Date(now * 1000).toISOString(),
      data: {
        paymentIntent: {
          id: intent.id,
          externalId: intent.external_id,
          kind: intent.kind,
          chain: intent.chain,
          chainId: intent.chain_id,
          asset: intent.asset,
          expectedAmount: intent.expected_amount,
          receivedUnits: received.toString(),
          confirmedUnits: confirmed.toString(),
          depositAddress: intent.deposit_address,
          status,
          transactionHashes: hashes,
        },
      },
    });
    statements.push(
      db
        .prepare(`INSERT INTO webhook_events
      (event_id, type, payment_intent, body, status, attempts, next_attempt_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'pending', 0, ?, ?, ?)`)
        .bind(eventId, eventType, intent.id, body, now, now, now),
    );
  }
  if (statements.length) await db.batch(statements);
}

export async function deliverWebhooks(env: ApiEnv): Promise<void> {
  if (env.PAYMENT_WEBHOOK_SECRET.length < 24)
    throw new Error("PAYMENT_WEBHOOK_SECRET must be at least 24 characters");
  const endpoint = new URL(env.PAYMENT_WEBHOOK_URL);
  if (endpoint.protocol !== "https:") throw new Error("PAYMENT_WEBHOOK_URL must use HTTPS");
  const now = unixNow();
  const events = await all<{ event_id: string; body: string; attempts: number }>(
    env.DB,
    "SELECT event_id, body, attempts FROM webhook_events WHERE status = 'pending' AND next_attempt_at <= ? ORDER BY created_at LIMIT 20",
    now,
  );
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(env.PAYMENT_WEBHOOK_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  for (const event of events) {
    const timestamp = unixNow().toString();
    const signature = toHexString(
      await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${timestamp}.${event.body}`)),
    );
    let error = "";
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Webhook-Id": event.event_id,
          "Webhook-Timestamp": timestamp,
          "Webhook-Signature": `v1,${signature}`,
        },
        body: event.body,
        redirect: "manual",
        signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok) error = `webhook returned HTTP ${response.status}`;
      await response.body?.cancel();
    } catch (caught) {
      error = safeErrorText(caught);
    }
    const attempts = event.attempts + 1;
    if (!error) {
      await env.DB.prepare(
        "UPDATE webhook_events SET status = 'delivered', attempts = ?, last_error = '', delivered_at = ?, updated_at = ? WHERE event_id = ?",
      )
        .bind(attempts, unixNow(), unixNow(), event.event_id)
        .run();
    } else {
      const delay = Math.min(3_600, 2 ** Math.min(attempts, 12));
      await env.DB.prepare(
        "UPDATE webhook_events SET attempts = ?, last_error = ?, next_attempt_at = ?, updated_at = ? WHERE event_id = ?",
      )
        .bind(attempts, error.slice(0, 1_000), unixNow() + delay, unixNow(), event.event_id)
        .run();
    }
  }
}

async function dispatchSweeps(env: ApiEnv): Promise<void> {
  const now = unixNow();
  const jobs = await all<{ id: string }>(
    env.DB,
    `SELECT id FROM sweep_jobs
    WHERE ((status = 'queued' AND next_attempt_at <= ?) OR (status = 'processing' AND locked_until <= ?))
      AND last_dispatched_at <= ? ORDER BY next_attempt_at LIMIT 100`,
    now,
    now,
    now - 45,
  );
  if (!jobs.length) return;
  await env.SWEEP_QUEUE.sendBatch(
    jobs.map((job) => ({ body: { jobId: job.id } satisfies SweepMessage })),
  );
  await env.DB.batch(
    jobs.map((job) =>
      env.DB.prepare(
        "UPDATE sweep_jobs SET last_dispatched_at = ?, updated_at = ? WHERE id = ? AND status = 'queued'",
      ).bind(now, now, job.id),
    ),
  );
}

export async function all<T>(db: D1Database, sql: string, ...bindings: unknown[]): Promise<T[]> {
  const result = await db
    .prepare(sql)
    .bind(...bindings)
    .all<T>();
  return result.results;
}

export function unixNow(): number {
  return Math.floor(Date.now() / 1_000);
}

export function randomId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`;
}

export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function safeErrorText(error: unknown): string {
  return errorText(error)
    .replace(/https?:\/\/[^\s"'<>]+/gi, "[redacted-url]")
    .replace(/0x[0-9a-f]{128,}/gi, "[redacted-hex]");
}

function toHexString(value: ArrayBuffer): string {
  return [...new Uint8Array(value)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
