import { type Address, getAddress, isAddress, isAddressEqual, zeroAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { PAYMENT_FORWARDER_FACTORY_RUNTIME_CODE_HASH } from "./contracts.generated";
import type { NetworkConfig, PaymentStatus, TokenConfig } from "./types";

const UINT256_MAX = (1n << 256n) - 1n;

export function parseAmount(input: string, decimals: number): { amount: string; units: bigint } {
  const value = input.trim();
  if (!/^\d+(\.\d+)?$/.test(value)) throw new Error("amount must be a positive decimal string");
  const [whole, fraction = ""] = value.split(".");
  if (fraction.length > decimals)
    throw new Error(`amount supports at most ${decimals} decimal places`);
  const units =
    BigInt(whole) * 10n ** BigInt(decimals) +
    BigInt((fraction + "0".repeat(decimals)).slice(0, decimals) || "0");
  if (units <= 0n) throw new Error("amount must be greater than zero");
  if (units > UINT256_MAX) throw new Error("amount exceeds uint256");
  return { amount: formatUnits(units, decimals), units };
}

export function formatUnits(units: bigint, decimals: number): string {
  if (decimals === 0) return units.toString();
  const digits = units.toString().padStart(decimals + 1, "0");
  const fraction = digits.slice(-decimals).replace(/0+$/, "");
  return fraction ? `${digits.slice(0, -decimals)}.${fraction}` : digits.slice(0, -decimals);
}

export function deriveStatus(
  received: bigint,
  confirmed: bigint,
  expected: bigint,
  expired: boolean,
  reorged: boolean,
): PaymentStatus {
  if (confirmed >= expected) return "paid";
  if (reorged) return "reorged";
  if (received >= expected) return "confirming";
  if (received > 0n) return "underpaid";
  return expired ? "expired" : "pending";
}

export function paymentUri(
  network: NetworkConfig,
  tokenAddress: Address | "",
  depositAddress: Address,
  units: string,
): string {
  return tokenAddress
    ? `ethereum:${tokenAddress}@${network.chainId}/transfer?address=${depositAddress}&uint256=${units}`
    : `ethereum:${depositAddress}@${network.chainId}?value=${units}`;
}

export function loadNetworks(raw: string, requireRelayerKeys = false): Map<string, NetworkConfig> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("network configuration must be valid JSON");
  }
  if (!Array.isArray(parsed) || parsed.length === 0)
    throw new Error("at least one network must be configured");
  const result = new Map<string, NetworkConfig>();
  const chainIds = new Set<number>();
  for (const item of parsed) {
    if (!isObject(item)) throw new Error("each network must be an object");
    const name = stringField(item, "name").trim();
    const rpcUrl = stringField(item, "rpcUrl").trim();
    const nativeAsset = stringField(item, "nativeAsset").trim().toUpperCase();
    const explorerUrl = optionalString(item, "explorerUrl").trim().replace(/\/$/, "");
    const chainId = integerField(item, "chainId", 1, Number.MAX_SAFE_INTEGER);
    const confirmations = integerField(item, "confirmations", 1, 10_000);
    const maxGasPriceWei = positiveBigIntField(item, "maxGasPriceWei");
    if (!/^[a-z0-9][a-z0-9-]{0,79}$/.test(name) || !/^[A-Z0-9]{2,20}$/.test(nativeAsset))
      throw new Error(`invalid network name or native asset: ${name}`);
    let url: URL;
    try {
      url = new URL(rpcUrl);
    } catch {
      throw new Error(`invalid RPC URL for ${name}`);
    }
    if (url.protocol !== "https:") throw new Error(`RPC URL for ${name} must use HTTPS`);
    if (explorerUrl) {
      try {
        if (new URL(explorerUrl).protocol !== "https:") throw new Error();
      } catch {
        throw new Error(`explorer URL for ${name} must use HTTPS`);
      }
    }
    const treasuryAddress = checkedAddress(
      stringField(item, "treasuryAddress"),
      `treasury address for ${name}`,
    );
    const factoryAddress = checkedAddress(
      stringField(item, "factoryAddress"),
      `factory address for ${name}`,
    );
    const relayerAddress = checkedAddress(
      stringField(item, "relayerAddress"),
      `relayer address for ${name}`,
    );
    const factoryCodeHash = stringField(item, "factoryCodeHash") as `0x${string}`;
    if (
      !/^0x[0-9a-fA-F]{64}$/.test(factoryCodeHash) ||
      factoryCodeHash.toLowerCase() !== PAYMENT_FORWARDER_FACTORY_RUNTIME_CODE_HASH.toLowerCase()
    ) {
      throw new Error(`invalid factory code hash for ${name}`);
    }
    if (
      isAddressEqual(factoryAddress, treasuryAddress) ||
      isAddressEqual(relayerAddress, treasuryAddress) ||
      isAddressEqual(relayerAddress, factoryAddress)
    ) {
      throw new Error(`factory, relayer, and treasury must differ for ${name}`);
    }
    if (result.has(name) || chainIds.has(chainId))
      throw new Error(`duplicate network name or chain ID: ${name}`);
    const tokens: Record<string, TokenConfig> = {};
    const tokenInput = item.tokens ?? {};
    if (!isObject(tokenInput)) throw new Error(`tokens for ${name} must be an object`);
    for (const [rawSymbol, rawToken] of Object.entries(tokenInput)) {
      const symbol = rawSymbol.trim().toUpperCase();
      if (!/^[A-Z0-9]{2,20}$/.test(symbol) || !isObject(rawToken) || tokens[symbol])
        throw new Error(`invalid token symbol for ${name}`);
      if (symbol === nativeAsset)
        throw new Error(`token symbol must not match native asset for ${name}`);
      const address = checkedAddress(
        stringField(rawToken, "address"),
        `token address for ${name}/${symbol}`,
      );
      if (isAddressEqual(address, treasuryAddress))
        throw new Error(`token address must not match treasury for ${name}/${symbol}`);
      if (isAddressEqual(address, factoryAddress) || isAddressEqual(address, relayerAddress))
        throw new Error(`token address must not match factory or relayer for ${name}/${symbol}`);
      tokens[symbol] = {
        address,
        decimals: integerField(rawToken, "decimals", 0, 255),
      };
    }
    const relayerPrivateKey = optionalString(item, "relayerPrivateKey") as `0x${string}` | "";
    if (relayerPrivateKey && !/^0x[0-9a-fA-F]{64}$/.test(relayerPrivateKey))
      throw new Error(`invalid relayerPrivateKey for ${name}`);
    if (!requireRelayerKeys && relayerPrivateKey)
      throw new Error(`API network ${name} must not contain relayerPrivateKey`);
    if (requireRelayerKeys && !relayerPrivateKey)
      throw new Error(`relayerPrivateKey is required for ${name}`);
    if (
      relayerPrivateKey &&
      !isAddressEqual(privateKeyToAccount(relayerPrivateKey).address, relayerAddress)
    ) {
      throw new Error(`relayerPrivateKey does not match relayerAddress for ${name}`);
    }
    result.set(name, {
      name,
      chainId,
      rpcUrl,
      treasuryAddress,
      factoryAddress,
      factoryCodeHash: factoryCodeHash.toLowerCase() as `0x${string}`,
      relayerAddress,
      confirmations,
      maxGasPriceWei,
      nativeAsset,
      explorerUrl,
      tokens,
      ...(relayerPrivateKey ? { relayerPrivateKey } : {}),
    });
    chainIds.add(chainId);
  }
  return result;
}

export function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (isObject(value))
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
      .join(",")}}`;
  return JSON.stringify(value);
}

export function eligibleForSweep(
  isToken: boolean,
  status: PaymentStatus,
  confirmed: bigint,
  expected: bigint,
  expiredWithGrace: boolean,
  minTokenBps: number,
): boolean {
  if (confirmed <= 0n) return false;
  if (status === "paid") return true;
  if (!expiredWithGrace) return false;
  if (!isToken) return true;
  return confirmed >= (expected * BigInt(minTokenBps) + 9_999n) / 10_000n;
}

export function intSetting(raw: string, name: string, minimum: number, maximum: number): number {
  const value = Number(raw);
  if (!Number.isInteger(value) || value < minimum || value > maximum)
    throw new Error(`${name} is invalid`);
  return value;
}

function checkedAddress(value: string, label: string): Address {
  if (!isAddress(value) || getAddress(value) === zeroAddress) throw new Error(`invalid ${label}`);
  return getAddress(value);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringField(value: Record<string, unknown>, key: string): string {
  if (typeof value[key] !== "string" || value[key] === "") throw new Error(`${key} is required`);
  return value[key];
}

function optionalString(value: Record<string, unknown>, key: string): string {
  if (value[key] === undefined) return "";
  if (typeof value[key] !== "string") throw new Error(`${key} must be a string`);
  return value[key];
}

function integerField(
  value: Record<string, unknown>,
  key: string,
  minimum: number,
  maximum: number,
): number {
  const number = value[key];
  if (!Number.isSafeInteger(number) || (number as number) < minimum || (number as number) > maximum)
    throw new Error(`${key} is invalid`);
  return number as number;
}

function positiveBigIntField(value: Record<string, unknown>, key: string): bigint {
  const raw = value[key];
  if (typeof raw !== "string" || !/^\d+$/.test(raw))
    throw new Error(`${key} must be a positive integer string`);
  const number = BigInt(raw);
  if (number <= 0n || number > UINT256_MAX)
    throw new Error(`${key} must be a positive integer string`);
  return number;
}
