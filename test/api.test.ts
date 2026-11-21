import { env, exports } from "cloudflare:workers";
import { encodeFunctionData, erc20Abi, type Hex, keccak256, serializeTransaction } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  PAYMENT_FORWARDER_FACTORY_RUNTIME_CODE as factoryCode,
  PAYMENT_FORWARDER_FACTORY_RUNTIME_CODE_HASH as factoryCodeHash,
} from "../src/contracts.generated";
import { collectionCall, counterfactualAddress } from "../src/create2";
import { loadNetworks } from "../src/domain";
import {
  deliverWebhooks,
  expirePendingIntents,
  randomId,
  recalculateChain,
  rewindCollections,
  runScheduled,
  safeErrorText,
  syncChain,
  unixNow,
} from "../src/monitor";
import type {
  ApiEnv,
  IntentRow,
  NetworkConfig,
  SweepCoordinatorService,
  SweepMessage,
} from "../src/types";
import { reconcileWithdrawals } from "../src/withdrawals";

const bindings = env as unknown as ApiEnv;
const workerExports = exports as unknown as {
  default: { fetch(request: Request): Promise<Response> };
  SweepCoordinator: SweepCoordinatorService;
};
const api = workerExports.default;
const coordinator = workerExports.SweepCoordinator;
const apiKey = "test-api-key-at-least-24-characters";
let webhookResponder: ((request: Request) => Promise<Response>) | undefined;
let batchRpcResponder: ((request: Request) => Promise<Response>) | undefined;
let rpcResponder: ((request: Request) => Promise<Response>) | undefined;
let rpcFactoryCode: `0x${string}` = factoryCode;
const testFactory = "0x3333333333333333333333333333333333333333";
const treasury = privateKeyToAccount(
  "0x1111111111111111111111111111111111111111111111111111111111111111",
);
const testTreasury = treasury.address;
const testToken = "0x9999999999999999999999999999999999999999";
const relayer = privateKeyToAccount(
  "0xabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcd",
);

beforeAll(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const outgoing = input instanceof Request ? input : new Request(input, init);
      if (outgoing.url === "https://rpc.test/") {
        if (rpcResponder) return rpcResponder(outgoing);
        const request = JSON.parse(await outgoing.text());
        const result =
          request.method === "eth_chainId"
            ? "0x539"
            : request.method === "eth_blockNumber"
              ? "0x7b"
              : request.method === "eth_getCode"
                ? rpcFactoryCode
                : null;
        return Response.json({ jsonrpc: "2.0", id: request.id, result });
      }
      if (outgoing.url === "https://rpc.batch/" && batchRpcResponder)
        return batchRpcResponder(outgoing);
      if (outgoing.url === "https://webhook.test/events" && webhookResponder)
        return webhookResponder(outgoing);
      throw new Error(`unmocked request: ${outgoing.url}`);
    }),
  );
});

beforeEach(() => {
  rpcFactoryCode = factoryCode;
  batchRpcResponder = undefined;
  rpcResponder = undefined;
});

describe("deposit API", () => {
  it("keeps health public and every deposit read private", async () => {
    expect((await api.fetch(new Request("https://gateway.test/health"))).status).toBe(200);
    expect(
      (await api.fetch(new Request("https://gateway.test/api/v1/deposits/missing"))).status,
    ).toBe(401);
  });

  it("reports an active chain stale when failed scans do not advance it", async () => {
    const created = await create(randomId("health-scan"), {
      amount: "1",
      metadata: {},
    });
    const intent = await created.json<{ id: string }>();
    const stored = await bindings.DB.prepare("SELECT start_block FROM deposit_intents WHERE id = ?")
      .bind(intent.id)
      .first<{ start_block: number }>();
    const chain = "health-failure";
    const staleAt = unixNow() - 301;
    const network = {
      ...loadNetworks(bindings.NETWORKS_JSON).get("test")!,
      name: chain,
      rpcUrls: ["https://rpc.batch"],
    } satisfies NetworkConfig;
    try {
      await bindings.DB.batch([
        bindings.DB.prepare(
          "UPDATE deposit_intents SET chain = ?, status = 'pending' WHERE id = ?",
        ).bind(chain, intent.id),
        bindings.DB.prepare(`INSERT INTO chain_states
          (chain,last_scanned,lock_owner,locked_until,updated_at) VALUES (?,?,'',0,?)
          ON CONFLICT(chain) DO UPDATE SET last_scanned = excluded.last_scanned,
            lock_owner = '', locked_until = 0, updated_at = excluded.updated_at`).bind(
          chain,
          stored!.start_block - 1,
          staleAt,
        ),
      ]);
      batchRpcResponder = async () => {
        throw new Error("RPC unavailable");
      };
      await expect(syncChain(bindings, network)).rejects.toThrow("RPC unavailable");
      expect(
        await bindings.DB.prepare(
          "SELECT updated_at, lock_owner, locked_until FROM chain_states WHERE chain = ?",
        )
          .bind(chain)
          .first(),
      ).toEqual({ updated_at: staleAt, lock_owner: "", locked_until: 0 });

      const response = await api.fetch(new Request("https://gateway.test/health"));
      expect(await response.json()).toMatchObject({
        ok: false,
        staleChains: [chain],
      });
    } finally {
      await bindings.DB.batch([
        bindings.DB.prepare("DELETE FROM deposit_intents WHERE id = ?").bind(intent.id),
        bindings.DB.prepare("DELETE FROM chain_blocks WHERE chain = ?").bind(chain),
        bindings.DB.prepare("DELETE FROM chain_states WHERE chain = ?").bind(chain),
      ]);
    }
  });

  it("creates, polls, and safely replays an exact deposit intent", async () => {
    const key = randomId("idem");
    const first = await create(key, { amount: "0010.250000", metadata: { z: 1, a: 2 } });
    expect(first.status).toBe(201);
    const body = await first.json<Record<string, unknown>>();
    expect(body).not.toHaveProperty("kind");
    expect(body.expectedAmount).toBe("10.25");
    expect(body.expectedUnits).toBe("10250000");
    expect(body.remainingAmount).toBe("10.25");
    expect(body.remainingUnits).toBe("10250000");
    expect(body.paymentUri).toContain("@1337/transfer");
    expect(body.qrCodeDataUrl).toMatch(/^data:image\/svg\+xml;base64,/);
    expect(body.topUpPaymentUri).toBe(body.paymentUri);
    expect(body.topUpQrCodeDataUrl).toBe(body.qrCodeDataUrl);
    const stored = await bindings.DB.prepare(
      "SELECT intent_salt, forwarder_init_code_hash, treasury_address FROM deposit_intents WHERE id = ?",
    )
      .bind(body.id)
      .first<{
        intent_salt: `0x${string}`;
        forwarder_init_code_hash: `0x${string}`;
        treasury_address: string;
      }>();
    const network = loadNetworks(bindings.NETWORKS_JSON).get("test")!;
    const expected = counterfactualAddress(
      network.factoryAddress,
      stored!.intent_salt,
      network.treasuryAddress,
      network.tokens.USDC.address,
    );
    expect(body.depositAddress).toBe(expected.address);
    expect(stored?.forwarder_init_code_hash).toBe(expected.initCodeHash);
    expect(stored?.treasury_address).toBe(network.treasuryAddress);

    const replay = await create(key, { amount: "10.25", metadata: { a: 2, z: 1 } });
    expect(replay.status).toBe(200);
    expect((await replay.json<{ id: string }>()).id).toBe(body.id);
    expect((await create(key, { amount: "10.26", metadata: { a: 2, z: 1 } })).status).toBe(409);

    const poll = await api.fetch(
      authorizedRequest(`https://gateway.test/api/v1/deposits/${body.id}`),
    );
    expect(poll.status).toBe(200);
    expect((await poll.json<{ status: string }>()).status).toBe("pending");

    await bindings.DB.prepare(
      "UPDATE deposit_intents SET received_units = '4000000', status = 'underpaid' WHERE id = ?",
    )
      .bind(body.id)
      .run();
    const partial = await (
      await api.fetch(authorizedRequest(`https://gateway.test/api/v1/deposits/${body.id}`))
    ).json<Record<string, unknown>>();
    expect(partial).toMatchObject({
      status: "underpaid",
      remainingAmount: "6.25",
      remainingUnits: "6250000",
      paymentUri: body.paymentUri,
    });
    expect(partial.topUpPaymentUri).toContain("uint256=6250000");
    expect(partial.topUpPaymentUri).not.toBe(body.paymentUri);
    expect(partial.topUpQrCodeDataUrl).toMatch(/^data:image\/svg\+xml;base64,/);

    await bindings.DB.prepare("UPDATE deposit_intents SET expires_at = ? WHERE id = ?")
      .bind(unixNow() - 1, body.id)
      .run();
    const expired = await (
      await api.fetch(authorizedRequest(`https://gateway.test/api/v1/deposits/${body.id}`))
    ).json<Record<string, unknown>>();
    expect(expired).toMatchObject({
      expired: true,
      remainingAmount: "6.25",
      remainingUnits: "6250000",
    });
    expect(expired.topUpPaymentUri).toBeNull();
    expect(expired.topUpQrCodeDataUrl).toBeNull();

    await bindings.DB.prepare(
      "UPDATE deposit_intents SET received_units = '11000000', confirmed_units = '11000000', status = 'paid' WHERE id = ?",
    )
      .bind(body.id)
      .run();
    const overpaid = await (
      await api.fetch(authorizedRequest(`https://gateway.test/api/v1/deposits/${body.id}`))
    ).json<Record<string, unknown>>();
    expect(overpaid).toMatchObject({ remainingAmount: "0", remainingUnits: "0" });
    expect(overpaid.topUpPaymentUri).toBeNull();
    expect(overpaid.topUpQrCodeDataUrl).toBeNull();
  });

  it("creates independent intents concurrently and collapses racing retries", async () => {
    const prefix = `concurrent-${crypto.randomUUID()}`;
    const distinct = await Promise.all(
      Array.from({ length: 12 }, (_, index) =>
        create(`${prefix}-${index}`, { amount: "1", metadata: { index } }),
      ),
    );
    expect(distinct.map((response) => response.status)).toEqual(Array(12).fill(201));
    const distinctBodies = await Promise.all(
      distinct.map((response) => response.json<{ id: string; depositAddress: string }>()),
    );
    expect(new Set(distinctBodies.map((intent) => intent.id)).size).toBe(12);
    expect(new Set(distinctBodies.map((intent) => intent.depositAddress)).size).toBe(12);

    const retryKey = `${prefix}-retry`;
    const retries = await Promise.all(
      Array.from({ length: 6 }, () => create(retryKey, { amount: "2", metadata: { retry: true } })),
    );
    expect(retries.filter((response) => response.status === 201)).toHaveLength(1);
    expect(retries.every((response) => response.status === 200 || response.status === 201)).toBe(
      true,
    );
    const retryBodies = await Promise.all(
      retries.map((response) => response.json<{ id: string }>()),
    );
    expect(new Set(retryBodies.map((intent) => intent.id)).size).toBe(1);

    const conflictKey = `${prefix}-conflict`;
    const conflicts = await Promise.all([
      create(conflictKey, { amount: "3", metadata: {} }),
      create(conflictKey, { amount: "4", metadata: {} }),
    ]);
    expect(conflicts.map((response) => response.status).sort()).toEqual([201, 409]);
    expect(
      await bindings.DB.prepare(
        "SELECT COUNT(*) AS count FROM deposit_intents WHERE instr(idempotency_key, ?) = 1",
      )
        .bind(prefix)
        .first(),
    ).toEqual({ count: 14 });
    await bindings.DB.prepare("DELETE FROM deposit_intents WHERE instr(idempotency_key, ?) = 1")
      .bind(prefix)
      .run();
  });

  it("fails closed when the configured factory code is absent or changed", async () => {
    rpcFactoryCode = "0x6001";
    const response = await create(randomId("idem"), { amount: "1", metadata: {} });
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "network RPC or factory unavailable" });
  });

  it("rejects boundary bypasses and unknown JSON fields", async () => {
    const request = authorizedRequest("https://gateway.test/api/v1/deposits", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": randomId("idem") },
      body: JSON.stringify({
        purpose: "deposit",
        externalId: "order",
        chain: "test",
        asset: "USDC",
        amount: "1",
        unexpected: true,
      }),
    });
    expect((await api.fetch(request)).status).toBe(400);
    const wrongType = authorizedRequest("https://gateway.test/api/v1/deposits", {
      method: "POST",
      headers: { "Content-Type": "text/plain", "Idempotency-Key": randomId("idem") },
      body: "{}",
    });
    expect((await api.fetch(wrongType)).status).toBe(415);
    const jsonp = authorizedRequest("https://gateway.test/api/v1/deposits", {
      method: "POST",
      headers: { "Content-Type": "application/jsonp", "Idempotency-Key": randomId("idem") },
      body: "{}",
    });
    expect((await api.fetch(jsonp)).status).toBe(415);

    const depth = 5_000;
    const deeplyNested = authorizedRequest("https://gateway.test/api/v1/deposits", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": randomId("idem") },
      body: `{"purpose":"deposit","externalId":"deep","chain":"test","asset":"USDC","amount":"1","metadata":${'{"next":'.repeat(depth)}null${"}".repeat(depth)}}`,
    });
    const deepResponse = await api.fetch(deeplyNested);
    expect(deepResponse.status).toBe(400);
    expect(await deepResponse.json()).toEqual({ error: "metadata is too deeply nested" });
  });

  it("accepts only deposit purposes", async () => {
    const deposit = await create(randomId("idem"), { amount: "1", metadata: {} });
    expect(deposit.status).toBe(201);
    expect(await deposit.json<{ purpose: string }>()).toMatchObject({ purpose: "deposit" });

    const invalid = authorizedRequest("https://gateway.test/api/v1/deposits", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": randomId("idem") },
      body: JSON.stringify({
        kind: "payment",
        purpose: "deposit",
        externalId: "unsupported-kind",
        chain: "test",
        asset: "USDC",
        amount: "1",
      }),
    });
    expect(await (await api.fetch(invalid)).json()).toEqual({
      error: "invalid JSON body",
    });
    const invalidPurpose = await create(randomId("idem"), {
      amount: "1",
      metadata: {},
      purpose: "checkout",
    });
    expect(await invalidPurpose.json()).toEqual({
      error: "purpose must be deposit",
    });
    const schema = await bindings.DB.prepare(
      "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'deposit_intents'",
    ).first<{ sql: string }>();
    expect(schema?.sql).not.toContain("kind");
    expect(schema?.sql).toContain("purpose");
    expect(
      (
        await bindings.DB.prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('payment_intents', 'payment_transactions', 'withdrawals')",
        ).all()
      ).results,
    ).toEqual([]);
    const foreignKeys = await bindings.DB.prepare(`
      SELECT 'deposit_transfers' AS table_name, name FROM pragma_table_info('deposit_transfers')
      WHERE name IN ('payment_intent', 'deposit_intent')
      UNION ALL
      SELECT 'webhook_events', name FROM pragma_table_info('webhook_events')
      WHERE name IN ('payment_intent', 'deposit_intent')
      UNION ALL
      SELECT 'sweep_jobs', name FROM pragma_table_info('sweep_jobs')
      WHERE name IN ('payment_intent', 'deposit_intent')
      ORDER BY table_name`).all<{ table_name: string; name: string }>();
    expect(foreignKeys.results).toEqual([
      { table_name: "deposit_transfers", name: "deposit_intent" },
      { table_name: "sweep_jobs", name: "deposit_intent" },
      { table_name: "webhook_events", name: "deposit_intent" },
    ]);
  });

  it("redacts RPC credentials and raw transactions from errors", () => {
    const message = safeErrorText(
      new Error(`RPC https://rpc.test/v3/private-key rejected 0x${"ab".repeat(128)}`),
    );
    expect(message).toBe("RPC [redacted-url] rejected [redacted-hex]");
  });
});

describe("withdrawal API", () => {
  it("pages the signer inbox and removes expired proposals", async () => {
    const created = await Promise.all(
      ["first", "second"].map(async (name, index) => {
        const response = await createWithdrawal(randomId(`signer-${name}`), {
          externalId: `signer-${name}`,
          asset: "USDC",
          amount: String(index + 1),
          destinationAddress: `0x${String(index + 5).repeat(40)}`,
        });
        expect(response.status).toBe(201);
        return response.json<{ id: string }>();
      }),
    );

    const firstPage = await (
      await api.fetch(
        authorizedRequest(
          "https://gateway.test/api/v1/withdrawals?status=awaiting_signature&limit=1",
        ),
      )
    ).json<{ items: Array<Record<string, unknown>>; nextCursor: string | null }>();
    expect(firstPage.items).toHaveLength(1);
    expect(firstPage.items[0]).toMatchObject({ status: "awaiting_signature" });
    expect(firstPage.items[0]).not.toHaveProperty("proposal");
    expect(firstPage.nextCursor).toMatch(/^\d+:wd_/);

    const secondPage = await (
      await api.fetch(
        authorizedRequest(
          `https://gateway.test/api/v1/withdrawals?limit=1&cursor=${encodeURIComponent(firstPage.nextCursor!)}`,
        ),
      )
    ).json<{ items: Array<{ id: string }>; nextCursor: string | null }>();
    expect(secondPage.items).toHaveLength(1);
    expect(new Set([firstPage.items[0].id, secondPage.items[0].id])).toEqual(
      new Set(created.map((row) => row.id)),
    );
    expect(secondPage.nextCursor).toBeNull();

    await bindings.DB.prepare("UPDATE withdrawal_intents SET expires_at = ? WHERE id = ?")
      .bind(unixNow() - 1, created[0].id)
      .run();
    const refreshed = await (
      await api.fetch(authorizedRequest("https://gateway.test/api/v1/withdrawals"))
    ).json<{ items: Array<{ id: string }> }>();
    expect(refreshed.items.map((row) => row.id)).not.toContain(created[0].id);
    expect(
      await bindings.DB.prepare("SELECT status FROM withdrawal_intents WHERE id = ?")
        .bind(created[0].id)
        .first(),
    ).toEqual({ status: "expired" });

    expect(
      (
        await api.fetch(
          authorizedRequest("https://gateway.test/api/v1/withdrawals?status=complete"),
        )
      ).status,
    ).toBe(400);
    await Promise.all(
      created.map((row) =>
        bindings.DB.prepare("DELETE FROM withdrawal_intents WHERE id = ?").bind(row.id).run(),
      ),
    );
  });

  it("accepts only withdrawal purposes", async () => {
    const invalidPurpose = await createWithdrawal(randomId("withdrawal-purpose"), {
      externalId: "invalid-withdrawal-purpose",
      purpose: "swap",
      asset: "USDC",
      amount: "1",
      destinationAddress: "0x8888888888888888888888888888888888888888",
    });
    expect(invalidPurpose.status).toBe(400);
    expect(await invalidPurpose.json()).toEqual({
      error: "purpose must be withdrawal",
    });

    const invalid = await api.fetch(
      authorizedRequest("https://gateway.test/api/v1/withdrawals", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": randomId("withdrawal-purpose"),
        },
        body: JSON.stringify({
          purpose: "deposit",
          externalId: "invalid-purpose",
          chain: "test",
          asset: "USDC",
          amount: "1",
          destinationAddress: "0x8888888888888888888888888888888888888888",
        }),
      }),
    );
    expect(await invalid.json()).toEqual({
      error: "purpose must be withdrawal",
    });
  });

  it("queues terminal withdrawal webhooks once", async () => {
    const created = await createWithdrawal(randomId("withdrawal-webhook"), {
      externalId: "withdrawal-webhook",
      asset: "USDC",
      amount: "1",
      destinationAddress: "0x8888888888888888888888888888888888888888",
    });
    const withdrawal = await created.json<{ id: string }>();
    const now = unixNow();
    try {
      await bindings.DB.prepare(
        "UPDATE withdrawal_intents SET status = 'complete', completed_at = ? WHERE id = ?",
      )
        .bind(now, withdrawal.id)
        .run();
      await reconcileWithdrawals(bindings);
      await reconcileWithdrawals(bindings);
      const succeeded = await bindings.DB.prepare(
        `SELECT type, subject_type, subject_id, deposit_intent, body FROM webhook_events
         WHERE subject_type = 'withdrawal' AND subject_id = ? AND type = 'withdrawal.succeeded'`,
      )
        .bind(withdrawal.id)
        .first<{
          type: string;
          subject_type: string;
          subject_id: string;
          deposit_intent: string | null;
          body: string;
        }>();
      expect(succeeded).toMatchObject({
        type: "withdrawal.succeeded",
        subject_type: "withdrawal",
        subject_id: withdrawal.id,
        deposit_intent: null,
      });
      expect(JSON.parse(succeeded!.body).data.withdrawal).toMatchObject({
        id: withdrawal.id,
        status: "complete",
      });
      expect(
        await bindings.DB.prepare(
          "SELECT COUNT(*) AS count FROM webhook_events WHERE subject_type = 'withdrawal' AND subject_id = ?",
        )
          .bind(withdrawal.id)
          .first(),
      ).toEqual({ count: 1 });

      await bindings.DB.prepare(
        "UPDATE withdrawal_intents SET status = 'failed', completed_at = NULL WHERE id = ?",
      )
        .bind(withdrawal.id)
        .run();
      await reconcileWithdrawals(bindings);
      expect(
        await bindings.DB.prepare(
          "SELECT type FROM webhook_events WHERE subject_type = 'withdrawal' AND subject_id = ? AND type = 'withdrawal.failed'",
        )
          .bind(withdrawal.id)
          .first(),
      ).toEqual({ type: "withdrawal.failed" });
    } finally {
      await bindings.DB.prepare(
        "DELETE FROM webhook_events WHERE subject_type = 'withdrawal' AND subject_id = ?",
      )
        .bind(withdrawal.id)
        .run();
      await bindings.DB.prepare("DELETE FROM withdrawal_intents WHERE id = ?")
        .bind(withdrawal.id)
        .run();
    }
  });

  it("creates and replays a batch of withdrawal proposals", async () => {
    const key = randomId("withdrawal-batch");
    const request = () =>
      api.fetch(
        authorizedRequest("https://gateway.test/api/v1/withdrawals/batch", {
          method: "POST",
          headers: { "Content-Type": "application/json", "Idempotency-Key": key },
          body: JSON.stringify({
            withdrawals: [
              {
                externalId: "batch-1",
                chain: "test",
                asset: "USDC",
                amount: "1",
                destinationAddress: "0x8888888888888888888888888888888888888888",
              },
              {
                externalId: "batch-2",
                chain: "test",
                asset: "USDC",
                amount: "2",
                destinationAddress: "0x7777777777777777777777777777777777777777",
              },
            ],
          }),
        }),
      );
    const first = await request();
    expect(first.status).toBe(201);
    const body = await first.json<{
      batchId: string;
      summary: { created: number; replayed: number; failed: number };
      items: Array<{ status: number; withdrawal: { id: string } }>;
    }>();
    expect(body.batchId).toMatch(/^batch_[0-9a-f]{32}$/);
    expect(body.summary).toEqual({ created: 2, replayed: 0, failed: 0 });
    expect(body.items).toHaveLength(2);
    const ids = body.items.map((item) => item.withdrawal.id);
    try {
      const replay = await request();
      expect(replay.status).toBe(200);
      const replayed = await replay.json<{
        summary: { created: number; replayed: number; failed: number };
        items: Array<{ status: number; withdrawal: { id: string } }>;
      }>();
      expect(replayed.summary).toEqual({ created: 0, replayed: 2, failed: 0 });
      expect(replayed.items.map((item) => item.withdrawal.id)).toEqual(ids);
      const inbox = await api.fetch(
        authorizedRequest("https://gateway.test/api/v1/withdrawals?status=awaiting_signature"),
      );
      const inboxBody = await inbox.json<{ items: Array<{ id: string }> }>();
      expect(inboxBody.items.map((item) => item.id)).toEqual(expect.arrayContaining(ids));
    } finally {
      await Promise.all(
        ids.map((id) =>
          bindings.DB.prepare("DELETE FROM withdrawal_intents WHERE id = ?").bind(id).run(),
        ),
      );
    }
  });

  it("returns per-item failures for a withdrawal batch", async () => {
    const key = randomId("withdrawal-batch-partial");
    const response = await api.fetch(
      authorizedRequest("https://gateway.test/api/v1/withdrawals/batch", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Idempotency-Key": key },
        body: JSON.stringify({
          withdrawals: [
            {
              externalId: "batch-valid",
              chain: "test",
              asset: "USDC",
              amount: "1",
              destinationAddress: "0x8888888888888888888888888888888888888888",
            },
            {
              externalId: "batch-invalid",
              chain: "test",
              asset: "USDC",
              amount: "1",
              destinationAddress: "0x0000000000000000000000000000000000000000",
            },
          ],
        }),
      }),
    );
    expect(response.status).toBe(207);
    const body = await response.json<{
      summary: { created: number; replayed: number; failed: number };
      items: Array<{ status: number; withdrawal?: { id: string }; error?: string }>;
    }>();
    expect(body.summary).toEqual({ created: 1, replayed: 0, failed: 1 });
    expect(body.items[1]).toEqual({ index: 1, status: 400, error: "invalid destinationAddress" });
    const createdId = body.items[0].withdrawal?.id;
    try {
      expect(createdId).toMatch(/^wd_/);
    } finally {
      if (createdId) {
        await bindings.DB.prepare("DELETE FROM withdrawal_intents WHERE id = ?")
          .bind(createdId)
          .run();
      }
    }
  });

  it("rejects withdrawals to its own deposit forwarders", async () => {
    const payment = await (
      await create(randomId("circular-payment"), { amount: "1", metadata: {} })
    ).json<{ id: string; depositAddress: string }>();
    const response = await createWithdrawal(randomId("circular-withdrawal"), {
      externalId: "circular",
      asset: "USDC",
      amount: "1",
      destinationAddress: payment.depositAddress,
    });
    const body = await response.json<{ id?: string; error?: string }>();
    try {
      expect(response.status).toBe(400);
      expect(body.error).toBe("invalid withdrawal destination");
    } finally {
      if (body.id)
        await bindings.DB.prepare("DELETE FROM withdrawal_intents WHERE id = ?")
          .bind(body.id)
          .run();
      await bindings.DB.prepare("DELETE FROM deposit_intents WHERE id = ?").bind(payment.id).run();
    }
  });

  it("accepts only an exact externally signed transfer and confirms it", async () => {
    const destination = "0x5555555555555555555555555555555555555555";
    const created = await createWithdrawal(randomId("withdrawal"), {
      externalId: "withdrawal-1",
      asset: "USDC",
      amount: "1.25",
      destinationAddress: destination,
    });
    expect(created.status).toBe(201);
    const withdrawal = await created.json<{
      id: string;
      amountUnits: string;
      sourceAddress: string;
      status: string;
    }>();
    expect(withdrawal).toMatchObject({
      amountUnits: "1250000",
      sourceAddress: testTreasury,
      status: "awaiting_signature",
    });

    const proposalResponse = await api.fetch(
      authorizedRequest(`https://gateway.test/api/v1/withdrawals/${withdrawal.id}/proposal`),
    );
    expect(proposalResponse.status).toBe(200);
    const proposal = await proposalResponse.json<{
      proposal: { to: string; value: string; data: Hex };
    }>();
    expect(proposal.proposal).toMatchObject({ to: testToken, value: "0" });

    const wrongData = encodeFunctionData({
      abi: erc20Abi,
      functionName: "transfer",
      args: ["0x6666666666666666666666666666666666666666", 1_250_000n],
    });
    const baseTransaction = {
      type: "legacy",
      chainId: 1337,
      nonce: 7,
      to: testToken,
      value: 0n,
      gas: 80_000n,
      gasPrice: 1n,
      data: proposal.proposal.data,
    } as const;
    const attacker = privateKeyToAccount(
      "0x2222222222222222222222222222222222222222222222222222222222222222",
    );
    const tampered = await Promise.all([
      treasury.signTransaction({ ...baseTransaction, data: wrongData }),
      attacker.signTransaction(baseTransaction),
      treasury.signTransaction({ ...baseTransaction, chainId: 1 }),
      treasury.signTransaction({ ...baseTransaction, value: 1n }),
      treasury.signTransaction({ ...baseTransaction, gas: 500_001n }),
      treasury.signTransaction({ ...baseTransaction, gasPrice: 1_000_000_001n }),
    ]);
    for (const rawTransaction of tampered) {
      const rejected = await api.fetch(
        authorizedRequest(`https://gateway.test/api/v1/withdrawals/${withdrawal.id}/transaction`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ rawTransaction }),
        }),
      );
      expect(rejected.status).toBe(400);
    }
    const invalidSignature = serializeTransaction(baseTransaction, {
      r: "0x0",
      s: "0x1",
      v: 2709n,
    });
    const invalidSignatureResponse = await api.fetch(
      authorizedRequest(`https://gateway.test/api/v1/withdrawals/${withdrawal.id}/transaction`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rawTransaction: invalidSignature }),
      }),
    );
    expect(invalidSignatureResponse.status).toBe(400);
    expect(await invalidSignatureResponse.json()).toEqual({
      error: "invalid raw transaction signature",
    });
    expect(
      await bindings.DB.prepare(
        "SELECT COUNT(*) AS count FROM withdrawal_transactions WHERE withdrawal = ?",
      )
        .bind(withdrawal.id)
        .first(),
    ).toEqual({ count: 0 });

    const raw = await treasury.signTransaction(baseTransaction);
    const txHash = keccak256(raw);
    const blockHash = `0x${"7".repeat(64)}` as Hex;
    const staleBlockHash = `0x${"8".repeat(64)}` as Hex;
    let head = 100;
    let canonicalBlockHash = blockHash;
    let transactionMissing = false;
    let rebroadcastError = "";
    let receiptStatus = "0x1";
    rpcResponder = async (request) => {
      const body = JSON.parse(await request.text()) as {
        id: number;
        method: string;
        params: unknown[];
      };
      let result: unknown;
      if (body.method === "eth_chainId") result = "0x539";
      else if (body.method === "eth_sendRawTransaction") {
        if (rebroadcastError)
          return Response.json({
            jsonrpc: "2.0",
            id: body.id,
            error: { code: -32_000, message: rebroadcastError },
          });
        result = keccak256(body.params[0] as Hex);
      } else if (body.method === "eth_blockNumber") result = `0x${head.toString(16)}`;
      else if (body.method === "eth_getBlockByNumber") result = { hash: canonicalBlockHash };
      else if (body.method === "eth_getTransactionReceipt")
        result = transactionMissing
          ? null
          : {
              blockHash,
              blockNumber: "0x64",
              contractAddress: null,
              cumulativeGasUsed: "0x10000",
              effectiveGasPrice: "0x1",
              from: testTreasury,
              gasUsed: "0x10000",
              logs: [
                {
                  address: testToken,
                  blockHash,
                  blockNumber: "0x64",
                  data: `0x${(1_250_000).toString(16).padStart(64, "0")}`,
                  logIndex: "0x0",
                  removed: false,
                  topics: [
                    "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef",
                    `0x${"0".repeat(24)}${testTreasury.slice(2).toLowerCase()}`,
                    `0x${"0".repeat(24)}${destination.slice(2).toLowerCase()}`,
                  ],
                  transactionHash: txHash,
                  transactionIndex: "0x0",
                },
              ],
              logsBloom: `0x${"0".repeat(512)}`,
              status: receiptStatus,
              to: testToken,
              transactionHash: txHash,
              transactionIndex: "0x0",
              type: "0x0",
            };
      else if (body.method === "eth_getTransactionByHash") result = null;
      else throw new Error(`unmocked withdrawal RPC method: ${body.method}`);
      return Response.json({ jsonrpc: "2.0", id: body.id, result });
    };

    const submitted = await api.fetch(
      authorizedRequest(`https://gateway.test/api/v1/withdrawals/${withdrawal.id}/transaction`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rawTransaction: raw }),
      }),
    );
    expect(submitted.status).toBe(202);
    expect(await submitted.json()).toMatchObject({
      status: "submitted",
      transaction: { hash: txHash, status: "submitted" },
    });

    await reconcileWithdrawals(bindings);
    const confirming = await api.fetch(
      authorizedRequest(`https://gateway.test/api/v1/withdrawals/${withdrawal.id}`),
    );
    expect(await confirming.json()).toMatchObject({
      status: "confirming",
      transaction: { hash: txHash, status: "submitted", blockNumber: 100 },
    });

    head = 101;
    canonicalBlockHash = staleBlockHash;
    await reconcileWithdrawals(bindings);
    const reorged = await api.fetch(
      authorizedRequest(`https://gateway.test/api/v1/withdrawals/${withdrawal.id}`),
    );
    expect(await reorged.json()).toMatchObject({
      status: "submitted",
      transaction: { hash: txHash, status: "submitted", blockNumber: null },
    });

    canonicalBlockHash = blockHash;
    await reconcileWithdrawals(bindings);
    const complete = await api.fetch(
      authorizedRequest(`https://gateway.test/api/v1/withdrawals/${withdrawal.id}`),
    );
    expect(await complete.json()).toMatchObject({
      status: "complete",
      transaction: { hash: txHash, status: "confirmed", blockNumber: 100 },
    });
    const completedAt = await bindings.DB.prepare(
      "SELECT completed_at FROM withdrawal_intents WHERE id = ?",
    )
      .bind(withdrawal.id)
      .first<{ completed_at: number }>();
    vi.useFakeTimers();
    try {
      vi.setSystemTime((completedAt!.completed_at + 60) * 1_000);
      await reconcileWithdrawals(bindings);
    } finally {
      vi.useRealTimers();
    }
    expect(
      await bindings.DB.prepare("SELECT completed_at FROM withdrawal_intents WHERE id = ?")
        .bind(withdrawal.id)
        .first(),
    ).toEqual(completedAt);
    receiptStatus = "0x0";
    await reconcileWithdrawals(bindings);
    const failedAt = await bindings.DB.prepare(
      "SELECT status, updated_at FROM withdrawal_intents WHERE id = ?",
    )
      .bind(withdrawal.id)
      .first<{ status: string; updated_at: number }>();
    expect(failedAt?.status).toBe("failed");
    vi.useFakeTimers();
    try {
      vi.setSystemTime((failedAt!.updated_at + 60) * 1_000);
      await reconcileWithdrawals(bindings);
    } finally {
      vi.useRealTimers();
    }
    expect(
      await bindings.DB.prepare("SELECT status, updated_at FROM withdrawal_intents WHERE id = ?")
        .bind(withdrawal.id)
        .first(),
    ).toEqual(failedAt);
    transactionMissing = true;
    rebroadcastError = "nonce too low";
    await reconcileWithdrawals(bindings);
    expect(
      await bindings.DB.prepare(
        "SELECT status, completed_at, last_error FROM withdrawal_intents WHERE id = ?",
      )
        .bind(withdrawal.id)
        .first(),
    ).toMatchObject({
      status: "submitted",
      completed_at: null,
      last_error: expect.stringContaining("nonce too low"),
    });
    expect(
      await bindings.DB.prepare(
        "SELECT status, block_number, last_error FROM withdrawal_transactions WHERE withdrawal = ?",
      )
        .bind(withdrawal.id)
        .first(),
    ).toMatchObject({
      status: "submitted",
      block_number: null,
      last_error: expect.stringContaining("nonce too low"),
    });
    await bindings.DB.prepare("DELETE FROM withdrawal_intents WHERE id = ?")
      .bind(withdrawal.id)
      .run();
  });

  it("does not classify unknown transaction errors as successful broadcasts", async () => {
    const created = await createWithdrawal(randomId("withdrawal-unknown-broadcast"), {
      externalId: "unknown-broadcast",
      asset: "USDC",
      amount: "1",
      destinationAddress: "0x5555555555555555555555555555555555555555",
    });
    const withdrawal = await created.json<{ id: string }>();
    const proposal = await (
      await api.fetch(
        authorizedRequest(`https://gateway.test/api/v1/withdrawals/${withdrawal.id}/proposal`),
      )
    ).json<{ proposal: { to: `0x${string}`; data: Hex } }>();
    const raw = await treasury.signTransaction({
      type: "legacy",
      chainId: 1337,
      nonce: 8,
      to: proposal.proposal.to,
      value: 0n,
      gas: 80_000n,
      gasPrice: 1n,
      data: proposal.proposal.data,
    });
    rpcResponder = async (request) => {
      const body = JSON.parse(await request.text()) as { id: number; method: string };
      if (body.method === "eth_chainId")
        return Response.json({ jsonrpc: "2.0", id: body.id, result: "0x539" });
      if (body.method === "eth_sendRawTransaction")
        return Response.json({
          jsonrpc: "2.0",
          id: body.id,
          error: { code: -32_000, message: "unknown transaction type" },
        });
      if (
        body.method === "eth_getTransactionReceipt" ||
        body.method === "eth_getTransactionByHash"
      ) {
        return Response.json({ jsonrpc: "2.0", id: body.id, result: null });
      }
      throw new Error(`unmocked withdrawal RPC method: ${body.method}`);
    };

    const submitted = await api.fetch(
      authorizedRequest(`https://gateway.test/api/v1/withdrawals/${withdrawal.id}/transaction`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rawTransaction: raw }),
      }),
    );
    expect(submitted.status).toBe(202);
    expect(await submitted.json()).toMatchObject({
      status: "submitted",
      lastError: expect.stringContaining("unknown transaction type"),
      transaction: {
        status: "prepared",
        lastError: expect.stringContaining("unknown transaction type"),
      },
    });
    await reconcileWithdrawals(bindings);
    expect(
      await bindings.DB.prepare(
        "SELECT status, last_error FROM withdrawal_transactions WHERE withdrawal = ?",
      )
        .bind(withdrawal.id)
        .first(),
    ).toMatchObject({
      status: "submitted",
      last_error: expect.stringContaining("unknown transaction type"),
    });
    await bindings.DB.prepare("DELETE FROM withdrawal_intents WHERE id = ?")
      .bind(withdrawal.id)
      .run();
  });

  it("returns a conflict when two different signatures race for one withdrawal", async () => {
    const created = await createWithdrawal(randomId("withdrawal-race"), {
      externalId: "race",
      asset: "USDC",
      amount: "1",
      destinationAddress: "0x5555555555555555555555555555555555555555",
    });
    const withdrawal = await created.json<{ id: string }>();
    const proposal = await (
      await api.fetch(
        authorizedRequest(`https://gateway.test/api/v1/withdrawals/${withdrawal.id}/proposal`),
      )
    ).json<{ proposal: { to: `0x${string}`; data: Hex } }>();
    const raws = await Promise.all(
      [20, 21].map((nonce) =>
        treasury.signTransaction({
          type: "legacy",
          chainId: 1337,
          nonce,
          to: proposal.proposal.to,
          value: 0n,
          gas: 80_000n,
          gasPrice: 1n,
          data: proposal.proposal.data,
        }),
      ),
    );
    rpcResponder = async (request) => {
      const body = JSON.parse(await request.text()) as {
        id: number;
        method: string;
        params: unknown[];
      };
      const result =
        body.method === "eth_chainId"
          ? "0x539"
          : body.method === "eth_sendRawTransaction"
            ? keccak256(body.params[0] as Hex)
            : null;
      return Response.json({ jsonrpc: "2.0", id: body.id, result });
    };

    const responses = await Promise.all(
      raws.map((raw) =>
        api.fetch(
          authorizedRequest(
            `https://gateway.test/api/v1/withdrawals/${withdrawal.id}/transaction`,
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ rawTransaction: raw }),
            },
          ),
        ),
      ),
    );
    expect(responses.map((response) => response.status).sort()).toEqual([202, 409]);
    expect(
      await bindings.DB.prepare(
        "SELECT COUNT(*) AS count FROM withdrawal_transactions WHERE withdrawal = ?",
      )
        .bind(withdrawal.id)
        .first(),
    ).toEqual({ count: 1 });
    const winner = await bindings.DB.prepare(
      "SELECT nonce FROM withdrawal_transactions WHERE withdrawal = ?",
    )
      .bind(withdrawal.id)
      .first<{ nonce: number }>();
    const second = await createWithdrawal(randomId("withdrawal-replay"), {
      externalId: "replay",
      asset: "USDC",
      amount: "1",
      destinationAddress: "0x6666666666666666666666666666666666666666",
    });
    const secondWithdrawal = await second.json<{ id: string }>();
    const secondProposal = await (
      await api.fetch(
        authorizedRequest(
          `https://gateway.test/api/v1/withdrawals/${secondWithdrawal.id}/proposal`,
        ),
      )
    ).json<{ proposal: { to: `0x${string}`; data: Hex } }>();
    const replay = await treasury.signTransaction({
      type: "legacy",
      chainId: 1337,
      nonce: winner!.nonce,
      to: secondProposal.proposal.to,
      value: 0n,
      gas: 80_000n,
      gasPrice: 1n,
      data: secondProposal.proposal.data,
    });
    expect(
      (
        await api.fetch(
          authorizedRequest(
            `https://gateway.test/api/v1/withdrawals/${secondWithdrawal.id}/transaction`,
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ rawTransaction: replay }),
            },
          ),
        )
      ).status,
    ).toBe(409);
    await bindings.DB.batch([
      bindings.DB.prepare("DELETE FROM withdrawal_intents WHERE id = ?").bind(withdrawal.id),
      bindings.DB.prepare("DELETE FROM withdrawal_intents WHERE id = ?").bind(secondWithdrawal.id),
    ]);
  });

  it("accepts only a same-nonce fee increase as a replacement", async () => {
    const created = await createWithdrawal(randomId("withdrawal-replacement"), {
      externalId: "replacement",
      asset: "USDC",
      amount: "1",
      destinationAddress: "0x7777777777777777777777777777777777777777",
    });
    const withdrawal = await created.json<{ id: string }>();
    const proposal = await (
      await api.fetch(
        authorizedRequest(`https://gateway.test/api/v1/withdrawals/${withdrawal.id}/proposal`),
      )
    ).json<{ proposal: { to: `0x${string}`; data: Hex } }>();
    const sign = (nonce: number, gasPrice: bigint, gas = 80_000n) =>
      treasury.signTransaction({
        type: "legacy",
        chainId: 1337,
        nonce,
        to: proposal.proposal.to,
        value: 0n,
        gas,
        gasPrice,
        data: proposal.proposal.data,
      });
    rpcResponder = async (request) => {
      const body = JSON.parse(await request.text()) as {
        id: number;
        method: string;
        params: unknown[];
      };
      const result =
        body.method === "eth_sendRawTransaction"
          ? keccak256(body.params[0] as Hex)
          : body.method === "eth_chainId"
            ? "0x539"
            : null;
      return Response.json({ jsonrpc: "2.0", id: body.id, result });
    };
    const submit = (rawTransaction: Hex) =>
      api.fetch(
        authorizedRequest(`https://gateway.test/api/v1/withdrawals/${withdrawal.id}/transaction`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ rawTransaction }),
        }),
      );
    const firstRaw = await sign(30, 1n);
    expect((await submit(firstRaw)).status).toBe(202);
    expect((await submit(await sign(31, 3n))).status).toBe(409);
    expect((await submit(await sign(30, 1n, 81_000n))).status).toBe(409);
    const replacementRaw = await sign(30, 2n);
    expect((await submit(replacementRaw)).status).toBe(202);
    const attempts = (
      await bindings.DB.prepare(
        "SELECT id, tx_hash, status, replacement_of FROM withdrawal_transactions WHERE withdrawal = ?",
      )
        .bind(withdrawal.id)
        .all<{ id: string; tx_hash: Hex; status: string; replacement_of: string | null }>()
    ).results;
    const firstAttempt = attempts.find((attempt) => attempt.replacement_of === null)!;
    const replacementAttempt = attempts.find((attempt) => attempt.replacement_of !== null)!;
    expect(firstAttempt.status).toBe("replaced");
    expect(replacementAttempt.status).toBe("submitted");
    expect(
      await bindings.DB.prepare(
        "SELECT nonce, withdrawal FROM withdrawal_nonce_reservations WHERE withdrawal = ?",
      )
        .bind(withdrawal.id)
        .first(),
    ).toEqual({ nonce: 30, withdrawal: withdrawal.id });

    await bindings.DB.batch([
      bindings.DB.prepare("UPDATE withdrawal_transactions SET updated_at = 1 WHERE id = ?").bind(
        firstAttempt.id,
      ),
      bindings.DB.prepare("UPDATE withdrawal_transactions SET updated_at = 2 WHERE id = ?").bind(
        replacementAttempt.id,
      ),
    ]);
    const blockHash = `0x${"a".repeat(64)}` as Hex;
    let reconciliationBroadcasts = 0;
    rpcResponder = async (request) => {
      const body = JSON.parse(await request.text()) as {
        id: number;
        method: string;
        params: unknown[];
      };
      let result: unknown;
      if (body.method === "eth_chainId") result = "0x539";
      else if (body.method === "eth_blockNumber") result = "0x1f";
      else if (body.method === "eth_getBlockByNumber") result = { hash: blockHash };
      else if (body.method === "eth_sendRawTransaction") {
        reconciliationBroadcasts++;
        result = keccak256(body.params[0] as Hex);
      } else if (body.method === "eth_getTransactionReceipt") {
        result =
          body.params[0] === firstAttempt.tx_hash
            ? {
                blockHash,
                blockNumber: "0x1e",
                contractAddress: null,
                cumulativeGasUsed: "0x10000",
                effectiveGasPrice: "0x1",
                from: testTreasury,
                gasUsed: "0x10000",
                logs: [
                  {
                    address: testToken,
                    blockHash,
                    blockNumber: "0x1e",
                    data: `0x${(1_000_000).toString(16).padStart(64, "0")}`,
                    logIndex: "0x0",
                    removed: false,
                    topics: [
                      "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef",
                      `0x${"0".repeat(24)}${testTreasury.slice(2).toLowerCase()}`,
                      `0x${"0".repeat(24)}${"7".repeat(40)}`,
                    ],
                    transactionHash: firstAttempt.tx_hash,
                    transactionIndex: "0x0",
                  },
                ],
                logsBloom: `0x${"0".repeat(512)}`,
                status: "0x1",
                to: testToken,
                transactionHash: firstAttempt.tx_hash,
                transactionIndex: "0x0",
                type: "0x0",
              }
            : null;
      } else throw new Error(`unmocked withdrawal RPC method: ${body.method}`);
      return Response.json({ jsonrpc: "2.0", id: body.id, result });
    };
    await reconcileWithdrawals(bindings);
    expect(reconciliationBroadcasts).toBe(0);
    expect(
      await bindings.DB.prepare("SELECT status FROM withdrawal_intents WHERE id = ?")
        .bind(withdrawal.id)
        .first(),
    ).toEqual({ status: "complete" });
    expect(
      await bindings.DB.prepare("SELECT status FROM withdrawal_transactions WHERE id = ?")
        .bind(replacementAttempt.id)
        .first(),
    ).toEqual({ status: "replaced" });
    await bindings.DB.prepare("DELETE FROM withdrawal_intents WHERE id = ?")
      .bind(withdrawal.id)
      .run();
  });

  it("reconciles the live withdrawal before a full page of replaced history", async () => {
    const destination = "0x8888888888888888888888888888888888888888";
    const created = await createWithdrawal(randomId("withdrawal-history"), {
      externalId: "history-priority",
      asset: "USDC",
      amount: "1",
      destinationAddress: destination,
    });
    const withdrawal = await created.json<{ id: string }>();
    const proposal = await (
      await api.fetch(
        authorizedRequest(`https://gateway.test/api/v1/withdrawals/${withdrawal.id}/proposal`),
      )
    ).json<{ proposal: { to: `0x${string}`; data: Hex } }>();
    const raw = await treasury.signTransaction({
      type: "legacy",
      chainId: 1337,
      nonce: 40,
      to: proposal.proposal.to,
      value: 0n,
      gas: 80_000n,
      gasPrice: 1n,
      data: proposal.proposal.data,
    });
    const txHash = keccak256(raw);
    const transactionId = randomId("wtx");
    await bindings.DB.batch([
      bindings.DB.prepare(
        "UPDATE withdrawal_intents SET status = 'submitted', updated_at = 2 WHERE id = ?",
      ).bind(withdrawal.id),
      bindings.DB.prepare(`INSERT INTO withdrawal_transactions
        (id,withdrawal,chain,tx_hash,raw_tx,from_address,to_address,nonce,status,created_at,updated_at)
        VALUES (?,?,'test',?,?,?, ?,40,'prepared',2,2)`).bind(
        transactionId,
        withdrawal.id,
        txHash,
        raw,
        testTreasury,
        testToken,
      ),
    ]);
    await bindings.DB.batch(
      Array.from({ length: 100 }, () =>
        bindings.DB.prepare(`INSERT INTO withdrawal_transactions
          (id,withdrawal,chain,tx_hash,raw_tx,from_address,to_address,nonce,status,created_at,updated_at)
          VALUES (?,?,'test',?,?,?, ?,40,'replaced',1,1)`).bind(
          randomId("wtx"),
          withdrawal.id,
          `0x${crypto.randomUUID().replaceAll("-", "").repeat(2)}`,
          raw,
          testTreasury,
          testToken,
        ),
      ),
    );
    const blockHash = `0x${"b".repeat(64)}` as Hex;
    let broadcasts = 0;
    rpcResponder = async (request) => {
      const body = JSON.parse(await request.text()) as {
        id: number;
        method: string;
        params: unknown[];
      };
      let result: unknown;
      if (body.method === "eth_chainId") result = "0x539";
      else if (body.method === "eth_sendRawTransaction") {
        broadcasts++;
        return Response.json({
          jsonrpc: "2.0",
          id: body.id,
          error: { code: -32_000, message: "nonce too low" },
        });
      } else if (body.method === "eth_blockNumber") result = "0x33";
      else if (body.method === "eth_getBlockByNumber") result = { hash: blockHash };
      else if (body.method === "eth_getTransactionReceipt")
        result =
          body.params[0] === txHash
            ? {
                blockHash,
                blockNumber: "0x32",
                contractAddress: null,
                cumulativeGasUsed: "0x10000",
                effectiveGasPrice: "0x1",
                from: testTreasury,
                gasUsed: "0x10000",
                logs: [
                  {
                    address: testToken,
                    blockHash,
                    blockNumber: "0x32",
                    data: `0x${(1_000_000).toString(16).padStart(64, "0")}`,
                    logIndex: "0x0",
                    removed: false,
                    topics: [
                      "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef",
                      `0x${"0".repeat(24)}${testTreasury.slice(2).toLowerCase()}`,
                      `0x${"0".repeat(24)}${destination.slice(2).toLowerCase()}`,
                    ],
                    transactionHash: txHash,
                    transactionIndex: "0x0",
                  },
                ],
                logsBloom: `0x${"0".repeat(512)}`,
                status: "0x1",
                to: testToken,
                transactionHash: txHash,
                transactionIndex: "0x0",
                type: "0x0",
              }
            : null;
      else throw new Error(`unmocked withdrawal RPC method: ${body.method}`);
      return Response.json({ jsonrpc: "2.0", id: body.id, result });
    };

    await reconcileWithdrawals(bindings);
    expect(broadcasts).toBe(0);
    expect(
      await bindings.DB.prepare("SELECT status FROM withdrawal_intents WHERE id = ?")
        .bind(withdrawal.id)
        .first(),
    ).toEqual({ status: "complete" });
    await bindings.DB.prepare("DELETE FROM withdrawal_intents WHERE id = ?")
      .bind(withdrawal.id)
      .run();
  });
});

describe("refund API", () => {
  it("creates an idempotent refund to the sole payer and exposes it to the signer", async () => {
    const payer = "0x5555555555555555555555555555555555555555";
    const deposit = await payDeposit(payer);
    const key = randomId("refund");
    const createRefund = (idempotencyKey: string, body = "{}") =>
      api.fetch(
        authorizedRequest(`https://gateway.test/api/v1/deposits/${deposit.id}/refunds`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "Idempotency-Key": idempotencyKey },
          body,
        }),
      );
    try {
      const created = await createRefund(key);
      expect(created.status).toBe(201);
      const refund = (
        await created.json<{
          refund: {
            id: string;
            purpose: string;
            depositIntentId: string;
            sourceAddress: string;
            destinationAddress: string;
            amount: string;
            status: string;
          };
        }>()
      ).refund;
      expect(refund).toMatchObject({
        purpose: "refund",
        depositIntentId: deposit.id,
        sourceAddress: testTreasury,
        destinationAddress: payer,
        amount: "1.25",
        status: "awaiting_signature",
      });

      const replay = await createRefund(key);
      expect(replay.status).toBe(200);
      expect((await replay.json<{ refund: { id: string } }>()).refund.id).toBe(refund.id);
      expect((await createRefund(key, JSON.stringify({ amount: "0.5" }))).status).toBe(409);

      const listed = await api.fetch(
        authorizedRequest(`https://gateway.test/api/v1/deposits/${deposit.id}/refunds`),
      );
      expect(await listed.json()).toMatchObject({
        items: [{ id: refund.id, purpose: "refund" }],
        refundedAmount: "1.25",
        refundableAmount: "0",
      });

      const inbox = await api.fetch(
        authorizedRequest("https://gateway.test/api/v1/withdrawals?status=awaiting_signature"),
      );
      const items = await inbox.json<{
        items: Array<{ id: string; purpose: string; depositIntentId?: string }>;
      }>();
      expect(items.items.find((item) => item.id === refund.id)).toMatchObject({
        purpose: "refund",
        depositIntentId: deposit.id,
      });

      const proposal = await api.fetch(
        authorizedRequest(`https://gateway.test/api/v1/withdrawals/${refund.id}/proposal`),
      );
      expect(await proposal.json()).toMatchObject({
        purpose: "refund",
        depositIntentId: deposit.id,
        proposal: { to: testToken, value: "0" },
      });
    } finally {
      await bindings.DB.prepare("DELETE FROM withdrawal_intents WHERE deposit_intent = ?")
        .bind(deposit.id)
        .run();
      await bindings.DB.prepare("DELETE FROM deposit_intents WHERE id = ?").bind(deposit.id).run();
    }
  });

  it("requires a paid deposit with one payer and an available balance", async () => {
    const payer = "0x5555555555555555555555555555555555555555";
    const unpaid = await create(randomId("unpaid-refund"), { amount: "1", metadata: {} });
    const unpaidBody = await unpaid.json<{ id: string }>();
    const twoPayers = await payDeposit(payer, "1", "0x6666666666666666666666666666666666666666");
    const payable = await payDeposit(payer, "1");
    const post = (depositId: string, key: string, body = "{}") =>
      api.fetch(
        authorizedRequest(`https://gateway.test/api/v1/deposits/${depositId}/refunds`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "Idempotency-Key": key },
          body,
        }),
      );
    try {
      expect((await post(unpaidBody.id, randomId("refund"))).status).toBe(409);
      const multiple = await post(twoPayers.id, randomId("refund"));
      expect(multiple.status).toBe(409);
      expect(await multiple.json()).toEqual({
        error:
          "deposit has multiple payer addresses; use a withdrawal with an explicit destination",
      });
      expect(
        (await post(payable.id, randomId("refund"), JSON.stringify({ amount: "1.01" }))).status,
      ).toBe(409);
      expect((await post(payable.id, randomId("refund"))).status).toBe(201);
      expect((await post(payable.id, randomId("refund"))).status).toBe(409);
    } finally {
      for (const depositId of [unpaidBody.id, twoPayers.id, payable.id]) {
        await bindings.DB.prepare("DELETE FROM withdrawal_intents WHERE deposit_intent = ?")
          .bind(depositId)
          .run();
        await bindings.DB.prepare("DELETE FROM deposit_intents WHERE id = ?").bind(depositId).run();
      }
    }
  });

  it("queues refund webhooks and expires unsigned refunds after a deposit reorg", async () => {
    const payer = "0x5555555555555555555555555555555555555555";
    const completedDeposit = await payDeposit(payer);
    const reorgedDeposit = await payDeposit(payer);
    const createRefund = (depositId: string) =>
      api.fetch(
        authorizedRequest(`https://gateway.test/api/v1/deposits/${depositId}/refunds`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": randomId("refund-webhook"),
          },
          body: "{}",
        }),
      );
    try {
      const completed = await (await createRefund(completedDeposit.id)).json<{
        refund: { id: string };
      }>();
      await bindings.DB.prepare(
        "UPDATE withdrawal_intents SET status = 'complete', completed_at = ? WHERE id = ?",
      )
        .bind(unixNow(), completed.refund.id)
        .run();
      await reconcileWithdrawals(bindings);
      const event = await bindings.DB.prepare(
        "SELECT type, body FROM webhook_events WHERE deposit_intent = ? AND type = 'refund.succeeded'",
      )
        .bind(completedDeposit.id)
        .first<{ type: string; body: string }>();
      expect(event?.type).toBe("refund.succeeded");
      expect(JSON.parse(event!.body)).toMatchObject({
        type: "refund.succeeded",
        data: { refund: { id: completed.refund.id, status: "complete" } },
      });
      await reconcileWithdrawals(bindings);
      expect(
        await bindings.DB.prepare(
          "SELECT COUNT(*) AS count FROM webhook_events WHERE deposit_intent = ? AND type = 'refund.succeeded'",
        )
          .bind(completedDeposit.id)
          .first(),
      ).toEqual({ count: 1 });

      const pending = await (await createRefund(reorgedDeposit.id)).json<{
        refund: { id: string };
      }>();
      await bindings.DB.prepare("UPDATE deposit_intents SET status = 'reorged' WHERE id = ?")
        .bind(reorgedDeposit.id)
        .run();
      await reconcileWithdrawals(bindings);
      expect(
        await bindings.DB.prepare("SELECT status FROM withdrawal_intents WHERE id = ?")
          .bind(pending.refund.id)
          .first(),
      ).toEqual({ status: "expired" });
      expect(
        await bindings.DB.prepare(
          "SELECT type FROM webhook_events WHERE deposit_intent = ? AND type = 'refund.expired'",
        )
          .bind(reorgedDeposit.id)
          .first(),
      ).toEqual({ type: "refund.expired" });
    } finally {
      for (const depositId of [completedDeposit.id, reorgedDeposit.id]) {
        await bindings.DB.prepare("DELETE FROM withdrawal_intents WHERE deposit_intent = ?")
          .bind(depositId)
          .run();
        await bindings.DB.prepare("DELETE FROM deposit_intents WHERE id = ?").bind(depositId).run();
      }
    }
  });

  it("supports partial refunds after the active proposal completes", async () => {
    const payer = "0x5555555555555555555555555555555555555555";
    const deposit = await payDeposit(payer, "1");
    const post = (key: string, amount: string) =>
      api.fetch(
        authorizedRequest(`https://gateway.test/api/v1/deposits/${deposit.id}/refunds`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "Idempotency-Key": key },
          body: JSON.stringify({ amount }),
        }),
      );
    try {
      const first = await post(randomId("partial-refund"), "0.4");
      expect(first.status).toBe(201);
      const firstRefund = await first.json<{ refund: { id: string } }>();
      expect((await post(randomId("partial-refund"), "0.6")).status).toBe(409);
      await bindings.DB.prepare(
        "UPDATE withdrawal_intents SET status = 'complete', completed_at = ? WHERE id = ?",
      )
        .bind(unixNow(), firstRefund.refund.id)
        .run();
      expect((await post(randomId("partial-refund"), "0.6")).status).toBe(201);
      const listed = await api.fetch(
        authorizedRequest(`https://gateway.test/api/v1/deposits/${deposit.id}/refunds`),
      );
      expect(await listed.json()).toMatchObject({
        refundedAmount: "1",
        refundableAmount: "0",
      });
    } finally {
      await bindings.DB.prepare("DELETE FROM withdrawal_intents WHERE deposit_intent = ?")
        .bind(deposit.id)
        .run();
      await bindings.DB.prepare("DELETE FROM deposit_intents WHERE id = ?").bind(deposit.id).run();
    }
  });
});

describe("sweep coordinator", () => {
  it("backfills a cryptographically provable historical treasury snapshot", async () => {
    const now = unixNow();
    const validIntentId = randomId("di");
    const validJobId = randomId("swp");
    const valid = intentFields("91", testToken);
    const insertIntent = (id: string, fields: ReturnType<typeof intentFields>) =>
      bindings.DB.prepare(`INSERT INTO deposit_intents
        (id,idempotency_key,request_hash,external_id,chain,chain_id,asset,token_address,decimals,
         expected_amount,expected_units,deposit_address,intent_salt,factory_address,forwarder_init_code_hash,
         start_block,confirmations,status,expires_at,metadata,created_at,updated_at)
        VALUES (?,?,?,'historical','test',1337,'USDC',?,6,'0.0001','100',?,?,?,?,1,2,
          'paid',?,'{}',?,?)`).bind(
        id,
        randomId("idem"),
        "b".repeat(64),
        testToken,
        fields.address,
        fields.salt,
        testFactory,
        fields.initCodeHash,
        now + 3600,
        now,
        now,
      );
    const insertJob = (id: string, intent: string) =>
      bindings.DB.prepare(`INSERT INTO sweep_jobs
        (id,deposit_intent,chain,observed_units,remaining_units,status,next_attempt_at,created_at,updated_at)
        VALUES (?,?,'test','100','0','queued',?,?,?)`).bind(id, intent, now, now, now);
    await bindings.DB.batch([
      insertIntent(validIntentId, valid),
      insertJob(validJobId, validIntentId),
    ]);
    try {
      expect((await coordinator.claimSweep(validJobId, randomId("owner")))?.treasuryAddress).toBe(
        testTreasury,
      );
      expect(
        await bindings.DB.prepare("SELECT treasury_address FROM deposit_intents WHERE id = ?")
          .bind(validIntentId)
          .first(),
      ).toEqual({ treasury_address: testTreasury });
    } finally {
      await bindings.DB.prepare("DELETE FROM deposit_intents WHERE id = ?")
        .bind(validIntentId)
        .run();
    }
  });

  it("accepts only the canonical relayer factory call and stores it idempotently", async () => {
    const now = unixNow();
    const intentId = randomId("di");
    const jobId = randomId("swp");
    const snapshottedTreasury = "0x4444444444444444444444444444444444444444";
    const fields = intentFields("90", testToken, snapshottedTreasury);
    await bindings.DB.batch([
      bindings.DB.prepare(`INSERT INTO deposit_intents
        (id,idempotency_key,request_hash,external_id,chain,chain_id,asset,token_address,decimals,expected_amount,expected_units,
         treasury_address,deposit_address,intent_salt,factory_address,forwarder_init_code_hash,start_block,confirmations,status,expires_at,metadata,created_at,updated_at)
         VALUES (?,?,?,'order','test',1337,'USDC','0x9999999999999999999999999999999999999999',6,'0.0001','100',?,?,?,?,?,1,2,'paid',?,'{}',?,?)`).bind(
        intentId,
        randomId("idem"),
        "a".repeat(64),
        snapshottedTreasury,
        fields.address,
        fields.salt,
        testFactory,
        fields.initCodeHash,
        now + 3600,
        now,
        now,
      ),
      bindings.DB.prepare(`INSERT INTO sweep_jobs
        (id,deposit_intent,chain,observed_units,remaining_units,status,next_attempt_at,created_at,updated_at)
        VALUES (?,?,'test','100','0','queued',?,?,?)`).bind(jobId, intentId, now, now, now),
    ]);
    const owners = [randomId("owner"), randomId("owner")];
    const claims = await Promise.all(owners.map((owner) => coordinator.claimSweep(jobId, owner)));
    expect(claims.filter(Boolean)).toHaveLength(1);
    expect(claims.find(Boolean)?.treasuryAddress).toBe(snapshottedTreasury);
    const owner = claims[0] ? owners[0] : owners[1];
    const data = collectionCall(fields.salt, snapshottedTreasury, testToken);
    const firstRaw = await relayer.signTransaction({
      type: "legacy",
      chainId: 1337,
      nonce: 0,
      to: testFactory,
      value: 0n,
      gas: 300_000n,
      gasPrice: 1n,
      data,
    });
    const first = await coordinator.registerSweepTransaction(
      jobId,
      owner,
      "deploy_collect",
      firstRaw,
    );
    expect(
      (await coordinator.registerSweepTransaction(jobId, owner, "deploy_collect", firstRaw)).id,
    ).toBe(first.id);
    const rows = await bindings.DB.prepare(
      "SELECT kind, amount_units FROM sweep_transactions WHERE sweep_job = ?",
    )
      .bind(jobId)
      .all<{ kind: string; amount_units: string }>();
    expect(rows.results).toEqual([{ kind: "deploy_collect", amount_units: "0" }]);
  });

  it("reports expired underpayment recovery without marking the payment paid", async () => {
    const now = unixNow();
    const intentId = randomId("di");
    const jobId = randomId("swp");
    const fields = intentFields("95", testToken);
    await bindings.DB.batch([
      bindings.DB.prepare(`INSERT INTO deposit_intents
        (id,idempotency_key,request_hash,external_id,chain,chain_id,asset,token_address,decimals,expected_amount,expected_units,
         received_units,confirmed_units,deposit_address,intent_salt,factory_address,forwarder_init_code_hash,start_block,confirmations,status,
         expires_at,metadata,created_at,updated_at)
         VALUES (?,?,?,'partial-order','test',1337,'USDC',?,6,'0.0001','100','40','40',?,?,?,?,1,2,'underpaid',?,'{}',?,?)`).bind(
        intentId,
        randomId("idem"),
        "f".repeat(64),
        testToken,
        fields.address,
        fields.salt,
        testFactory,
        fields.initCodeHash,
        now - 120,
        now,
        now,
      ),
      bindings.DB.prepare(`INSERT INTO sweep_jobs
        (id,deposit_intent,chain,observed_units,remaining_units,status,next_attempt_at,created_at,updated_at)
        VALUES (?,?,'test','40','0','queued',?,?,?)`).bind(jobId, intentId, now, now, now),
    ]);
    const owner = randomId("owner");
    await coordinator.claimSweep(jobId, owner);
    await coordinator.releaseSweep(jobId, owner, {
      status: "external",
      remainingUnits: "0",
      delaySeconds: 0,
      error: "",
    });

    expect(
      await bindings.DB.prepare("SELECT status, collected_units FROM sweep_jobs WHERE id = ?")
        .bind(jobId)
        .first(),
    ).toEqual({ status: "external", collected_units: "40" });
    const event = await bindings.DB.prepare(
      "SELECT body FROM webhook_events WHERE deposit_intent = ? AND type = 'deposit.recovered'",
    )
      .bind(intentId)
      .first<{ body: string }>();
    expect(JSON.parse(event!.body).data.depositIntent).toMatchObject({
      requestedUnits: "100",
      receivedUnits: "40",
      missingUnits: "60",
      collectedUnits: "40",
      depositStatus: "underpaid",
      settlementStatus: "expired_underpaid_collected",
    });
    expect(
      (
        await bindings.DB.prepare("SELECT status FROM deposit_intents WHERE id = ?")
          .bind(intentId)
          .first<{ status: string }>()
      )?.status,
    ).toBe("underpaid");
  });
});

describe("analytics", () => {
  it("aggregates integer units, collection, fees, and status counts without floats", async () => {
    const now = unixNow();
    const intentId = randomId("di");
    const jobId = randomId("swp");
    const withdrawalId = randomId("wd");
    const refundId = randomId("wd");
    const fields = intentFields("96", "");
    const requested = "900719925474099300000";
    const received = "900719925474099300001";
    await bindings.DB.batch([
      bindings.DB.prepare(`INSERT INTO deposit_intents
        (id,idempotency_key,request_hash,external_id,chain,chain_id,asset,token_address,decimals,expected_amount,expected_units,
         received_units,confirmed_units,deposit_address,intent_salt,factory_address,forwarder_init_code_hash,start_block,confirmations,status,
         expires_at,metadata,created_at,updated_at)
         VALUES (?,?,?,'analytics-order','analytics',31337,'TOK','',18,?,?,?, ?,?,?,?,?,1,1,'paid',?,'{}',?,?)`).bind(
        intentId,
        randomId("idem"),
        "9".repeat(64),
        requested,
        requested,
        received,
        received,
        fields.address,
        fields.salt,
        testFactory,
        fields.initCodeHash,
        now - 1,
        now,
        now,
      ),
      bindings.DB.prepare(`INSERT INTO sweep_jobs
        (id,deposit_intent,chain,observed_units,collected_units,remaining_units,status,next_attempt_at,completed_at,created_at,updated_at)
        VALUES (?,?,'analytics',?,?,'0','complete',?,?,?,?)`).bind(
        jobId,
        intentId,
        received,
        received,
        now,
        now,
        now,
        now,
      ),
      bindings.DB.prepare(`INSERT INTO sweep_transactions
        (id,sweep_job,chain,kind,tx_hash,raw_tx,from_address,to_address,amount_units,fee_wei,nonce,status,block_number,created_at,updated_at)
        VALUES (?,?,'analytics','deploy_collect',?,'0x01',?,?,?, '123',0,'confirmed',1,?,?)`).bind(
        randomId("stx"),
        jobId,
        `0x${"7".repeat(64)}`,
        relayer.address,
        testFactory,
        received,
        now,
        now,
      ),
      bindings.DB.prepare(`INSERT INTO withdrawal_intents
        (id,idempotency_key,request_hash,purpose,external_id,chain,chain_id,asset,token_address,
         decimals,source_address,destination_address,amount,amount_units,confirmations,
         max_gas_price_wei,status,expires_at,created_at,updated_at)
        VALUES (?,?,?,'withdrawal','fee-analytics','fee-analytics',31337,'ETH','',18,?,?,
          '1','1',1,'100','failed',?,?,?)`).bind(
        withdrawalId,
        randomId("idem"),
        "8".repeat(64),
        testTreasury,
        "0x8888888888888888888888888888888888888888",
        now + 3_600,
        now,
        now,
      ),
      bindings.DB.prepare(`INSERT INTO withdrawal_intents
        (id,idempotency_key,request_hash,purpose,external_id,deposit_intent,chain,chain_id,asset,
         token_address,decimals,source_address,destination_address,amount,amount_units,confirmations,
         max_gas_price_wei,status,expires_at,created_at,updated_at)
        VALUES (?,?,?,'refund','refund-analytics',?,'analytics',31337,'TOK','',18,?,?,
          '1','1',1,'100','complete',?,?,?)`).bind(
        refundId,
        randomId("idem"),
        "6".repeat(64),
        intentId,
        testTreasury,
        "0x8888888888888888888888888888888888888888",
        now + 3_600,
        now,
        now,
      ),
      ...[
        { status: "confirmed", fee: "10", block: 1 },
        { status: "failed", fee: "20", block: 2 },
      ].map((transaction, index) =>
        bindings.DB.prepare(`INSERT INTO withdrawal_transactions
          (id,withdrawal,chain,tx_hash,raw_tx,from_address,to_address,nonce,fee_wei,status,
           block_number,block_hash,created_at,updated_at)
          VALUES (?,?,'fee-analytics',?,'0x01',?,?,0,?,?,?, ?,?,?)`).bind(
          randomId("wtx"),
          withdrawalId,
          `0x${(index + 1).toString(16).padStart(64, "0")}`,
          testTreasury,
          "0x8888888888888888888888888888888888888888",
          transaction.fee,
          transaction.status,
          transaction.block,
          `0x${(index + 10).toString(16).padStart(64, "0")}`,
          now,
          now,
        ),
      ),
    ]);
    const pagedFees = Array.from({ length: 1000 }, (_, index) => index);
    for (let offset = 0; offset < pagedFees.length; offset += 100) {
      await bindings.DB.batch(
        pagedFees.slice(offset, offset + 100).map((index) =>
          bindings.DB.prepare(`INSERT INTO withdrawal_transactions
            (id,withdrawal,chain,tx_hash,raw_tx,from_address,to_address,nonce,fee_wei,status,
             block_number,block_hash,created_at,updated_at)
            VALUES (?,?, 'fee-analytics',?,'0x01',?,?,?,'1','failed',3,?,?,?)`).bind(
            `wtx_page_${index.toString().padStart(4, "0")}`,
            withdrawalId,
            `0x${(index + 10_000).toString(16).padStart(64, "0")}`,
            testTreasury,
            "0x8888888888888888888888888888888888888888",
            index + 1,
            `0x${(index + 20_000).toString(16).padStart(64, "0")}`,
            now,
            now,
          ),
        ),
      );
    }

    const response = await api.fetch(
      authorizedRequest("https://gateway.test/api/v1/analytics/summary"),
    );
    expect(response.status).toBe(200);
    const body = await response.json<{
      assets: Array<Record<string, unknown>>;
      collectionFeesWei: Record<string, string>;
      withdrawalFeesWei: Record<string, string>;
      withdrawals: Record<string, number>;
      refunds: Record<string, number>;
    }>();
    expect(body.assets.find((item) => item.chain === "analytics" && item.asset === "TOK")).toEqual({
      chain: "analytics",
      asset: "TOK",
      intents: 1,
      statuses: { paid: 1 },
      requestedUnits: requested,
      receivedUnits: received,
      confirmedUnits: received,
      collectedUnits: received,
      overpaidIntents: 1,
      expiredIntents: 1,
    });
    expect(body.collectionFeesWei.analytics).toBe("123");
    expect(body.withdrawalFeesWei["fee-analytics"]).toBe("1030");
    expect(body.withdrawals).toEqual({ failed: 1 });
    expect(body.refunds).toEqual({ complete: 1 });
    await bindings.DB.prepare("DELETE FROM withdrawal_intents WHERE id = ?")
      .bind(withdrawalId)
      .run();
    await bindings.DB.prepare("DELETE FROM withdrawal_intents WHERE id = ?").bind(refundId).run();
    await bindings.DB.prepare("DELETE FROM deposit_intents WHERE id = ?").bind(intentId).run();
  });
});

describe("chain scanner", () => {
  it("bounds native scans and fast-forwards token-only catch-up", async () => {
    const now = unixNow();
    const nativeId = randomId("di");
    const tokenId = randomId("di");
    const secondTokenId = randomId("di");
    const native = intentFields("a1", "");
    const token = intentFields("b2", testToken);
    const secondToken = intentFields("c3", testToken);
    await bindings.DB.batch([
      bindings.DB.prepare(`INSERT INTO deposit_intents
        (id,idempotency_key,request_hash,external_id,chain,chain_id,asset,token_address,decimals,expected_amount,expected_units,
         deposit_address,intent_salt,factory_address,forwarder_init_code_hash,start_block,confirmations,status,expires_at,metadata,created_at,updated_at)
         VALUES (?,?,?,'batch-native','batch-test',1337,'ETH','',18,'0.0000000000000001','100',?,?,?,?,1,2,'pending',?,'{}',?,?)`).bind(
        nativeId,
        randomId("idem"),
        "d".repeat(64),
        native.address,
        native.salt,
        testFactory,
        native.initCodeHash,
        now + 3600,
        now,
        now,
      ),
      bindings.DB.prepare(`INSERT INTO deposit_intents
        (id,idempotency_key,request_hash,external_id,chain,chain_id,asset,token_address,decimals,expected_amount,expected_units,
         deposit_address,intent_salt,factory_address,forwarder_init_code_hash,start_block,confirmations,status,expires_at,metadata,created_at,updated_at)
         VALUES (?,?,?,'batch-token','batch-test',1337,'USDC',?,6,'0.0001','100',?,?,?,?,1,2,'pending',?,'{}',?,?)`).bind(
        tokenId,
        randomId("idem"),
        "e".repeat(64),
        testToken,
        token.address,
        token.salt,
        testFactory,
        token.initCodeHash,
        now + 3600,
        now,
        now,
      ),
      bindings.DB.prepare(`INSERT INTO deposit_intents
        (id,idempotency_key,request_hash,external_id,chain,chain_id,asset,token_address,decimals,expected_amount,expected_units,
         deposit_address,intent_salt,factory_address,forwarder_init_code_hash,start_block,confirmations,status,expires_at,metadata,created_at,updated_at)
         VALUES (?,?,?,'batch-token-2','batch-test',1337,'USDC',?,6,'0.0001','100',?,?,?,?,1,2,'pending',?,'{}',?,?)`).bind(
        secondTokenId,
        randomId("idem"),
        "f".repeat(64),
        testToken,
        secondToken.address,
        secondToken.salt,
        testFactory,
        secondToken.initCodeHash,
        now + 3600,
        now,
        now,
      ),
    ]);
    const extraTokenIds = Array.from({ length: 99 }, () => randomId("di"));
    await bindings.DB.batch(
      extraTokenIds.map((id, index) => {
        const salt = `0x${(index + 1).toString(16).padStart(64, "0")}` as `0x${string}`;
        const fields = counterfactualAddress(testFactory, salt, testTreasury, testToken);
        return bindings.DB.prepare(`INSERT INTO deposit_intents
          (id,idempotency_key,request_hash,external_id,chain,chain_id,asset,token_address,decimals,expected_amount,expected_units,
           deposit_address,intent_salt,factory_address,forwarder_init_code_hash,start_block,confirmations,status,expires_at,metadata,created_at,updated_at)
           VALUES (?,?,?,?,'batch-test',1337,'USDC',?,6,'0.0001','100',?,?,?,?,1,2,'pending',?,'{}',?,?)`).bind(
          id,
          randomId("idem"),
          "1".repeat(64),
          `batch-extra-${index}`,
          testToken,
          fields.address,
          salt,
          testFactory,
          fields.initCodeHash,
          now + 3600,
          now,
          now,
        );
      }),
    );

    const batchSizes: number[] = [];
    const blockRequests: Array<{ params: unknown[] }> = [];
    const logFilters: Array<Record<string, unknown>> = [];
    const tokenTxHash = `0x${"a".repeat(64)}`;
    const secondTokenTxHash = `0x${"b".repeat(64)}`;
    const partialTokenTxHash = `0x${"c".repeat(64)}`;
    const zeroTokenTxHash = `0x${"d".repeat(64)}`;
    let returnTokenPayment = false;
    let activeRpcRequests = 0;
    let maxConcurrentRpcRequests = 0;
    batchRpcResponder = async (request) => {
      activeRpcRequests++;
      maxConcurrentRpcRequests = Math.max(maxConcurrentRpcRequests, activeRpcRequests);
      await new Promise((resolve) => setTimeout(resolve, 1));
      const payload = JSON.parse(await request.text());
      const requests = (Array.isArray(payload) ? payload : [payload]) as Array<{
        jsonrpc: string;
        id: number;
        method: string;
        params: unknown[];
      }>;
      batchSizes.push(requests.length);
      const responses = requests.map((rpc) => {
        let result: unknown;
        if (rpc.method === "eth_chainId") result = "0x539";
        else if (rpc.method === "eth_blockNumber") result = "0xc8";
        else if (rpc.method === "eth_getBalance") result = "0x0";
        else if (rpc.method === "eth_getLogs") {
          logFilters.push(rpc.params[0] as Record<string, unknown>);
          result = returnTokenPayment
            ? [
                tokenTransferLog(token.address, tokenTxHash, "5", 0, 40),
                tokenTransferLog(token.address, partialTokenTxHash, "7", 1, 60),
                tokenTransferLog(secondToken.address, secondTokenTxHash, "6", 2, 100),
                tokenTransferLog(secondToken.address, zeroTokenTxHash, "8", 3, 0),
              ]
            : [];
        } else if (rpc.method === "eth_getBlockByNumber") {
          blockRequests.push(rpc);
          const blockNumber = Number(BigInt(rpc.params[0] as string));
          const hash = `0x${blockNumber.toString(16).padStart(64, "0")}`;
          result = {
            baseFeePerGas: "0x1",
            difficulty: "0x0",
            extraData: "0x",
            gasLimit: "0x1c9c380",
            gasUsed: "0x0",
            hash,
            logsBloom: `0x${"0".repeat(512)}`,
            miner: "0x0000000000000000000000000000000000000000",
            mixHash: `0x${"0".repeat(64)}`,
            nonce: "0x0000000000000000",
            number: rpc.params[0],
            parentHash: `0x${Math.max(0, blockNumber - 1)
              .toString(16)
              .padStart(64, "0")}`,
            receiptsRoot: `0x${"1".repeat(64)}`,
            sha3Uncles: `0x${"2".repeat(64)}`,
            size: "0x1",
            stateRoot: `0x${"3".repeat(64)}`,
            timestamp: "0x1",
            totalDifficulty: "0x0",
            transactions: [],
            transactionsRoot: `0x${"4".repeat(64)}`,
            uncles: [],
          };
        } else throw new Error(`unexpected RPC method: ${rpc.method}`);
        return { jsonrpc: "2.0", id: rpc.id, result };
      });
      activeRpcRequests--;
      return Response.json(Array.isArray(payload) ? responses : responses[0]);
    };

    const network = {
      ...loadNetworks(bindings.NETWORKS_JSON).get("test")!,
      name: "batch-test",
      rpcUrls: ["https://rpc.batch"],
    } satisfies NetworkConfig;
    await syncChain(bindings, network);

    expect(
      await bindings.DB.prepare(
        "SELECT last_scanned FROM chain_states WHERE chain = 'batch-test'",
      ).first(),
    ).toEqual({ last_scanned: 40 });
    expect(Math.max(...batchSizes)).toBe(10);
    expect(maxConcurrentRpcRequests).toBe(1);
    expect(blockRequests.filter((request) => request.params[1] === true)).toHaveLength(40);
    expect(logFilters).toHaveLength(2);
    expect(logFilters).toEqual(
      expect.arrayContaining([expect.objectContaining({ fromBlock: "0x1", toBlock: "0x28" })]),
    );
    expect(logFilters.map(topicAddressCount).sort((a, b) => a - b)).toEqual([1, 100]);

    await bindings.DB.prepare(
      "UPDATE deposit_intents SET status = 'expired', expires_at = ? WHERE id = ?",
    )
      .bind(now - 1, nativeId)
      .run();
    blockRequests.length = 0;
    logFilters.length = 0;
    returnTokenPayment = true;
    await syncChain(bindings, network);

    expect(
      await bindings.DB.prepare(
        "SELECT last_scanned FROM chain_states WHERE chain = 'batch-test'",
      ).first(),
    ).toEqual({ last_scanned: 200 });
    expect(blockRequests.filter((request) => request.params[1] === true)).toHaveLength(0);
    expect(blockRequests.filter((request) => request.params[0] === "0x96")).toHaveLength(1);
    expect(blockRequests.filter((request) => request.params[0] === "0xc8")).toHaveLength(1);
    expect(logFilters).toHaveLength(2);
    expect(logFilters).toEqual(
      expect.arrayContaining([expect.objectContaining({ fromBlock: "0x28", toBlock: "0xc8" })]),
    );
    expect(logFilters.map(topicAddressCount).sort((a, b) => a - b)).toEqual([1, 100]);
    expect(
      (
        await bindings.DB.prepare(
          "SELECT tx_hash, amount_units, block_number FROM deposit_transfers WHERE deposit_intent = ? ORDER BY tx_hash",
        )
          .bind(tokenId)
          .all()
      ).results,
    ).toEqual([
      { tx_hash: tokenTxHash, amount_units: "40", block_number: 150 },
      { tx_hash: partialTokenTxHash, amount_units: "60", block_number: 150 },
    ]);
    expect(
      await bindings.DB.prepare("SELECT status FROM deposit_intents WHERE id = ?")
        .bind(tokenId)
        .first(),
    ).toEqual({ status: "paid" });
    expect(
      await bindings.DB.prepare(
        "SELECT tx_hash, amount_units, block_number FROM deposit_transfers WHERE deposit_intent = ?",
      )
        .bind(secondTokenId)
        .first(),
    ).toEqual({ tx_hash: secondTokenTxHash, amount_units: "100", block_number: 150 });
    expect(
      await bindings.DB.prepare("SELECT status FROM deposit_intents WHERE id = ?")
        .bind(secondTokenId)
        .first(),
    ).toEqual({ status: "paid" });
    expect(
      await bindings.DB.prepare("SELECT COUNT(*) AS count FROM deposit_transfers WHERE tx_hash = ?")
        .bind(zeroTokenTxHash)
        .first(),
    ).toEqual({ count: 0 });

    await bindings.DB.batch([
      bindings.DB.prepare("DELETE FROM deposit_intents WHERE chain = 'batch-test'"),
      bindings.DB.prepare("DELETE FROM chain_blocks WHERE chain = 'batch-test'"),
      bindings.DB.prepare("DELETE FROM chain_states WHERE chain = 'batch-test'"),
    ]);
  });

  it("keeps idle reconciliation inside the free-tier D1 query budget", async () => {
    const now = unixNow();
    await bindings.DB.batch(
      Array.from({ length: 60 }, (_, index) => {
        const salt = `0x${(index + 1_000).toString(16).padStart(64, "0")}` as `0x${string}`;
        const fields = counterfactualAddress(testFactory, salt, testTreasury, testToken);
        return bindings.DB.prepare(`INSERT INTO deposit_intents
          (id,idempotency_key,request_hash,external_id,chain,chain_id,asset,token_address,decimals,expected_amount,expected_units,
           deposit_address,intent_salt,factory_address,forwarder_init_code_hash,start_block,confirmations,status,expires_at,metadata,created_at,updated_at)
           VALUES (?,?,?,?,'scale-test',1337,'USDC',?,6,'0.0001','100',?,?,?,?,1,2,'pending',?,'{}',?,?)`).bind(
          randomId("di"),
          randomId("idem"),
          "2".repeat(64),
          `scale-${index}`,
          testToken,
          fields.address,
          salt,
          testFactory,
          fields.initCodeHash,
          now + 3_600,
          now,
          now,
        );
      }),
    );
    const intents = (
      await bindings.DB.prepare(
        "SELECT * FROM deposit_intents WHERE chain = 'scale-test'",
      ).all<IntentRow>()
    ).results;
    let prepares = 0;
    const countedDb = new Proxy(bindings.DB, {
      get(target, property) {
        if (property === "prepare")
          return (sql: string) => {
            prepares++;
            return target.prepare(sql);
          };
        const value = Reflect.get(target, property);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const network = {
      ...loadNetworks(bindings.NETWORKS_JSON).get("test")!,
      name: "scale-test",
    } satisfies NetworkConfig;
    await recalculateChain({ ...bindings, DB: countedDb }, network, intents, 1, new Set());
    expect(prepares).toBeLessThanOrEqual(5);
    await bindings.DB.prepare("DELETE FROM deposit_intents WHERE chain = 'scale-test'").run();
  });
});

describe("confirmation and reorg state", () => {
  it("rolls collection amounts and fees back before retrying a reorged transaction", async () => {
    const now = unixNow();
    const intentId = randomId("di");
    const jobId = randomId("swp");
    const fields = intentFields("89", "");
    await bindings.DB.batch([
      bindings.DB.prepare(`INSERT INTO deposit_intents
        (id,idempotency_key,request_hash,external_id,chain,chain_id,asset,token_address,decimals,expected_amount,expected_units,
         deposit_address,intent_salt,factory_address,forwarder_init_code_hash,start_block,confirmations,status,expires_at,metadata,created_at,updated_at)
         VALUES (?,?,?,'collection-reorg','test',1337,'ETH','',18,'1','100',?,?,?,?,1,2,'paid',?,'{}',?,?)`).bind(
        intentId,
        randomId("idem"),
        "a".repeat(64),
        fields.address,
        fields.salt,
        testFactory,
        fields.initCodeHash,
        now + 3600,
        now,
        now,
      ),
      bindings.DB.prepare(`INSERT INTO sweep_jobs
        (id,deposit_intent,chain,observed_units,collected_units,remaining_units,status,next_attempt_at,completed_at,created_at,updated_at)
        VALUES (?,?,'test','100','100','0','complete',?,?,?,?)`).bind(
        jobId,
        intentId,
        now,
        now,
        now,
        now,
      ),
      ...[
        { block: 9, amount: "40", fee: "10", hash: "8" },
        { block: 10, amount: "60", fee: "20", hash: "9" },
      ].map((transaction) =>
        bindings.DB.prepare(`INSERT INTO sweep_transactions
          (id,sweep_job,chain,kind,tx_hash,raw_tx,from_address,to_address,amount_units,fee_wei,nonce,status,block_number,created_at,updated_at)
          VALUES (?,?,'test','collect',?,'0x01',?,?,?,?,0,'confirmed',?,?,?)`).bind(
          randomId("stx"),
          jobId,
          `0x${transaction.hash.repeat(64)}`,
          relayer.address,
          testFactory,
          transaction.amount,
          transaction.fee,
          transaction.block,
          now,
          now,
        ),
      ),
    ]);

    await rewindCollections(bindings.DB, "test", 10);

    expect(
      await bindings.DB.prepare("SELECT status, collected_units FROM sweep_jobs WHERE id = ?")
        .bind(jobId)
        .first(),
    ).toEqual({ status: "queued", collected_units: "40" });
    expect(
      (
        await bindings.DB.prepare(`SELECT block_number, amount_units, fee_wei, status FROM sweep_transactions
          WHERE sweep_job = ? ORDER BY status`)
          .bind(jobId)
          .all()
      ).results,
    ).toEqual([
      { block_number: 9, amount_units: "40", fee_wei: "10", status: "confirmed" },
      { block_number: null, amount_units: "0", fee_wei: "0", status: "submitted" },
    ]);
  });

  it("expires an untouched intent even when chain polling is unavailable", async () => {
    const now = unixNow();
    const intentId = randomId("di");
    const fields = intentFields("91", "");
    await bindings.DB.prepare(`INSERT INTO deposit_intents
      (id,idempotency_key,request_hash,external_id,chain,chain_id,asset,token_address,decimals,expected_amount,expected_units,
       deposit_address,intent_salt,factory_address,forwarder_init_code_hash,start_block,confirmations,status,expires_at,metadata,created_at,updated_at)
       VALUES (?,?,?,'expired-order','test',1337,'ETH','',18,'1','100',?,?,?,?,10,2,'pending',?,'{}',?,?)`)
      .bind(
        intentId,
        randomId("idem"),
        "c".repeat(64),
        fields.address,
        fields.salt,
        testFactory,
        fields.initCodeHash,
        now - 1,
        now - 3601,
        now - 3601,
      )
      .run();
    await expirePendingIntents(bindings.DB);
    expect(
      (
        await bindings.DB.prepare("SELECT status FROM deposit_intents WHERE id = ?")
          .bind(intentId)
          .first<{ status: string }>()
      )?.status,
    ).toBe("expired");
  });

  it("emits each paid transition once and reverses it after an orphaned block", async () => {
    const now = unixNow();
    const intentId = randomId("di");
    const fields = intentFields("92", "");
    await bindings.DB.prepare(`INSERT INTO deposit_intents
      (id,idempotency_key,request_hash,external_id,chain,chain_id,asset,token_address,decimals,expected_amount,expected_units,
       deposit_address,intent_salt,factory_address,forwarder_init_code_hash,start_block,confirmations,status,expires_at,metadata,created_at,updated_at)
       VALUES (?,?,?,'reorg-order','test',1337,'ETH','',18,'0.0000000000000001','100',?,?,?,?,10,2,'pending',?,'{}',?,?)`)
      .bind(
        intentId,
        randomId("idem"),
        "b".repeat(64),
        fields.address,
        fields.salt,
        testFactory,
        fields.initCodeHash,
        now + 3600,
        now,
        now,
      )
      .run();
    await bindings.DB.prepare(`INSERT INTO deposit_transfers
      (id,deposit_intent,chain,tx_hash,event_index,asset,from_address,to_address,amount_units,block_number,block_hash,block_timestamp,canonical,created_at,updated_at)
      VALUES (?,?,'test',?,-1,'ETH','0x5555555555555555555555555555555555555555',?,'100',10,?, ?,1,?,?)`)
      .bind(
        randomId("ptx"),
        intentId,
        `0x${"1".repeat(64)}`,
        fields.address,
        `0x${"2".repeat(64)}`,
        now,
        now,
        now,
      )
      .run();
    const network = loadNetworks(bindings.NETWORKS_JSON).get("test")!;
    let intent = await bindings.DB.prepare("SELECT * FROM deposit_intents WHERE id = ?")
      .bind(intentId)
      .first<IntentRow>();
    await recalculateChain(bindings, network, [intent!], 10, new Set());
    expect(
      (
        await bindings.DB.prepare("SELECT status FROM deposit_intents WHERE id = ?")
          .bind(intentId)
          .first<{ status: string }>()
      )?.status,
    ).toBe("confirming");
    intent = await bindings.DB.prepare("SELECT * FROM deposit_intents WHERE id = ?")
      .bind(intentId)
      .first<IntentRow>();
    await recalculateChain(bindings, network, [intent!], 11, new Set());
    intent = await bindings.DB.prepare("SELECT * FROM deposit_intents WHERE id = ?")
      .bind(intentId)
      .first<IntentRow>();
    expect(intent?.status).toBe("paid");
    await recalculateChain(bindings, network, [intent!], 12, new Set());
    expect(
      (
        await bindings.DB.prepare(
          "SELECT count(*) AS count FROM webhook_events WHERE deposit_intent = ? AND type = 'deposit.succeeded'",
        )
          .bind(intentId)
          .first<{ count: number }>()
      )?.count,
    ).toBe(1);

    await bindings.DB.prepare("UPDATE deposit_transfers SET canonical = 0 WHERE deposit_intent = ?")
      .bind(intentId)
      .run();
    intent = await bindings.DB.prepare("SELECT * FROM deposit_intents WHERE id = ?")
      .bind(intentId)
      .first<IntentRow>();
    await recalculateChain(bindings, network, [intent!], 12, new Set([intentId]));
    expect(
      (
        await bindings.DB.prepare("SELECT status FROM deposit_intents WHERE id = ?")
          .bind(intentId)
          .first<{ status: string }>()
      )?.status,
    ).toBe("reorged");
    expect(
      (
        await bindings.DB.prepare(
          "SELECT count(*) AS count FROM webhook_events WHERE deposit_intent = ? AND type = 'deposit.reorged'",
        )
          .bind(intentId)
          .first<{ count: number }>()
      )?.count,
    ).toBe(1);
    const event = await bindings.DB.prepare(
      "SELECT body FROM webhook_events WHERE deposit_intent = ? AND type = 'deposit.reorged'",
    )
      .bind(intentId)
      .first<{ body: string }>();
    expect(JSON.parse(event!.body).data.depositIntent.transactionHashes).toEqual([
      `0x${"1".repeat(64)}`,
    ]);
  });

  it("collects a confirmed late payment without crediting it", async () => {
    const now = unixNow();
    const intentId = randomId("di");
    const fields = intentFields("93", testToken);
    await bindings.DB.batch([
      bindings.DB.prepare(`INSERT INTO deposit_intents
        (id,idempotency_key,request_hash,external_id,chain,chain_id,asset,token_address,decimals,expected_amount,expected_units,
         deposit_address,intent_salt,factory_address,forwarder_init_code_hash,start_block,confirmations,status,expires_at,metadata,created_at,updated_at)
         VALUES (?,?,?,'late-order','test',1337,'USDC','0x9999999999999999999999999999999999999999',6,'0.0001','100',?,?,?,?,1,2,'expired',?,'{}',?,?)`).bind(
        intentId,
        randomId("idem"),
        "e".repeat(64),
        fields.address,
        fields.salt,
        testFactory,
        fields.initCodeHash,
        now - 120,
        now - 3600,
        now - 3600,
      ),
      bindings.DB.prepare(`INSERT INTO deposit_transfers
        (id,deposit_intent,chain,tx_hash,event_index,asset,from_address,to_address,amount_units,block_number,block_hash,block_timestamp,canonical,created_at,updated_at)
        VALUES (?,?,'test',?,0,'USDC','0x5555555555555555555555555555555555555555',?,'100',10,?,?,1,?,?)`).bind(
        randomId("ptx"),
        intentId,
        `0x${"3".repeat(64)}`,
        fields.address,
        `0x${"4".repeat(64)}`,
        now,
        now,
        now,
      ),
    ]);
    const intent = await bindings.DB.prepare("SELECT * FROM deposit_intents WHERE id = ?")
      .bind(intentId)
      .first<IntentRow>();
    const network = loadNetworks(bindings.NETWORKS_JSON).get("test")!;
    await recalculateChain(bindings, network, [intent!], 11, new Set());
    const updated = await bindings.DB.prepare(
      "SELECT status, received_units, confirmed_units FROM deposit_intents WHERE id = ?",
    )
      .bind(intentId)
      .first<{ status: string; received_units: string; confirmed_units: string }>();
    expect(updated).toEqual({ status: "expired", received_units: "0", confirmed_units: "0" });
    expect(
      await bindings.DB.prepare(
        "SELECT status, observed_units FROM sweep_jobs WHERE deposit_intent = ?",
      )
        .bind(intentId)
        .first(),
    ).toEqual({ status: "queued", observed_units: "100" });
    expect(
      (
        await bindings.DB.prepare(
          "SELECT count(*) AS count FROM webhook_events WHERE deposit_intent = ?",
        )
          .bind(intentId)
          .first<{ count: number }>()
      )?.count,
    ).toBe(0);
  });
});

describe("webhook delivery", () => {
  it("keeps the event ID and body stable across signed retries", async () => {
    await bindings.DB.prepare(
      "UPDATE webhook_events SET status = 'delivered' WHERE status = 'pending'",
    ).run();
    const eventId = randomId("evt");
    const intent = await bindings.DB.prepare("SELECT id FROM deposit_intents LIMIT 1").first<{
      id: string;
    }>();
    expect(intent).not.toBeNull();
    const body = JSON.stringify({ id: eventId, type: "deposit.succeeded" });
    await bindings.DB.prepare(`INSERT INTO webhook_events
      (event_id,type,subject_type,subject_id,deposit_intent,body,status,attempts,
       next_attempt_at,created_at,updated_at)
      VALUES (?,'deposit.succeeded','deposit',?,?,?,'pending',0,?,?,?)`)
      .bind(eventId, intent!.id, intent!.id, body, unixNow(), unixNow(), unixNow())
      .run();
    const seen: Array<{
      id: string | null;
      timestamp: string | null;
      signature: string | null;
      body: string;
    }> = [];
    let attempt = 0;
    webhookResponder = async (request) => {
      attempt++;
      seen.push({
        id: request.headers.get("Webhook-Id"),
        timestamp: request.headers.get("Webhook-Timestamp"),
        signature: request.headers.get("Webhook-Signature"),
        body: await request.text(),
      });
      return new Response(null, { status: attempt === 1 ? 503 : 204 });
    };
    await deliverWebhooks(bindings);
    await bindings.DB.prepare("UPDATE webhook_events SET next_attempt_at = ? WHERE event_id = ?")
      .bind(unixNow(), eventId)
      .run();
    await deliverWebhooks(bindings);
    expect(seen).toHaveLength(2);
    expect(seen.map((item) => item.id)).toEqual([eventId, eventId]);
    expect(seen.map((item) => item.body)).toEqual([body, body]);
    const hmacKey = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(bindings.PAYMENT_WEBHOOK_SECRET),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    for (const item of seen) {
      const signed = await crypto.subtle.sign(
        "HMAC",
        hmacKey,
        new TextEncoder().encode(`${item.timestamp}.${item.body}`),
      );
      const expected = [...new Uint8Array(signed)]
        .map((byte) => byte.toString(16).padStart(2, "0"))
        .join("");
      expect(item.signature).toBe(`v1,${expected}`);
    }
    expect(
      (
        await bindings.DB.prepare("SELECT status FROM webhook_events WHERE event_id = ?")
          .bind(eventId)
          .first<{ status: string }>()
      )?.status,
    ).toBe("delivered");
  });

  it("requires HTTPS and never follows webhook redirects", async () => {
    await expect(
      deliverWebhooks({ ...bindings, PAYMENT_WEBHOOK_URL: "http://webhook.test/events" }),
    ).rejects.toThrow("HTTPS");

    const eventId = randomId("evt");
    const intent = await bindings.DB.prepare("SELECT id FROM deposit_intents LIMIT 1").first<{
      id: string;
    }>();
    await bindings.DB.prepare(`INSERT INTO webhook_events
      (event_id,type,subject_type,subject_id,deposit_intent,body,status,attempts,
       next_attempt_at,created_at,updated_at)
      VALUES (?,'deposit.succeeded','deposit',?,?,'{}','pending',0,?,?,?)`)
      .bind(eventId, intent!.id, intent!.id, unixNow(), unixNow(), unixNow())
      .run();
    let redirectMode = "";
    webhookResponder = async (request) => {
      redirectMode = request.redirect;
      return new Response(null, {
        status: 307,
        headers: { Location: "https://attacker.invalid/" },
      });
    };
    await deliverWebhooks(bindings);
    expect(redirectMode).toBe("manual");
    expect(
      (
        await bindings.DB.prepare("SELECT status FROM webhook_events WHERE event_id = ?")
          .bind(eventId)
          .first<{ status: string }>()
      )?.status,
    ).toBe("pending");
  });

  it("dispatches due sweeps without scanning unused networks", async () => {
    const now = unixNow();
    const intentId = randomId("di");
    const jobId = randomId("swp");
    const fields = intentFields("94", "");
    await bindings.DB.batch([
      bindings.DB.prepare(`INSERT INTO deposit_intents
        (id,idempotency_key,request_hash,external_id,chain,chain_id,asset,token_address,decimals,expected_amount,expected_units,
         deposit_address,intent_salt,factory_address,forwarder_init_code_hash,start_block,confirmations,status,expires_at,metadata,created_at,updated_at)
         VALUES (?,?,?,'dispatch-test','test',1337,'ETH','',18,'1','1',?,?,?,?,1,2,'paid',?,'{}',?,?)`).bind(
        intentId,
        randomId("idem"),
        "d".repeat(64),
        fields.address,
        fields.salt,
        testFactory,
        fields.initCodeHash,
        now + 3600,
        now,
        now,
      ),
      bindings.DB.prepare(`INSERT INTO sweep_jobs
        (id,deposit_intent,chain,observed_units,remaining_units,status,next_attempt_at,last_dispatched_at,created_at,updated_at)
        VALUES (?,?,'test','1','0','queued',?,0,?,?)`).bind(jobId, intentId, now, now, now),
    ]);
    const sendSweeps = vi.fn(async (_messages: MessageSendRequest<SweepMessage>[]) => undefined);
    const sendScans = vi.fn(
      async (_messages: MessageSendRequest<{ chain: string }>[]) => undefined,
    );
    const noIntentNetwork = JSON.stringify([
      {
        name: "empty",
        chainId: 31337,
        rpcUrl: "https://rpc.empty",
        treasuryAddress: "0x2222222222222222222222222222222222222222",
        factoryAddress: "0x3333333333333333333333333333333333333333",
        factoryCodeHash,
        relayerAddress: relayer.address,
        confirmations: 2,
        maxGasPriceWei: "1000000000",
        nativeAsset: "ETH",
        tokens: {},
      },
    ]);
    await runScheduled({
      ...bindings,
      NETWORKS_JSON: noIntentNetwork,
      PAYMENT_WEBHOOK_SECRET: "short",
      SCAN_QUEUE: { sendBatch: sendScans } as unknown as Queue<{ chain: string }>,
      SWEEP_QUEUE: { sendBatch: sendSweeps } as unknown as Queue<SweepMessage>,
    });
    expect(sendScans).not.toHaveBeenCalled();
    expect(sendSweeps).toHaveBeenCalledWith(
      expect.arrayContaining([expect.objectContaining({ body: { jobId } })]),
    );
  });

  it("maintenance-scans expired payment chains every 15 minutes", async () => {
    const response = await create(randomId("maintenance"), { amount: "1", metadata: {} });
    const intent = await response.json<{ id: string }>();
    const maintenanceChain = "maintenance";
    await bindings.DB.prepare(
      "UPDATE deposit_intents SET chain = ?, chain_id = 31338, status = 'expired' WHERE id = ?",
    )
      .bind(maintenanceChain, intent.id)
      .run();
    const [network] = JSON.parse(bindings.NETWORKS_JSON) as Array<Record<string, unknown>>;
    const maintenanceNetworks = JSON.stringify([
      { ...network, name: maintenanceChain, chainId: 31338 },
    ]);
    await bindings.DB.prepare("DELETE FROM chain_states WHERE chain = ?")
      .bind(maintenanceChain)
      .run();
    const sendScans = vi.fn(
      async (_messages: MessageSendRequest<{ chain: string }>[]) => undefined,
    );
    const scheduledEnv = {
      ...bindings,
      NETWORKS_JSON: maintenanceNetworks,
      SCAN_QUEUE: { sendBatch: sendScans } as unknown as Queue<{ chain: string }>,
      SWEEP_QUEUE: { sendBatch: vi.fn() } as unknown as Queue<SweepMessage>,
    };

    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-08-18T00:14:00Z"));
      await runScheduled(scheduledEnv);
      expect(sendScans).not.toHaveBeenCalled();

      vi.setSystemTime(new Date("2026-08-18T00:15:00Z"));
      await runScheduled(scheduledEnv);
      expect(sendScans).toHaveBeenCalledWith([{ body: { chain: maintenanceChain } }]);
    } finally {
      vi.useRealTimers();
      await bindings.DB.prepare("DELETE FROM deposit_intents WHERE id = ?").bind(intent.id).run();
    }
  });
});

function create(
  idempotencyKey: string,
  overrides: {
    amount: string;
    metadata: Record<string, unknown>;
    purpose?: string;
  },
): Promise<Response> {
  return api.fetch(
    authorizedRequest("https://gateway.test/api/v1/deposits", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": idempotencyKey },
      body: JSON.stringify({
        purpose: "deposit",
        externalId: idempotencyKey,
        chain: "test",
        asset: "USDC",
        expiresInSeconds: 1800,
        ...overrides,
      }),
    }),
  );
}

function createWithdrawal(
  idempotencyKey: string,
  body: {
    externalId: string;
    purpose?: string;
    asset: string;
    amount: string;
    destinationAddress: string;
  },
): Promise<Response> {
  return api.fetch(
    authorizedRequest("https://gateway.test/api/v1/withdrawals", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": idempotencyKey },
      body: JSON.stringify({
        purpose: "withdrawal",
        chain: "test",
        expiresInSeconds: 1800,
        ...body,
      }),
    }),
  );
}

async function payDeposit(
  payer: string,
  amount = "1.25",
  secondPayer?: string,
): Promise<{ id: string; depositAddress: string; expectedUnits: string }> {
  const response = await create(randomId("refund-deposit"), { amount, metadata: {} });
  if (response.status !== 201)
    throw new Error(`failed to create refund test deposit: ${response.status}`);
  const intent = await response.json<{
    id: string;
    depositAddress: string;
    expectedUnits: string;
  }>();
  const units = BigInt(intent.expectedUnits);
  const transfers = secondPayer
    ? [
        { from: payer, amountUnits: units / 2n },
        { from: secondPayer, amountUnits: units - units / 2n },
      ]
    : [{ from: payer, amountUnits: units }];
  const now = unixNow();
  await bindings.DB.batch([
    bindings.DB.prepare(
      "UPDATE deposit_intents SET status = 'paid', received_units = expected_units, confirmed_units = expected_units WHERE id = ?",
    ).bind(intent.id),
    ...transfers.map((transfer, index) =>
      bindings.DB.prepare(`INSERT INTO deposit_transfers
        (id,deposit_intent,chain,tx_hash,event_index,asset,from_address,to_address,amount_units,
         block_number,block_hash,block_timestamp,canonical,created_at,updated_at)
        VALUES (?,?,'test',?,?,'USDC',?,?,?,?,?,?,1,?,?)`).bind(
        randomId("transfer"),
        intent.id,
        randomHex(),
        index,
        transfer.from,
        intent.depositAddress,
        transfer.amountUnits.toString(),
        10 + index,
        randomHex(),
        now,
        now,
        now,
      ),
    ),
  ]);
  return intent;
}

function randomHex(): string {
  return `0x${crypto.randomUUID().replaceAll("-", "").padEnd(64, "0").slice(0, 64)}`;
}

function authorizedRequest(url: string, init: RequestInit = {}): Request {
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${apiKey}`);
  return new Request(url, { ...init, headers });
}

function intentFields(
  seed: string,
  tokenAddress: typeof testToken | "",
  treasuryAddress: `0x${string}` = testTreasury,
) {
  const salt = `0x${seed.repeat(32)}` as `0x${string}`;
  return { salt, ...counterfactualAddress(testFactory, salt, treasuryAddress, tokenAddress) };
}

function tokenTransferLog(
  to: string,
  transactionHash: string,
  fromNibble: string,
  index: number,
  amount: number,
) {
  return {
    address: testToken,
    blockHash: `0x${(150).toString(16).padStart(64, "0")}`,
    blockNumber: "0x96",
    data: `0x${amount.toString(16).padStart(64, "0")}`,
    logIndex: "0x0",
    removed: false,
    topics: [
      "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef",
      `0x${"0".repeat(24)}${fromNibble.repeat(40)}`,
      `0x${"0".repeat(24)}${to.slice(2).toLowerCase()}`,
    ],
    transactionHash,
    transactionIndex: `0x${index.toString(16)}`,
  };
}

function topicAddressCount(filter: Record<string, unknown>): number {
  return ((filter.topics as unknown[])[2] as unknown[]).length;
}
