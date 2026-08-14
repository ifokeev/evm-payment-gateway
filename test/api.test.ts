import { env, exports } from "cloudflare:workers";
import { privateKeyToAccount } from "viem/accounts";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { loadNetworks } from "../src/domain";
import { deliverWebhooks, expirePendingIntents, randomId, recalculateChain, runScheduled, safeErrorText, unixNow } from "../src/monitor";
import type { ApiEnv, IntentRow, SweepCoordinatorService, SweepMessage } from "../src/types";

const bindings = env as unknown as ApiEnv;
const workerExports = exports as unknown as { default: { fetch(request: Request): Promise<Response> }; SweepCoordinator: SweepCoordinatorService };
const api = workerExports.default;
const coordinator = workerExports.SweepCoordinator;
const apiKey = "test-api-key-at-least-24-characters";
let webhookResponder: ((request: Request) => Promise<Response>) | undefined;
let turnkeyResponder = defaultTurnkeyResponder;
const turnkeyRequests: Array<{ body: Record<string, unknown>; stamp: string | null }> = [];

beforeAll(() => {
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const outgoing = input instanceof Request ? input : new Request(input, init);
    if (outgoing.url === "https://rpc.test/") {
      const request = JSON.parse(await outgoing.text());
      const result = request.method === "eth_chainId" ? "0x539" : request.method === "eth_blockNumber" ? "0x7b" : null;
      return Response.json({ jsonrpc: "2.0", id: request.id, result });
    }
    if (outgoing.url === "https://webhook.test/events" && webhookResponder) return webhookResponder(outgoing);
    if (outgoing.url === "https://api.turnkey.com/public/v1/submit/create_wallet_accounts") {
      const body = JSON.parse(await outgoing.text()) as Record<string, unknown>;
      turnkeyRequests.push({ body, stamp: outgoing.headers.get("X-Stamp") });
      return turnkeyResponder(body);
    }
    throw new Error(`unmocked request: ${outgoing.url}`);
  }));
});

beforeEach(() => {
  turnkeyRequests.length = 0;
  turnkeyResponder = defaultTurnkeyResponder;
});

describe("payment API", () => {
  it("keeps health public and every payment read private", async () => {
    expect((await api.fetch(new Request("https://gateway.test/api/payments/v1/health"))).status).toBe(200);
    expect((await api.fetch(new Request("https://gateway.test/api/payments/v1/intents/missing"))).status).toBe(401);
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
    expect(turnkeyRequests).toHaveLength(1);
    expect(turnkeyRequests[0].stamp).toBeTruthy();
    expect(((turnkeyRequests[0].body.parameters as { accounts: Array<{ path: string }> }).accounts[0]).path)
      .toMatch(/^m\/44'\/60'\/0'\/0\/\d+$/);

    const replay = await create(key, { amount: "10.25", metadata: { a: 2, z: 1 } });
    expect(replay.status).toBe(200);
    expect((await replay.json<{ id: string }>()).id).toBe(body.id);
    expect((await create(key, { amount: "10.26", metadata: { a: 2, z: 1 } })).status).toBe(409);

    const poll = await api.fetch(authorizedRequest(`https://gateway.test/api/payments/v1/intents/${body.id}`));
    expect(poll.status).toBe(200);
    expect((await poll.json<{ status: string }>()).status).toBe("pending");

    await bindings.DB.prepare("UPDATE payment_intents SET received_units = '4000000', status = 'underpaid' WHERE id = ?")
      .bind(body.id).run();
    const partial = await (await api.fetch(authorizedRequest(`https://gateway.test/api/payments/v1/intents/${body.id}`)))
      .json<Record<string, unknown>>();
    expect(partial).toMatchObject({
      status: "underpaid",
      remainingAmount: "6.25",
      remainingUnits: "6250000",
      paymentUri: body.paymentUri,
    });
    expect(partial.topUpPaymentUri).toContain("uint256=6250000");
    expect(partial.topUpPaymentUri).not.toBe(body.paymentUri);
    expect(partial.topUpQrCodeDataUrl).toMatch(/^data:image\/svg\+xml;base64,/);

    await bindings.DB.prepare("UPDATE payment_intents SET expires_at = ? WHERE id = ?").bind(unixNow() - 1, body.id).run();
    const expired = await (await api.fetch(authorizedRequest(`https://gateway.test/api/payments/v1/intents/${body.id}`)))
      .json<Record<string, unknown>>();
    expect(expired).toMatchObject({ expired: true, remainingAmount: "6.25", remainingUnits: "6250000" });
    expect(expired.topUpPaymentUri).toBeNull();
    expect(expired.topUpQrCodeDataUrl).toBeNull();

    await bindings.DB.prepare("UPDATE payment_intents SET received_units = '11000000', confirmed_units = '11000000', status = 'paid' WHERE id = ?")
      .bind(body.id).run();
    const overpaid = await (await api.fetch(authorizedRequest(`https://gateway.test/api/payments/v1/intents/${body.id}`)))
      .json<Record<string, unknown>>();
    expect(overpaid).toMatchObject({ remainingAmount: "0", remainingUnits: "0" });
    expect(overpaid.topUpPaymentUri).toBeNull();
    expect(overpaid.topUpQrCodeDataUrl).toBeNull();
  });

  it("fails closed when Turnkey cannot allocate a deposit address", async () => {
    turnkeyResponder = async () => new Response(null, { status: 503 });
    const response = await create(randomId("idem"), { amount: "1", metadata: {} });
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "deposit signer unavailable" });
  });

  it("rejects boundary bypasses and unknown JSON fields", async () => {
    const request = authorizedRequest("https://gateway.test/api/payments/v1/intents", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": randomId("idem") },
      body: JSON.stringify({ kind: "payment", externalId: "order", chain: "test", asset: "USDC", amount: "1", unexpected: true }),
    });
    expect((await api.fetch(request)).status).toBe(400);
    const wrongType = authorizedRequest("https://gateway.test/api/payments/v1/intents", {
      method: "POST", headers: { "Content-Type": "text/plain", "Idempotency-Key": randomId("idem") }, body: "{}",
    });
    expect((await api.fetch(wrongType)).status).toBe(415);
    const jsonp = authorizedRequest("https://gateway.test/api/payments/v1/intents", {
      method: "POST", headers: { "Content-Type": "application/jsonp", "Idempotency-Key": randomId("idem") }, body: "{}",
    });
    expect((await api.fetch(jsonp)).status).toBe(415);
  });

  it("accepts only generic payment and invoice kinds", async () => {
    const invoice = await create(randomId("idem"), { amount: "1", metadata: {}, kind: "invoice" });
    expect(invoice.status).toBe(201);
    expect((await invoice.json<{ kind: string }>()).kind).toBe("invoice");

    const invalid = authorizedRequest("https://gateway.test/api/payments/v1/intents", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": randomId("idem") },
      body: JSON.stringify({ kind: "custom", externalId: "unsupported-kind", chain: "test", asset: "USDC", amount: "1" }),
    });
    expect(await (await api.fetch(invalid)).json()).toEqual({ error: "kind must be payment or invoice" });
    const schema = await bindings.DB.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'payment_intents'")
      .first<{ sql: string }>();
    expect(schema?.sql).toContain("kind IN ('payment', 'invoice')");
  });

  it("redacts RPC credentials and raw transactions from errors", () => {
    const message = safeErrorText(new Error(`RPC https://rpc.test/v3/private-key rejected 0x${"ab".repeat(128)}`));
    expect(message).toBe("RPC [redacted-url] rejected [redacted-hex]");
  });
});

describe("sweep coordinator", () => {
  it("stores signed transactions idempotently and caps cumulative gas funding", async () => {
    const now = unixNow();
    const intentId = randomId("pi");
    const jobId = randomId("swp");
    const deposit = "0x3333333333333333333333333333333333333333";
    await bindings.DB.batch([
      bindings.DB.prepare(`INSERT INTO payment_intents
        (id,idempotency_key,request_hash,kind,external_id,chain,chain_id,asset,token_address,decimals,expected_amount,expected_units,
         deposit_address,derivation_index,start_block,confirmations,status,expires_at,metadata,created_at,updated_at)
         VALUES (?,?,?,'payment','order','test',1337,'USDC','0x9999999999999999999999999999999999999999',6,'0.0001','100',?,900,1,2,'paid',?,'{}',?,?)`)
        .bind(intentId, randomId("idem"), "a".repeat(64), deposit, now + 3600, now, now),
      bindings.DB.prepare(`INSERT INTO sweep_jobs
        (id,payment_intent,chain,observed_units,remaining_units,status,next_attempt_at,created_at,updated_at)
        VALUES (?,?,'test','100','0','queued',?,?,?)`).bind(jobId, intentId, now, now, now),
    ]);
    const owner = randomId("owner");
    expect(await coordinator.claimSweep(jobId, owner)).not.toBeNull();
    const signer = privateKeyToAccount("0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef");
    const firstRaw = await signer.signTransaction({ type: "legacy", chainId: 1337, nonce: 0, to: deposit, value: 60n, gas: 21_000n, gasPrice: 1n });
    const secondRaw = await signer.signTransaction({ type: "legacy", chainId: 1337, nonce: 1, to: deposit, value: 40n, gas: 21_000n, gasPrice: 1n });
    const first = await coordinator.registerSweepTransaction(jobId, owner, "gas", firstRaw);
    expect((await coordinator.registerSweepTransaction(jobId, owner, "gas", firstRaw)).id).toBe(first.id);
    await coordinator.registerSweepTransaction(jobId, owner, "gas", secondRaw);
    const rows = await bindings.DB.prepare("SELECT amount_units FROM sweep_transactions WHERE sweep_job = ? ORDER BY nonce").bind(jobId).all<{ amount_units: string }>();
    expect(rows.results.map((row) => row.amount_units)).toEqual(["60", "40"]);
  });
});

describe("confirmation and reorg state", () => {
  it("expires an untouched intent even when chain polling is unavailable", async () => {
    const now = unixNow();
    const intentId = randomId("pi");
    await bindings.DB.prepare(`INSERT INTO payment_intents
      (id,idempotency_key,request_hash,kind,external_id,chain,chain_id,asset,token_address,decimals,expected_amount,expected_units,
       deposit_address,derivation_index,start_block,confirmations,status,expires_at,metadata,created_at,updated_at)
       VALUES (?,?,?,'invoice','expired-order','test',1337,'ETH','',18,'1','100',?,902,10,2,'pending',?,'{}',?,?)`)
      .bind(intentId, randomId("idem"), "c".repeat(64), "0x6666666666666666666666666666666666666666", now - 1, now - 3601, now - 3601).run();
    await expirePendingIntents(bindings.DB);
    expect((await bindings.DB.prepare("SELECT status FROM payment_intents WHERE id = ?").bind(intentId).first<{ status: string }>())?.status).toBe("expired");
  });

  it("emits each paid transition once and reverses it after an orphaned block", async () => {
    const now = unixNow();
    const intentId = randomId("pi");
    await bindings.DB.prepare(`INSERT INTO payment_intents
      (id,idempotency_key,request_hash,kind,external_id,chain,chain_id,asset,token_address,decimals,expected_amount,expected_units,
       deposit_address,derivation_index,start_block,confirmations,status,expires_at,metadata,created_at,updated_at)
       VALUES (?,?,?,'payment','reorg-order','test',1337,'ETH','',18,'0.0000000000000001','100',?,901,10,2,'pending',?,'{}',?,?)`)
      .bind(intentId, randomId("idem"), "b".repeat(64), "0x4444444444444444444444444444444444444444", now + 3600, now, now).run();
    await bindings.DB.prepare(`INSERT INTO payment_transactions
      (id,payment_intent,chain,tx_hash,event_index,asset,from_address,to_address,amount_units,block_number,block_hash,block_timestamp,canonical,created_at,updated_at)
      VALUES (?,?,'test',?,-1,'ETH','0x5555555555555555555555555555555555555555','0x4444444444444444444444444444444444444444','100',10,?, ?,1,?,?)`)
      .bind(randomId("ptx"), intentId, `0x${"1".repeat(64)}`, `0x${"2".repeat(64)}`, now, now, now).run();
    const network = loadNetworks(bindings.NETWORKS_JSON).get("test")!;
    let intent = await bindings.DB.prepare("SELECT * FROM payment_intents WHERE id = ?").bind(intentId).first<IntentRow>();
    await recalculateChain(bindings, network, [intent!], 10, new Set());
    expect((await bindings.DB.prepare("SELECT status FROM payment_intents WHERE id = ?").bind(intentId).first<{ status: string }>())?.status).toBe("confirming");
    intent = await bindings.DB.prepare("SELECT * FROM payment_intents WHERE id = ?").bind(intentId).first<IntentRow>();
    await recalculateChain(bindings, network, [intent!], 11, new Set());
    intent = await bindings.DB.prepare("SELECT * FROM payment_intents WHERE id = ?").bind(intentId).first<IntentRow>();
    expect(intent?.status).toBe("paid");
    await recalculateChain(bindings, network, [intent!], 12, new Set());
    expect((await bindings.DB.prepare("SELECT count(*) AS count FROM webhook_events WHERE payment_intent = ? AND type = 'payment.succeeded'")
      .bind(intentId).first<{ count: number }>())?.count).toBe(1);

    await bindings.DB.prepare("UPDATE payment_transactions SET canonical = 0 WHERE payment_intent = ?").bind(intentId).run();
    intent = await bindings.DB.prepare("SELECT * FROM payment_intents WHERE id = ?").bind(intentId).first<IntentRow>();
    await recalculateChain(bindings, network, [intent!], 12, new Set([intentId]));
    expect((await bindings.DB.prepare("SELECT status FROM payment_intents WHERE id = ?").bind(intentId).first<{ status: string }>())?.status).toBe("reorged");
    expect((await bindings.DB.prepare("SELECT count(*) AS count FROM webhook_events WHERE payment_intent = ? AND type = 'payment.reorged'")
      .bind(intentId).first<{ count: number }>())?.count).toBe(1);
    const event = await bindings.DB.prepare("SELECT body FROM webhook_events WHERE payment_intent = ? AND type = 'payment.reorged'")
      .bind(intentId).first<{ body: string }>();
    expect(JSON.parse(event!.body).data.paymentIntent.transactionHashes).toEqual([`0x${"1".repeat(64)}`]);
  });

  it("collects a confirmed late payment without crediting it", async () => {
    const now = unixNow();
    const intentId = randomId("pi");
    await bindings.DB.batch([
      bindings.DB.prepare(`INSERT INTO payment_intents
        (id,idempotency_key,request_hash,kind,external_id,chain,chain_id,asset,token_address,decimals,expected_amount,expected_units,
         deposit_address,derivation_index,start_block,confirmations,status,expires_at,metadata,created_at,updated_at)
         VALUES (?,?,?,'payment','late-order','test',1337,'USDC','0x9999999999999999999999999999999999999999',6,'0.0001','100',?,904,1,2,'expired',?,'{}',?,?)`)
        .bind(intentId, randomId("idem"), "e".repeat(64), "0x8888888888888888888888888888888888888888", now - 120, now - 3600, now - 3600),
      bindings.DB.prepare(`INSERT INTO payment_transactions
        (id,payment_intent,chain,tx_hash,event_index,asset,from_address,to_address,amount_units,block_number,block_hash,block_timestamp,canonical,created_at,updated_at)
        VALUES (?,?,'test',?,0,'USDC','0x5555555555555555555555555555555555555555','0x8888888888888888888888888888888888888888','100',10,?,?,1,?,?)`)
        .bind(randomId("ptx"), intentId, `0x${"3".repeat(64)}`, `0x${"4".repeat(64)}`, now, now, now),
    ]);
    const intent = await bindings.DB.prepare("SELECT * FROM payment_intents WHERE id = ?").bind(intentId).first<IntentRow>();
    const network = loadNetworks(bindings.NETWORKS_JSON).get("test")!;
    await recalculateChain(bindings, network, [intent!], 11, new Set());
    const updated = await bindings.DB.prepare("SELECT status, received_units, confirmed_units FROM payment_intents WHERE id = ?")
      .bind(intentId).first<{ status: string; received_units: string; confirmed_units: string }>();
    expect(updated).toEqual({ status: "expired", received_units: "0", confirmed_units: "0" });
    expect(await bindings.DB.prepare("SELECT status, observed_units FROM sweep_jobs WHERE payment_intent = ?")
      .bind(intentId).first()).toEqual({ status: "queued", observed_units: "100" });
    expect((await bindings.DB.prepare("SELECT count(*) AS count FROM webhook_events WHERE payment_intent = ?")
      .bind(intentId).first<{ count: number }>())?.count).toBe(0);
  });
});

describe("webhook delivery", () => {
  it("keeps the event ID and body stable across signed retries", async () => {
    await bindings.DB.prepare("UPDATE webhook_events SET status = 'delivered' WHERE status = 'pending'").run();
    const eventId = randomId("evt");
    const intent = await bindings.DB.prepare("SELECT id FROM payment_intents LIMIT 1").first<{ id: string }>();
    expect(intent).not.toBeNull();
    const body = JSON.stringify({ id: eventId, type: "payment.succeeded" });
    await bindings.DB.prepare(`INSERT INTO webhook_events
      (event_id,type,payment_intent,body,status,attempts,next_attempt_at,created_at,updated_at)
      VALUES (?,'payment.succeeded',?,?,'pending',0,?,?,?)`).bind(eventId, intent!.id, body, unixNow(), unixNow(), unixNow()).run();
    const seen: Array<{ id: string | null; timestamp: string | null; signature: string | null; body: string }> = [];
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
    await bindings.DB.prepare("UPDATE webhook_events SET next_attempt_at = ? WHERE event_id = ?").bind(unixNow(), eventId).run();
    await deliverWebhooks(bindings);
    expect(seen).toHaveLength(2);
    expect(seen.map((item) => item.id)).toEqual([eventId, eventId]);
    expect(seen.map((item) => item.body)).toEqual([body, body]);
    const hmacKey = await crypto.subtle.importKey("raw", new TextEncoder().encode(bindings.PAYMENT_WEBHOOK_SECRET),
      { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    for (const item of seen) {
      const signed = await crypto.subtle.sign("HMAC", hmacKey, new TextEncoder().encode(`${item.timestamp}.${item.body}`));
      const expected = [...new Uint8Array(signed)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
      expect(item.signature).toBe(`v1,${expected}`);
    }
    expect((await bindings.DB.prepare("SELECT status FROM webhook_events WHERE event_id = ?").bind(eventId).first<{ status: string }>())?.status).toBe("delivered");
  });

  it("requires HTTPS and never follows webhook redirects", async () => {
    await expect(deliverWebhooks({ ...bindings, PAYMENT_WEBHOOK_URL: "http://webhook.test/events" })).rejects.toThrow("HTTPS");

    const eventId = randomId("evt");
    const intent = await bindings.DB.prepare("SELECT id FROM payment_intents LIMIT 1").first<{ id: string }>();
    await bindings.DB.prepare(`INSERT INTO webhook_events
      (event_id,type,payment_intent,body,status,attempts,next_attempt_at,created_at,updated_at)
      VALUES (?,'payment.succeeded',?,'{}','pending',0,?,?,?)`).bind(eventId, intent!.id, unixNow(), unixNow(), unixNow()).run();
    let redirectMode = "";
    webhookResponder = async (request) => {
      redirectMode = request.redirect;
      return new Response(null, { status: 307, headers: { Location: "https://attacker.invalid/" } });
    };
    await deliverWebhooks(bindings);
    expect(redirectMode).toBe("manual");
    expect((await bindings.DB.prepare("SELECT status FROM webhook_events WHERE event_id = ?").bind(eventId).first<{ status: string }>())?.status).toBe("pending");
  });

  it("dispatches due sweeps even when webhook configuration is broken", async () => {
    const now = unixNow();
    const intentId = randomId("pi");
    const jobId = randomId("swp");
    await bindings.DB.batch([
      bindings.DB.prepare(`INSERT INTO payment_intents
        (id,idempotency_key,request_hash,kind,external_id,chain,chain_id,asset,token_address,decimals,expected_amount,expected_units,
         deposit_address,derivation_index,start_block,confirmations,status,expires_at,metadata,created_at,updated_at)
         VALUES (?,?,?,'invoice','dispatch-test','test',1337,'ETH','',18,'1','1',?,903,1,2,'paid',?,'{}',?,?)`)
        .bind(intentId, randomId("idem"), "d".repeat(64), "0x7777777777777777777777777777777777777777", now + 3600, now, now),
      bindings.DB.prepare(`INSERT INTO sweep_jobs
        (id,payment_intent,chain,observed_units,remaining_units,status,next_attempt_at,last_dispatched_at,created_at,updated_at)
        VALUES (?,?,'test','1','0','queued',?,0,?,?)`).bind(jobId, intentId, now, now, now),
    ]);
    const sendBatch = vi.fn(async (_messages: MessageSendRequest<SweepMessage>[]) => undefined);
    const noIntentNetwork = JSON.stringify([{
      name: "empty", chainId: 31337, rpcUrl: "https://rpc.empty", treasuryAddress: "0x2222222222222222222222222222222222222222",
      confirmations: 2, maxGasPriceWei: "1000000000", nativeAsset: "ETH", tokens: {},
    }]);
    await runScheduled({
      ...bindings,
      NETWORKS_JSON: noIntentNetwork,
      PAYMENT_WEBHOOK_SECRET: "short",
      SWEEP_QUEUE: { sendBatch } as unknown as Queue<SweepMessage>,
    });
    expect(sendBatch).toHaveBeenCalledWith(expect.arrayContaining([expect.objectContaining({ body: { jobId } })]));
  });
});

function create(idempotencyKey: string, overrides: { amount: string; metadata: Record<string, unknown>; kind?: "payment" | "invoice" }): Promise<Response> {
  return api.fetch(authorizedRequest("https://gateway.test/api/payments/v1/intents", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Idempotency-Key": idempotencyKey },
    body: JSON.stringify({
      kind: "payment", externalId: idempotencyKey, chain: "test", asset: "USDC", expiresInSeconds: 1800, ...overrides,
    }),
  }));
}

function authorizedRequest(url: string, init: RequestInit = {}): Request {
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${apiKey}`);
  return new Request(url, { ...init, headers });
}

async function defaultTurnkeyResponder(body: Record<string, unknown>): Promise<Response> {
  const parameters = body.parameters as { accounts: Array<{ path: string }> };
  const index = BigInt(parameters.accounts[0].path.split("/").at(-1)!);
  const address = `0x${(0x700000n + index).toString(16).padStart(40, "0")}`;
  return Response.json({
    activity: {
      id: `activity-${index}`,
      organizationId: "test-org",
      type: "ACTIVITY_TYPE_CREATE_WALLET_ACCOUNTS",
      status: "ACTIVITY_STATUS_COMPLETED",
      intent: { createWalletAccountsIntent: body.parameters },
      result: { createWalletAccountsResult: { addresses: [address] } },
    },
  });
}
