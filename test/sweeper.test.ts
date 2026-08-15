import {
  decodeFunctionData,
  encodeAbiParameters,
  encodeEventTopics,
  type Hex,
  keccak256,
  parseAbiItem,
  parseTransaction,
  recoverTransactionAddress,
  type TransactionSerialized,
  zeroAddress,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  PAYMENT_FORWARDER_FACTORY_RUNTIME_CODE as factoryCode,
  PAYMENT_FORWARDER_FACTORY_RUNTIME_CODE_HASH as factoryCodeHash,
} from "../src/contracts.generated";
import { collectionCall, counterfactualAddress, forwarderFactoryAbi } from "../src/create2";
import sweeper from "../src/sweeper";
import type {
  SweepCoordinatorService,
  SweeperEnv,
  SweepJob,
  SweepMessage,
  SweepOutcome,
  SweepTransaction,
} from "../src/types";

const relayerPrivateKey = "0xabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcd";
const relayer = privateKeyToAccount(relayerPrivateKey);
const treasury = "0x2222222222222222222222222222222222222222";
const factoryAddress = "0x3333333333333333333333333333333333333333";
const token = "0x9999999999999999999999999999999999999999";
const salt = `0x${"12".repeat(32)}` as Hex;
const nativeBalance = 1_000_000_000_000_000_000n;
const gasPrice = 1_000_000_000n;
const fundsCollectedEvent = parseAbiItem(
  "event FundsCollected(address indexed asset, uint256 amount)",
);

afterEach(() => vi.unstubAllGlobals());

describe("keyless collection worker", () => {
  it("signs a factory deployment call with only the low-balance relayer", async () => {
    const fixture = collectionFixture();
    await sweeper.queue(fixture.batch, fixture.env);

    expect(fixture.ack).toHaveBeenCalledOnce();
    expect(fixture.retry).not.toHaveBeenCalled();
    expect(fixture.state.kind).toBe("deploy_collect");
    const raw = fixture.state.registered!;
    const transaction = parseTransaction(raw);
    expect(
      await recoverTransactionAddress({
        serializedTransaction: raw as TransactionSerialized,
      }),
    ).toBe(relayer.address);
    expect(transaction.to).toBe(factoryAddress);
    expect(transaction.value ?? 0n).toBe(0n);
    expect(transaction.gas).toBe(240_000n);
    expect(transaction.data).toBe(collectionCall(salt, treasury, ""));
    expect(fixture.state.released).toMatchObject({
      status: "queued",
      remainingUnits: nativeBalance.toString(),
      error: "",
    });
  });

  it("collects tokens without funding the deposit address", async () => {
    const fixture = collectionFixture({ tokenAddress: token, balance: 100n });
    await sweeper.queue(fixture.batch, fixture.env);

    const raw = fixture.state.registered!;
    const transaction = parseTransaction(raw);
    const decoded = decodeFunctionData({ abi: forwarderFactoryAbi, data: transaction.data! });
    expect(decoded.functionName).toBe("deployAndCollect");
    expect(decoded.args).toEqual([salt, treasury, token]);
    expect(transaction.to).toBe(factoryAddress);
    expect(transaction.value ?? 0n).toBe(0n);
    expect(fixture.state.kind).toBe("deploy_collect");
  });

  it("uses the permissionless collect path after the forwarder exists", async () => {
    const fixture = collectionFixture({ tokenAddress: token, balance: 25n, forwarderCode: "0x01" });
    await sweeper.queue(fixture.batch, fixture.env);

    expect(fixture.state.kind).toBe("collect");
  });

  it("does not sign when gas exceeds the configured ceiling", async () => {
    const fixture = collectionFixture({ gasPrice, maxGasPriceWei: (gasPrice - 1n).toString() });
    await sweeper.queue(fixture.batch, fixture.env);

    expect(fixture.state.registered).toBeUndefined();
    expect(fixture.state.released).toMatchObject({ status: "queued" });
    expect(fixture.state.released?.error).toContain("gas price exceeds");
  });

  it("does not sign an oversized collection transaction", async () => {
    const fixture = collectionFixture({ estimatedGas: 1_000_001n });
    await sweeper.queue(fixture.batch, fixture.env);

    expect(fixture.state.registered).toBeUndefined();
    expect(fixture.state.released?.error).toContain("outside the allowed range");
  });

  it("does not sign when the relayer cannot pay the maximum fee", async () => {
    const fixture = collectionFixture({ relayerBalance: 1n });
    await sweeper.queue(fixture.batch, fixture.env);

    expect(fixture.state.registered).toBeUndefined();
    expect(fixture.state.released?.error).toContain("insufficient balance");
  });

  it("fails closed when the canonical factory code changes", async () => {
    const fixture = collectionFixture({ rpcFactoryCode: "0x6001" });
    await sweeper.queue(fixture.batch, fixture.env);

    expect(fixture.state.registered).toBeUndefined();
    expect(fixture.state.released?.error).toContain("factory code hash mismatch");
  });

  it("independently rejects a tampered counterfactual address", async () => {
    const fixture = collectionFixture({
      depositAddress: "0x4444444444444444444444444444444444444444",
    });
    await sweeper.queue(fixture.batch, fixture.env);

    expect(fixture.state.registered).toBeUndefined();
    expect(fixture.state.released?.error).toContain("network configuration differ");
  });

  it("retries a transient zero balance before deployment", async () => {
    const fixture = collectionFixture({ balance: 0n });
    await sweeper.queue(fixture.batch, fixture.env);

    expect(fixture.state.released).toMatchObject({ status: "queued", error: "" });
  });

  it("recognizes a permissionless external collection", async () => {
    const fixture = collectionFixture({ balance: 0n, forwarderCode: "0x01" });
    await sweeper.queue(fixture.batch, fixture.env);

    expect(fixture.state.released).toMatchObject({ status: "external", remainingUnits: "0" });
  });

  it("records exact collected units and gas fees from a confirmed receipt", async () => {
    const fixture = collectionFixture({ balance: 0n, confirmedAmount: 123n });
    await sweeper.queue(fixture.batch, fixture.env);

    expect(fixture.state.reports.at(-1)).toMatchObject({
      status: "confirmed",
      blockNumber: 10,
      amountUnits: "123",
      feeWei: (210_000n * gasPrice).toString(),
    });
    expect(fixture.state.released).toMatchObject({ status: "complete", remainingUnits: "0" });
  });

  it("waits for the existing collection instead of signing a duplicate", async () => {
    const fixture = collectionFixture({ balance: 0n, confirmedAmount: 123n, headBlock: 10n });
    await sweeper.queue(fixture.batch, fixture.env);

    expect(fixture.state.registered).toBeUndefined();
    expect(fixture.state.reports.at(-1)).toMatchObject({ status: "submitted", blockNumber: 10 });
    expect(fixture.state.released).toMatchObject({ status: "queued" });
  });

  it("replaces a reverted collection transaction", async () => {
    const fixture = collectionFixture({ balance: 100n, confirmedAmount: 0n, receiptStatus: "0x0" });
    await sweeper.queue(fixture.batch, fixture.env);

    expect(fixture.state.reports[0]).toMatchObject({ status: "failed", blockNumber: 10 });
    expect(fixture.state.registered).toBeDefined();
    expect(fixture.state.released).toMatchObject({ status: "queued", remainingUnits: "100" });
  });

  it("rejects a collection event for a different asset", async () => {
    const fixture = collectionFixture({
      balance: 0n,
      confirmedAmount: 123n,
      collectedAsset: token,
    });
    await sweeper.queue(fixture.batch, fixture.env);

    expect(fixture.state.released).toMatchObject({ status: "queued" });
    expect(fixture.state.released?.error).toContain("asset mismatch");
  });
});

type FixtureOptions = {
  tokenAddress?: typeof token | "";
  balance?: bigint;
  forwarderCode?: Hex;
  rpcFactoryCode?: Hex;
  gasPrice?: bigint;
  maxGasPriceWei?: string;
  depositAddress?: `0x${string}`;
  estimatedGas?: bigint;
  relayerBalance?: bigint;
  confirmedAmount?: bigint;
  collectedAsset?: `0x${string}`;
  headBlock?: bigint;
  receiptStatus?: "0x0" | "0x1";
};

function collectionFixture(options: FixtureOptions = {}): {
  batch: MessageBatch<SweepMessage>;
  env: SweeperEnv;
  ack: ReturnType<typeof vi.fn>;
  retry: ReturnType<typeof vi.fn>;
  state: {
    registered?: Hex;
    kind?: "deploy_collect" | "collect";
    released?: SweepOutcome;
    reports: Array<{
      status: string;
      blockNumber: number;
      amountUnits: string;
      feeWei: string;
    }>;
  };
} {
  const tokenAddress = options.tokenAddress ?? "";
  const calculated = counterfactualAddress(factoryAddress, salt, treasury, tokenAddress);
  const depositAddress = options.depositAddress ?? calculated.address;
  const balance = options.balance ?? nativeBalance;
  const job: SweepJob = {
    id: "swp_test",
    chain: "test",
    chainId: 1337,
    asset: tokenAddress ? "USDC" : "ETH",
    tokenAddress,
    depositAddress,
    intentSalt: salt,
    factoryAddress,
    factoryCodeHash,
    forwarderInitCodeHash: calculated.initCodeHash,
    relayerAddress: relayer.address,
    treasuryAddress: treasury,
    confirmations: 2,
    maxGasPriceWei: options.maxGasPriceWei ?? "2000000000",
    observedUnits: balance.toString(),
    status: "processing",
    attempts: 0,
    transactions:
      options.confirmedAmount === undefined
        ? []
        : [
            {
              id: "stx_existing",
              kind: "deploy_collect",
              hash: `0x${"45".repeat(32)}`,
              rawTransaction: "0x01",
              from: relayer.address,
              to: factoryAddress,
              amountUnits: "0",
              feeWei: "0",
              nonce: 0,
              status: "submitted",
              createdAt: new Date(0).toISOString(),
            },
          ],
  };
  const state: {
    registered?: Hex;
    kind?: "deploy_collect" | "collect";
    released?: SweepOutcome;
    reports: Array<{
      status: string;
      blockNumber: number;
      amountUnits: string;
      feeWei: string;
    }>;
  } = { reports: [] };
  const gateway = {
    claimSweep: vi.fn(async () => job),
    registerSweepTransaction: vi.fn(
      async (
        _jobId: string,
        _owner: string,
        kind: "deploy_collect" | "collect",
        raw: Hex,
      ): Promise<SweepTransaction> => {
        state.registered = raw;
        state.kind = kind;
        const transaction = parseTransaction(raw);
        return {
          id: "stx_test",
          kind,
          hash: keccak256(raw),
          rawTransaction: raw,
          from: relayer.address,
          to: transaction.to!,
          amountUnits: "0",
          feeWei: "0",
          nonce: transaction.nonce!,
          status: "prepared",
          createdAt: new Date(0).toISOString(),
        };
      },
    ),
    reportSweepTransaction: vi.fn(
      async (
        _id: string,
        _owner: string,
        status: string,
        blockNumber: number,
        _error: string,
        amountUnits: string,
        feeWei: string,
      ) => {
        state.reports.push({ status, blockNumber, amountUnits, feeWei });
      },
    ),
    releaseSweep: vi.fn(async (_jobId: string, _owner: string, outcome: SweepOutcome) => {
      state.released = outcome;
      return { delaySeconds: 15 };
    }),
  } as unknown as SweepCoordinatorService;
  const queue = { send: vi.fn(async () => undefined) } as unknown as Queue<SweepMessage>;
  const env: SweeperEnv = {
    GATEWAY: gateway,
    SWEEP_QUEUE: queue,
    SWEEPER_NETWORKS_JSON: JSON.stringify([
      {
        name: "test",
        chainId: 1337,
        rpcUrl: "https://rpc.sweeper",
        treasuryAddress: treasury,
        factoryAddress,
        factoryCodeHash,
        relayerAddress: relayer.address,
        relayerPrivateKey,
        confirmations: 2,
        maxGasPriceWei: options.maxGasPriceWei ?? "2000000000",
        nativeAsset: "ETH",
        tokens: tokenAddress ? { USDC: { address: token, decimals: 6 } } : {},
      },
    ]),
    SWEEPER_GAS_BUFFER_BPS: "12000",
    SWEEPER_RETRY_SECONDS: "15",
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(input, init);
      if (request.url !== "https://rpc.sweeper/")
        throw new Error(`unmocked request: ${request.url}`);
      const body = JSON.parse(await request.text()) as {
        id: number;
        method: string;
        params: unknown[];
      };
      const address = String(body.params?.[0] ?? "").toLowerCase();
      let result: unknown = "0x0";
      if (body.method === "eth_chainId") result = "0x539";
      else if (body.method === "eth_blockNumber")
        result = `0x${(options.headBlock ?? 12n).toString(16)}`;
      else if (
        body.method === "eth_getTransactionReceipt" &&
        options.confirmedAmount !== undefined
      ) {
        result = {
          blockHash: `0x${"67".repeat(32)}`,
          blockNumber: "0xa",
          contractAddress: null,
          cumulativeGasUsed: "0x33450",
          effectiveGasPrice: `0x${gasPrice.toString(16)}`,
          from: relayer.address,
          gasUsed: "0x33450",
          logs: [
            {
              address: depositAddress,
              blockHash: `0x${"67".repeat(32)}`,
              blockNumber: "0xa",
              data: encodeAbiParameters([{ type: "uint256" }], [options.confirmedAmount]),
              logIndex: "0x0",
              removed: false,
              topics: encodeEventTopics({
                abi: [fundsCollectedEvent],
                eventName: "FundsCollected",
                args: { asset: options.collectedAsset ?? zeroAddress },
              }),
              transactionHash: `0x${"45".repeat(32)}`,
              transactionIndex: "0x0",
            },
          ],
          logsBloom: `0x${"00".repeat(256)}`,
          status: options.receiptStatus ?? "0x1",
          to: factoryAddress,
          transactionHash: `0x${"45".repeat(32)}`,
          transactionIndex: "0x0",
          type: "0x0",
        };
      } else if (body.method === "eth_getCode") {
        result =
          address === factoryAddress.toLowerCase()
            ? (options.rpcFactoryCode ?? factoryCode)
            : (options.forwarderCode ?? "0x");
      } else if (body.method === "eth_getBalance") {
        result =
          address === relayer.address.toLowerCase()
            ? `0x${(options.relayerBalance ?? nativeBalance).toString(16)}`
            : `0x${balance.toString(16)}`;
      } else if (body.method === "eth_call") {
        result = `0x${balance.toString(16).padStart(64, "0")}`;
      } else if (body.method === "eth_gasPrice") {
        result = `0x${(options.gasPrice ?? gasPrice).toString(16)}`;
      } else if (body.method === "eth_getTransactionCount") result = "0x0";
      else if (body.method === "eth_estimateGas")
        result = `0x${(options.estimatedGas ?? 200_000n).toString(16)}`;
      else if (body.method === "eth_sendRawTransaction") result = keccak256(body.params[0] as Hex);
      return Response.json({ jsonrpc: "2.0", id: body.id, result });
    }),
  );
  const ack = vi.fn();
  const retry = vi.fn();
  const batch = {
    messages: [{ body: { jobId: job.id }, ack, retry }],
  } as unknown as MessageBatch<SweepMessage>;
  return { batch, env, ack, retry, state };
}
