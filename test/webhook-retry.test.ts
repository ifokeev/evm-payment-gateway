import { env, exports } from "cloudflare:workers";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { deliverWebhooks, randomId, unixNow } from "../src/monitor";
import type { ApiEnv } from "../src/types";

const bindings = env as unknown as ApiEnv;
const api = (exports as unknown as { default: { fetch(request: Request): Promise<Response> } })
  .default;
const WINDOW = 3_600;
const withWindow = (seconds: number): ApiEnv => ({
  ...bindings,
  WEBHOOK_RETRY_WINDOW_SECONDS: String(seconds),
});
let webhookStatus = 503;
let deliveries: string[] = [];

type EventRow = {
  status: string;
  attempts: number;
  next_attempt_at: number;
  last_error: string;
  updated_at: number;
  delivered_at: number | null;
};

beforeAll(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(input, init);
      if (request.url !== "https://webhook.test/events")
        throw new Error(`unmocked request: ${request.url}`);
      deliveries.push(request.headers.get("Webhook-Id") ?? "");
      return new Response(null, { status: webhookStatus });
    }),
  );
  vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-11-22T12:00:00Z") });
});

afterAll(() => {
  vi.useRealTimers();
});

beforeEach(async () => {
  webhookStatus = 503;
  deliveries = [];
  await bindings.DB.prepare("DELETE FROM webhook_events").run();
});

async function insertEvent(
  fields: { createdAt?: number; attempts?: number; status?: string } = {},
): Promise<string> {
  const eventId = randomId("evt");
  const now = unixNow();
  await bindings.DB.prepare(`INSERT INTO webhook_events
    (event_id,type,subject_type,subject_id,body,status,attempts,next_attempt_at,created_at,updated_at)
    VALUES (?,'deposit.succeeded','deposit','','{}',?,?,?,?,?)`)
    .bind(
      eventId,
      fields.status ?? "pending",
      fields.attempts ?? 0,
      now,
      fields.createdAt ?? now,
      fields.createdAt ?? now,
    )
    .run();
  return eventId;
}

async function eventRow(eventId: string): Promise<EventRow> {
  const row = await bindings.DB.prepare("SELECT * FROM webhook_events WHERE event_id = ?")
    .bind(eventId)
    .first<EventRow>();
  return row!;
}

describe("webhook retry window", () => {
  it("defaults the retry window to 72 hours", () => {
    expect(bindings.WEBHOOK_RETRY_WINDOW_SECONDS).toBe("259200");
  });

  it("rejects a retry window outside 60 seconds to 30 days", async () => {
    for (const invalid of ["59", "2592001", "", "soon", "1.5"])
      await expect(
        deliverWebhooks({ ...bindings, WEBHOOK_RETRY_WINDOW_SECONDS: invalid }),
      ).rejects.toThrow("WEBHOOK_RETRY_WINDOW_SECONDS is invalid");
    for (const valid of ["60", "2592000"])
      await deliverWebhooks({ ...bindings, WEBHOOK_RETRY_WINDOW_SECONDS: valid });
  });

  it("uses 72 hours when the variable is not set", async () => {
    const now = unixNow();
    const hourlyAttemptFits = await insertEvent({ createdAt: now + 3_600 - 259_200, attempts: 11 });
    const hourlyAttemptTooLate = await insertEvent({
      createdAt: now + 3_600 - 259_200 - 1,
      attempts: 11,
    });
    await deliverWebhooks({ ...bindings, WEBHOOK_RETRY_WINDOW_SECONDS: undefined });

    expect(await eventRow(hourlyAttemptFits)).toMatchObject({ status: "pending", attempts: 12 });
    expect(await eventRow(hourlyAttemptTooLate)).toMatchObject({ status: "failed", attempts: 12 });
  });

  it("reschedules a failing event inside the window with the existing backoff", async () => {
    const now = unixNow();
    const fresh = await insertEvent();
    const lateInWindow = await insertEvent({ createdAt: now - 600, attempts: 11 });
    await deliverWebhooks(withWindow(7_200));

    expect(await eventRow(fresh)).toMatchObject({
      status: "pending",
      attempts: 1,
      next_attempt_at: now + 2,
      last_error: "webhook returned HTTP 503",
      updated_at: now,
    });
    expect(await eventRow(lateInWindow)).toMatchObject({
      status: "pending",
      attempts: 12,
      next_attempt_at: now + 3_600,
    });
  });

  it("marks an event failed once its next attempt would fall outside the window", async () => {
    const now = unixNow();
    // The hourly attempt after this failure lands exactly on the end of the window, then one second later.
    const lastAttemptFits = await insertEvent({ createdAt: now + 3_600 - WINDOW, attempts: 11 });
    const nextAttemptTooLate = await insertEvent({
      createdAt: now + 3_600 - WINDOW - 1,
      attempts: 11,
    });
    await deliverWebhooks(withWindow(WINDOW));

    expect(await eventRow(lastAttemptFits)).toMatchObject({ status: "pending", attempts: 12 });
    expect(await eventRow(nextAttemptTooLate)).toMatchObject({
      status: "failed",
      attempts: 12,
      last_error: "webhook returned HTTP 503",
      updated_at: now,
    });
  });

  it("fails an event that is already older than the window on its next failed attempt", async () => {
    const stale = await insertEvent({ createdAt: unixNow() - WINDOW - 10, attempts: 3 });
    await deliverWebhooks(withWindow(WINDOW));

    expect(await eventRow(stale)).toMatchObject({ status: "failed", attempts: 4 });
  });

  it("never selects a failed event again", async () => {
    const stale = await insertEvent({ createdAt: unixNow() - WINDOW - 10 });
    await deliverWebhooks(withWindow(WINDOW));
    expect(deliveries).toEqual([stale]);
    const failed = await eventRow(stale);

    vi.setSystemTime(new Date(Date.now() + 7 * 24 * 3_600_000));
    await deliverWebhooks(withWindow(WINDOW));

    expect(deliveries).toEqual([stale]);
    expect(await eventRow(stale)).toEqual(failed);
  });

  it("keeps the delivered path unchanged, even for an event past the window", async () => {
    webhookStatus = 204;
    const now = unixNow();
    const stale = await insertEvent({ createdAt: now - WINDOW * 5, attempts: 6 });
    await deliverWebhooks(withWindow(WINDOW));

    expect(await eventRow(stale)).toMatchObject({
      status: "delivered",
      attempts: 7,
      last_error: "",
      delivered_at: now,
    });
  });

  it("delivers a failed event again after an operator re-queues it", async () => {
    const stale = await insertEvent({ createdAt: unixNow() - WINDOW - 10 });
    await deliverWebhooks(withWindow(WINDOW));
    expect((await eventRow(stale)).status).toBe("failed");

    webhookStatus = 204;
    await bindings.DB.prepare(
      "UPDATE webhook_events SET status = 'pending', next_attempt_at = 0 WHERE event_id = ?",
    )
      .bind(stale)
      .run();
    await deliverWebhooks(withWindow(WINDOW));

    expect(deliveries).toEqual([stale, stale]);
    expect(await eventRow(stale)).toMatchObject({ status: "delivered", attempts: 2 });
  });
});

describe("webhook backlog in health", () => {
  async function webhooks() {
    const response = await api.fetch(new Request("https://gateway.test/health"));
    expect(response.status).toBe(200);
    return (await response.json<{ webhooks: unknown }>()).webhooks;
  }

  it("is empty without pending or failed events", async () => {
    await insertEvent({ status: "delivered" });
    expect(await webhooks()).toEqual({ pending: 0, failed: 0, oldestPendingAgeSeconds: 0 });
  });

  it("counts pending and failed events and ages the oldest pending one", async () => {
    const now = unixNow();
    await insertEvent({ createdAt: now - 30 });
    await insertEvent({ createdAt: now - 120 });
    await insertEvent({ createdAt: now - 99_999, status: "failed" });
    await insertEvent({ createdAt: now - 200_000, status: "delivered" });
    expect(await webhooks()).toEqual({ pending: 2, failed: 1, oldestPendingAgeSeconds: 120 });
  });
});
