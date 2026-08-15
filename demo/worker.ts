import { parseAmount } from "../src/domain";

const API_ROOT = "/api";
const GATEWAY_ROOT = "/api/payments/v1";
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
  DEMO_CHAIN: string;
  DEMO_ASSET: string;
  DEMO_ASSET_DECIMALS: string;
  DEMO_MIN_AMOUNT: string;
  DEMO_MAX_AMOUNT: string;
  DEMO_EXPIRY_SECONDS: string;
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
    const amount = amountConfig(env);
    return json({
      chain: env.DEMO_CHAIN,
      asset: env.DEMO_ASSET,
      minimumAmount: amount.minimum.amount,
      maximumAmount: amount.maximum.amount,
      turnstileSiteKey: requiredSetting(env.TURNSTILE_SITE_KEY, "TURNSTILE_SITE_KEY"),
    });
  }
  if (request.method === "POST" && url.pathname === `${API_ROOT}/intents`) {
    return createDemoIntent(request, env);
  }
  const intentMatch = url.pathname.match(/^\/api\/intents\/(pi_[A-Za-z0-9_-]+)$/);
  if (request.method === "GET" && intentMatch) {
    return getDemoIntent(request, env, intentMatch[1]);
  }
  if (request.method === "POST" && url.pathname === "/webhooks/payment") {
    return receiveWebhook(request, env);
  }
  if (url.pathname.startsWith(`${API_ROOT}/`) || url.pathname.startsWith("/webhooks/")) {
    throw new DemoError(404, "not found");
  }
  return env.ASSETS.fetch(request);
}

async function createDemoIntent(request: Request, env: DemoEnv): Promise<Response> {
  const origin = request.headers.get("Origin");
  if (origin && origin !== new URL(request.url).origin) throw new DemoError(403, "invalid origin");
  const ip = request.headers.get("CF-Connecting-IP") ?? "unknown";
  if (!(await env.DEMO_RATE_LIMITER.limit({ key: ip })).success) {
    throw new DemoError(429, "too many demo payments; try again in a minute");
  }

  const body = await readObject(request, 8_192);
  rejectUnknownFields(body, ["amount", "purpose", "idempotencyKey", "turnstileToken"]);
  const amount = stringField(body, "amount");
  const purpose = stringField(body, "purpose");
  const idempotencyKey = stringField(body, "idempotencyKey");
  const turnstileToken = stringField(body, "turnstileToken");
  if (purpose !== "checkout" && purpose !== "account_top_up") {
    throw new DemoError(400, "purpose must be checkout or account_top_up");
  }
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(idempotencyKey)
  ) {
    throw new DemoError(400, "idempotencyKey must be a UUID");
  }
  if (!turnstileToken || turnstileToken.length > 2_048) {
    throw new DemoError(400, "complete the security check");
  }

  const configured = amountConfig(env);
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
  if (
    !(await verifyTurnstile(
      turnstileToken,
      ip,
      new URL(request.url).hostname,
      env.TURNSTILE_SECRET_KEY,
    ))
  ) {
    throw new DemoError(403, "security check failed; please try again");
  }

  const gateway = await env.GATEWAY.fetch(
    new Request(`https://gateway.internal${GATEWAY_ROOT}/intents`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${requiredSecret(env.PAYMENT_API_KEY, "PAYMENT_API_KEY", 24)}`,
        "Content-Type": "application/json",
        "Idempotency-Key": `demo:${idempotencyKey}`,
      },
      body: JSON.stringify({
        kind: "payment",
        externalId: `demo_${idempotencyKey}`,
        chain: requiredSetting(env.DEMO_CHAIN, "DEMO_CHAIN"),
        asset: requiredSetting(env.DEMO_ASSET, "DEMO_ASSET"),
        amount: parsed.amount,
        expiresInSeconds: integerSetting(
          env.DEMO_EXPIRY_SECONDS,
          "DEMO_EXPIRY_SECONDS",
          300,
          86_400,
        ),
        metadata: { demo: true, purpose },
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

async function getDemoIntent(request: Request, env: DemoEnv, intentId: string): Promise<Response> {
  const authorization = request.headers.get("Authorization") ?? "";
  const token = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
  if (!(await validAccessToken(token, intentId, env.DEMO_SESSION_SECRET))) {
    throw new DemoError(401, "invalid demo access token");
  }
  const headers = {
    Authorization: `Bearer ${requiredSecret(env.PAYMENT_API_KEY, "PAYMENT_API_KEY", 24)}`,
  };
  const [intentResponse, sweepResponse, webhookEvent] = await Promise.all([
    env.GATEWAY.fetch(
      new Request(`https://gateway.internal${GATEWAY_ROOT}/intents/${intentId}`, { headers }),
    ),
    env.GATEWAY.fetch(
      new Request(`https://gateway.internal${GATEWAY_ROOT}/intents/${intentId}/sweep`, { headers }),
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
  if (event.type !== "payment.succeeded" && event.type !== "payment.reorged") {
    throw new DemoError(400, "unsupported webhook event");
  }
  const paymentIntent = event.data.paymentIntent;
  if (
    !isObject(paymentIntent) ||
    typeof paymentIntent.id !== "string" ||
    !/^pi_[A-Za-z0-9_-]+$/.test(paymentIntent.id)
  ) {
    throw new DemoError(400, "invalid webhook body");
  }
  await env.DEMO_EVENTS.put(
    `intent:${paymentIntent.id}`,
    JSON.stringify({
      id: eventId,
      type: event.type,
      createdAt: event.createdAt,
      paymentIntent: {
        id: paymentIntent.id,
        status: paymentIntent.status,
        receivedUnits: paymentIntent.receivedUnits,
        confirmedUnits: paymentIntent.confirmedUnits,
        transactionHashes: paymentIntent.transactionHashes,
      },
    }),
    { expirationTtl: 7 * 24 * 60 * 60 },
  );
  return new Response(null, { status: 204 });
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

function amountConfig(env: DemoEnv): {
  decimals: number;
  minimum: ReturnType<typeof parseAmount>;
  maximum: ReturnType<typeof parseAmount>;
} {
  const decimals = integerSetting(env.DEMO_ASSET_DECIMALS, "DEMO_ASSET_DECIMALS", 0, 255);
  let minimum: ReturnType<typeof parseAmount>;
  let maximum: ReturnType<typeof parseAmount>;
  try {
    minimum = parseAmount(env.DEMO_MIN_AMOUNT, decimals);
    maximum = parseAmount(env.DEMO_MAX_AMOUNT, decimals);
  } catch {
    throw new Error("demo amount configuration is invalid");
  }
  if (minimum.units > maximum.units) throw new Error("demo amount configuration is invalid");
  return { decimals, minimum, maximum };
}

function publicIntent(value: Record<string, unknown>): Record<string, unknown> {
  const id = value.id;
  if (typeof id !== "string" || !/^pi_[A-Za-z0-9_-]+$/.test(id)) {
    throw new DemoError(502, "gateway returned an invalid intent");
  }
  const fields = [
    "id",
    "kind",
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
  return Object.fromEntries(
    fields.filter((field) => field in value).map((field) => [field, value[field]]),
  );
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
