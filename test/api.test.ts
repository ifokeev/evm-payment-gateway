import { env, exports } from "cloudflare:workers";
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
let rpcFactoryCode: `0x${string}` = factoryCode;
const testFactory = "0x3333333333333333333333333333333333333333";
const testTreasury = "0x2222222222222222222222222222222222222222";
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
});

describe("payment API", () => {
  it("keeps health public and every payment read private", async () => {
    expect(
      (await api.fetch(new Request("https://gateway.test/api/payments/v1/health"))).status,
    ).toBe(200);
    expect(
      (await api.fetch(new Request("https://gateway.test/api/payments/v1/intents/missing"))).status,
    ).toBe(401);
  });

  it("creates, polls, and safely replays an exact payment intent", async () => {
    const key = randomId("idem");
    const first = await create(key, { amount: "0010.250000", metadata: { z: 1, a: 2 } });
    expect(first.status).toBe(201);
    const body = await first.json<Record<string, unknown>>();
    expect(body.kind).toBe("payment");
    expect(body.expectedAmount).toBe("10.25");
    expect(body.expectedUnits).toBe("10250000");
    expect(body.remainingAmount).toBe("10.25");
    expect(body.remainingUnits).toBe("10250000");
    expect(body.paymentUri).toContain("@1337/transfer");
    expect(body.qrCodeDataUrl).toMatch(/^data:image\/svg\+xml;base64,/);
    expect(body.topUpPaymentUri).toBe(body.paymentUri);
    expect(body.topUpQrCodeDataUrl).toBe(body.qrCodeDataUrl);
    const stored = await bindings.DB.prepare(
      "SELECT intent_salt, forwarder_init_code_hash FROM payment_intents WHERE id = ?",
    )
      .bind(body.id)
      .first<{ intent_salt: `0x${string}`; forwarder_init_code_hash: `0x${string}` }>();
    const network = loadNetworks(bindings.NETWORKS_JSON).get("test")!;
    const expected = counterfactualAddress(
      network.factoryAddress,
      stored!.intent_salt,
      network.treasuryAddress,
      network.tokens.USDC.address,
    );
    expect(body.depositAddress).toBe(expected.address);
    expect(stored?.forwarder_init_code_hash).toBe(expected.initCodeHash);

    const replay = await create(key, { amount: "10.25", metadata: { a: 2, z: 1 } });
    expect(replay.status).toBe(200);
    expect((await replay.json<{ id: string }>()).id).toBe(body.id);
    expect((await create(key, { amount: "10.26", metadata: { a: 2, z: 1 } })).status).toBe(409);

    const poll = await api.fetch(
      authorizedRequest(`https://gateway.test/api/payments/v1/intents/${body.id}`),
    );
    expect(poll.status).toBe(200);
    expect((await poll.json<{ status: string }>()).status).toBe("pending");

    await bindings.DB.prepare(
      "UPDATE payment_intents SET received_units = '4000000', status = 'underpaid' WHERE id = ?",
    )
      .bind(body.id)
      .run();
    const partial = await (
      await api.fetch(authorizedRequest(`https://gateway.test/api/payments/v1/intents/${body.id}`))
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

    await bindings.DB.prepare("UPDATE payment_intents SET expires_at = ? WHERE id = ?")
      .bind(unixNow() - 1, body.id)
      .run();
    const expired = await (
      await api.fetch(authorizedRequest(`https://gateway.test/api/payments/v1/intents/${body.id}`))
    ).json<Record<string, unknown>>();
    expect(expired).toMatchObject({
      expired: true,
      remainingAmount: "6.25",
      remainingUnits: "6250000",
    });
    expect(expired.topUpPaymentUri).toBeNull();
    expect(expired.topUpQrCodeDataUrl).toBeNull();

    await bindings.DB.prepare(
      "UPDATE payment_intents SET received_units = '11000000', confirmed_units = '11000000', status = 'paid' WHERE id = ?",
    )
      .bind(body.id)
      .run();
    const overpaid = await (
      await api.fetch(authorizedRequest(`https://gateway.test/api/payments/v1/intents/${body.id}`))
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
        "SELECT COUNT(*) AS count FROM payment_intents WHERE instr(idempotency_key, ?) = 1",
      )
        .bind(prefix)
        .first(),
    ).toEqual({ count: 14 });
    await bindings.DB.prepare("DELETE FROM payment_intents WHERE instr(idempotency_key, ?) = 1")
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
    const request = authorizedRequest("https://gateway.test/api/payments/v1/intents", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": randomId("idem") },
      body: JSON.stringify({
        kind: "payment",
        externalId: "order",
        chain: "test",
        asset: "USDC",
        amount: "1",
        unexpected: true,
      }),
    });
    expect((await api.fetch(request)).status).toBe(400);
    const wrongType = authorizedRequest("https://gateway.test/api/payments/v1/intents", {
      method: "POST",
      headers: { "Content-Type": "text/plain", "Idempotency-Key": randomId("idem") },
      body: "{}",
    });
    expect((await api.fetch(wrongType)).status).toBe(415);
    const jsonp = authorizedRequest("https://gateway.test/api/payments/v1/intents", {
      method: "POST",
      headers: { "Content-Type": "application/jsonp", "Idempotency-Key": randomId("idem") },
      body: "{}",
    });
    expect((await api.fetch(jsonp)).status).toBe(415);

    const depth = 5_000;
    const deeplyNested = authorizedRequest("https://gateway.test/api/payments/v1/intents", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": randomId("idem") },
      body: `{"kind":"payment","externalId":"deep","chain":"test","asset":"USDC","amount":"1","metadata":${'{"next":'.repeat(depth)}null${"}".repeat(depth)}}`,
    });
    const deepResponse = await api.fetch(deeplyNested);
    expect(deepResponse.status).toBe(400);
    expect(await deepResponse.json()).toEqual({ error: "metadata is too deeply nested" });
  });

  it("accepts only generic payment and invoice kinds", async () => {
    const invoice = await create(randomId("idem"), { amount: "1", metadata: {}, kind: "invoice" });
    expect(invoice.status).toBe(201);
    expect((await invoice.json<{ kind: string }>()).kind).toBe("invoice");

    const invalid = authorizedRequest("https://gateway.test/api/payments/v1/intents", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": randomId("idem") },
      body: JSON.stringify({
        kind: "custom",
        externalId: "unsupported-kind",
        chain: "test",
        asset: "USDC",
        amount: "1",
      }),
    });
    expect(await (await api.fetch(invalid)).json()).toEqual({
      error: "kind must be payment or invoice",
    });
    const schema = await bindings.DB.prepare(
      "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'payment_intents'",
    ).first<{ sql: string }>();
    expect(schema?.sql).toContain("kind IN ('payment', 'invoice')");
  });

  it("redacts RPC credentials and raw transactions from errors", () => {
    const message = safeErrorText(
      new Error(`RPC https://rpc.test/v3/private-key rejected 0x${"ab".repeat(128)}`),
    );
    expect(message).toBe("RPC [redacted-url] rejected [redacted-hex]");
  });
});

describe("sweep coordinator", () => {
  it("accepts only the canonical relayer factory call and stores it idempotently", async () => {
    const now = unixNow();
    const intentId = randomId("pi");
    const jobId = randomId("swp");
    const fields = intentFields("90", testToken);
    await bindings.DB.batch([
      bindings.DB.prepare(`INSERT INTO payment_intents
        (id,idempotency_key,request_hash,kind,external_id,chain,chain_id,asset,token_address,decimals,expected_amount,expected_units,
         deposit_address,intent_salt,factory_address,forwarder_init_code_hash,start_block,confirmations,status,expires_at,metadata,created_at,updated_at)
         VALUES (?,?,?,'payment','order','test',1337,'USDC','0x9999999999999999999999999999999999999999',6,'0.0001','100',?,?,?,?,1,2,'paid',?,'{}',?,?)`).bind(
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
        (id,payment_intent,chain,observed_units,remaining_units,status,next_attempt_at,created_at,updated_at)
        VALUES (?,?,'test','100','0','queued',?,?,?)`).bind(jobId, intentId, now, now, now),
    ]);
    const owners = [randomId("owner"), randomId("owner")];
    const claims = await Promise.all(owners.map((owner) => coordinator.claimSweep(jobId, owner)));
    expect(claims.filter(Boolean)).toHaveLength(1);
    const owner = claims[0] ? owners[0] : owners[1];
    const data = collectionCall(fields.salt, testTreasury, testToken);
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
    const intentId = randomId("pi");
    const jobId = randomId("swp");
    const fields = intentFields("95", testToken);
    await bindings.DB.batch([
      bindings.DB.prepare(`INSERT INTO payment_intents
        (id,idempotency_key,request_hash,kind,external_id,chain,chain_id,asset,token_address,decimals,expected_amount,expected_units,
         received_units,confirmed_units,deposit_address,intent_salt,factory_address,forwarder_init_code_hash,start_block,confirmations,status,
         expires_at,metadata,created_at,updated_at)
         VALUES (?,?,?,'payment','partial-order','test',1337,'USDC',?,6,'0.0001','100','40','40',?,?,?,?,1,2,'underpaid',?,'{}',?,?)`).bind(
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
        (id,payment_intent,chain,observed_units,remaining_units,status,next_attempt_at,created_at,updated_at)
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
      "SELECT body FROM webhook_events WHERE payment_intent = ? AND type = 'payment.recovered'",
    )
      .bind(intentId)
      .first<{ body: string }>();
    expect(JSON.parse(event!.body).data.paymentIntent).toMatchObject({
      requestedUnits: "100",
      receivedUnits: "40",
      missingUnits: "60",
      collectedUnits: "40",
      paymentStatus: "underpaid",
      settlementStatus: "expired_underpaid_collected",
    });
    expect(
      (
        await bindings.DB.prepare("SELECT status FROM payment_intents WHERE id = ?")
          .bind(intentId)
          .first<{ status: string }>()
      )?.status,
    ).toBe("underpaid");
  });
});

describe("analytics", () => {
  it("aggregates integer units, collection, fees, and status counts without floats", async () => {
    const now = unixNow();
    const intentId = randomId("pi");
    const jobId = randomId("swp");
    const fields = intentFields("96", "");
    const requested = "900719925474099300000";
    const received = "900719925474099300001";
    await bindings.DB.batch([
      bindings.DB.prepare(`INSERT INTO payment_intents
        (id,idempotency_key,request_hash,kind,external_id,chain,chain_id,asset,token_address,decimals,expected_amount,expected_units,
         received_units,confirmed_units,deposit_address,intent_salt,factory_address,forwarder_init_code_hash,start_block,confirmations,status,
         expires_at,metadata,created_at,updated_at)
         VALUES (?,?,?,'payment','analytics-order','analytics',31337,'TOK','',18,?,?,?, ?,?,?,?,?,1,1,'paid',?,'{}',?,?)`).bind(
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
        (id,payment_intent,chain,observed_units,collected_units,remaining_units,status,next_attempt_at,completed_at,created_at,updated_at)
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
    ]);

    const response = await api.fetch(
      authorizedRequest("https://gateway.test/api/payments/v1/analytics/summary"),
    );
    expect(response.status).toBe(200);
    const body = await response.json<{
      assets: Array<Record<string, unknown>>;
      collectionFeesWei: Record<string, string>;
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
  });
});

describe("chain scanner", () => {
  it("bounds native scans and fast-forwards token-only catch-up", async () => {
    const now = unixNow();
    const nativeId = randomId("pi");
    const tokenId = randomId("pi");
    const secondTokenId = randomId("pi");
    const native = intentFields("a1", "");
    const token = intentFields("b2", testToken);
    const secondToken = intentFields("c3", testToken);
    await bindings.DB.batch([
      bindings.DB.prepare(`INSERT INTO payment_intents
        (id,idempotency_key,request_hash,kind,external_id,chain,chain_id,asset,token_address,decimals,expected_amount,expected_units,
         deposit_address,intent_salt,factory_address,forwarder_init_code_hash,start_block,confirmations,status,expires_at,metadata,created_at,updated_at)
         VALUES (?,?,?,'payment','batch-native','batch-test',1337,'ETH','',18,'0.0000000000000001','100',?,?,?,?,1,2,'pending',?,'{}',?,?)`).bind(
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
      bindings.DB.prepare(`INSERT INTO payment_intents
        (id,idempotency_key,request_hash,kind,external_id,chain,chain_id,asset,token_address,decimals,expected_amount,expected_units,
         deposit_address,intent_salt,factory_address,forwarder_init_code_hash,start_block,confirmations,status,expires_at,metadata,created_at,updated_at)
         VALUES (?,?,?,'payment','batch-token','batch-test',1337,'USDC',?,6,'0.0001','100',?,?,?,?,1,2,'pending',?,'{}',?,?)`).bind(
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
      bindings.DB.prepare(`INSERT INTO payment_intents
        (id,idempotency_key,request_hash,kind,external_id,chain,chain_id,asset,token_address,decimals,expected_amount,expected_units,
         deposit_address,intent_salt,factory_address,forwarder_init_code_hash,start_block,confirmations,status,expires_at,metadata,created_at,updated_at)
         VALUES (?,?,?,'payment','batch-token-2','batch-test',1337,'USDC',?,6,'0.0001','100',?,?,?,?,1,2,'pending',?,'{}',?,?)`).bind(
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
    const extraTokenIds = Array.from({ length: 99 }, () => randomId("pi"));
    await bindings.DB.batch(
      extraTokenIds.map((id, index) => {
        const salt = `0x${(index + 1).toString(16).padStart(64, "0")}` as `0x${string}`;
        const fields = counterfactualAddress(testFactory, salt, testTreasury, testToken);
        return bindings.DB.prepare(`INSERT INTO payment_intents
          (id,idempotency_key,request_hash,kind,external_id,chain,chain_id,asset,token_address,decimals,expected_amount,expected_units,
           deposit_address,intent_salt,factory_address,forwarder_init_code_hash,start_block,confirmations,status,expires_at,metadata,created_at,updated_at)
           VALUES (?,?,?,'payment',?,'batch-test',1337,'USDC',?,6,'0.0001','100',?,?,?,?,1,2,'pending',?,'{}',?,?)`).bind(
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
      rpcUrl: "https://rpc.batch",
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
      "UPDATE payment_intents SET status = 'expired', expires_at = ? WHERE id = ?",
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
          "SELECT tx_hash, amount_units, block_number FROM payment_transactions WHERE payment_intent = ? ORDER BY tx_hash",
        )
          .bind(tokenId)
          .all()
      ).results,
    ).toEqual([
      { tx_hash: tokenTxHash, amount_units: "40", block_number: 150 },
      { tx_hash: partialTokenTxHash, amount_units: "60", block_number: 150 },
    ]);
    expect(
      await bindings.DB.prepare("SELECT status FROM payment_intents WHERE id = ?")
        .bind(tokenId)
        .first(),
    ).toEqual({ status: "paid" });
    expect(
      await bindings.DB.prepare(
        "SELECT tx_hash, amount_units, block_number FROM payment_transactions WHERE payment_intent = ?",
      )
        .bind(secondTokenId)
        .first(),
    ).toEqual({ tx_hash: secondTokenTxHash, amount_units: "100", block_number: 150 });
    expect(
      await bindings.DB.prepare("SELECT status FROM payment_intents WHERE id = ?")
        .bind(secondTokenId)
        .first(),
    ).toEqual({ status: "paid" });
    expect(
      await bindings.DB.prepare(
        "SELECT COUNT(*) AS count FROM payment_transactions WHERE tx_hash = ?",
      )
        .bind(zeroTokenTxHash)
        .first(),
    ).toEqual({ count: 0 });

    await bindings.DB.batch([
      bindings.DB.prepare("DELETE FROM payment_intents WHERE chain = 'batch-test'"),
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
        return bindings.DB.prepare(`INSERT INTO payment_intents
          (id,idempotency_key,request_hash,kind,external_id,chain,chain_id,asset,token_address,decimals,expected_amount,expected_units,
           deposit_address,intent_salt,factory_address,forwarder_init_code_hash,start_block,confirmations,status,expires_at,metadata,created_at,updated_at)
           VALUES (?,?,?,'payment',?,'scale-test',1337,'USDC',?,6,'0.0001','100',?,?,?,?,1,2,'pending',?,'{}',?,?)`).bind(
          randomId("pi"),
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
        "SELECT * FROM payment_intents WHERE chain = 'scale-test'",
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
    await bindings.DB.prepare("DELETE FROM payment_intents WHERE chain = 'scale-test'").run();
  });
});

describe("confirmation and reorg state", () => {
  it("rolls collection amounts and fees back before retrying a reorged transaction", async () => {
    const now = unixNow();
    const intentId = randomId("pi");
    const jobId = randomId("swp");
    const fields = intentFields("89", "");
    await bindings.DB.batch([
      bindings.DB.prepare(`INSERT INTO payment_intents
        (id,idempotency_key,request_hash,kind,external_id,chain,chain_id,asset,token_address,decimals,expected_amount,expected_units,
         deposit_address,intent_salt,factory_address,forwarder_init_code_hash,start_block,confirmations,status,expires_at,metadata,created_at,updated_at)
         VALUES (?,?,?,'payment','collection-reorg','test',1337,'ETH','',18,'1','100',?,?,?,?,1,2,'paid',?,'{}',?,?)`).bind(
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
        (id,payment_intent,chain,observed_units,collected_units,remaining_units,status,next_attempt_at,completed_at,created_at,updated_at)
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
    const intentId = randomId("pi");
    const fields = intentFields("91", "");
    await bindings.DB.prepare(`INSERT INTO payment_intents
      (id,idempotency_key,request_hash,kind,external_id,chain,chain_id,asset,token_address,decimals,expected_amount,expected_units,
       deposit_address,intent_salt,factory_address,forwarder_init_code_hash,start_block,confirmations,status,expires_at,metadata,created_at,updated_at)
       VALUES (?,?,?,'invoice','expired-order','test',1337,'ETH','',18,'1','100',?,?,?,?,10,2,'pending',?,'{}',?,?)`)
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
        await bindings.DB.prepare("SELECT status FROM payment_intents WHERE id = ?")
          .bind(intentId)
          .first<{ status: string }>()
      )?.status,
    ).toBe("expired");
  });

  it("emits each paid transition once and reverses it after an orphaned block", async () => {
    const now = unixNow();
    const intentId = randomId("pi");
    const fields = intentFields("92", "");
    await bindings.DB.prepare(`INSERT INTO payment_intents
      (id,idempotency_key,request_hash,kind,external_id,chain,chain_id,asset,token_address,decimals,expected_amount,expected_units,
       deposit_address,intent_salt,factory_address,forwarder_init_code_hash,start_block,confirmations,status,expires_at,metadata,created_at,updated_at)
       VALUES (?,?,?,'payment','reorg-order','test',1337,'ETH','',18,'0.0000000000000001','100',?,?,?,?,10,2,'pending',?,'{}',?,?)`)
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
    await bindings.DB.prepare(`INSERT INTO payment_transactions
      (id,payment_intent,chain,tx_hash,event_index,asset,from_address,to_address,amount_units,block_number,block_hash,block_timestamp,canonical,created_at,updated_at)
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
    let intent = await bindings.DB.prepare("SELECT * FROM payment_intents WHERE id = ?")
      .bind(intentId)
      .first<IntentRow>();
    await recalculateChain(bindings, network, [intent!], 10, new Set());
    expect(
      (
        await bindings.DB.prepare("SELECT status FROM payment_intents WHERE id = ?")
          .bind(intentId)
          .first<{ status: string }>()
      )?.status,
    ).toBe("confirming");
    intent = await bindings.DB.prepare("SELECT * FROM payment_intents WHERE id = ?")
      .bind(intentId)
      .first<IntentRow>();
    await recalculateChain(bindings, network, [intent!], 11, new Set());
    intent = await bindings.DB.prepare("SELECT * FROM payment_intents WHERE id = ?")
      .bind(intentId)
      .first<IntentRow>();
    expect(intent?.status).toBe("paid");
    await recalculateChain(bindings, network, [intent!], 12, new Set());
    expect(
      (
        await bindings.DB.prepare(
          "SELECT count(*) AS count FROM webhook_events WHERE payment_intent = ? AND type = 'payment.succeeded'",
        )
          .bind(intentId)
          .first<{ count: number }>()
      )?.count,
    ).toBe(1);

    await bindings.DB.prepare(
      "UPDATE payment_transactions SET canonical = 0 WHERE payment_intent = ?",
    )
      .bind(intentId)
      .run();
    intent = await bindings.DB.prepare("SELECT * FROM payment_intents WHERE id = ?")
      .bind(intentId)
      .first<IntentRow>();
    await recalculateChain(bindings, network, [intent!], 12, new Set([intentId]));
    expect(
      (
        await bindings.DB.prepare("SELECT status FROM payment_intents WHERE id = ?")
          .bind(intentId)
          .first<{ status: string }>()
      )?.status,
    ).toBe("reorged");
    expect(
      (
        await bindings.DB.prepare(
          "SELECT count(*) AS count FROM webhook_events WHERE payment_intent = ? AND type = 'payment.reorged'",
        )
          .bind(intentId)
          .first<{ count: number }>()
      )?.count,
    ).toBe(1);
    const event = await bindings.DB.prepare(
      "SELECT body FROM webhook_events WHERE payment_intent = ? AND type = 'payment.reorged'",
    )
      .bind(intentId)
      .first<{ body: string }>();
    expect(JSON.parse(event!.body).data.paymentIntent.transactionHashes).toEqual([
      `0x${"1".repeat(64)}`,
    ]);
  });

  it("collects a confirmed late payment without crediting it", async () => {
    const now = unixNow();
    const intentId = randomId("pi");
    const fields = intentFields("93", testToken);
    await bindings.DB.batch([
      bindings.DB.prepare(`INSERT INTO payment_intents
        (id,idempotency_key,request_hash,kind,external_id,chain,chain_id,asset,token_address,decimals,expected_amount,expected_units,
         deposit_address,intent_salt,factory_address,forwarder_init_code_hash,start_block,confirmations,status,expires_at,metadata,created_at,updated_at)
         VALUES (?,?,?,'payment','late-order','test',1337,'USDC','0x9999999999999999999999999999999999999999',6,'0.0001','100',?,?,?,?,1,2,'expired',?,'{}',?,?)`).bind(
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
      bindings.DB.prepare(`INSERT INTO payment_transactions
        (id,payment_intent,chain,tx_hash,event_index,asset,from_address,to_address,amount_units,block_number,block_hash,block_timestamp,canonical,created_at,updated_at)
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
    const intent = await bindings.DB.prepare("SELECT * FROM payment_intents WHERE id = ?")
      .bind(intentId)
      .first<IntentRow>();
    const network = loadNetworks(bindings.NETWORKS_JSON).get("test")!;
    await recalculateChain(bindings, network, [intent!], 11, new Set());
    const updated = await bindings.DB.prepare(
      "SELECT status, received_units, confirmed_units FROM payment_intents WHERE id = ?",
    )
      .bind(intentId)
      .first<{ status: string; received_units: string; confirmed_units: string }>();
    expect(updated).toEqual({ status: "expired", received_units: "0", confirmed_units: "0" });
    expect(
      await bindings.DB.prepare(
        "SELECT status, observed_units FROM sweep_jobs WHERE payment_intent = ?",
      )
        .bind(intentId)
        .first(),
    ).toEqual({ status: "queued", observed_units: "100" });
    expect(
      (
        await bindings.DB.prepare(
          "SELECT count(*) AS count FROM webhook_events WHERE payment_intent = ?",
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
    const intent = await bindings.DB.prepare("SELECT id FROM payment_intents LIMIT 1").first<{
      id: string;
    }>();
    expect(intent).not.toBeNull();
    const body = JSON.stringify({ id: eventId, type: "payment.succeeded" });
    await bindings.DB.prepare(`INSERT INTO webhook_events
      (event_id,type,payment_intent,body,status,attempts,next_attempt_at,created_at,updated_at)
      VALUES (?,'payment.succeeded',?,?,'pending',0,?,?,?)`)
      .bind(eventId, intent!.id, body, unixNow(), unixNow(), unixNow())
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
    const intent = await bindings.DB.prepare("SELECT id FROM payment_intents LIMIT 1").first<{
      id: string;
    }>();
    await bindings.DB.prepare(`INSERT INTO webhook_events
      (event_id,type,payment_intent,body,status,attempts,next_attempt_at,created_at,updated_at)
      VALUES (?,'payment.succeeded',?,'{}','pending',0,?,?,?)`)
      .bind(eventId, intent!.id, unixNow(), unixNow(), unixNow())
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

  it("dispatches due sweeps even when webhook configuration is broken", async () => {
    const now = unixNow();
    const intentId = randomId("pi");
    const jobId = randomId("swp");
    const fields = intentFields("94", "");
    await bindings.DB.batch([
      bindings.DB.prepare(`INSERT INTO payment_intents
        (id,idempotency_key,request_hash,kind,external_id,chain,chain_id,asset,token_address,decimals,expected_amount,expected_units,
         deposit_address,intent_salt,factory_address,forwarder_init_code_hash,start_block,confirmations,status,expires_at,metadata,created_at,updated_at)
         VALUES (?,?,?,'invoice','dispatch-test','test',1337,'ETH','',18,'1','1',?,?,?,?,1,2,'paid',?,'{}',?,?)`).bind(
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
        (id,payment_intent,chain,observed_units,remaining_units,status,next_attempt_at,last_dispatched_at,created_at,updated_at)
        VALUES (?,?,'test','1','0','queued',?,0,?,?)`).bind(jobId, intentId, now, now, now),
    ]);
    const sendBatch = vi.fn(async (_messages: MessageSendRequest<SweepMessage>[]) => undefined);
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
      SWEEP_QUEUE: { sendBatch } as unknown as Queue<SweepMessage>,
    });
    expect(sendBatch).toHaveBeenCalledWith(
      expect.arrayContaining([expect.objectContaining({ body: { jobId } })]),
    );
  });
});

function create(
  idempotencyKey: string,
  overrides: { amount: string; metadata: Record<string, unknown>; kind?: "payment" | "invoice" },
): Promise<Response> {
  return api.fetch(
    authorizedRequest("https://gateway.test/api/payments/v1/intents", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": idempotencyKey },
      body: JSON.stringify({
        kind: "payment",
        externalId: idempotencyKey,
        chain: "test",
        asset: "USDC",
        expiresInSeconds: 1800,
        ...overrides,
      }),
    }),
  );
}

function authorizedRequest(url: string, init: RequestInit = {}): Request {
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${apiKey}`);
  return new Request(url, { ...init, headers });
}

function intentFields(seed: string, tokenAddress: typeof testToken | "") {
  const salt = `0x${seed.repeat(32)}` as `0x${string}`;
  return { salt, ...counterfactualAddress(testFactory, salt, testTreasury, tokenAddress) };
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
