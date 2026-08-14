import { ApiKeyStamper } from "@turnkey/api-key-stamper";
import { getAddress, isAddress, zeroAddress, type Address, type Hex } from "viem";
import type { TurnkeyAddressEnv, TurnkeyEnv } from "./types";

const TURNKEY_BASE_URL = "https://api.turnkey.com";
const TURNKEY_TIMEOUT_MS = 15_000;
const MAX_RESPONSE_BYTES = 1_000_000;
const MAX_TRANSACTION_BYTES = 131_072;

export async function allocateTurnkeyAddress(env: TurnkeyAddressEnv, index: number): Promise<Address> {
  validateConfig(env, env.TURNKEY_WALLET_ID);
  if (!Number.isSafeInteger(index) || index < 0 || index >= 0x80000000) throw new Error("deposit address space exhausted");
  const path = `m/44'/60'/0'/0/${index}`;
  const response = await turnkeyRequest(env, "/public/v1/submit/create_wallet_accounts", {
    type: "ACTIVITY_TYPE_CREATE_WALLET_ACCOUNTS",
    timestampMs: Date.now().toString(),
    organizationId: env.TURNKEY_ORGANIZATION_ID,
    parameters: {
      walletId: env.TURNKEY_WALLET_ID,
      accounts: [{
        curve: "CURVE_SECP256K1",
        pathFormat: "PATH_FORMAT_BIP32",
        path,
        addressFormat: "ADDRESS_FORMAT_ETHEREUM",
      }],
      persist: true,
    },
  });
  const activity = completedActivity(response, env.TURNKEY_ORGANIZATION_ID, "ACTIVITY_TYPE_CREATE_WALLET_ACCOUNTS");
  const intent = objectField(objectField(activity, "intent"), "createWalletAccountsIntent");
  const accounts = intent.accounts;
  if (intent.walletId !== env.TURNKEY_WALLET_ID || intent.persist !== true || !Array.isArray(accounts) || accounts.length !== 1
    || !isObject(accounts[0]) || accounts[0].curve !== "CURVE_SECP256K1" || accounts[0].pathFormat !== "PATH_FORMAT_BIP32"
    || accounts[0].path !== path || accounts[0].addressFormat !== "ADDRESS_FORMAT_ETHEREUM") {
    throw new Error("Turnkey activity intent mismatch");
  }
  const result = objectField(objectField(activity, "result"), "createWalletAccountsResult");
  const addresses = result.addresses;
  if (!Array.isArray(addresses) || addresses.length !== 1 || typeof addresses[0] !== "string"
    || !isAddress(addresses[0]) || getAddress(addresses[0]) === zeroAddress) {
    throw new Error("Turnkey returned an invalid deposit address");
  }
  return getAddress(addresses[0]);
}

export async function signTurnkeyTransaction(env: TurnkeyEnv, address: Address, unsignedTransaction: Hex): Promise<Hex> {
  validateConfig(env);
  if (!isAddress(address) || getAddress(address) === zeroAddress) throw new Error("Turnkey signing address is invalid");
  if (!validHex(unsignedTransaction, MAX_TRANSACTION_BYTES)) throw new Error("unsigned transaction is invalid");
  const response = await turnkeyRequest(env, "/public/v1/submit/sign_transaction", {
    type: "ACTIVITY_TYPE_SIGN_TRANSACTION_V2",
    timestampMs: Date.now().toString(),
    organizationId: env.TURNKEY_ORGANIZATION_ID,
    parameters: {
      signWith: getAddress(address),
      unsignedTransaction: unsignedTransaction.slice(2),
      type: "TRANSACTION_TYPE_ETHEREUM",
    },
  });
  const activity = completedActivity(response, env.TURNKEY_ORGANIZATION_ID, "ACTIVITY_TYPE_SIGN_TRANSACTION_V2");
  const intent = objectField(objectField(activity, "intent"), "signTransactionIntentV2");
  if (intent.signWith !== getAddress(address) || intent.unsignedTransaction !== unsignedTransaction.slice(2)
    || intent.type !== "TRANSACTION_TYPE_ETHEREUM") throw new Error("Turnkey activity intent mismatch");
  const signed = objectField(objectField(activity, "result"), "signTransactionResult").signedTransaction;
  if (typeof signed !== "string") throw new Error("Turnkey returned an invalid signed transaction");
  const normalized = (signed.startsWith("0x") ? signed : `0x${signed}`) as Hex;
  if (!validHex(normalized, MAX_TRANSACTION_BYTES)) throw new Error("Turnkey returned an invalid signed transaction");
  return normalized;
}

async function turnkeyRequest(env: TurnkeyEnv, path: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const serialized = JSON.stringify(body);
  const stamper = new ApiKeyStamper({
    apiPublicKey: env.TURNKEY_API_PUBLIC_KEY,
    apiPrivateKey: env.TURNKEY_API_PRIVATE_KEY,
    runtimeOverride: "purejs",
  });
  const stamp = await stamper.stamp(serialized);
  const response = await fetch(`${TURNKEY_BASE_URL}${path}`, {
    method: "POST",
    headers: {
      "Accept": "application/json",
      "Content-Type": "application/json",
      [stamp.stampHeaderName]: stamp.stampHeaderValue,
    },
    body: serialized,
    redirect: "manual",
    signal: AbortSignal.timeout(TURNKEY_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`Turnkey request failed with HTTP ${response.status}`);
  const declaredLength = Number(response.headers.get("Content-Length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) throw new Error("Turnkey response is too large");
  const text = await limitedResponseText(response);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("Turnkey returned invalid JSON");
  }
  if (!isObject(parsed)) throw new Error("Turnkey returned an invalid response");
  return parsed;
}

async function limitedResponseText(response: Response): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) return text + decoder.decode();
    bytes += value.byteLength;
    if (bytes > MAX_RESPONSE_BYTES) {
      try {
        await reader.cancel();
      } catch {
        // Ignore cancellation errors; the size violation is authoritative.
      }
      throw new Error("Turnkey response is too large");
    }
    text += decoder.decode(value, { stream: true });
  }
}

function completedActivity(response: Record<string, unknown>, organizationId: string, type: string): Record<string, unknown> {
  const activity = objectField(response, "activity");
  if (activity.organizationId !== organizationId || activity.type !== type) throw new Error("Turnkey activity identity mismatch");
  if (activity.status !== "ACTIVITY_STATUS_COMPLETED") {
    const status = typeof activity.status === "string" ? activity.status : "unknown";
    throw new Error(`Turnkey activity did not complete (${status})`);
  }
  return activity;
}

function validateConfig(env: TurnkeyEnv, walletId?: string): void {
  if (!/^[A-Za-z0-9_-]{1,200}$/.test(env.TURNKEY_ORGANIZATION_ID)) throw new Error("TURNKEY_ORGANIZATION_ID is invalid");
  if (!/^(02|03)[0-9a-fA-F]{64}$/.test(env.TURNKEY_API_PUBLIC_KEY)) throw new Error("TURNKEY_API_PUBLIC_KEY is invalid");
  if (!/^[0-9a-fA-F]{64}$/.test(env.TURNKEY_API_PRIVATE_KEY)) throw new Error("TURNKEY_API_PRIVATE_KEY is invalid");
  if (walletId !== undefined && !/^[A-Za-z0-9_-]{1,200}$/.test(walletId)) {
    throw new Error("TURNKEY_WALLET_ID is invalid");
  }
}

function objectField(value: Record<string, unknown>, key: string): Record<string, unknown> {
  const field = value[key];
  if (!isObject(field)) throw new Error("Turnkey returned an invalid response");
  return field;
}

function validHex(value: string, maximumBytes: number): boolean {
  return /^0x[0-9a-fA-F]+$/.test(value) && (value.length - 2) % 2 === 0 && (value.length - 2) / 2 <= maximumBytes;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
