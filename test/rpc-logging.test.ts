import { createPublicClient } from "viem";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { rpcTransport } from "../src/rpc";

type RpcCall = { id: number; method: string };
type Handler = (payload: RpcCall | RpcCall[]) => Response;

const RESULTS: Record<string, string> = { eth_chainId: "0x539", eth_blockNumber: "0x7b" };
const account = "0x2222222222222222222222222222222222222222";

function answer(call: RpcCall) {
  return { jsonrpc: "2.0", id: call.id, result: RESULTS[call.method] ?? "0x0" };
}

const healthy: Handler = (payload) =>
  Response.json(Array.isArray(payload) ? payload.map(answer) : answer(payload));

function clientFor(urls: string[], handlers: Record<string, Handler>, batch = false) {
  return createPublicClient({
    transport: rpcTransport(urls, {
      batch: batch ? { batchSize: 10 } : false,
      fetchFn: async (request, init) => {
        const href =
          typeof request === "string"
            ? request
            : request instanceof URL
              ? request.href
              : request.url;
        return handlers[new URL(href).host](JSON.parse(init?.body as string));
      },
    }),
  });
}

describe("rpc endpoint failure logging", () => {
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });

  afterEach(() => {
    warn.mockRestore();
  });

  it("logs the endpoint that failed and stays quiet while endpoints answer", async () => {
    let primaryUp = true;
    const client = clientFor(["https://primary.test/v3/secret-key", "https://fallback.test"], {
      "primary.test": (payload) =>
        primaryUp ? healthy(payload) : new Response("unavailable", { status: 500 }),
      "fallback.test": healthy,
    });

    expect(await client.getChainId()).toBe(1337);
    expect(warn).not.toHaveBeenCalled();

    primaryUp = false;
    expect(await client.getChainId()).toBe(1337);
    expect(warn).toHaveBeenCalledTimes(1);
    const [message, host, method, reason] = warn.mock.calls[0] as string[];
    expect([message, host, method]).toEqual(["rpc endpoint failed", "primary.test", "eth_chainId"]);
    expect(reason).toContain("HTTP request failed");
    expect(reason).toContain("Status: 500");
    expect(warn.mock.calls[0].join(" ")).not.toMatch(/secret-key|\/v3/);
  });

  it("logs a JSON-RPC error answer from an endpoint that the fallback then skips", async () => {
    const client = clientFor(["https://primary.test", "https://fallback.test"], {
      "primary.test": (payload) =>
        Response.json({
          jsonrpc: "2.0",
          id: (payload as RpcCall).id,
          error: { code: -32602, message: "invalid params from provider" },
        }),
      "fallback.test": healthy,
    });

    expect(await client.getBlockNumber()).toBe(123n);
    expect(warn).toHaveBeenCalledTimes(1);
    const [, host, method, reason] = warn.mock.calls[0] as string[];
    expect([host, method]).toEqual(["primary.test", "eth_blockNumber"]);
    expect(reason).toContain("invalid params from provider");
  });

  it("logs a failed batch once for all of its callers", async () => {
    const client = clientFor(
      ["https://primary.test", "https://fallback.test"],
      {
        "primary.test": () => new Response("unavailable", { status: 500 }),
        "fallback.test": healthy,
      },
      true,
    );

    const [chainId, block] = await Promise.all([
      client.getChainId(),
      client.getBlockNumber(),
      client.getBalance({ address: account }),
    ]);
    expect([chainId, block]).toEqual([1337, 123n]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][1]).toBe("primary.test");
  });

  it("logs a batch rejected with a single JSON-RPC error once", async () => {
    const client = clientFor(
      ["https://primary.test", "https://fallback.test"],
      {
        "primary.test": () =>
          Response.json(
            { jsonrpc: "2.0", id: null, error: { code: -32600, message: "batch not allowed" } },
            { status: 400 },
          ),
        "fallback.test": healthy,
      },
      true,
    );

    const [chainId] = await Promise.all([
      client.getChainId(),
      client.getBlockNumber(),
      client.getBalance({ address: account }),
    ]);
    expect(chainId).toBe(1337);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][1]).toBe("primary.test");
  });

  it("throws the last error and logs one line per failing endpoint", async () => {
    const client = clientFor(["https://primary.test", "https://fallback.test"], {
      "primary.test": () => new Response("primary down", { status: 500 }),
      "fallback.test": () => new Response("fallback down", { status: 503 }),
    });

    await expect(client.getChainId()).rejects.toThrow("Status: 503");
    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn.mock.calls.map((call: unknown[]) => call[1])).toEqual([
      "primary.test",
      "fallback.test",
    ]);
    expect(warn.mock.calls[0][3]).toContain("Status: 500");
    expect(warn.mock.calls[1][3]).toContain("Status: 503");
  });

  it("keeps request bodies and raw transactions out of the log and bounds the reason", async () => {
    const client = clientFor(["https://primary.test/v3/secret-key"], {
      "primary.test": () => new Response(`rejected ${"x".repeat(5_000)}`, { status: 500 }),
    });
    const serializedTransaction = `0x${"ab".repeat(200)}` as const;

    await expect(client.sendRawTransaction({ serializedTransaction })).rejects.toThrow();
    expect(warn).toHaveBeenCalledTimes(1);
    const reason = warn.mock.calls[0][3] as string;
    expect(reason.length).toBeLessThanOrEqual(300);
    expect(warn.mock.calls[0].join(" ")).not.toMatch(/abababab|secret-key|Request body/);
  });
});
