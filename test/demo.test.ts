import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import demo, { type DemoEnv } from "../demo/worker";

const intent = {
  id: "di_demo123",
  kind: "payment",
  purpose: "account_top_up",
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
const withdrawal = {
  id: "wd_demo123",
  purpose: "withdrawal",
  externalId: "demo_withdrawal_123",
  chain: "base-sepolia",
  chainId: 84532,
  asset: "USDC",
  amount: "1.25",
  amountUnits: "1250000",
  sourceAddress: "0x2222222222222222222222222222222222222222",
  destinationAddress: "0x3333333333333333333333333333333333333333",
  requiredConfirmations: 3,
  status: "awaiting_signature",
  expiresAt: "2026-08-15T10:30:00.000Z",
  completedAt: null,
  lastError: "",
  proposal: {
    chainId: 84532,
    from: "0x2222222222222222222222222222222222222222",
    to: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
    value: "0",
    data: `0xa9059cbb${"0".repeat(24)}${"3".repeat(40)}${(1_250_000).toString(16).padStart(64, "0")}`,
    amount: "1.25",
    asset: "USDC",
    maxGas: "500000",
    maxGasPriceWei: "1000000000",
  },
  transaction: null,
  internalSecret: "must-not-leak",
  createdAt: "2026-08-15T10:00:00.000Z",
  updatedAt: "2026-08-15T10:00:00.000Z",
};
const swapIntent = {
  ...intent,
  id: "di_swap123",
  purpose: "swap",
  externalId: "demo_swap_123",
  expectedAmount: "0.5",
  expectedUnits: "500000",
  remainingAmount: "0.5",
  remainingUnits: "500000",
};
const swapWithdrawal = {
  ...withdrawal,
  id: "wd_swap123",
  purpose: "swap",
  externalId: "demo_swap_123",
  chain: "ethereum-sepolia",
  chainId: 11155111,
  asset: "ETH",
  amount: "0.00001",
  amountUnits: "10000000000000",
  destinationAddress: "0x4444444444444444444444444444444444444444",
  proposal: {
    ...withdrawal.proposal,
    chainId: 11155111,
    to: "0x4444444444444444444444444444444444444444",
    value: "10000000000000",
    data: "0x",
    amount: "0.00001",
    asset: "ETH",
  },
};
const swap = {
  id: "swp_demo123",
  externalId: "demo_swap_123",
  depositIntentId: swapIntent.id,
  withdrawalIntentId: swapWithdrawal.id,
  input: {
    chain: "base-sepolia",
    chainId: 84532,
    asset: "USDC",
    expectedAmount: "0.5",
    expectedUnits: "500000",
    receivedUnits: "500000",
    confirmedUnits: "500000",
    depositAddress: swapIntent.depositAddress,
    depositStatus: "paid",
    collectionStatus: "complete",
    collectedUnits: "500000",
  },
  output: {
    chain: "ethereum-sepolia",
    chainId: 11155111,
    asset: "ETH",
    amount: "0.00001",
    amountUnits: "10000000000000",
    sourceAddress: swapWithdrawal.sourceAddress,
    destinationAddress: swapWithdrawal.destinationAddress,
    withdrawalStatus: "awaiting_signature",
  },
  refund: {
    address: "0x5555555555555555555555555555555555555555",
    sourceAddress: withdrawal.sourceAddress,
    withdrawalIntentId: null,
    withdrawalStatus: null,
  },
  status: "awaiting_signature",
  quoteExpiresAt: swapIntent.expiresAt,
  lastError: "",
  completedAt: null,
  createdAt: "2026-08-15T10:00:00.000Z",
  updatedAt: "2026-08-15T10:00:00.000Z",
  internalSecret: "must-not-leak",
};
const createdSwap = {
  ...swap,
  withdrawalIntentId: null,
  output: { ...swap.output, withdrawalStatus: null },
  status: "awaiting_input",
};
const analytics = {
  generatedAt: "2026-08-15T12:00:00.000Z",
  assets: [
    {
      chain: "base-sepolia",
      asset: "USDC",
      intents: 12,
      statuses: { pending: 3, paid: 9 },
      confirmedUnits: "4250000",
      collectedUnits: "3750000",
    },
    {
      chain: "ethereum-sepolia",
      asset: "ETH",
      intents: 2,
      statuses: { paid: 1 },
      confirmedUnits: "1000000000000",
      collectedUnits: "500000000000",
    },
  ],
  collectionFeesWei: { "base-sepolia": "secret-operational-detail" },
  webhooks: [{ type: "deposit.succeeded", status: "delivered", count: 9 }],
};
const options = [
  {
    chain: "base-sepolia",
    chainLabel: "Base Sepolia",
    chainId: 84532,
    asset: "USDC",
    decimals: 6,
    minimumAmount: "0.01",
    maximumAmount: "5",
    defaultAmount: "0.50",
    nativeAsset: "ETH",
    walletRpcUrl: "https://sepolia.base.org",
    explorerUrl: "https://sepolia.basescan.org",
  },
  {
    chain: "ethereum-sepolia",
    chainLabel: "Ethereum Sepolia",
    chainId: 11155111,
    asset: "ETH",
    decimals: 18,
    minimumAmount: "0.000001",
    maximumAmount: "0.001",
    defaultAmount: "0.00001",
    nativeAsset: "ETH",
    walletRpcUrl: "https://ethereum-sepolia-rpc.publicnode.com",
    explorerUrl: "https://sepolia.etherscan.io",
  },
  {
    chain: "bnb-testnet",
    chainLabel: "BNB Testnet",
    chainId: 97,
    asset: "TBNB",
    decimals: 18,
    minimumAmount: "0.00001",
    maximumAmount: "0.01",
    defaultAmount: "0.001",
    nativeAsset: "TBNB",
    walletRpcUrl: "https://bsc-testnet-dataseed.bnbchain.org",
    explorerUrl: "https://testnet.bscscan.com",
  },
];

let env: DemoEnv;
let events: Map<string, string>;
let gatewayRequests: Array<{
  method: string;
  path: string;
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
          method: request.method,
          path,
          headers: new Headers(request.headers),
          body: request.method === "POST" ? await request.clone().json() : null,
        });
        if (request.method === "POST" && path.endsWith("/swaps")) {
          return Response.json(createdSwap, { status: 201 });
        }
        if (request.method === "GET" && path.endsWith(`/swaps/${swap.id}`)) {
          return Response.json(swap);
        }
        if (
          request.method === "GET" &&
          path.endsWith(`/withdrawals/${swapWithdrawal.id}/proposal`)
        ) {
          return Response.json(swapWithdrawal);
        }
        if (request.method === "POST" && path.endsWith("/withdrawals")) {
          const { proposal: _, internalSecret: __, ...created } = withdrawal;
          return Response.json(created, { status: 201 });
        }
        if (request.method === "GET" && path.endsWith(`/withdrawals/${withdrawal.id}/proposal`)) {
          return Response.json(withdrawal);
        }
        if (request.method === "POST" && path.endsWith("/transaction")) {
          const payout = path.includes(swapWithdrawal.id) ? swapWithdrawal : withdrawal;
          return Response.json(
            {
              ...payout,
              status: "submitted",
              transaction: {
                hash: `0x${"4".repeat(64)}`,
                from: payout.sourceAddress,
                to: payout.proposal.to,
                nonce: 4,
                feeWei: "0",
                status: "submitted",
                blockNumber: null,
                lastError: "",
              },
            },
            { status: 202 },
          );
        }
        if (request.method === "POST" && path.endsWith("/deposits")) {
          return Response.json(
            gatewayRequests.at(-1)?.body?.purpose === "swap" ? swapIntent : intent,
            { status: 201 },
          );
        }
        if (path.endsWith("/analytics/summary")) return Response.json(analytics);
        if (path.endsWith("/sweep")) {
          return Response.json({ status: "not_queued", transactions: [] });
        }
        return Response.json(path.includes(swapIntent.id) ? swapIntent : intent);
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
    DEMO_OPTIONS_JSON: JSON.stringify(options),
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
      purpose: "account_top_up",
      chain: "base-sepolia",
      asset: "USDC",
      amount: "1.25",
      metadata: { demo: true },
    });

    events.set(
      `intent:${intent.id}`,
      JSON.stringify({ id: "evt_demo", type: "deposit.succeeded" }),
    );
    const poll = await demo.fetch(
      new Request(`https://demo.test/api/deposits/${intent.id}`, {
        headers: { Authorization: `Bearer ${body.accessToken}` },
      }),
      env,
    );
    expect(poll.status).toBe(200);
    expect(await poll.json()).toMatchObject({
      intent: { id: intent.id },
      sweep: { status: "not_queued" },
      webhookEvent: { id: "evt_demo", type: "deposit.succeeded" },
    });

    const unrelated = await demo.fetch(
      new Request("https://demo.test/api/deposits/di_other", {
        headers: { Authorization: `Bearer ${body.accessToken}` },
      }),
      env,
    );
    expect(unrelated.status).toBe(401);
  });

  it("creates, reveals, and submits an externally signed withdrawal", async () => {
    const created = await demo.fetch(createWithdrawalRequest(), env);
    expect(created.status).toBe(201);
    const body = await created.json<{
      withdrawal: Record<string, unknown>;
      accessToken: string;
    }>();
    expect(body.withdrawal).toMatchObject({
      id: withdrawal.id,
      amount: "1.25",
      destinationAddress: withdrawal.destinationAddress,
      status: "awaiting_signature",
      transaction: null,
    });
    expect(body.withdrawal).not.toHaveProperty("internalSecret");
    expect(gatewayRequests[0]).toMatchObject({
      method: "POST",
      path: "/api/v1/withdrawals",
      body: {
        purpose: "withdrawal",
        chain: "base-sepolia",
        asset: "USDC",
        amount: "1.25",
        destinationAddress: withdrawal.destinationAddress,
      },
    });
    expect(gatewayRequests[0].headers.get("Idempotency-Key")).toMatch(/^demo:withdrawal:/);

    const status = await demo.fetch(
      new Request(`https://demo.test/api/withdrawals/${withdrawal.id}`, {
        headers: { Authorization: `Bearer ${body.accessToken}` },
      }),
      env,
    );
    expect(await status.json()).toMatchObject({
      withdrawal: {
        id: withdrawal.id,
        proposal: {
          from: withdrawal.sourceAddress,
          to: withdrawal.proposal.to,
          data: withdrawal.proposal.data,
        },
      },
    });

    const rawTransaction = `0x${"12".repeat(100)}`;
    const submitted = await demo.fetch(
      new Request(`https://demo.test/api/withdrawals/${withdrawal.id}/transaction`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${body.accessToken}`,
          "CF-Connecting-IP": "192.0.2.10",
          "Content-Type": "application/json",
          Origin: "https://demo.test",
        },
        body: JSON.stringify({ rawTransaction }),
      }),
      env,
    );
    expect(submitted.status).toBe(202);
    expect(await submitted.json()).toMatchObject({
      withdrawal: { status: "submitted", transaction: { nonce: 4, status: "submitted" } },
    });
    expect(gatewayRequests.at(-1)).toMatchObject({
      method: "POST",
      path: `/api/v1/withdrawals/${withdrawal.id}/transaction`,
      body: { rawTransaction },
    });
    expect(gatewayRequests.at(-1)?.headers.get("Authorization")).toBe(
      `Bearer ${env.PAYMENT_API_KEY}`,
    );
  });

  it("creates, polls, and signs a fixed cross-chain swap", async () => {
    const created = await demo.fetch(createSwapRequest(), env);
    expect(created.status).toBe(201);
    const body = await created.json<{
      swap: Record<string, unknown>;
      intent: Record<string, unknown>;
      accessToken: string;
    }>();
    expect(body).toMatchObject({
      swap: {
        id: createdSwap.id,
        depositIntentId: swapIntent.id,
        status: "awaiting_input",
        output: { chain: "ethereum-sepolia", asset: "ETH", amount: "0.00001" },
      },
      intent: { id: swapIntent.id, purpose: "swap", expectedAmount: "0.5" },
    });
    expect(body.swap).not.toHaveProperty("internalSecret");
    expect(gatewayRequests[0]).toMatchObject({
      method: "POST",
      path: "/api/v1/deposits",
      body: {
        purpose: "swap",
        chain: "base-sepolia",
        asset: "USDC",
        amount: "0.5",
      },
    });
    expect(gatewayRequests[1]).toMatchObject({
      method: "POST",
      path: "/api/v1/swaps",
      body: {
        depositIntentId: swapIntent.id,
        outputChain: "ethereum-sepolia",
        outputAsset: "ETH",
        outputAmount: "0.00001",
        destinationAddress: swapWithdrawal.destinationAddress,
        refundAddress: swap.refund.address,
      },
    });

    const polled = await demo.fetch(
      new Request(`https://demo.test/api/swaps/${swap.id}`, {
        headers: { Authorization: `Bearer ${body.accessToken}` },
      }),
      env,
    );
    expect(await polled.json()).toMatchObject({
      swap: { id: swap.id, status: "awaiting_signature" },
      intent: { id: swapIntent.id },
      payout: { id: swapWithdrawal.id, proposal: { chainId: 11155111 } },
    });

    const rawTransaction = `0x${"34".repeat(100)}`;
    const submitted = await demo.fetch(
      new Request(`https://demo.test/api/swaps/${swap.id}/transaction`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${body.accessToken}`,
          "CF-Connecting-IP": "192.0.2.10",
          "Content-Type": "application/json",
          Origin: "https://demo.test",
        },
        body: JSON.stringify({ rawTransaction }),
      }),
      env,
    );
    expect(submitted.status).toBe(202);
    expect(await submitted.json()).toMatchObject({
      swap: { id: swap.id },
      payout: { id: swapWithdrawal.id, status: "submitted" },
    });
    expect(gatewayRequests.findLast((item) => item.method === "POST")).toMatchObject({
      path: `/api/v1/withdrawals/${swapWithdrawal.id}/transaction`,
      body: { rawTransaction },
    });
  });

  it("rejects user-defined swap terms before it creates a deposit", async () => {
    expect((await demo.fetch(createSwapRequest({ amount: "0.51" }), env)).status).toBe(400);
    expect((await demo.fetch(createSwapRequest({ outputAmount: "5" }), env)).status).toBe(400);
    expect(
      (
        await demo.fetch(
          createSwapRequest({ refundAddress: "0x0000000000000000000000000000000000000000" }),
          env,
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await demo.fetch(
          createSwapRequest({ chain: "ethereum-sepolia", asset: "ETH", amount: "0.00001" }),
          env,
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await demo.fetch(
          createSwapRequest({ outputChain: "base-sepolia", outputAsset: "USDC" }),
          env,
        )
      ).status,
    ).toBe(400);
    expect(gatewayRequests).toHaveLength(0);
  });

  it("allows only configured network and asset pairs", async () => {
    const ethereum = await demo.fetch(
      createRequest({
        chain: "ethereum-sepolia",
        asset: "ETH",
        amount: "0.00001",
        purpose: "checkout",
      }),
      env,
    );
    expect(ethereum.status).toBe(201);
    expect(gatewayRequests[0].body).toMatchObject({
      chain: "ethereum-sepolia",
      asset: "ETH",
      amount: "0.00001",
    });

    const unsupported = await demo.fetch(
      createRequest({ chain: "bnb-testnet", asset: "USDC", amount: "1", purpose: "checkout" }),
      env,
    );
    expect(unsupported.status).toBe(400);
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
    expect((await demo.fetch(new Request("https://demo.test/api/analytics"), env)).status).toBe(
      429,
    );
    expect(gatewayRequests).toHaveLength(0);
  });

  it("rejects malformed requests and invalid intent access tokens", async () => {
    const malformed = new Request("https://demo.test/api/deposits", {
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
      new Request(`https://demo.test/api/deposits/${intent.id}`, {
        headers: { Authorization: `Bearer ${tamperedToken}` },
      }),
      env,
    );
    expect(tampered.status).toBe(401);

    vi.useFakeTimers();
    try {
      vi.setSystemTime(Date.now() + 24 * 60 * 60 * 1_000 + 1);
      const expired = await demo.fetch(
        new Request(`https://demo.test/api/deposits/${intent.id}`, {
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
      type: "deposit.succeeded",
      createdAt: new Date().toISOString(),
      data: {
        depositIntent: {
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
      new Request("https://demo.test/webhooks/deposit", {
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
      type: "deposit.succeeded",
      depositIntent: { id: intent.id, confirmedUnits: "1250000" },
    });
    expect((await demo.fetch(webhookRequest(), env)).status).toBe(204);

    const tampered = new Request("https://demo.test/webhooks/deposit", {
      method: "POST",
      headers: {
        "Webhook-Id": event.id,
        "Webhook-Timestamp": timestamp,
        "Webhook-Signature": `v1,${signature}`,
      },
      body: rawBody.replace("1250000", "5000000"),
    });
    expect((await demo.fetch(tampered, env)).status).toBe(401);

    const stale = new Request("https://demo.test/webhooks/deposit", {
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
      options,
      turnstileSiteKey: "1x00000000000000000000AA",
    });
    const asset = await demo.fetch(new Request("https://demo.test/"), env);
    expect(await asset.text()).toBe("demo asset");
  });

  it("exposes only aggregate analytics for configured demo assets", async () => {
    const response = await demo.fetch(new Request("https://demo.test/api/analytics"), env);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      assets: [
        {
          chain: "base-sepolia",
          asset: "USDC",
          intents: 12,
          paidIntents: 9,
          confirmedAmount: "4.25",
          collectedAmount: "3.75",
        },
        {
          chain: "ethereum-sepolia",
          asset: "ETH",
          intents: 2,
          paidIntents: 1,
          confirmedAmount: "0.000001",
          collectedAmount: "0.0000005",
        },
        {
          chain: "bnb-testnet",
          asset: "TBNB",
          intents: 0,
          paidIntents: 0,
          confirmedAmount: "0",
          collectedAmount: "0",
        },
      ],
      generatedAt: analytics.generatedAt,
    });
    expect(gatewayRequests.at(-1)?.headers.get("Authorization")).toBe(
      `Bearer ${env.PAYMENT_API_KEY}`,
    );
  });
});

function createRequest(input: {
  chain?: string;
  asset?: string;
  amount: string;
  purpose: string;
}): Request {
  return new Request("https://demo.test/api/deposits", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: "https://demo.test",
      "CF-Connecting-IP": "192.0.2.10",
    },
    body: JSON.stringify({
      chain: "base-sepolia",
      asset: "USDC",
      ...input,
      idempotencyKey: crypto.randomUUID(),
      turnstileToken: "XXXX.DUMMY.TOKEN.XXXX",
    }),
  });
}

function createWithdrawalRequest(): Request {
  return new Request("https://demo.test/api/withdrawals", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: "https://demo.test",
      "CF-Connecting-IP": "192.0.2.10",
    },
    body: JSON.stringify({
      chain: "base-sepolia",
      asset: "USDC",
      amount: "1.250000",
      destinationAddress: withdrawal.destinationAddress,
      idempotencyKey: crypto.randomUUID(),
      turnstileToken: "XXXX.DUMMY.TOKEN.XXXX",
    }),
  });
}

function createSwapRequest(
  input: Partial<{
    chain: string;
    asset: string;
    amount: string;
    outputChain: string;
    outputAsset: string;
    outputAmount: string;
    destinationAddress: string;
    refundAddress: string;
  }> = {},
): Request {
  return new Request("https://demo.test/api/swaps", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: "https://demo.test",
      "CF-Connecting-IP": "192.0.2.10",
    },
    body: JSON.stringify({
      chain: "base-sepolia",
      asset: "USDC",
      amount: "0.50",
      outputChain: "ethereum-sepolia",
      outputAsset: "ETH",
      destinationAddress: swapWithdrawal.destinationAddress,
      refundAddress: swap.refund.address,
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
