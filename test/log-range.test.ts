import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { counterfactualAddress } from "../src/create2";
import { loadNetworks } from "../src/domain";
import { randomId, syncChain, unixNow } from "../src/monitor";
import type { ApiEnv, NetworkConfig } from "../src/types";

const bindings = env as unknown as ApiEnv;
const testFactory = "0x3333333333333333333333333333333333333333";
const testTreasury = "0x2222222222222222222222222222222222222222";
const testToken = "0x9999999999999999999999999999999999999999";
const rpcUrl = "https://rpc.logs";
const startBlock = 10_000;
let logFilters: Array<{ fromBlock: string; toBlock: string }> = [];
let headBlock = 0;
let transferBlock: number | undefined;
let nextSalt = 1;

beforeAll(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const outgoing = input instanceof Request ? input : new Request(input, init);
      if (outgoing.url !== `${rpcUrl}/`) throw new Error(`unmocked request: ${outgoing.url}`);
      const payload = JSON.parse(await outgoing.text());
      const requests = (Array.isArray(payload) ? payload : [payload]) as Array<{
        id: number;
        method: string;
        params: unknown[];
      }>;
      const responses = requests.map((rpc) => ({
        jsonrpc: "2.0",
        id: rpc.id,
        result: rpcResult(rpc),
      }));
      return Response.json(Array.isArray(payload) ? responses : responses[0]);
    }),
  );
});

beforeEach(() => {
  logFilters = [];
  transferBlock = undefined;
});

describe("log range", () => {
  it("defaults to 5,000 blocks and accepts 1 to 5,000", () => {
    expect(loadNetworksWith({}).maxLogRange).toBe(5_000);
    expect(loadNetworksWith({ maxLogRange: 1 }).maxLogRange).toBe(1);
    expect(loadNetworksWith({ maxLogRange: 1_000 }).maxLogRange).toBe(1_000);
    expect(loadNetworksWith({ maxLogRange: 5_000 }).maxLogRange).toBe(5_000);
  });

  it("rejects a range outside 1 to 5,000 and a value that is not an integer", () => {
    for (const invalid of [0, -1, 5_001, 1.5, "1000", null, true, Number.NaN])
      expect(() => loadNetworksWith({ maxLogRange: invalid })).toThrow("maxLogRange is invalid");
  });

  it("accepts the field on the relayer network list too", () => {
    const key = "0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
    const [network] = JSON.parse(bindings.NETWORKS_JSON);
    expect(() => loadNetworks(JSON.stringify([{ ...network, maxLogRange: 1_000 }]))).not.toThrow();
    expect(() =>
      loadNetworks(
        JSON.stringify([{ ...network, maxLogRange: 1_000, relayerPrivateKey: key }]),
        true,
      ),
    ).toThrow("relayerPrivateKey does not match relayerAddress");
  });

  it("reads a window of 1, 999, 1000, 1001 or 5000 blocks in requests of at most 1,000 blocks", async () => {
    const expected = [
      { blocks: 1, ranges: [[0, 0]] },
      { blocks: 999, ranges: [[0, 998]] },
      { blocks: 1_000, ranges: [[0, 999]] },
      {
        blocks: 1_001,
        ranges: [
          [0, 999],
          [1_000, 1_000],
        ],
      },
      {
        blocks: 5_000,
        ranges: [
          [0, 999],
          [1_000, 1_999],
          [2_000, 2_999],
          [3_000, 3_999],
          [4_000, 4_999],
        ],
      },
    ];
    for (const { blocks, ranges } of expected) {
      const chain = `range-${blocks}`;
      await insertTokenIntent(chain, 1);
      logFilters = [];
      headBlock = startBlock + blocks - 1;
      await syncChain(bindings, networkFor(chain, 1_000));
      expect(
        logFilters.map(({ fromBlock, toBlock }) => [
          Number(fromBlock) - startBlock,
          Number(toBlock) - startBlock,
        ]),
      ).toEqual(ranges);
    }
  });

  it("sends one request for a full window with the default range", async () => {
    await insertTokenIntent("range-default", 1);
    headBlock = startBlock + 5_000 - 1;
    await syncChain(bindings, networkFor("range-default"));
    expect(logFilters).toEqual([
      {
        fromBlock: `0x${startBlock.toString(16)}`,
        toBlock: `0x${(startBlock + 4_999).toString(16)}`,
      },
    ]);
  });

  it("splits every chunk of 100 deposit addresses into ranges", async () => {
    await insertTokenIntent("range-chunks", 101);
    headBlock = startBlock + 2_000 - 1;
    await syncChain(bindings, networkFor("range-chunks", 1_000));
    expect(logFilters).toHaveLength(4);
    expect(logFilters.map((filter) => Number(filter.toBlock) - startBlock)).toEqual([
      999, 1_999, 999, 1_999,
    ]);
  });

  it("finds a transfer that sits in the last request of the window", async () => {
    const intentId = await insertTokenIntent("range-last", 1);
    headBlock = startBlock + 2_499;
    transferBlock = startBlock + 2_400;
    await syncChain(bindings, networkFor("range-last", 1_000));
    expect(logFilters).toHaveLength(3);
    expect(
      await bindings.DB.prepare(
        "SELECT block_number, amount_units FROM payment_transactions WHERE payment_intent = ?",
      )
        .bind(intentId)
        .all(),
    ).toMatchObject({ results: [{ block_number: startBlock + 2_400, amount_units: "7" }] });
  });

  it("finds a transfer on the boundary block of two requests", async () => {
    const intentId = await insertTokenIntent("range-boundary", 1);
    headBlock = startBlock + 1_999;
    transferBlock = startBlock + 1_000;
    await syncChain(bindings, networkFor("range-boundary", 1_000));
    expect(logFilters).toHaveLength(2);
    expect(
      (
        await bindings.DB.prepare(
          "SELECT block_number FROM payment_transactions WHERE payment_intent = ?",
        )
          .bind(intentId)
          .all()
      ).results,
    ).toEqual([{ block_number: startBlock + 1_000 }]);
  });
});

function loadNetworksWith(fields: Record<string, unknown>): NetworkConfig {
  const [network] = JSON.parse(bindings.NETWORKS_JSON);
  return loadNetworks(JSON.stringify([{ ...network, ...fields }])).get(network.name)!;
}

function networkFor(chain: string, maxLogRange?: number): NetworkConfig {
  const network = loadNetworks(bindings.NETWORKS_JSON).get("test")!;
  return {
    ...network,
    name: chain,
    rpcUrls: [rpcUrl],
    maxLogRange: maxLogRange ?? network.maxLogRange,
  };
}

async function insertTokenIntent(chain: string, count: number): Promise<string> {
  const now = unixNow();
  const ids: string[] = [];
  const statements = Array.from({ length: count }, (_, index) => {
    const salt = `0x${(nextSalt++).toString(16).padStart(64, "0")}` as `0x${string}`;
    const fields = counterfactualAddress(testFactory, salt, testTreasury, testToken);
    const id = randomId("pi");
    ids.push(id);
    return bindings.DB.prepare(`INSERT INTO payment_intents
      (id,idempotency_key,request_hash,kind,external_id,chain,chain_id,asset,token_address,decimals,expected_amount,expected_units,
       deposit_address,intent_salt,factory_address,forwarder_init_code_hash,start_block,confirmations,status,expires_at,metadata,created_at,updated_at)
       VALUES (?,?,?,'payment',?,?,1337,'USDC',?,6,'0.000001','1',?,?,?,?,?,2,'pending',?,'{}',?,?)`).bind(
      id,
      randomId("idem"),
      "1".repeat(64),
      `${chain}-${index}`,
      chain,
      testToken,
      fields.address,
      salt,
      testFactory,
      fields.initCodeHash,
      startBlock,
      now + 3_600,
      now,
      now,
    );
  });
  await bindings.DB.batch(statements);
  return ids[0];
}

function blockHash(blockNumber: number): string {
  return `0x${blockNumber.toString(16).padStart(64, "0")}`;
}

function rpcResult(rpc: { method: string; params: unknown[] }): unknown {
  if (rpc.method === "eth_chainId") return "0x539";
  if (rpc.method === "eth_blockNumber") return `0x${headBlock.toString(16)}`;
  if (rpc.method === "eth_getLogs") {
    const filter = rpc.params[0] as { fromBlock: string; toBlock: string; topics: unknown[] };
    logFilters.push({ fromBlock: filter.fromBlock, toBlock: filter.toBlock });
    const covers =
      transferBlock !== undefined &&
      transferBlock >= Number(filter.fromBlock) &&
      transferBlock <= Number(filter.toBlock);
    return covers ? [transferLog(transferBlock!, (filter.topics[2] as string[])[0])] : [];
  }
  if (rpc.method === "eth_getBlockByNumber") {
    const blockNumber = Number(BigInt(rpc.params[0] as string));
    return {
      baseFeePerGas: "0x1",
      difficulty: "0x0",
      extraData: "0x",
      gasLimit: "0x1c9c380",
      gasUsed: "0x0",
      hash: blockHash(blockNumber),
      logsBloom: `0x${"0".repeat(512)}`,
      miner: "0x0000000000000000000000000000000000000000",
      mixHash: `0x${"0".repeat(64)}`,
      nonce: "0x0000000000000000",
      number: rpc.params[0],
      parentHash: blockHash(Math.max(0, blockNumber - 1)),
      receiptsRoot: `0x${"1".repeat(64)}`,
      sha3Uncles: `0x${"2".repeat(64)}`,
      size: "0x1",
      stateRoot: `0x${"3".repeat(64)}`,
      timestamp: "0x1",
      totalDifficulty: "0x0",
      transactions: [],
      transactionsRoot: `0x${"4".repeat(64)}`,
      uncles: [],
    };
  }
  throw new Error(`unexpected RPC method: ${rpc.method}`);
}

function transferLog(blockNumber: number, toTopic: string) {
  return {
    address: testToken,
    blockHash: blockHash(blockNumber),
    blockNumber: `0x${blockNumber.toString(16)}`,
    data: `0x${(7).toString(16).padStart(64, "0")}`,
    logIndex: "0x0",
    removed: false,
    topics: [
      "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef",
      `0x${"0".repeat(24)}${"5".repeat(40)}`,
      toTopic,
    ],
    transactionHash: `0x${"a".repeat(64)}`,
    transactionIndex: "0x0",
  };
}
