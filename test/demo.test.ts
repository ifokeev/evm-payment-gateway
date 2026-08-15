import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import demo, { type DemoEnv } from "../demo/worker";

const intent = {
  id: "pi_demo123",
  kind: "payment",
  externalId: "demo_123",
  chain: "base-sepolia",
  chainId: 84532,
  asset: "USDC",
  expectedAmount: "1.25",
  expectedUnits: "1250000",
  receivedAmount: "0",
  confirmedAmount: "0",
  remainingAmount: "1.25",
  remainingUnits: "1250000",
  depositAddress: "0x1111111111111111111111111111111111111111",
  paymentUri:
    "ethereum:0x036CbD53842c5426634e7929541eC2318f3dCF7e@84532/transfer?address=0x1111111111111111111111111111111111111111&uint256=1250000",
  qrCodeDataUrl: "data:image/svg+xml;base64,PHN2Zy8+",
  topUpPaymentUri:
    "ethereum:0x036CbD53842c5426634e7929541eC2318f3dCF7e@84532/transfer?address=0x1111111111111111111111111111111111111111&uint256=1250000",
  topUpQrCodeDataUrl: "data:image/svg+xml;base64,PHN2Zy8+",
  requiredConfirmations: 3,
  status: "pending",
  expiresAt: "2026-08-15T10:30:00.000Z",
  expired: false,
  metadata: { shouldNotLeak: true },
  transactions: [],
};

let env: DemoEnv;
let events: Map<string, string>;
let gatewayRequests: Array<{
  headers: Headers;
  body: Record<string, unknown> | null;
}>;
let rateLimitSuccess: boolean;

beforeEach(() => {
  events = new Map();
  gatewayRequests = [];
  rateLimitSuccess = true;
  env = {
    ASSETS: {
      fetch: vi.fn(async () => new Response("demo asset")),
    } as unknown as Fetcher,
    GATEWAY: {
      fetch: vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = input instanceof Request ? input : new Request(input, init);
        const path = new URL(request.url).pathname;
        gatewayRequests.push({
          headers: new Headers(request.headers),
          body: request.method === "POST" ? await request.clone().json() : null,
        });
        if (request.method === "POST" && path.endsWith("/intents")) {
          return Response.json(intent, { status: 201 });
        }
        if (path.endsWith("/sweep")) {
          return Response.json({ status: "not_queued", transactions: [] });
        }
        return Response.json(intent);
      }),
    } as unknown as Fetcher,
    DEMO_EVENTS: {
      get: vi.fn(async (key: string, type?: string) => {
        const value = events.get(key) ?? null;
        return type === "json" && value ? JSON.parse(value) : value;
      }),
      put: vi.fn(async (key: string, value: string) => {
        events.set(key, value);
      }),
    } as unknown as KVNamespace,
    DEMO_RATE_LIMITER: {
      limit: vi.fn(async () => ({ success: rateLimitSuccess })),
    },
    PAYMENT_API_KEY: "test-api-key-at-least-24-characters",
    PAYMENT_WEBHOOK_SECRET: "test-webhook-secret-at-least-24-characters",
    DEMO_SESSION_SECRET: "test-demo-session-secret-at-least-32-characters",
    TURNSTILE_SITE_KEY: "1x00000000000000000000AA",
    TURNSTILE_SECRET_KEY: "1x0000000000000000000000000000000AA",
    DEMO_CHAIN: "base-sepolia",
    DEMO_ASSET: "USDC",
    DEMO_ASSET_DECIMALS: "6",
    DEMO_MIN_AMOUNT: "0.01",
    DEMO_MAX_AMOUNT: "5",
    DEMO_EXPIRY_SECONDS: "1800",
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => Response.json({ success: true, action: "test", hostname: "localhost" })),
  );
});

afterEach(() => vi.unstubAllGlobals());

describe("public demo", () => {
  it("creates an exact user-chosen payment without exposing backend fields", async () => {
    const response = await demo.fetch(
      createRequest({ amount: "1.250000", purpose: "account_top_up" }),
      env,
    );
    expect(response.status).toBe(201);
    const body = await response.json<{
      intent: Record<string, unknown>;
      accessToken: string;
    }>();
    expect(body.intent).toMatchObject({
      id: intent.id,
      kind: "payment",
      expectedAmount: "1.25",
    });
    expect(body.intent).not.toHaveProperty("metadata");
    expect(body.accessToken.split(".")).toHaveLength(2);

    const gatewayRequest = gatewayRequests[0];
    expect(gatewayRequest.headers.get("Authorization")).toBe(`Bearer ${env.PAYMENT_API_KEY}`);
    expect(gatewayRequest.headers.get("Idempotency-Key")).toMatch(/^demo:/);
    expect(gatewayRequest.body).toMatchObject({
      kind: "payment",
      chain: "base-sepolia",
      asset: "USDC",
      amount: "1.25",
      metadata: { demo: true, purpose: "account_top_up" },
    });

    events.set(
      `intent:${intent.id}`,
      JSON.stringify({ id: "evt_demo", type: "payment.succeeded" }),
    );
    const poll = await demo.fetch(
      new Request(`https://demo.test/api/intents/${intent.id}`, {
        headers: { Authorization: `Bearer ${body.accessToken}` },
      }),
      env,
    );
    expect(poll.status).toBe(200);
    expect(await poll.json()).toMatchObject({
      intent: { id: intent.id },
      sweep: { status: "not_queued" },
      webhookEvent: { id: "evt_demo", type: "payment.succeeded" },
    });

    const unrelated = await demo.fetch(
      new Request("https://demo.test/api/intents/pi_other", {
        headers: { Authorization: `Bearer ${body.accessToken}` },
      }),
      env,
    );
    expect(unrelated.status).toBe(401);
  });

  it("enforces origin, amount, challenge, and rate-limit boundaries", async () => {
    const foreign = createRequest({ amount: "1", purpose: "checkout" });
    foreign.headers.set("Origin", "https://attacker.test");
    expect((await demo.fetch(foreign, env)).status).toBe(403);

    expect(
      (await demo.fetch(createRequest({ amount: "5.000001", purpose: "checkout" }), env)).status,
    ).toBe(400);

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ success: false })),
    );
    expect(
      (await demo.fetch(createRequest({ amount: "1", purpose: "checkout" }), env)).status,
    ).toBe(403);

    rateLimitSuccess = false;
    expect(
      (await demo.fetch(createRequest({ amount: "1", purpose: "checkout" }), env)).status,
    ).toBe(429);
    expect(gatewayRequests).toHaveLength(0);
  });

  it("rejects malformed requests and invalid intent access tokens", async () => {
    const malformed = new Request("https://demo.test/api/intents", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        amount: "1",
        purpose: "checkout",
        idempotencyKey: crypto.randomUUID(),
        turnstileToken: "token",
        unexpected: true,
      }),
    });
    expect((await demo.fetch(malformed, env)).status).toBe(400);

    const created = await demo.fetch(createRequest({ amount: "1", purpose: "checkout" }), env);
    const { accessToken } = await created.json<{ accessToken: string }>();
    const tamperedToken = `${accessToken.slice(0, -1)}${accessToken.endsWith("a") ? "b" : "a"}`;
    const tampered = await demo.fetch(
      new Request(`https://demo.test/api/intents/${intent.id}`, {
        headers: { Authorization: `Bearer ${tamperedToken}` },
      }),
      env,
    );
    expect(tampered.status).toBe(401);

    vi.useFakeTimers();
    try {
      vi.setSystemTime(Date.now() + 24 * 60 * 60 * 1_000 + 1);
      const expired = await demo.fetch(
        new Request(`https://demo.test/api/intents/${intent.id}`, {
          headers: { Authorization: `Bearer ${accessToken}` },
        }),
        env,
      );
      expect(expired.status).toBe(401);
    } finally {
      vi.useRealTimers();
    }
  });

  it("accepts authentic idempotent webhooks and rejects tampering", async () => {
    const event = {
      id: "evt_demo123",
      type: "payment.succeeded",
      createdAt: new Date().toISOString(),
      data: {
        paymentIntent: {
          id: intent.id,
          status: "paid",
          receivedUnits: "1250000",
          confirmedUnits: "1250000",
          transactionHashes: [`0x${"1".repeat(64)}`],
        },
      },
    };
    const rawBody = JSON.stringify(event);
    const timestamp = Math.floor(Date.now() / 1_000).toString();
    const signature = await signWebhook(timestamp, rawBody, env.PAYMENT_WEBHOOK_SECRET);
    const webhookRequest = () =>
      new Request("https://demo.test/webhooks/payment", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Webhook-Id": event.id,
          "Webhook-Timestamp": timestamp,
          "Webhook-Signature": `v1,${signature}`,
        },
        body: rawBody,
      });
    expect((await demo.fetch(webhookRequest(), env)).status).toBe(204);
    expect(JSON.parse(events.get(`intent:${intent.id}`) ?? "null")).toMatchObject({
      id: event.id,
      type: "payment.succeeded",
      paymentIntent: { id: intent.id, confirmedUnits: "1250000" },
    });
    expect((await demo.fetch(webhookRequest(), env)).status).toBe(204);

    const tampered = new Request("https://demo.test/webhooks/payment", {
      method: "POST",
      headers: {
        "Webhook-Id": event.id,
        "Webhook-Timestamp": timestamp,
        "Webhook-Signature": `v1,${signature}`,
      },
      body: rawBody.replace("1250000", "5000000"),
    });
    expect((await demo.fetch(tampered, env)).status).toBe(401);

    const stale = new Request("https://demo.test/webhooks/payment", {
      method: "POST",
      headers: {
        "Webhook-Id": event.id,
        "Webhook-Timestamp": String(Number(timestamp) - 301),
        "Webhook-Signature": `v1,${signature}`,
      },
      body: rawBody,
    });
    expect((await demo.fetch(stale, env)).status).toBe(401);
  });

  it("serves public configuration and delegates static assets", async () => {
    const config = await demo.fetch(new Request("https://demo.test/api/config"), env);
    expect(await config.json()).toEqual({
      chain: "base-sepolia",
      asset: "USDC",
      minimumAmount: "0.01",
      maximumAmount: "5",
      turnstileSiteKey: "1x00000000000000000000AA",
    });
    const asset = await demo.fetch(new Request("https://demo.test/"), env);
    expect(await asset.text()).toBe("demo asset");
  });
});

function createRequest(input: { amount: string; purpose: string }): Request {
  return new Request("https://demo.test/api/intents", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: "https://demo.test",
      "CF-Connecting-IP": "192.0.2.10",
    },
    body: JSON.stringify({
      ...input,
      idempotencyKey: crypto.randomUUID(),
      turnstileToken: "XXXX.DUMMY.TOKEN.XXXX",
    }),
  });
}

async function signWebhook(timestamp: string, body: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(`${timestamp}.${body}`),
  );
  return [...new Uint8Array(signature)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
