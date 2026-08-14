import {
  decodeFunctionData,
  erc20Abi,
  type Hex,
  keccak256,
  parseTransaction,
  recoverTransactionAddress,
  type TransactionSerialized,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { afterEach, describe, expect, it, vi } from "vitest";
import sweeper from "../src/sweeper";
import type {
  SweepCoordinatorService,
  SweeperEnv,
  SweepJob,
  SweepMessage,
  SweepOutcome,
  SweepTransaction,
} from "../src/types";

const depositAccount = privateKeyToAccount(
  "0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
);
const treasury = "0x2222222222222222222222222222222222222222";
const token = "0x9999999999999999999999999999999999999999";
const balance = 1_000_000_000_000_000_000n;
const gasPrice = 1_000_000_000n;

afterEach(() => vi.unstubAllGlobals());

describe("sweeper runtime", () => {
  it("signs and broadcasts the full native balance minus estimated gas", async () => {
    const fixture = sweepFixture(gasPrice, "2000000000");
    await sweeper.queue(fixture.batch, fixture.env);

    expect(fixture.ack).toHaveBeenCalledOnce();
    expect(fixture.retry).not.toHaveBeenCalled();
    expect(fixture.state.registered).toBeDefined();
    const transaction = parseTransaction(fixture.state.registered!);
    expect(transaction.to).toBe(treasury);
    expect(transaction.gas).toBe(25_200n);
    expect(transaction.gasPrice).toBe(gasPrice);
    expect(transaction.value).toBe(balance - 25_200n * gasPrice);
    expect(fixture.state.released).toMatchObject({ status: "queued", error: "" });
  });

  it("retries without signing when RPC gas exceeds the configured ceiling", async () => {
    const fixture = sweepFixture(gasPrice, (gasPrice - 1n).toString());
    await sweeper.queue(fixture.batch, fixture.env);

    expect(fixture.ack).toHaveBeenCalledOnce();
    expect(fixture.state.registered).toBeUndefined();
    expect(fixture.state.turnkeyRequests).toBe(0);
    expect(fixture.state.released).toMatchObject({ status: "queued" });
    expect(fixture.state.released?.error).toContain("gas price exceeds");
  });

  it("automatically funds only the token wallet's missing gas", async () => {
    const fixture = tokenSweepFixture();
    await sweeper.queue(fixture.batch, fixture.env);

    expect(fixture.ack).toHaveBeenCalledOnce();
    expect(fixture.state.kind).toBe("gas");
    expect(fixture.state.turnkeyRequests).toBe(0);
    const transaction = parseTransaction(fixture.state.registered!);
    expect(
      await recoverTransactionAddress({
        serializedTransaction: fixture.state.registered! as TransactionSerialized,
      }),
    ).toBe(fixture.gasAccount.address);
    expect(transaction.to?.toLowerCase()).toBe(depositAccount.address.toLowerCase());
    expect(transaction.value).toBe(60_000n);
    expect(transaction.gas).toBe(21_000n);
    expect(fixture.state.released).toMatchObject({ status: "queued", error: "" });
  });

  it("signs the complete token balance after gas is available", async () => {
    const fixture = tokenSweepFixture(60_000n);
    await sweeper.queue(fixture.batch, fixture.env);

    expect(fixture.state.kind).toBe("sweep");
    expect(fixture.state.turnkeyRequests).toBe(1);
    const transaction = parseTransaction(fixture.state.registered!);
    expect(
      await recoverTransactionAddress({
        serializedTransaction: fixture.state.registered! as TransactionSerialized,
      }),
    ).toBe(depositAccount.address);
    expect(transaction.to?.toLowerCase()).toBe(token.toLowerCase());
    const transfer = decodeFunctionData({ abi: erc20Abi, data: transaction.data! });
    expect(transfer.functionName).toBe("transfer");
    expect(transfer.args).toEqual([treasury, 100n]);
  });
});

function sweepFixture(
  rpcGasPrice: bigint,
  maxGasPriceWei: string,
): {
  batch: MessageBatch<SweepMessage>;
  env: SweeperEnv;
  ack: ReturnType<typeof vi.fn>;
  retry: ReturnType<typeof vi.fn>;
  state: { registered?: Hex; released?: SweepOutcome; turnkeyRequests: number };
} {
  const job: SweepJob = {
    id: "swp_native",
    chain: "test",
    chainId: 1337,
    asset: "ETH",
    tokenAddress: "",
    depositAddress: depositAccount.address,
    derivationIndex: 0,
    treasuryAddress: treasury,
    confirmations: 2,
    maxGasPriceWei,
    observedUnits: balance.toString(),
    status: "processing",
    attempts: 0,
    transactions: [],
  };
  const state: { registered?: Hex; released?: SweepOutcome; turnkeyRequests: number } = {
    turnkeyRequests: 0,
  };
  const gateway = {
    claimSweep: vi.fn(async () => job),
    registerSweepTransaction: vi.fn(
      async (
        _jobId: string,
        _owner: string,
        kind: "gas" | "sweep",
        raw: Hex,
      ): Promise<SweepTransaction> => {
        state.registered = raw;
        const transaction = parseTransaction(raw);
        return {
          id: "stx_native",
          kind,
          hash: keccak256(raw),
          rawTransaction: raw,
          from: depositAccount.address,
          to: transaction.to!,
          amountUnits: (transaction.value ?? 0n).toString(),
          nonce: transaction.nonce!,
          status: "prepared",
          createdAt: new Date(0).toISOString(),
        };
      },
    ),
    reportSweepTransaction: vi.fn(async () => undefined),
    releaseSweep: vi.fn(async (_jobId: string, _owner: string, outcome: SweepOutcome) => {
      state.released = outcome;
      return { delaySeconds: 15 };
    }),
  } as unknown as SweepCoordinatorService;
  const queue = { send: vi.fn(async () => undefined) } as unknown as Queue<SweepMessage>;
  const env: SweeperEnv = {
    GATEWAY: gateway,
    SWEEP_QUEUE: queue,
    TURNKEY_ORGANIZATION_ID: "test-org",
    TURNKEY_API_PUBLIC_KEY: "036b17d1f2e12c4247f8bce6e563a440f277037d812deb33a0f4a13945d898c296",
    TURNKEY_API_PRIVATE_KEY: "0000000000000000000000000000000000000000000000000000000000000001",
    SWEEPER_NETWORKS_JSON: JSON.stringify([
      {
        name: "test",
        chainId: 1337,
        rpcUrl: "https://rpc.sweeper",
        treasuryAddress: treasury,
        confirmations: 2,
        maxGasPriceWei,
        nativeAsset: "ETH",
        tokens: {},
      },
    ]),
    SWEEPER_GAS_BUFFER_BPS: "12000",
    SWEEPER_MAX_GAS_FUNDING_WEI: "10000000000000000",
    SWEEPER_RETRY_SECONDS: "15",
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(input, init);
      const body = JSON.parse(await request.text()) as {
        id?: number;
        method?: string;
        params?: unknown[];
        parameters?: Record<string, unknown>;
      };
      if (request.url === "https://rpc.sweeper/") {
        const results: Record<string, string> = {
          eth_chainId: "0x539",
          eth_getBalance: `0x${balance.toString(16)}`,
          eth_gasPrice: `0x${rpcGasPrice.toString(16)}`,
          eth_getTransactionCount: "0x0",
          eth_estimateGas: "0x5208",
        };
        if (body.method === "eth_sendRawTransaction")
          results.eth_sendRawTransaction = keccak256(body.params![0] as Hex);
        return Response.json({ jsonrpc: "2.0", id: body.id, result: results[body.method!] });
      }
      if (request.url === "https://api.turnkey.com/public/v1/submit/sign_transaction") {
        state.turnkeyRequests++;
        const parameters = body.parameters as {
          unsignedTransaction: string;
          signWith: string;
          type: string;
        };
        const unsigned = parseTransaction(`0x${parameters.unsignedTransaction}`);
        const signed = await depositAccount.signTransaction({
          type: "legacy",
          chainId: unsigned.chainId!,
          nonce: unsigned.nonce!,
          to: unsigned.to!,
          value: unsigned.value!,
          gas: unsigned.gas!,
          gasPrice: unsigned.gasPrice!,
          data: unsigned.data,
        });
        return Response.json({
          activity: {
            organizationId: "test-org",
            type: "ACTIVITY_TYPE_SIGN_TRANSACTION_V2",
            status: "ACTIVITY_STATUS_COMPLETED",
            intent: { signTransactionIntentV2: parameters },
            result: { signTransactionResult: { signedTransaction: signed.slice(2) } },
          },
        });
      }
      throw new Error(`unmocked request: ${request.url}`);
    }),
  );
  const ack = vi.fn();
  const retry = vi.fn();
  const batch = {
    messages: [{ body: { jobId: job.id }, ack, retry }],
  } as unknown as MessageBatch<SweepMessage>;
  return { batch, env, ack, retry, state };
}

function tokenSweepFixture(depositGas = 0n): {
  batch: MessageBatch<SweepMessage>;
  env: SweeperEnv;
  ack: ReturnType<typeof vi.fn>;
  gasAccount: ReturnType<typeof privateKeyToAccount>;
  state: {
    registered?: Hex;
    kind?: "gas" | "sweep";
    released?: SweepOutcome;
    turnkeyRequests: number;
  };
} {
  const gasPrivateKey = "0xabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcd";
  const gasAccount = privateKeyToAccount(gasPrivateKey);
  const job: SweepJob = {
    id: "swp_token",
    chain: "test-token",
    chainId: 1338,
    asset: "USDC",
    tokenAddress: token,
    depositAddress: depositAccount.address,
    derivationIndex: 1,
    treasuryAddress: treasury,
    confirmations: 2,
    maxGasPriceWei: "1000000000",
    observedUnits: "100",
    status: "processing",
    attempts: 0,
    transactions: [],
  };
  const state: {
    registered?: Hex;
    kind?: "gas" | "sweep";
    released?: SweepOutcome;
    turnkeyRequests: number;
  } = { turnkeyRequests: 0 };
  const gateway = {
    claimSweep: vi.fn(async () => job),
    registerSweepTransaction: vi.fn(
      async (
        _jobId: string,
        _owner: string,
        kind: "gas" | "sweep",
        raw: Hex,
      ): Promise<SweepTransaction> => {
        state.registered = raw;
        state.kind = kind;
        const transaction = parseTransaction(raw);
        return {
          id: "stx_gas",
          kind,
          hash: keccak256(raw),
          rawTransaction: raw,
          from: gasAccount.address,
          to: transaction.to!,
          amountUnits: (transaction.value ?? 0n).toString(),
          nonce: transaction.nonce!,
          status: "prepared",
          createdAt: new Date(0).toISOString(),
        };
      },
    ),
    reportSweepTransaction: vi.fn(async () => undefined),
    releaseSweep: vi.fn(async (_jobId: string, _owner: string, outcome: SweepOutcome) => {
      state.released = outcome;
      return { delaySeconds: 15 };
    }),
  } as unknown as SweepCoordinatorService;
  const env: SweeperEnv = {
    GATEWAY: gateway,
    SWEEP_QUEUE: { send: vi.fn(async () => undefined) } as unknown as Queue<SweepMessage>,
    TURNKEY_ORGANIZATION_ID: "test-org",
    TURNKEY_API_PUBLIC_KEY: "036b17d1f2e12c4247f8bce6e563a440f277037d812deb33a0f4a13945d898c296",
    TURNKEY_API_PRIVATE_KEY: "0000000000000000000000000000000000000000000000000000000000000001",
    SWEEPER_NETWORKS_JSON: JSON.stringify([
      {
        name: "test-token",
        chainId: 1338,
        rpcUrl: "https://rpc.token-sweeper",
        treasuryAddress: treasury,
        confirmations: 2,
        maxGasPriceWei: "1000000000",
        nativeAsset: "ETH",
        tokens: { USDC: { address: token, decimals: 6 } },
        gasPrivateKey,
      },
    ]),
    SWEEPER_GAS_BUFFER_BPS: "12000",
    SWEEPER_MAX_GAS_FUNDING_WEI: "1000000",
    SWEEPER_RETRY_SECONDS: "15",
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(input, init);
      const body = JSON.parse(await request.text()) as {
        id: number;
        method: string;
        params: unknown[];
        parameters?: { unsignedTransaction: string; signWith: string; type: string };
      };
      if (request.url.includes("api.turnkey.com")) {
        state.turnkeyRequests++;
        if (!depositGas) throw new Error("Turnkey must not sign before gas funding confirms");
        const parameters = body.parameters!;
        const unsigned = parseTransaction(`0x${parameters.unsignedTransaction}`);
        const signed = await depositAccount.signTransaction({
          type: "legacy",
          chainId: unsigned.chainId!,
          nonce: unsigned.nonce!,
          to: unsigned.to!,
          value: unsigned.value!,
          gas: unsigned.gas!,
          gasPrice: unsigned.gasPrice!,
          data: unsigned.data,
        });
        return Response.json({
          activity: {
            organizationId: "test-org",
            type: "ACTIVITY_TYPE_SIGN_TRANSACTION_V2",
            status: "ACTIVITY_STATUS_COMPLETED",
            intent: { signTransactionIntentV2: parameters },
            result: { signTransactionResult: { signedTransaction: signed.slice(2) } },
          },
        });
      }
      if (request.url !== "https://rpc.token-sweeper/")
        throw new Error(`unmocked request: ${request.url}`);
      let result = "0x0";
      if (body.method === "eth_chainId") result = "0x53a";
      else if (body.method === "eth_call") result = `0x${100n.toString(16).padStart(64, "0")}`;
      else if (body.method === "eth_estimateGas") result = "0xc350";
      else if (body.method === "eth_gasPrice") result = "0x1";
      else if (body.method === "eth_getTransactionCount") result = "0x0";
      else if (body.method === "eth_getBalance") {
        result =
          (body.params[0] as string).toLowerCase() === gasAccount.address.toLowerCase()
            ? `0x${balance.toString(16)}`
            : `0x${depositGas.toString(16)}`;
      } else if (body.method === "eth_sendRawTransaction")
        result = keccak256(body.params[0] as Hex);
      return Response.json({ jsonrpc: "2.0", id: body.id, result });
    }),
  );
  const ack = vi.fn();
  const batch = {
    messages: [{ body: { jobId: job.id }, ack, retry: vi.fn() }],
  } as unknown as MessageBatch<SweepMessage>;
  return { batch, env, ack, gasAccount, state };
}
