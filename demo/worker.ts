import { formatUnits, parseAmount } from "../src/domain";

const API_ROOT = "/api";
const GATEWAY_ROOT = "/api/v1";
const TURNSTILE_VERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
const TURNSTILE_TEST_SECRET = "1x0000000000000000000000000000000AA";

export interface DemoEnv {
  ASSETS: Fetcher;
  GATEWAY: Fetcher;
  DEMO_EVENTS: KVNamespace;
  DEMO_RATE_LIMITER: RateLimit;
  PAYMENT_API_KEY: string;
  PAYMENT_WEBHOOK_SECRET: string;
  DEMO_SESSION_SECRET: string;
  TURNSTILE_SITE_KEY: string;
  TURNSTILE_SECRET_KEY: string;
  DEMO_OPTIONS_JSON: string;
  DEMO_EXPIRY_SECONDS: string;
}

interface DemoOption {
  chain: string;
  chainLabel: string;
  chainId: number;
  asset: string;
  decimals: number;
  minimumAmount: string;
  maximumAmount: string;
  defaultAmount: string;
  nativeAsset: string;
  walletRpcUrl: string;
  explorerUrl: string;
}

export default {
  async fetch(request: Request, env: DemoEnv): Promise<Response> {
    try {
      return await route(request, env);
    } catch (error) {
      if (error instanceof DemoError) return json({ error: error.message }, error.status);
      console.error("demo request failed", safeError(error));
      return json({ error: "internal server error" }, 500);
    }
  },
};

async function route(request: Request, env: DemoEnv): Promise<Response> {
  const url = new URL(request.url);
  if (request.method === "GET" && url.pathname === `${API_ROOT}/config`) {
    return json({
      options: demoOptions(env),
      turnstileSiteKey: requiredSetting(env.TURNSTILE_SITE_KEY, "TURNSTILE_SITE_KEY"),
    });
  }
  if (request.method === "GET" && url.pathname === `${API_ROOT}/analytics`) {
    return getDemoAnalytics(request, env);
  }
  if (request.method === "GET" && url.pathname === "/analytics") {
    url.pathname = "/analytics.html";
    return env.ASSETS.fetch(new Request(url.toString(), { headers: request.headers }));
  }
  if (request.method === "POST" && url.pathname === `${API_ROOT}/deposits`) {
    return createDemoIntent(request, env);
  }
  if (request.method === "POST" && url.pathname === `${API_ROOT}/withdrawals`) {
    return createDemoWithdrawal(request, env);
  }
  if (request.method === "POST" && url.pathname === `${API_ROOT}/swaps`) {
    return createDemoSwap(request, env);
  }
  const intentMatch = url.pathname.match(/^\/api\/deposits\/(di_[A-Za-z0-9_-]+)$/);
  if (request.method === "GET" && intentMatch) {
    return getDemoIntent(request, env, intentMatch[1]);
  }
  const withdrawalMatch = url.pathname.match(
    /^\/api\/withdrawals\/(wd_[A-Za-z0-9_-]+)(?:\/(transaction))?$/,
  );
  if (request.method === "GET" && withdrawalMatch && !withdrawalMatch[2]) {
    return getDemoWithdrawal(request, env, withdrawalMatch[1]);
  }
  if (request.method === "POST" && withdrawalMatch?.[2] === "transaction") {
    return submitDemoWithdrawal(request, env, withdrawalMatch[1]);
  }
  const swapMatch = url.pathname.match(/^\/api\/swaps\/(swp_[A-Za-z0-9_-]+)(?:\/(transaction))?$/);
  if (request.method === "GET" && swapMatch && !swapMatch[2]) {
    return getDemoSwap(request, env, swapMatch[1]);
  }
  if (request.method === "POST" && swapMatch?.[2] === "transaction") {
    return submitDemoSwapTransaction(request, env, swapMatch[1]);
  }
  if (request.method === "POST" && url.pathname === "/webhooks/deposit") {
    return receiveWebhook(request, env);
  }
  if (url.pathname.startsWith(`${API_ROOT}/`) || url.pathname.startsWith("/webhooks/")) {
    throw new DemoError(404, "not found");
  }
  return env.ASSETS.fetch(request);
}

async function createDemoIntent(request: Request, env: DemoEnv): Promise<Response> {
  enforceSameOrigin(request);
  const ip = request.headers.get("CF-Connecting-IP") ?? "unknown";
  if (!(await env.DEMO_RATE_LIMITER.limit({ key: `create:${ip}` })).success) {
    throw new DemoError(429, "too many demo payments; try again in a minute");
  }

  const body = await readObject(request, 8_192);
  rejectUnknownFields(body, ["chain", "asset", "amount", "idempotencyKey", "turnstileToken"]);
  const chain = stringField(body, "chain");
  const asset = stringField(body, "asset");
  const amount = stringField(body, "amount");
  const idempotencyKey = demoIdempotencyKey(body);
  const turnstileToken = stringField(body, "turnstileToken");

  const option = demoOption(env, chain, asset);
  const configured = amountConfig(option);
  let parsed: ReturnType<typeof parseAmount>;
  try {
    parsed = parseAmount(amount, configured.decimals);
  } catch {
    throw new DemoError(400, "enter a valid payment amount");
  }
  if (parsed.units < configured.minimum.units || parsed.units > configured.maximum.units) {
    throw new DemoError(
      400,
      `amount must be between ${configured.minimum.amount} and ${configured.maximum.amount}`,
    );
  }
  await requireTurnstile(turnstileToken, ip, request, env);

  const gateway = await env.GATEWAY.fetch(
    new Request(`https://gateway.internal${GATEWAY_ROOT}/deposits`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${requiredSecret(env.PAYMENT_API_KEY, "PAYMENT_API_KEY", 24)}`,
        "Content-Type": "application/json",
        "Idempotency-Key": `demo:${idempotencyKey}`,
      },
      body: JSON.stringify({
        kind: "payment",
        purpose: "deposit",
        externalId: `demo_${idempotencyKey}`,
        chain: option.chain,
        asset: option.asset,
        amount: parsed.amount,
        expiresInSeconds: integerSetting(
          env.DEMO_EXPIRY_SECONDS,
          "DEMO_EXPIRY_SECONDS",
          300,
          86_400,
        ),
        metadata: { demo: true },
      }),
    }),
  );
  const gatewayBody = await responseObject(gateway, 2_000_000);
  if (!gateway.ok)
    throw new DemoError(
      gateway.status >= 500 ? 502 : gateway.status,
      "gateway rejected the payment",
    );
  const intent = publicIntent(gatewayBody);
  const expiresAt = Date.now() + 24 * 60 * 60 * 1_000;
  return json(
    {
      intent,
      accessToken: await issueAccessToken(intent.id as string, expiresAt, env.DEMO_SESSION_SECRET),
    },
    gateway.status,
  );
}

async function createDemoWithdrawal(request: Request, env: DemoEnv): Promise<Response> {
  enforceSameOrigin(request);
  const ip = request.headers.get("CF-Connecting-IP") ?? "unknown";
  if (!(await env.DEMO_RATE_LIMITER.limit({ key: `withdrawal:${ip}` })).success) {
    throw new DemoError(429, "too many demo withdrawals; try again in a minute");
  }
  const body = await readObject(request, 8_192);
  rejectUnknownFields(body, [
    "chain",
    "asset",
    "amount",
    "destinationAddress",
    "idempotencyKey",
    "turnstileToken",
  ]);
  const chain = stringField(body, "chain");
  const asset = stringField(body, "asset");
  const amount = stringField(body, "amount");
  const destinationAddress = demoAddress(body, "destinationAddress");
  const idempotencyKey = demoIdempotencyKey(body);
  const turnstileToken = stringField(body, "turnstileToken");
  const option = demoOption(env, chain, asset);
  const configured = amountConfig(option);
  let parsed: ReturnType<typeof parseAmount>;
  try {
    parsed = parseAmount(amount, configured.decimals);
  } catch {
    throw new DemoError(400, "enter a valid withdrawal amount");
  }
  if (parsed.units < configured.minimum.units || parsed.units > configured.maximum.units) {
    throw new DemoError(
      400,
      `amount must be between ${configured.minimum.amount} and ${configured.maximum.amount}`,
    );
  }
  await requireTurnstile(turnstileToken, ip, request, env);

  const gateway = await env.GATEWAY.fetch(
    new Request(`https://gateway.internal${GATEWAY_ROOT}/withdrawals`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${requiredSecret(env.PAYMENT_API_KEY, "PAYMENT_API_KEY", 24)}`,
        "Content-Type": "application/json",
        "Idempotency-Key": `demo:withdrawal:${idempotencyKey}`,
      },
      body: JSON.stringify({
        purpose: "withdrawal",
        externalId: `demo_withdrawal_${idempotencyKey}`,
        chain: option.chain,
        asset: option.asset,
        amount: parsed.amount,
        destinationAddress,
        expiresInSeconds: integerSetting(
          env.DEMO_EXPIRY_SECONDS,
          "DEMO_EXPIRY_SECONDS",
          300,
          86_400,
        ),
      }),
    }),
  );
  const gatewayBody = await responseObject(gateway, 2_000_000);
  if (!gateway.ok) {
    throw new DemoError(
      gateway.status >= 500 ? 502 : gateway.status,
      "gateway rejected the withdrawal",
    );
  }
  const withdrawal = publicWithdrawal(gatewayBody);
  return json(
    {
      withdrawal,
      accessToken: await issueAccessToken(
        withdrawal.id as string,
        Date.now() + 24 * 60 * 60 * 1_000,
        env.DEMO_SESSION_SECRET,
      ),
    },
    gateway.status,
  );
}

async function createDemoSwap(request: Request, env: DemoEnv): Promise<Response> {
  enforceSameOrigin(request);
  const ip = request.headers.get("CF-Connecting-IP") ?? "unknown";
  if (!(await env.DEMO_RATE_LIMITER.limit({ key: `swap:${ip}` })).success) {
    throw new DemoError(429, "too many demo swaps; try again in a minute");
  }
  const body = await readObject(request, 8_192);
  rejectUnknownFields(body, [
    "chain",
    "asset",
    "amount",
    "outputChain",
    "outputAsset",
    "walletAddress",
    "idempotencyKey",
    "turnstileToken",
  ]);
  const input = demoOption(env, stringField(body, "chain"), stringField(body, "asset"));
  const output = demoOption(
    env,
    stringField(body, "outputChain"),
    stringField(body, "outputAsset"),
  );
  if (input.asset === input.nativeAsset) {
    throw new DemoError(400, "select a token for the swap input");
  }
  if (input.chain === output.chain && input.asset === output.asset) {
    throw new DemoError(400, "swap input and output must differ");
  }
  const walletAddress = demoAddress(body, "walletAddress");
  const idempotencyKey = demoIdempotencyKey(body);
  const turnstileToken = stringField(body, "turnstileToken");
  let inputAmount: ReturnType<typeof parseAmount>;
  let configuredInput: ReturnType<typeof parseAmount>;
  let outputAmount: ReturnType<typeof parseAmount>;
  try {
    inputAmount = parseAmount(stringField(body, "amount"), input.decimals);
    configuredInput = parseAmount(input.defaultAmount, input.decimals);
    outputAmount = parseAmount(output.defaultAmount, output.decimals);
  } catch {
    throw new DemoError(400, "invalid demo swap amount");
  }
  if (inputAmount.units !== configuredInput.units) {
    throw new DemoError(400, `swap input amount must be ${configuredInput.amount} ${input.asset}`);
  }
  await requireTurnstile(turnstileToken, ip, request, env);

  const authorization = gatewayAuthorization(env);
  const depositResponse = await env.GATEWAY.fetch(
    new Request(`https://gateway.internal${GATEWAY_ROOT}/deposits`, {
      method: "POST",
      headers: {
        ...authorization,
        "Content-Type": "application/json",
        "Idempotency-Key": `demo:swap:deposit:${idempotencyKey}`,
      },
      body: JSON.stringify({
        kind: "payment",
        purpose: "swap",
        externalId: `demo_swap_${idempotencyKey}`,
        chain: input.chain,
        asset: input.asset,
        amount: inputAmount.amount,
        expiresInSeconds: integerSetting(
          env.DEMO_EXPIRY_SECONDS,
          "DEMO_EXPIRY_SECONDS",
          300,
          86_400,
        ),
        metadata: { demo: true },
      }),
    }),
  );
  const depositBody = await responseObject(depositResponse, 2_000_000);
  if (!depositResponse.ok) {
    throw new DemoError(
      depositResponse.status >= 500 ? 502 : depositResponse.status,
      "gateway rejected the swap input",
    );
  }
  const intent = publicIntent(depositBody);
  const swapResponse = await env.GATEWAY.fetch(
    new Request(`https://gateway.internal${GATEWAY_ROOT}/swaps`, {
      method: "POST",
      headers: {
        ...authorization,
        "Content-Type": "application/json",
        "Idempotency-Key": `demo:swap:${idempotencyKey}`,
      },
      body: JSON.stringify({
        depositIntentId: intent.id,
        outputChain: output.chain,
        outputAsset: output.asset,
        outputAmount: outputAmount.amount,
        destinationAddress: walletAddress,
        refundAddress: walletAddress,
      }),
    }),
  );
  const swapBody = await responseObject(swapResponse, 2_000_000);
  if (!swapResponse.ok) {
    throw new DemoError(
      swapResponse.status >= 500 ? 502 : swapResponse.status,
      "gateway rejected the swap terms",
    );
  }
  const swap = publicSwap(swapBody);
  if (swap.depositIntentId !== intent.id) {
    throw new DemoError(502, "gateway returned an invalid swap");
  }
  return json(
    {
      swap,
      intent,
      sweep: null,
      webhookEvent: null,
      payout: null,
      accessToken: await issueAccessToken(
        swap.id as string,
        Date.now() + 24 * 60 * 60 * 1_000,
        env.DEMO_SESSION_SECRET,
      ),
    },
    swapResponse.status,
  );
}

async function getDemoWithdrawal(
  request: Request,
  env: DemoEnv,
  withdrawalId: string,
): Promise<Response> {
  await requireAccess(request, withdrawalId, env);
  const response = await env.GATEWAY.fetch(
    new Request(`https://gateway.internal${GATEWAY_ROOT}/withdrawals/${withdrawalId}/proposal`, {
      headers: gatewayAuthorization(env),
    }),
  );
  const body = await responseObject(response, 2_000_000);
  if (!response.ok) throw new DemoError(502, "gateway withdrawal status is unavailable");
  return json({ withdrawal: publicWithdrawal(body) });
}

async function submitDemoWithdrawal(
  request: Request,
  env: DemoEnv,
  withdrawalId: string,
): Promise<Response> {
  enforceSameOrigin(request);
  await requireAccess(request, withdrawalId, env);
  const ip = request.headers.get("CF-Connecting-IP") ?? "unknown";
  if (!(await env.DEMO_RATE_LIMITER.limit({ key: `withdrawal-submit:${ip}` })).success) {
    throw new DemoError(429, "too many signed transaction attempts; try again in a minute");
  }
  const body = await readObject(request, 262_200);
  rejectUnknownFields(body, ["rawTransaction"]);
  const rawTransaction = signedRawTransaction(body);
  const response = await env.GATEWAY.fetch(
    new Request(`https://gateway.internal${GATEWAY_ROOT}/withdrawals/${withdrawalId}/transaction`, {
      method: "POST",
      headers: { ...gatewayAuthorization(env), "Content-Type": "application/json" },
      body: JSON.stringify({ rawTransaction }),
    }),
  );
  const responseBody = await responseObject(response, 2_000_000);
  if (!response.ok) {
    throw new DemoError(
      response.status >= 500 ? 502 : response.status,
      "gateway rejected the signed transaction",
    );
  }
  return json({ withdrawal: publicWithdrawal(responseBody) }, response.status);
}

async function getDemoSwap(request: Request, env: DemoEnv, swapId: string): Promise<Response> {
  await requireAccess(request, swapId, env);
  return json(await demoSwapState(env, swapId));
}

async function submitDemoSwapTransaction(
  request: Request,
  env: DemoEnv,
  swapId: string,
): Promise<Response> {
  enforceSameOrigin(request);
  await requireAccess(request, swapId, env);
  const ip = request.headers.get("CF-Connecting-IP") ?? "unknown";
  if (!(await env.DEMO_RATE_LIMITER.limit({ key: `swap-submit:${ip}` })).success) {
    throw new DemoError(429, "too many signed transaction attempts; try again in a minute");
  }
  const body = await readObject(request, 262_200);
  rejectUnknownFields(body, ["rawTransaction"]);
  const rawTransaction = signedRawTransaction(body);
  const swapResponse = await env.GATEWAY.fetch(
    new Request(`https://gateway.internal${GATEWAY_ROOT}/swaps/${swapId}`, {
      headers: gatewayAuthorization(env),
    }),
  );
  const swapBody = await responseObject(swapResponse, 2_000_000);
  if (!swapResponse.ok) throw new DemoError(502, "gateway swap status is unavailable");
  const swap = publicSwap(swapBody);
  if (swap.id !== swapId) throw new DemoError(502, "gateway returned an invalid swap");
  const payoutId = awaitingSwapPayoutId(swap);
  const response = await env.GATEWAY.fetch(
    new Request(`https://gateway.internal${GATEWAY_ROOT}/withdrawals/${payoutId}/transaction`, {
      method: "POST",
      headers: { ...gatewayAuthorization(env), "Content-Type": "application/json" },
      body: JSON.stringify({ rawTransaction }),
    }),
  );
  const responseBody = await responseObject(response, 2_000_000);
  if (!response.ok) {
    throw new DemoError(
      response.status >= 500 ? 502 : response.status,
      "gateway rejected the signed transaction",
    );
  }
  return json(
    { ...(await demoSwapState(env, swapId)), payout: publicWithdrawal(responseBody) },
    response.status,
  );
}

async function demoSwapState(env: DemoEnv, swapId: string): Promise<Record<string, unknown>> {
  const headers = gatewayAuthorization(env);
  const swapResponse = await env.GATEWAY.fetch(
    new Request(`https://gateway.internal${GATEWAY_ROOT}/swaps/${swapId}`, { headers }),
  );
  const swapBody = await responseObject(swapResponse, 2_000_000);
  if (!swapResponse.ok) throw new DemoError(502, "gateway swap status is unavailable");
  const swap = publicSwap(swapBody);
  if (swap.id !== swapId) throw new DemoError(502, "gateway returned an invalid swap");
  const depositIntentId = swap.depositIntentId as string;
  const payoutId = swapPayoutId(swap);
  const [intentResponse, sweepResponse, payoutResponse, webhookEvent] = await Promise.all([
    env.GATEWAY.fetch(
      new Request(`https://gateway.internal${GATEWAY_ROOT}/deposits/${depositIntentId}`, {
        headers,
      }),
    ),
    env.GATEWAY.fetch(
      new Request(`https://gateway.internal${GATEWAY_ROOT}/deposits/${depositIntentId}/sweep`, {
        headers,
      }),
    ),
    payoutId
      ? env.GATEWAY.fetch(
          new Request(`https://gateway.internal${GATEWAY_ROOT}/withdrawals/${payoutId}/proposal`, {
            headers,
          }),
        )
      : null,
    env.DEMO_EVENTS.get(`intent:${depositIntentId}`, "json"),
  ]);
  const [intent, sweep, payout] = await Promise.all([
    responseObject(intentResponse, 2_000_000),
    responseObject(sweepResponse, 1_000_000),
    payoutResponse ? responseObject(payoutResponse, 2_000_000) : null,
  ]);
  if (!intentResponse.ok || !sweepResponse.ok || (payoutResponse && !payoutResponse.ok)) {
    throw new DemoError(502, "gateway swap status is unavailable");
  }
  return {
    swap,
    intent: publicIntent(intent),
    sweep,
    webhookEvent,
    payout: payout ? publicWithdrawal(payout) : null,
  };
}

async function getDemoAnalytics(request: Request, env: DemoEnv): Promise<Response> {
  const ip = request.headers.get("CF-Connecting-IP") ?? "unknown";
  if (!(await env.DEMO_RATE_LIMITER.limit({ key: `analytics:${ip}` })).success) {
    throw new DemoError(429, "analytics refresh limit reached; try again in a minute");
  }
  const response = await env.GATEWAY.fetch(
    new Request(`https://gateway.internal${GATEWAY_ROOT}/analytics/summary`, {
      headers: {
        Authorization: `Bearer ${requiredSecret(env.PAYMENT_API_KEY, "PAYMENT_API_KEY", 24)}`,
      },
    }),
  );
  const body = await responseObject(response, 2_000_000);
  if (!response.ok) throw new DemoError(502, "gateway analytics are unavailable");
  return json(publicAnalytics(body, env));
}

async function getDemoIntent(request: Request, env: DemoEnv, intentId: string): Promise<Response> {
  await requireAccess(request, intentId, env);
  const headers = gatewayAuthorization(env);
  const [intentResponse, sweepResponse, webhookEvent] = await Promise.all([
    env.GATEWAY.fetch(
      new Request(`https://gateway.internal${GATEWAY_ROOT}/deposits/${intentId}`, { headers }),
    ),
    env.GATEWAY.fetch(
      new Request(`https://gateway.internal${GATEWAY_ROOT}/deposits/${intentId}/sweep`, {
        headers,
      }),
    ),
    env.DEMO_EVENTS.get(`intent:${intentId}`, "json"),
  ]);
  const [intent, sweep] = await Promise.all([
    responseObject(intentResponse, 2_000_000),
    responseObject(sweepResponse, 1_000_000),
  ]);
  if (!intentResponse.ok || !sweepResponse.ok)
    throw new DemoError(502, "gateway status is unavailable");
  return json({ intent: publicIntent(intent), sweep, webhookEvent });
}

async function receiveWebhook(request: Request, env: DemoEnv): Promise<Response> {
  const eventId = request.headers.get("Webhook-Id") ?? "";
  const timestamp = request.headers.get("Webhook-Timestamp") ?? "";
  const signature = request.headers.get("Webhook-Signature") ?? "";
  if (!/^evt_[A-Za-z0-9_-]+$/.test(eventId) || eventId.length > 200) {
    throw new DemoError(401, "invalid webhook");
  }
  if (!/^\d{10}$/.test(timestamp) || Math.abs(Date.now() / 1_000 - Number(timestamp)) > 300) {
    throw new DemoError(401, "invalid webhook");
  }
  const match = signature.match(/^v1,([0-9a-f]{64})$/i);
  if (!match) throw new DemoError(401, "invalid webhook");
  const rawBody = await limitedText(request, 1_000_000);
  const key = await hmacKey(
    requiredSecret(env.PAYMENT_WEBHOOK_SECRET, "PAYMENT_WEBHOOK_SECRET", 24),
  );
  if (
    !(await crypto.subtle.verify(
      "HMAC",
      key,
      hexBytes(match[1]),
      new TextEncoder().encode(`${timestamp}.${rawBody}`),
    ))
  ) {
    throw new DemoError(401, "invalid webhook");
  }

  let event: unknown;
  try {
    event = JSON.parse(rawBody);
  } catch {
    throw new DemoError(400, "invalid webhook body");
  }
  if (!isObject(event) || event.id !== eventId || !isObject(event.data)) {
    throw new DemoError(400, "invalid webhook body");
  }
  if (event.type !== "deposit.succeeded" && event.type !== "deposit.reorged") {
    throw new DemoError(400, "unsupported webhook event");
  }
  const depositIntent = event.data.depositIntent;
  if (
    !isObject(depositIntent) ||
    typeof depositIntent.id !== "string" ||
    !/^di_[A-Za-z0-9_-]+$/.test(depositIntent.id)
  ) {
    throw new DemoError(400, "invalid webhook body");
  }
  await env.DEMO_EVENTS.put(
    `intent:${depositIntent.id}`,
    JSON.stringify({
      id: eventId,
      type: event.type,
      createdAt: event.createdAt,
      depositIntent: {
        id: depositIntent.id,
        status: depositIntent.status,
        receivedUnits: depositIntent.receivedUnits,
        confirmedUnits: depositIntent.confirmedUnits,
        transactionHashes: depositIntent.transactionHashes,
      },
    }),
    { expirationTtl: 7 * 24 * 60 * 60 },
  );
  return new Response(null, { status: 204 });
}

async function requireTurnstile(
  token: string,
  ip: string,
  request: Request,
  env: DemoEnv,
): Promise<void> {
  if (!token || token.length > 2_048) throw new DemoError(400, "complete the security check");
  if (
    !(await verifyTurnstile(token, ip, new URL(request.url).hostname, env.TURNSTILE_SECRET_KEY))
  ) {
    throw new DemoError(403, "security check failed; try again");
  }
}

async function verifyTurnstile(
  token: string,
  ip: string,
  hostname: string,
  secret: string,
): Promise<boolean> {
  requiredSetting(secret, "TURNSTILE_SECRET_KEY");
  const body = new FormData();
  body.set("secret", secret);
  body.set("response", token);
  if (ip !== "unknown") body.set("remoteip", ip);
  body.set("idempotency_key", crypto.randomUUID());
  let response: Response;
  try {
    response = await fetch(TURNSTILE_VERIFY_URL, {
      method: "POST",
      body,
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    return false;
  }
  if (!response.ok) return false;
  const result = await responseObject(response, 65_536);
  if (result.success !== true) return false;
  if (secret === TURNSTILE_TEST_SECRET) return true;
  return result.action === "create_intent" && result.hostname === hostname;
}

function amountConfig(option: DemoOption): {
  decimals: number;
  minimum: ReturnType<typeof parseAmount>;
  maximum: ReturnType<typeof parseAmount>;
} {
  let minimum: ReturnType<typeof parseAmount>;
  let maximum: ReturnType<typeof parseAmount>;
  try {
    minimum = parseAmount(option.minimumAmount, option.decimals);
    maximum = parseAmount(option.maximumAmount, option.decimals);
  } catch {
    throw new Error("demo amount configuration is invalid");
  }
  if (minimum.units > maximum.units) throw new Error("demo amount configuration is invalid");
  return { decimals: option.decimals, minimum, maximum };
}

function publicIntent(value: Record<string, unknown>): Record<string, unknown> {
  const id = value.id;
  if (typeof id !== "string" || !/^di_[A-Za-z0-9_-]+$/.test(id)) {
    throw new DemoError(502, "gateway returned an invalid intent");
  }
  const fields = [
    "id",
    "kind",
    "purpose",
    "externalId",
    "chain",
    "chainId",
    "asset",
    "expectedAmount",
    "expectedUnits",
    "receivedAmount",
    "confirmedAmount",
    "remainingAmount",
    "remainingUnits",
    "depositAddress",
    "paymentUri",
    "qrCodeDataUrl",
    "topUpPaymentUri",
    "topUpQrCodeDataUrl",
    "requiredConfirmations",
    "status",
    "expiresAt",
    "expired",
    "transactions",
    "createdAt",
    "updatedAt",
  ];
  return publicFields(value, fields);
}

function publicSwap(value: Record<string, unknown>): Record<string, unknown> {
  const id = value.id;
  const depositIntentId = value.depositIntentId;
  if (
    typeof id !== "string" ||
    !/^swp_[A-Za-z0-9_-]+$/.test(id) ||
    typeof depositIntentId !== "string" ||
    !/^di_[A-Za-z0-9_-]+$/.test(depositIntentId) ||
    !isObject(value.input) ||
    !isObject(value.output) ||
    !isObject(value.refund)
  ) {
    throw new DemoError(502, "gateway returned an invalid swap");
  }
  const result = publicFields(value, [
    "id",
    "externalId",
    "depositIntentId",
    "withdrawalIntentId",
    "status",
    "quoteExpiresAt",
    "lastError",
    "completedAt",
    "createdAt",
    "updatedAt",
  ]);
  result.input = publicFields(value.input, [
    "chain",
    "chainId",
    "asset",
    "expectedAmount",
    "expectedUnits",
    "receivedUnits",
    "confirmedUnits",
    "depositAddress",
    "depositStatus",
    "collectionStatus",
    "collectedUnits",
  ]);
  result.output = publicFields(value.output, [
    "chain",
    "chainId",
    "asset",
    "amount",
    "amountUnits",
    "sourceAddress",
    "destinationAddress",
    "withdrawalStatus",
  ]);
  result.refund = publicFields(value.refund, [
    "address",
    "sourceAddress",
    "withdrawalIntentId",
    "withdrawalStatus",
  ]);
  return result;
}

function publicWithdrawal(value: Record<string, unknown>): Record<string, unknown> {
  const id = value.id;
  if (typeof id !== "string" || !/^wd_[A-Za-z0-9_-]+$/.test(id)) {
    throw new DemoError(502, "gateway returned an invalid withdrawal");
  }
  const result = publicFields(value, [
    "id",
    "purpose",
    "externalId",
    "chain",
    "chainId",
    "asset",
    "amount",
    "amountUnits",
    "sourceAddress",
    "destinationAddress",
    "requiredConfirmations",
    "status",
    "expiresAt",
    "completedAt",
    "lastError",
    "createdAt",
    "updatedAt",
  ]);
  if (isObject(value.proposal)) {
    result.proposal = publicFields(value.proposal, [
      "chainId",
      "from",
      "to",
      "value",
      "data",
      "amount",
      "asset",
      "maxGas",
      "maxGasPriceWei",
    ]);
  }
  result.transaction = isObject(value.transaction)
    ? publicFields(value.transaction, [
        "hash",
        "from",
        "to",
        "nonce",
        "feeWei",
        "status",
        "blockNumber",
        "lastError",
        "explorerUrl",
      ])
    : null;
  return result;
}

function swapPayoutId(swap: Record<string, unknown>): string {
  const refund = swap.refund;
  if (
    isObject(refund) &&
    typeof refund.withdrawalIntentId === "string" &&
    /^wd_[A-Za-z0-9_-]+$/.test(refund.withdrawalIntentId) &&
    (String(swap.status).startsWith("refund_") || swap.status === "refunded")
  ) {
    return refund.withdrawalIntentId;
  }
  return typeof swap.withdrawalIntentId === "string" &&
    /^wd_[A-Za-z0-9_-]+$/.test(swap.withdrawalIntentId)
    ? swap.withdrawalIntentId
    : "";
}

function awaitingSwapPayoutId(swap: Record<string, unknown>): string {
  const output = swap.output;
  if (
    isObject(output) &&
    output.withdrawalStatus === "awaiting_signature" &&
    typeof swap.withdrawalIntentId === "string" &&
    /^wd_[A-Za-z0-9_-]+$/.test(swap.withdrawalIntentId)
  ) {
    return swap.withdrawalIntentId;
  }
  const refund = swap.refund;
  if (
    isObject(refund) &&
    refund.withdrawalStatus === "awaiting_signature" &&
    typeof refund.withdrawalIntentId === "string" &&
    /^wd_[A-Za-z0-9_-]+$/.test(refund.withdrawalIntentId)
  ) {
    return refund.withdrawalIntentId;
  }
  throw new DemoError(409, "swap has no transaction awaiting signature");
}

function publicFields(value: Record<string, unknown>, fields: string[]): Record<string, unknown> {
  return Object.fromEntries(
    fields.filter((field) => field in value).map((field) => [field, value[field]]),
  );
}

function publicAnalytics(value: Record<string, unknown>, env: DemoEnv): Record<string, unknown> {
  if (!Array.isArray(value.assets)) throw new DemoError(502, "gateway returned invalid analytics");
  const assets = value.assets;
  return {
    assets: demoOptions(env).map((option) => {
      const row = assets.find(
        (item) => isObject(item) && item.chain === option.chain && item.asset === option.asset,
      );
      if (!row) {
        return {
          chain: option.chain,
          asset: option.asset,
          intents: 0,
          paidIntents: 0,
          confirmedAmount: "0",
          collectedAmount: "0",
        };
      }
      if (!isObject(row) || !isObject(row.statuses)) {
        throw new DemoError(502, "gateway returned invalid analytics");
      }
      return {
        chain: option.chain,
        asset: option.asset,
        intents: analyticsInteger(row.intents),
        paidIntents: analyticsInteger(row.statuses.paid ?? 0),
        confirmedAmount: formatUnits(analyticsUnits(row.confirmedUnits), option.decimals),
        collectedAmount: formatUnits(analyticsUnits(row.collectedUnits), option.decimals),
      };
    }),
    withdrawals: analyticsWithdrawalStatuses(value.withdrawalsByPurpose),
    swaps: analyticsStatuses(value.swaps),
    generatedAt:
      typeof value.generatedAt === "string" && Number.isFinite(Date.parse(value.generatedAt))
        ? value.generatedAt
        : new Date().toISOString(),
  };
}

function analyticsStatuses(value: unknown): Record<string, number> {
  if (!isObject(value)) throw new DemoError(502, "gateway returned invalid analytics");
  return Object.fromEntries(
    Object.entries(value).map(([status, count]) => {
      if (!/^[a-z_]{1,40}$/.test(status)) {
        throw new DemoError(502, "gateway returned invalid analytics");
      }
      return [status, analyticsInteger(count)];
    }),
  );
}

function analyticsWithdrawalStatuses(value: unknown): Record<string, number> {
  if (!isObject(value)) throw new DemoError(502, "gateway returned invalid analytics");
  return analyticsStatuses(value.withdrawal);
}

function demoOption(env: DemoEnv, chain: string, asset: string): DemoOption {
  const option = demoOptions(env).find((item) => item.chain === chain && item.asset === asset);
  if (!option) throw new DemoError(400, "unsupported demo network or asset");
  return option;
}

function demoAddress(value: Record<string, unknown>, key: string): string {
  const address = stringField(value, key);
  if (!/^0x[0-9a-f]{40}$/i.test(address) || /^0x0{40}$/i.test(address)) {
    const label =
      key === "walletAddress"
        ? "wallet address"
        : key === "refundAddress"
          ? "refund address"
          : "destination address";
    throw new DemoError(400, `enter a valid ${label}`);
  }
  return address;
}

function demoIdempotencyKey(value: Record<string, unknown>): string {
  const key = stringField(value, "idempotencyKey");
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(key)) {
    throw new DemoError(400, "idempotencyKey must be a UUID");
  }
  return key;
}

function signedRawTransaction(value: Record<string, unknown>): string {
  const raw = stringField(value, "rawTransaction");
  if (!/^0x(?:[0-9a-f]{2})+$/i.test(raw) || raw.length > 262_146) {
    throw new DemoError(400, "enter a valid signed raw transaction");
  }
  return raw;
}

function demoOptions(env: DemoEnv): DemoOption[] {
  let value: unknown;
  try {
    value = JSON.parse(requiredSetting(env.DEMO_OPTIONS_JSON, "DEMO_OPTIONS_JSON"));
  } catch {
    throw new Error("DEMO_OPTIONS_JSON is invalid");
  }
  if (!Array.isArray(value) || value.length < 1 || value.length > 20) {
    throw new Error("DEMO_OPTIONS_JSON is invalid");
  }
  const seen = new Set<string>();
  const networks = new Map<string, string>();
  return value.map((item) => {
    if (!isObject(item)) throw new Error("DEMO_OPTIONS_JSON is invalid");
    const option = {
      chain: configString(item, "chain", /^[a-z0-9-]{1,40}$/),
      chainLabel: configString(item, "chainLabel", /^.{1,60}$/),
      chainId: configInteger(item, "chainId", 1, Number.MAX_SAFE_INTEGER),
      asset: configString(item, "asset", /^[A-Z0-9]{2,12}$/),
      decimals: configInteger(item, "decimals", 0, 255),
      minimumAmount: configString(item, "minimumAmount", /^\d+(?:\.\d+)?$/),
      maximumAmount: configString(item, "maximumAmount", /^\d+(?:\.\d+)?$/),
      defaultAmount: configString(item, "defaultAmount", /^\d+(?:\.\d+)?$/),
      nativeAsset: configString(item, "nativeAsset", /^[A-Z0-9]{2,12}$/),
      walletRpcUrl: configUrl(item, "walletRpcUrl"),
      explorerUrl: configUrl(item, "explorerUrl"),
    };
    const key = `${option.chain}:${option.asset}`;
    if (seen.has(key)) throw new Error("DEMO_OPTIONS_JSON contains duplicates");
    seen.add(key);
    const network = JSON.stringify([
      option.chainLabel,
      option.chainId,
      option.nativeAsset,
      option.walletRpcUrl,
      option.explorerUrl,
    ]);
    if (networks.has(option.chain) && networks.get(option.chain) !== network) {
      throw new Error("DEMO_OPTIONS_JSON contains inconsistent network settings");
    }
    networks.set(option.chain, network);
    const amounts = amountConfig(option);
    const defaultAmount = parseAmount(option.defaultAmount, option.decimals);
    if (
      defaultAmount.units < amounts.minimum.units ||
      defaultAmount.units > amounts.maximum.units
    ) {
      throw new Error("demo amount configuration is invalid");
    }
    return option;
  });
}

function configString(value: Record<string, unknown>, key: string, pattern: RegExp): string {
  const field = value[key];
  if (typeof field !== "string" || !pattern.test(field)) {
    throw new Error(`DEMO_OPTIONS_JSON ${key} is invalid`);
  }
  return field;
}

function configInteger(
  value: Record<string, unknown>,
  key: string,
  minimum: number,
  maximum: number,
): number {
  const field = value[key];
  if (!Number.isSafeInteger(field) || (field as number) < minimum || (field as number) > maximum) {
    throw new Error(`DEMO_OPTIONS_JSON ${key} is invalid`);
  }
  return field as number;
}

function configUrl(value: Record<string, unknown>, key: string): string {
  const field = configString(value, key, /^https:\/\/.{1,200}$/);
  try {
    const parsed = new URL(field);
    if (parsed.protocol !== "https:" || parsed.username || parsed.password) throw new Error();
  } catch {
    throw new Error(`DEMO_OPTIONS_JSON ${key} is invalid`);
  }
  return field;
}

function analyticsInteger(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new DemoError(502, "gateway returned invalid analytics");
  }
  return value as number;
}

function analyticsUnits(value: unknown): bigint {
  if (typeof value !== "string" || !/^\d+$/.test(value)) {
    throw new DemoError(502, "gateway returned invalid analytics");
  }
  return BigInt(value);
}

async function issueAccessToken(
  intentId: string,
  expiresAt: number,
  secret: string,
): Promise<string> {
  const payload = base64Url(new TextEncoder().encode(JSON.stringify({ intentId, expiresAt })));
  const signature = await crypto.subtle.sign(
    "HMAC",
    await hmacKey(requiredSecret(secret, "DEMO_SESSION_SECRET", 32)),
    new TextEncoder().encode(payload),
  );
  return `${payload}.${base64Url(new Uint8Array(signature))}`;
}

async function validAccessToken(token: string, intentId: string, secret: string): Promise<boolean> {
  if (token.length > 4_096) return false;
  const [payload, encodedSignature, extra] = token.split(".");
  if (!payload || !encodedSignature || extra) return false;
  let signature: ArrayBuffer;
  let parsed: unknown;
  try {
    signature = fromBase64Url(encodedSignature);
    parsed = JSON.parse(new TextDecoder().decode(fromBase64Url(payload)));
  } catch {
    return false;
  }
  if (
    !isObject(parsed) ||
    parsed.intentId !== intentId ||
    typeof parsed.expiresAt !== "number" ||
    !Number.isSafeInteger(parsed.expiresAt) ||
    parsed.expiresAt < Date.now()
  ) {
    return false;
  }
  return crypto.subtle.verify(
    "HMAC",
    await hmacKey(requiredSecret(secret, "DEMO_SESSION_SECRET", 32)),
    signature,
    new TextEncoder().encode(payload),
  );
}

async function requireAccess(request: Request, resourceId: string, env: DemoEnv): Promise<void> {
  const authorization = request.headers.get("Authorization") ?? "";
  const token = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
  if (!(await validAccessToken(token, resourceId, env.DEMO_SESSION_SECRET))) {
    throw new DemoError(401, "invalid demo access token");
  }
}

function gatewayAuthorization(env: DemoEnv): Record<string, string> {
  return {
    Authorization: `Bearer ${requiredSecret(env.PAYMENT_API_KEY, "PAYMENT_API_KEY", 24)}`,
  };
}

function enforceSameOrigin(request: Request): void {
  const origin = request.headers.get("Origin");
  if (origin && origin !== new URL(request.url).origin) throw new DemoError(403, "invalid origin");
}

async function readObject(
  request: Request,
  maximumBytes: number,
): Promise<Record<string, unknown>> {
  if (request.headers.get("Content-Type")?.split(";", 1)[0].trim() !== "application/json") {
    throw new DemoError(415, "Content-Type must be application/json");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(await limitedText(request, maximumBytes));
  } catch (error) {
    if (error instanceof DemoError) throw error;
    throw new DemoError(400, "request body must be valid JSON");
  }
  if (!isObject(parsed)) throw new DemoError(400, "request body must be an object");
  return parsed;
}

async function responseObject(
  response: Response,
  maximumBytes: number,
): Promise<Record<string, unknown>> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await limitedText(response, maximumBytes));
  } catch {
    throw new DemoError(502, "upstream returned an invalid response");
  }
  if (!isObject(parsed)) throw new DemoError(502, "upstream returned an invalid response");
  return parsed;
}

async function limitedText(
  message: { body: ReadableStream<Uint8Array> | null; headers: Headers },
  maximumBytes: number,
): Promise<string> {
  const declared = Number(message.headers.get("Content-Length"));
  if (Number.isFinite(declared) && declared > maximumBytes) {
    throw new DemoError(413, "request body is too large");
  }
  if (!message.body) return "";
  const reader = message.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) return text + decoder.decode();
    bytes += value.byteLength;
    if (bytes > maximumBytes) {
      await reader.cancel().catch(() => undefined);
      throw new DemoError(413, "request body is too large");
    }
    text += decoder.decode(value, { stream: true });
  }
}

function rejectUnknownFields(body: Record<string, unknown>, allowed: string[]): void {
  const extras = Object.keys(body).filter((key) => !allowed.includes(key));
  if (extras.length) throw new DemoError(400, `unknown field: ${extras[0]}`);
}

function stringField(value: Record<string, unknown>, key: string): string {
  const field = value[key];
  if (typeof field !== "string") throw new DemoError(400, `${key} must be a string`);
  return field.trim();
}

function integerSetting(raw: string, name: string, minimum: number, maximum: number): number {
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} is invalid`);
  }
  return value;
}

function requiredSetting(value: string, name: string): string {
  if (!value?.trim()) throw new Error(`${name} is required`);
  return value.trim();
}

function requiredSecret(value: string, name: string, minimumLength: number): string {
  if (!value || value.length < minimumLength) throw new Error(`${name} is too short`);
  return value;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function safeError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error))
    .replace(/https?:\/\/[^\s"'<>]+/gi, "[redacted-url]")
    .replace(/[0-9a-f]{64,}/gi, "[redacted]");
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

function hexBytes(value: string): ArrayBuffer {
  const bytes = new Uint8Array(value.length / 2);
  for (let index = 0; index < bytes.length; index++) {
    bytes[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes.buffer;
}

function base64Url(value: Uint8Array): string {
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function fromBase64Url(value: string): ArrayBuffer {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("invalid base64url");
  const padded =
    value.replaceAll("-", "+").replaceAll("_", "/") + "=".repeat((4 - (value.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  if (base64Url(bytes) !== value) throw new Error("non-canonical base64url");
  return bytes.buffer;
}

function json(body: unknown, status = 200): Response {
  return Response.json(body, {
    status,
    headers: {
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

class DemoError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
