import { serializeTransaction } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { allocateTurnkeyAddress, signTurnkeyTransaction } from "../src/turnkey";
import type { TurnkeyAddressEnv } from "../src/types";

const turnkeyEnv: TurnkeyAddressEnv = {
  TURNKEY_ORGANIZATION_ID: "test-org",
  TURNKEY_WALLET_ID: "test-wallet",
  TURNKEY_API_PUBLIC_KEY: "036b17d1f2e12c4247f8bce6e563a440f277037d812deb33a0f4a13945d898c296",
  TURNKEY_API_PRIVATE_KEY: "0000000000000000000000000000000000000000000000000000000000000001",
};

afterEach(() => vi.unstubAllGlobals());

describe("Turnkey custody", () => {
  it("allocates the exact persisted BIP-32 account with a stamped request", async () => {
    let request: Request | undefined;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      request = input instanceof Request ? input : new Request(input, init);
      const body = JSON.parse(await request.clone().text());
      return activityResponse("ACTIVITY_TYPE_CREATE_WALLET_ACCOUNTS", {
        createWalletAccountsResult: { addresses: ["0x1111111111111111111111111111111111111111"] },
      }, body.parameters);
    }));
    expect(await allocateTurnkeyAddress(turnkeyEnv, 42)).toBe("0x1111111111111111111111111111111111111111");
    expect(request?.url).toBe("https://api.turnkey.com/public/v1/submit/create_wallet_accounts");
    expect(request?.headers.get("X-Stamp")).toBeTruthy();
    const body = JSON.parse(await request!.clone().text());
    expect(body.parameters).toEqual({
      walletId: "test-wallet",
      accounts: [{
        curve: "CURVE_SECP256K1",
        pathFormat: "PATH_FORMAT_BIP32",
        path: "m/44'/60'/0'/0/42",
        addressFormat: "ADDRESS_FORMAT_ETHEREUM",
      }],
      persist: true,
    });
  });

  it("sends an unsigned Ethereum transaction and normalizes the signed result", async () => {
    const account = privateKeyToAccount("0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef");
    const transaction = {
      type: "legacy" as const,
      chainId: 84532,
      nonce: 3,
      to: "0x2222222222222222222222222222222222222222" as const,
      value: 10n,
      gas: 21_000n,
      gasPrice: 1n,
    };
    const unsigned = serializeTransaction(transaction);
    const signed = await account.signTransaction(transaction);
    let requestBody: Record<string, unknown> | undefined;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(input, init);
      const body = JSON.parse(await request.text()) as Record<string, unknown>;
      requestBody = body;
      return activityResponse("ACTIVITY_TYPE_SIGN_TRANSACTION_V2", {
        signTransactionResult: { signedTransaction: signed.slice(2) },
      }, body.parameters as Record<string, unknown>);
    }));
    expect(await signTurnkeyTransaction(turnkeyEnv, account.address, unsigned)).toBe(signed);
    expect((requestBody!.parameters as Record<string, unknown>).unsignedTransaction).toBe(unsigned.slice(2));
    expect((requestBody!.parameters as Record<string, unknown>).signWith).toBe(account.address);
  });

  it("rejects incomplete, mismatched, and malformed signer responses", async () => {
    const unsigned = serializeTransaction({
      type: "legacy", chainId: 1, nonce: 0, to: "0x2222222222222222222222222222222222222222",
      value: 1n, gas: 21_000n, gasPrice: 1n,
    });
    const address = "0x1111111111111111111111111111111111111111";
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({
      activity: {
        organizationId: "test-org",
        type: "ACTIVITY_TYPE_SIGN_TRANSACTION_V2",
        status: "ACTIVITY_STATUS_CONSENSUS_NEEDED",
      },
    })));
    await expect(signTurnkeyTransaction(turnkeyEnv, address, unsigned)).rejects.toThrow("did not complete");

    vi.stubGlobal("fetch", vi.fn(async () => Response.json({
      activity: {
        organizationId: "another-org",
        type: "ACTIVITY_TYPE_SIGN_TRANSACTION_V2",
        status: "ACTIVITY_STATUS_COMPLETED",
        result: { signTransactionResult: { signedTransaction: "00" } },
      },
    })));
    await expect(signTurnkeyTransaction(turnkeyEnv, address, unsigned)).rejects.toThrow("identity mismatch");

    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(input, init);
      const body = JSON.parse(await request.text());
      return activityResponse("ACTIVITY_TYPE_SIGN_TRANSACTION_V2", {
        signTransactionResult: { signedTransaction: "not-hex" },
      }, body.parameters);
    }));
    await expect(signTurnkeyTransaction(turnkeyEnv, address, unsigned)).rejects.toThrow("invalid signed transaction");

    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(input, init);
      const body = JSON.parse(await request.text());
      return activityResponse("ACTIVITY_TYPE_SIGN_TRANSACTION_V2", {
        signTransactionResult: { signedTransaction: "00" },
      }, { ...(body.parameters as Record<string, unknown>), signWith: "0x2222222222222222222222222222222222222222" });
    }));
    await expect(signTurnkeyTransaction(turnkeyEnv, address, unsigned)).rejects.toThrow("intent mismatch");

    const redirect = vi.fn(async () => new Response(null, { status: 302, headers: { Location: "https://attacker.invalid/" } }));
    vi.stubGlobal("fetch", redirect);
    await expect(signTurnkeyTransaction(turnkeyEnv, address, unsigned)).rejects.toThrow("HTTP 302");
    expect(redirect).toHaveBeenCalledOnce();
  });

  it("validates credentials and returned addresses before accepting custody", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(allocateTurnkeyAddress({ ...turnkeyEnv, TURNKEY_API_PRIVATE_KEY: "bad" }, 0)).rejects.toThrow("PRIVATE_KEY");
    expect(fetchMock).not.toHaveBeenCalled();

    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(input, init);
      const body = JSON.parse(await request.text());
      return activityResponse("ACTIVITY_TYPE_CREATE_WALLET_ACCOUNTS", {
        createWalletAccountsResult: { addresses: ["0x0000000000000000000000000000000000000000"] },
      }, body.parameters);
    }));
    await expect(allocateTurnkeyAddress(turnkeyEnv, 0)).rejects.toThrow("invalid deposit address");
  });

  it("stops reading a response as soon as it exceeds the size limit", async () => {
    let pulls = 0;
    let cancelled = false;
    vi.stubGlobal("fetch", vi.fn(async () => new Response(new ReadableStream({
      pull(controller) {
        pulls++;
        controller.enqueue(new Uint8Array(600_000));
        if (pulls === 10) controller.close();
      },
      cancel() {
        cancelled = true;
      },
    }))));
    await expect(allocateTurnkeyAddress(turnkeyEnv, 0)).rejects.toThrow("too large");
    expect(cancelled).toBe(true);
  });
});

function activityResponse(type: string, result: Record<string, unknown>, parameters: Record<string, unknown>): Response {
  const intentKey = type === "ACTIVITY_TYPE_CREATE_WALLET_ACCOUNTS" ? "createWalletAccountsIntent" : "signTransactionIntentV2";
  return Response.json({
    activity: {
      id: "activity-1",
      organizationId: "test-org",
      type,
      status: "ACTIVITY_STATUS_COMPLETED",
      intent: { [intentKey]: parameters },
      result,
    },
  });
}
