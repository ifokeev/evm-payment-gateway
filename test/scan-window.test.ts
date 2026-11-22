import { env, exports } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { counterfactualAddress } from "../src/create2";
import { loadNetworks } from "../src/domain";
import { randomId, runScheduled, syncChain, unixNow } from "../src/monitor";
import type { ApiEnv, IntentRow, NetworkConfig, SweepMessage } from "../src/types";

const bindings = env as unknown as ApiEnv;
const api = (exports as unknown as { default: { fetch(request: Request): Promise<Response> } })
  .default;
const testFactory = "0x3333333333333333333333333333333333333333";
const testTreasury = "0x2222222222222222222222222222222222222222";
const testToken = "0x9999999999999999999999999999999999999999";
const rpcUrl = "https://rpc.window";
const DAY = 86_400;

type Transfer = { to: string; blockNumber: number; amount: number };

let nextSalt = 1;
let headBlock = 0;
let blockTimestamp = 0;
let transfers: Transfer[] = [];
let remoteHashSuffix = new Map<number, string>();
let rpcRequests: Array<{ method: string; params: unknown[] }> = [];

beforeAll(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const outgoing = input instanceof Request ? input : new Request(input, init);
      if (outgoing.url !== `${rpcUrl}/`) throw new Error(`unmocked request: ${outgoing.url}`);
      const payload = JSON.parse(await outgoing.text());
      const requests = (Array.isArray(payload) ? payload : [payload]) as Array<{
        id: number;
        method: string;
        params: unknown[];
      }>;
      rpcRequests.push(...requests);
      const responses = requests.map((rpc) => ({
        jsonrpc: "2.0",
        id: rpc.id,
        result: rpcResult(rpc),
      }));
      return Response.json(Array.isArray(payload) ? responses : responses[0]);
    }),
  );
});

beforeEach(() => {
  headBlock = 0;
  blockTimestamp = unixNow();
  transfers = [];
  remoteHashSuffix = new Map();
  rpcRequests = [];
});

describe("scan window", () => {
  it("scans one new payment among a thousand settled ones and pays it out", async () => {
    const chain = "many-settled";
    const now = unixNow();
    await insertSettledIntents(chain, 1_000, now - 40 * DAY);
    const live = await insertIntent({ chain, startBlock: 50_000, expiresAt: now + 1_800 });
    headBlock = 50_010;
    transfers = [{ to: live.depositAddress, blockNumber: 50_005, amount: 1 }];

    await syncChain(bindings, networkFor(chain));

    expect(logFilters()).toHaveLength(1);
    expect(logFilters()[0]).toMatchObject({ fromBlock: "0xc350", toBlock: "0xc35a" });
    expect(logAddresses(logFilters()[0])).toEqual([live.depositAddress.toLowerCase()]);
    expect(await intentStatus(live.id)).toBe("paid");
    expect(await countRows("payment_transactions", chain)).toBe(1);
    expect(await countRows("sweep_jobs", chain)).toBe(1);
    expect(
      await bindings.DB.prepare(
        "SELECT COUNT(*) AS count FROM webhook_events WHERE payment_intent = ?",
      )
        .bind(live.id)
        .first(),
    ).toEqual({ count: 1 });
  });

  it("keeps detecting a late payment inside the window without crediting it", async () => {
    const chain = "late-inside";
    const now = unixNow();
    const expired = await insertIntent({
      chain,
      startBlock: 1_000,
      status: "expired",
      expiresAt: now - 10 * DAY,
      updatedAt: now - 10 * DAY,
    });
    headBlock = 1_020;
    transfers = [{ to: expired.depositAddress, blockNumber: 1_010, amount: 1 }];

    await syncChain(bindings, networkFor(chain));

    expect(logAddresses(logFilters()[0])).toEqual([expired.depositAddress.toLowerCase()]);
    expect(
      await bindings.DB.prepare(
        "SELECT status, received_units, confirmed_units FROM payment_intents WHERE id = ?",
      )
        .bind(expired.id)
        .first(),
    ).toEqual({ status: "expired", received_units: "0", confirmed_units: "0" });
    expect(await countRows("payment_transactions", chain)).toBe(1);
    expect(
      await bindings.DB.prepare(
        "SELECT status, observed_units FROM sweep_jobs WHERE payment_intent = ?",
      )
        .bind(expired.id)
        .first(),
    ).toEqual({ status: "queued", observed_units: "1" });
    expect(
      await bindings.DB.prepare(
        "SELECT COUNT(*) AS count FROM webhook_events WHERE payment_intent = ?",
      )
        .bind(expired.id)
        .first(),
    ).toEqual({ count: 0 });
  });

  it("stops scanning an intent when it leaves the window and leaves its row untouched", async () => {
    const chain = "leaving-window";
    const now = unixNow();
    const shortWindow = { ...bindings, LATE_PAYMENT_WINDOW_SECONDS: "3600" };
    const inside = await insertIntent({
      chain,
      startBlock: 1_000,
      status: "expired",
      expiresAt: now - 3_000,
      updatedAt: now - 3_000,
    });
    const outside = await insertIntent({
      chain,
      startBlock: 1_000,
      status: "expired",
      expiresAt: now - 3_700,
      updatedAt: now - 3_700,
    });
    const rowBefore = await intentRow(outside.id);
    headBlock = 1_020;
    transfers = [{ to: outside.depositAddress, blockNumber: 1_010, amount: 1 }];

    await syncChain(shortWindow, networkFor(chain));

    expect(logAddresses(logFilters()[0])).toEqual([inside.depositAddress.toLowerCase()]);
    expect(await intentRow(outside.id)).toEqual(rowBefore);
    expect(await countRows("payment_transactions", chain)).toBe(0);
    expect(await countRows("sweep_jobs", chain)).toBe(0);
    expect(await countRows("payment_intents", chain)).toBe(2);
  });

  it("uses a window of 30 days when the setting is absent", async () => {
    const chain = "default-window";
    const now = unixNow();
    const inside = await insertIntent({
      chain,
      startBlock: 1_000,
      status: "expired",
      expiresAt: now - 29 * DAY,
      updatedAt: now - 29 * DAY,
    });
    await insertIntent({
      chain,
      startBlock: 1_000,
      status: "expired",
      expiresAt: now - 31 * DAY,
      updatedAt: now - 31 * DAY,
    });
    headBlock = 1_020;

    await syncChain({ ...bindings, LATE_PAYMENT_WINDOW_SECONDS: undefined }, networkFor(chain));

    expect(logAddresses(logFilters()[0])).toEqual([inside.depositAddress.toLowerCase()]);
  });

  it("rejects a window outside 3,600 to 31,536,000 seconds", async () => {
    const chain = "bad-window";
    for (const invalid of ["3599", "31536001", "abc", ""])
      await expect(
        syncChain({ ...bindings, LATE_PAYMENT_WINDOW_SECONDS: invalid }, networkFor(chain)),
      ).rejects.toThrow("LATE_PAYMENT_WINDOW_SECONDS is invalid");
  });

  it("jumps over blocks that only settled intents could have touched", async () => {
    const chain = "jump-ahead";
    const now = unixNow();
    await insertSettledIntents(chain, 3, now - 40 * DAY, 90);
    const live = await insertIntent({ chain, startBlock: 900_000, expiresAt: now + 1_800 });
    await bindings.DB.batch([
      bindings.DB.prepare(
        "INSERT INTO chain_states (chain, last_scanned, lock_owner, locked_until, updated_at) VALUES (?, 100, '', 0, ?)",
      ).bind(chain, now - 600),
      bindings.DB.prepare(
        "INSERT INTO chain_blocks (chain, block_number, block_hash, parent_hash, block_timestamp) VALUES (?, 100, ?, ?, 1)",
      ).bind(chain, blockHash(100), blockHash(99)),
    ]);
    headBlock = 900_020;

    await syncChain(bindings, networkFor(chain));

    expect(logFilters()).toHaveLength(1);
    expect(logFilters()[0]).toMatchObject({ fromBlock: "0xdbba0", toBlock: "0xdbbb4" });
    expect(logAddresses(logFilters()[0])).toEqual([live.depositAddress.toLowerCase()]);
    expect(
      await bindings.DB.prepare("SELECT last_scanned FROM chain_states WHERE chain = ?")
        .bind(chain)
        .first(),
    ).toEqual({ last_scanned: 900_020 });
  });

  it("does nothing for a chain that has no live intent", async () => {
    const chain = "no-live";
    await insertSettledIntents(chain, 5, unixNow() - 40 * DAY);
    headBlock = 1_020;

    await syncChain(bindings, networkFor(chain));

    expect(rpcRequests).toEqual([]);
    expect(await countRows("chain_states", chain)).toBe(0);
  });

  it("rewinds a reorged payment inside the window", async () => {
    const chain = "reorg-inside";
    const now = unixNow();
    const paid = await insertIntent({
      chain,
      startBlock: 90,
      status: "paid",
      expiresAt: now + 600,
      updatedAt: now - 60,
    });
    await insertTransferRow(paid, chain, 103, 1);
    await storeChainBlocks(chain, 95, 105);
    headBlock = 106;
    for (const blockNumber of [102, 103, 104, 105]) remoteHashSuffix.set(blockNumber, "ee");

    await syncChain(bindings, networkFor(chain));

    expect(await intentStatus(paid.id)).toBe("reorged");
    expect(
      await bindings.DB.prepare(
        "SELECT canonical FROM payment_transactions WHERE payment_intent = ?",
      )
        .bind(paid.id)
        .first(),
    ).toEqual({ canonical: 0 });
    expect(
      await bindings.DB.prepare(
        "SELECT type FROM webhook_events WHERE payment_intent = ? ORDER BY created_at DESC LIMIT 1",
      )
        .bind(paid.id)
        .first(),
    ).toEqual({ type: "payment.reorged" });
  });

  it("keeps scanning a paid intent outside the window while its transfer is inside the reorg history", async () => {
    const chain = "reorg-history";
    const now = unixNow();
    const shortWindow = { ...bindings, LATE_PAYMENT_WINDOW_SECONDS: "3600" };
    const paid = await insertIntent({
      chain,
      startBlock: 90,
      status: "paid",
      expiresAt: now - 7_200,
      updatedAt: now - 7_200,
    });
    await insertTransferRow(paid, chain, 103, 1);
    await storeChainBlocks(chain, 95, 105);
    headBlock = 106;
    for (const blockNumber of [102, 103, 104, 105]) remoteHashSuffix.set(blockNumber, "ee");

    await syncChain(shortWindow, networkFor(chain));

    expect(await intentStatus(paid.id)).toBe("reorged");
  });

  it("drops a paid intent outside the window once its transfer is older than the reorg history", async () => {
    const chain = "reorg-old";
    const now = unixNow();
    const shortWindow = { ...bindings, LATE_PAYMENT_WINDOW_SECONDS: "3600" };
    const paid = await insertIntent({
      chain,
      startBlock: 90,
      status: "paid",
      expiresAt: now - 7_200,
      updatedAt: now - 7_200,
    });
    await insertTransferRow(paid, chain, 103, 1);
    await storeChainBlocks(chain, 400, 405);
    headBlock = 406;

    await syncChain(shortWindow, networkFor(chain));

    expect(rpcRequests).toEqual([]);
    expect(await intentStatus(paid.id)).toBe("paid");
  });
});

describe("scheduled scans", () => {
  it("queues a chain for the maintenance scan only while it has a live intent", async () => {
    const now = unixNow();
    const live = "sched-live";
    const settled = "sched-settled";
    await insertIntent({
      chain: live,
      startBlock: 1,
      status: "expired",
      expiresAt: now - 10 * DAY,
      updatedAt: now - 10 * DAY,
    });
    await insertSettledIntents(settled, 2, now - 40 * DAY);
    const sendBatch = vi.fn(async () => undefined);
    const scheduledEnv = scheduledEnvFor([live, settled], sendBatch);

    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(new Date(Math.floor(now / 900) * 900_000 + 840_000));
      await runScheduled(scheduledEnv);
      expect(sendBatch).not.toHaveBeenCalled();

      vi.setSystemTime(new Date((Math.floor(now / 900) + 1) * 900_000));
      await runScheduled(scheduledEnv);
      expect(sendBatch).toHaveBeenCalledTimes(1);
      expect(sendBatch).toHaveBeenCalledWith([{ body: { chain: live } }]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("queues an open chain every minute and a paid chain while its transfer is in the reorg history", async () => {
    const now = unixNow();
    const open = "sched-open";
    const paid = "sched-paid";
    const idle = "sched-idle";
    await insertIntent({ chain: open, startBlock: 1, expiresAt: now + 600 });
    const recent = await insertIntent({
      chain: paid,
      startBlock: 1,
      status: "paid",
      expiresAt: now - 600,
      updatedAt: now - 600,
    });
    await insertTransferRow(recent, paid, 1_000, 1);
    await storeChainBlocks(paid, 990, 1_010);
    const old = await insertIntent({
      chain: idle,
      startBlock: 1,
      status: "paid",
      expiresAt: now - 600,
      updatedAt: now - 600,
    });
    await insertTransferRow(old, idle, 100, 1);
    await storeChainBlocks(idle, 990, 1_010);
    const sendBatch = vi.fn(async () => undefined);
    const scheduledEnv = scheduledEnvFor([open, paid, idle], sendBatch);

    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(new Date(Math.floor(now / 900) * 900_000 + 60_000));
      await runScheduled(scheduledEnv);
      expect(sendBatch).toHaveBeenCalledWith([
        { body: { chain: open } },
        { body: { chain: paid } },
      ]);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("health", () => {
  it("marks a chain active while it has an open intent", async () => {
    const now = unixNow();
    const open = await insertIntent({ chain: "test", startBlock: 1, expiresAt: now + 600 });
    try {
      expect((await health()).networks.test.active).toBe(true);
      await bindings.DB.prepare("UPDATE payment_intents SET status = 'expired' WHERE id = ?")
        .bind(open.id)
        .run();
      expect((await health()).networks.test.active).toBe(false);
    } finally {
      await bindings.DB.prepare("DELETE FROM payment_intents WHERE id = ?").bind(open.id).run();
    }
  });
});

describe("query plans", () => {
  it("reads the live set through indexes", async () => {
    const chain = "plans";
    const now = unixNow();
    await insertSettledIntents(chain, 50, now - 40 * DAY);
    const live = await insertIntent({ chain, startBlock: 50_000, expiresAt: now + 1_800 });
    headBlock = 50_010;
    transfers = [{ to: live.depositAddress, blockNumber: 50_005, amount: 1 }];
    const statements: string[] = [];
    const spy = new Proxy(bindings.DB, {
      get(target, property) {
        if (property === "prepare")
          return (sql: string) => {
            statements.push(sql);
            return target.prepare(sql);
          };
        const value = Reflect.get(target, property);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    await syncChain({ ...bindings, DB: spy }, networkFor(chain));

    const scheduledEnv = {
      ...scheduledEnvFor(
        [chain],
        vi.fn(async () => undefined),
      ),
      DB: spy,
    };
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      for (const offset of [60_000, 900_000]) {
        vi.setSystemTime(new Date(Math.floor(now / 900) * 900_000 + 900_000 + offset));
        await runScheduled(scheduledEnv);
      }
    } finally {
      vi.useRealTimers();
    }

    const liveQueries = [
      ...new Set(
        statements.filter(
          (sql) =>
            (/status IN \('pending', 'underpaid', 'confirming', 'reorged'\)/.test(sql) &&
              /UNION/.test(sql)) ||
            /FROM payment_transactions WHERE chain = \?1/.test(sql) ||
            /FROM sweep_jobs\s+WHERE chain = \?1/.test(sql),
        ),
      ),
    ];
    expect(liveQueries).toHaveLength(5);
    for (const sql of liveQueries) {
      const detail = await queryPlan(sql);
      expect(
        detail.filter((line) =>
          /^SCAN (payment_intents|payment_transactions|sweep_jobs)\b(?! USING)/.test(line),
        ),
      ).toEqual([]);
    }
  });
});

function scheduledEnvFor(chains: string[], sendBatch: () => Promise<undefined>): ApiEnv {
  const [base] = JSON.parse(bindings.NETWORKS_JSON) as Array<Record<string, unknown>>;
  return {
    ...bindings,
    NETWORKS_JSON: JSON.stringify(
      chains.map((name, index) => ({ ...base, name, chainId: 31_400 + index })),
    ),
    SCAN_QUEUE: { sendBatch } as unknown as Queue<{ chain: string }>,
    SWEEP_QUEUE: { sendBatch: vi.fn() } as unknown as Queue<SweepMessage>,
  };
}

async function queryPlan(sql: string): Promise<string[]> {
  const parameters = Math.max(0, ...[...sql.matchAll(/\?(\d+)/g)].map((match) => Number(match[1])));
  const plan = await bindings.DB.prepare(`EXPLAIN QUERY PLAN ${sql}`)
    .bind(...Array.from({ length: parameters }, () => 1))
    .all<{ detail: string }>();
  return plan.results.map((row) => row.detail);
}

async function health(): Promise<{
  networks: Record<string, { active: boolean; lastScannedBlock: number | null }>;
}> {
  const response = await api.fetch(new Request("https://gateway.test/api/payments/v1/health"));
  expect(response.status).toBe(200);
  return response.json();
}

function networkFor(chain: string): NetworkConfig {
  return {
    ...loadNetworks(bindings.NETWORKS_JSON).get("test")!,
    name: chain,
    rpcUrls: [rpcUrl],
  };
}

type IntentOptions = {
  chain: string;
  startBlock: number;
  status?: IntentRow["status"];
  expiresAt?: number;
  updatedAt?: number;
};

async function insertIntent(
  options: IntentOptions,
): Promise<{ id: string; depositAddress: string }> {
  const [statement, intent] = intentStatement(options);
  await statement.run();
  return intent;
}

function intentStatement(options: IntentOptions) {
  const now = unixNow();
  const salt = `0x${(nextSalt++).toString(16).padStart(64, "0")}` as `0x${string}`;
  const fields = counterfactualAddress(testFactory, salt, testTreasury, testToken);
  const id = randomId("pi");
  const statement = bindings.DB.prepare(`INSERT INTO payment_intents
    (id,idempotency_key,request_hash,kind,external_id,chain,chain_id,asset,token_address,decimals,expected_amount,expected_units,
     deposit_address,intent_salt,factory_address,forwarder_init_code_hash,start_block,confirmations,status,expires_at,metadata,created_at,updated_at)
     VALUES (?,?,?,'payment',?,?,1337,'USDC',?,6,'0.000001','1',?,?,?,?,?,2,?,?,'{}',?,?)`).bind(
    id,
    randomId("idem"),
    "1".repeat(64),
    `${options.chain}-${id}`,
    options.chain,
    testToken,
    fields.address,
    salt,
    testFactory,
    fields.initCodeHash,
    options.startBlock,
    options.status ?? "pending",
    options.expiresAt ?? now + 1_800,
    options.updatedAt ?? now,
    options.updatedAt ?? now,
  );
  return [statement, { id, depositAddress: fields.address }] as const;
}

async function insertSettledIntents(
  chain: string,
  count: number,
  settledAt: number,
  startBlock = 1,
): Promise<void> {
  for (let offset = 0; offset < count; offset += 100) {
    const batch = Array.from(
      { length: Math.min(100, count - offset) },
      () =>
        intentStatement({
          chain,
          startBlock,
          status: "expired",
          expiresAt: settledAt,
          updatedAt: settledAt,
        })[0],
    );
    await bindings.DB.batch(batch);
  }
}

async function insertTransferRow(
  intent: { id: string; depositAddress: string },
  chain: string,
  blockNumber: number,
  amount: number,
): Promise<void> {
  await bindings.DB.prepare(`INSERT INTO payment_transactions
    (id,payment_intent,chain,tx_hash,event_index,asset,from_address,to_address,amount_units,block_number,block_hash,block_timestamp,canonical)
    VALUES (?,?,?,?,0,'USDC',?,?,?,?,?,?,1)`)
    .bind(
      randomId("ptx"),
      intent.id,
      chain,
      `0x${crypto.randomUUID().replaceAll("-", "").padEnd(64, "0")}`,
      `0x${"5".repeat(40)}`,
      intent.depositAddress,
      String(amount),
      blockNumber,
      blockHash(blockNumber),
      unixNow() - 100,
    )
    .run();
}

async function storeChainBlocks(chain: string, first: number, last: number): Promise<void> {
  const statements = [
    bindings.DB.prepare(
      `INSERT INTO chain_states (chain, last_scanned, lock_owner, locked_until, updated_at)
       VALUES (?, ?, '', 0, ?) ON CONFLICT(chain) DO UPDATE SET last_scanned = excluded.last_scanned`,
    ).bind(chain, last, unixNow() - 60),
  ];
  for (let blockNumber = first; blockNumber <= last; blockNumber++)
    statements.push(
      bindings.DB.prepare(
        "INSERT INTO chain_blocks (chain, block_number, block_hash, parent_hash, block_timestamp) VALUES (?, ?, ?, ?, 1)",
      ).bind(chain, blockNumber, blockHash(blockNumber), blockHash(blockNumber - 1)),
    );
  await bindings.DB.batch(statements);
}

async function intentRow(id: string): Promise<unknown> {
  return bindings.DB.prepare("SELECT * FROM payment_intents WHERE id = ?").bind(id).first();
}

async function intentStatus(id: string): Promise<string | undefined> {
  return (
    await bindings.DB.prepare("SELECT status FROM payment_intents WHERE id = ?")
      .bind(id)
      .first<{ status: string }>()
  )?.status;
}

async function countRows(table: string, chain: string): Promise<number> {
  const row = await bindings.DB.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE chain = ?`)
    .bind(chain)
    .first<{ count: number }>();
  return row?.count ?? 0;
}

function logFilters(): Array<{ fromBlock: string; toBlock: string; topics: unknown[] }> {
  return rpcRequests
    .filter((rpc) => rpc.method === "eth_getLogs")
    .map((rpc) => rpc.params[0] as { fromBlock: string; toBlock: string; topics: unknown[] });
}

function logAddresses(filter: { topics: unknown[] }): string[] {
  return (filter.topics[2] as string[]).map((topic) => `0x${topic.slice(26)}`);
}

function blockHash(blockNumber: number): string {
  const suffix = remoteHashSuffix.get(blockNumber) ?? "";
  return `0x${`${blockNumber.toString(16)}${suffix}`.padStart(64, "0")}`;
}

function rpcResult(rpc: { method: string; params: unknown[] }): unknown {
  if (rpc.method === "eth_chainId") return "0x539";
  if (rpc.method === "eth_blockNumber") return `0x${headBlock.toString(16)}`;
  if (rpc.method === "eth_getBalance") return "0x0";
  if (rpc.method === "eth_getLogs") {
    const filter = rpc.params[0] as { fromBlock: string; toBlock: string; topics: unknown[] };
    const addresses = logAddresses(filter);
    return transfers
      .filter(
        (transfer) =>
          addresses.includes(transfer.to.toLowerCase()) &&
          transfer.blockNumber >= Number(filter.fromBlock) &&
          transfer.blockNumber <= Number(filter.toBlock),
      )
      .map((transfer, index) => transferLog(transfer, index));
  }
  if (rpc.method === "eth_getBlockByNumber") {
    const blockNumber = Number(BigInt(rpc.params[0] as string));
    return {
      baseFeePerGas: "0x1",
      difficulty: "0x0",
      extraData: "0x",
      gasLimit: "0x1c9c380",
      gasUsed: "0x0",
      hash: blockHash(blockNumber),
      logsBloom: `0x${"0".repeat(512)}`,
      miner: "0x0000000000000000000000000000000000000000",
      mixHash: `0x${"0".repeat(64)}`,
      nonce: "0x0000000000000000",
      number: rpc.params[0],
      parentHash: blockHash(Math.max(0, blockNumber - 1)),
      receiptsRoot: `0x${"1".repeat(64)}`,
      sha3Uncles: `0x${"2".repeat(64)}`,
      size: "0x1",
      stateRoot: `0x${"3".repeat(64)}`,
      timestamp: `0x${blockTimestamp.toString(16)}`,
      totalDifficulty: "0x0",
      transactions: [],
      transactionsRoot: `0x${"4".repeat(64)}`,
      uncles: [],
    };
  }
  throw new Error(`unexpected RPC method: ${rpc.method}`);
}

function transferLog(transfer: Transfer, index: number) {
  return {
    address: testToken,
    blockHash: blockHash(transfer.blockNumber),
    blockNumber: `0x${transfer.blockNumber.toString(16)}`,
    data: `0x${transfer.amount.toString(16).padStart(64, "0")}`,
    logIndex: `0x${index.toString(16)}`,
    removed: false,
    topics: [
      "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef",
      `0x${"0".repeat(24)}${"5".repeat(40)}`,
      `0x${"0".repeat(24)}${transfer.to.slice(2).toLowerCase()}`,
    ],
    transactionHash: `0x${(0xa000 + transfer.blockNumber + index).toString(16).padStart(64, "0")}`,
    transactionIndex: "0x0",
  };
}
