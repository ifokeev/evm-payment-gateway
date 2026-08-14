import { privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";
import {
  deriveStatus,
  eligibleForSweep,
  formatUnits,
  loadNetworks,
  parseAmount,
  paymentUri,
  remainingGasFunding,
  stableStringify,
} from "../src/domain";

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
          name: "base",
          chainId: 8453,
          rpcUrl: "https://rpc.test",
          treasuryAddress: "0x2222222222222222222222222222222222222222",
          confirmations: 12,
          maxGasPriceWei: "5000000000",
          nativeAsset: "ETH",
          tokens: { USDC: { address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", decimals: 6 } },
        },
      ]),
    ).values();
    expect(paymentUri(network, network.tokens.USDC.address, deposit, "10000000")).toContain(
      "@8453/transfer",
    );
    expect(paymentUri(network, "", deposit, "100")).toBe(`ethereum:${deposit}@8453?value=100`);
  });

  it("validates network secrets and token recovery thresholds", () => {
    const gasPrivateKey = "0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
    const base = {
      name: "test",
      chainId: 1337,
      rpcUrl: "https://rpc.test",
      treasuryAddress: "0x2222222222222222222222222222222222222222",
      confirmations: 2,
      maxGasPriceWei: "1000000000",
      nativeAsset: "ETH",
    };
    expect(() =>
      loadNetworks(
        JSON.stringify([
          { ...base, treasuryAddress: "0x0000000000000000000000000000000000000000" },
        ]),
      ),
    ).toThrow("treasury");
    expect(() =>
      loadNetworks(
        JSON.stringify([
          {
            ...base,
            tokens: {
              USDC: { address: "0x9999999999999999999999999999999999999999", decimals: 6 },
            },
          },
        ]),
        true,
      ),
    ).toThrow("gasPrivateKey");
    expect(() =>
      loadNetworks(JSON.stringify([{ ...base, maxGasPriceWei: "0", tokens: {} }])),
    ).toThrow("maxGasPriceWei");
    expect(loadNetworks(JSON.stringify([{ ...base, tokens: {} }]), true).size).toBe(1);
    expect(() =>
      loadNetworks(JSON.stringify([{ ...base, rpcUrl: "http://rpc.test", tokens: {} }])),
    ).toThrow("HTTPS");
    expect(() =>
      loadNetworks(JSON.stringify([{ ...base, explorerUrl: "javascript:alert(1)", tokens: {} }])),
    ).toThrow("explorer");
    expect(() => loadNetworks(JSON.stringify([{ ...base, tokens: {}, gasPrivateKey }]))).toThrow(
      "must not contain gasPrivateKey",
    );
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
            tokens: { USDC: { address: base.treasuryAddress, decimals: 6 } },
          },
        ]),
      ),
    ).toThrow("treasury");
    expect(() =>
      loadNetworks(
        JSON.stringify([
          {
            ...base,
            treasuryAddress: privateKeyToAccount(gasPrivateKey).address,
            tokens: {
              USDC: { address: "0x9999999999999999999999999999999999999999", decimals: 6 },
            },
            gasPrivateKey,
          },
        ]),
        true,
      ),
    ).toThrow("treasury");
    expect(eligibleForSweep(true, "underpaid", 49n, 100n, true, 5_000)).toBe(false);
    expect(eligibleForSweep(true, "underpaid", 50n, 100n, true, 5_000)).toBe(true);
    expect(eligibleForSweep(false, "underpaid", 1n, 100n, true, 5_000)).toBe(true);
    expect(remainingGasFunding(100n, ["40", "30"], 30n)).toBe(0n);
    expect(() => remainingGasFunding(100n, ["60", "40"], 1n)).toThrow("limit");
    expect(() => remainingGasFunding(100n, ["not-a-number"])).toThrow("history");
  });

  it("canonicalizes nested idempotency metadata", () => {
    expect(stableStringify({ z: 1, a: { y: 2, x: [3, 4] } })).toBe('{"a":{"x":[3,4],"y":2},"z":1}');
  });
});
