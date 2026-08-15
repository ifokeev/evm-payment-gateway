import { createPublicClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";
import { PAYMENT_FORWARDER_FACTORY_RUNTIME_CODE_HASH } from "../src/contracts.generated";
import {
  deriveStatus,
  eligibleForSweep,
  formatUnits,
  loadNetworks,
  parseAmount,
  paymentUri,
  stableStringify,
} from "../src/domain";
import { rpcTransport } from "../src/rpc";

const relayerPrivateKey = "0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const relayerAddress = privateKeyToAccount(relayerPrivateKey).address;
const base = {
  name: "test",
  chainId: 1337,
  rpcUrls: ["https://rpc.test"],
  treasuryAddress: "0x2222222222222222222222222222222222222222",
  factoryAddress: "0x3333333333333333333333333333333333333333",
  factoryCodeHash: PAYMENT_FORWARDER_FACTORY_RUNTIME_CODE_HASH,
  relayerAddress,
  confirmations: 2,
  maxGasPriceWei: "1000000000",
  nativeAsset: "ETH",
};

describe("payment domain", () => {
  it("keeps decimal amounts exact through uint256 boundaries", () => {
    expect(parseAmount(" 0010.250000 ", 6)).toEqual({ amount: "10.25", units: 10_250_000n });
    expect(parseAmount("0.000001", 6)).toEqual({ amount: "0.000001", units: 1n });
    expect(formatUnits(10_250_000n, 6)).toBe("10.25");
    expect(() => parseAmount("10.0000001", 6)).toThrow("at most 6");
    for (const invalid of ["", "0", "-1", ".1", "1.", "1e3", "+1", "1..0"])
      expect(() => parseAmount(invalid, 6)).toThrow();
    const maximum = (1n << 256n) - 1n;
    expect(parseAmount(maximum.toString(), 0).units).toBe(maximum);
    expect(() => parseAmount((maximum + 1n).toString(), 0)).toThrow("uint256");
  });

  it("orders payment states without losing reorgs or underpayments", () => {
    expect(deriveStatus(0n, 0n, 100n, false, false)).toBe("pending");
    expect(deriveStatus(0n, 0n, 100n, true, false)).toBe("expired");
    expect(deriveStatus(50n, 0n, 100n, false, false)).toBe("underpaid");
    expect(deriveStatus(100n, 0n, 100n, false, false)).toBe("confirming");
    expect(deriveStatus(100n, 100n, 100n, false, true)).toBe("paid");
    expect(deriveStatus(0n, 0n, 100n, false, true)).toBe("reorged");
  });

  it("creates wallet-compatible links", () => {
    const deposit = "0x1111111111111111111111111111111111111111";
    const [network] = loadNetworks(
      JSON.stringify([
        {
          ...base,
          name: "base",
          chainId: 8453,
          tokens: {
            USDC: { address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", decimals: 6 },
          },
        },
      ]),
    ).values();
    expect(paymentUri(network, network.tokens.USDC.address, deposit, "10000000")).toContain(
      "@8453/transfer",
    );
    expect(paymentUri(network, "", deposit, "100")).toBe(`ethereum:${deposit}@8453?value=100`);
  });

  it("isolates the relayer key and validates contract identities", () => {
    expect(() =>
      loadNetworks(
        JSON.stringify([
          { ...base, treasuryAddress: "0x0000000000000000000000000000000000000000" },
        ]),
      ),
    ).toThrow("treasury");
    expect(() => loadNetworks(JSON.stringify([{ ...base, factoryCodeHash: "0x1234" }]))).toThrow(
      "code hash",
    );
    expect(() =>
      loadNetworks(JSON.stringify([{ ...base, relayerAddress: base.treasuryAddress }])),
    ).toThrow("must differ");
    expect(() => loadNetworks(JSON.stringify([{ ...base, tokens: {} }]), true)).toThrow(
      "relayerPrivateKey",
    );
    expect(
      loadNetworks(JSON.stringify([{ ...base, tokens: {}, relayerPrivateKey }]), true).size,
    ).toBe(1);
    expect(() =>
      loadNetworks(
        JSON.stringify([
          {
            ...base,
            tokens: {},
            relayerPrivateKey: "0xabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcd",
          },
        ]),
        true,
      ),
    ).toThrow("does not match");
    expect(() =>
      loadNetworks(JSON.stringify([{ ...base, tokens: {}, relayerPrivateKey }])),
    ).toThrow("must not contain");
    expect(() =>
      loadNetworks(JSON.stringify([{ ...base, maxGasPriceWei: "0", tokens: {} }])),
    ).toThrow("maxGasPriceWei");
    expect(() =>
      loadNetworks(JSON.stringify([{ ...base, rpcUrls: ["http://rpc.test"], tokens: {} }])),
    ).toThrow("HTTPS");
    expect(() => loadNetworks(JSON.stringify([{ ...base, rpcUrls: [], tokens: {} }]))).toThrow(
      "non-empty",
    );
    expect(() =>
      loadNetworks(
        JSON.stringify([
          { ...base, rpcUrls: ["https://rpc.test", "https://rpc.test"], tokens: {} },
        ]),
      ),
    ).toThrow("unique");
    expect(() =>
      loadNetworks(JSON.stringify([{ ...base, explorerUrl: "javascript:alert(1)", tokens: {} }])),
    ).toThrow("explorer");
    expect(() =>
      loadNetworks(
        JSON.stringify([
          {
            ...base,
            nativeAsset: "USDC",
            tokens: {
              USDC: { address: "0x9999999999999999999999999999999999999999", decimals: 6 },
            },
          },
        ]),
      ),
    ).toThrow("native asset");
    expect(() =>
      loadNetworks(
        JSON.stringify([
          {
            ...base,
            tokens: { USDC: { address: base.factoryAddress, decimals: 6 } },
          },
        ]),
      ),
    ).toThrow("factory or relayer");
  });

  it("falls back to the next RPC endpoint", async () => {
    const requests: string[] = [];
    const client = createPublicClient({
      transport: rpcTransport(["https://primary.test", "https://fallback.test"], {
        fetchFn: async (request, init) => {
          const url =
            typeof request === "string"
              ? request
              : request instanceof URL
                ? request.href
                : request.url;
          requests.push(url);
          if (url === "https://primary.test/") return new Response("unavailable", { status: 503 });
          const payload = JSON.parse(init?.body as string) as { id: number };
          return Response.json({ jsonrpc: "2.0", id: payload.id, result: "0x539" });
        },
      }),
    });

    expect(await client.getChainId()).toBe(1337);
    expect(requests).toEqual(["https://primary.test/", "https://fallback.test/"]);
  });

  it("recovers only economically useful expired underpayments", () => {
    expect(eligibleForSweep(true, "underpaid", 49n, 100n, true, 5_000)).toBe(false);
    expect(eligibleForSweep(true, "underpaid", 50n, 100n, true, 5_000)).toBe(true);
    expect(eligibleForSweep(false, "underpaid", 1n, 100n, true, 5_000)).toBe(true);
  });

  it("canonicalizes nested idempotency metadata", () => {
    expect(stableStringify({ z: 1, a: { y: 2, x: [3, 4] } })).toBe('{"a":{"x":[3,4],"y":2},"z":1}');
  });
});
