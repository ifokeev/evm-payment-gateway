import {
  createPublicClient,
  decodeEventLog,
  erc20Abi,
  type Hex,
  isAddressEqual,
  keccak256,
  parseAbi,
  parseAbiItem,
  serializeTransaction,
  TransactionNotFoundError,
  TransactionReceiptNotFoundError,
  zeroAddress,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { collectionCall, counterfactualAddress } from "./create2";
import { intSetting, loadNetworks } from "./domain";
import { errorText, safeErrorText } from "./monitor";
import { rpcTransport } from "./rpc";
import type {
  NetworkConfig,
  SweeperEnv,
  SweepJob,
  SweepMessage,
  SweepOutcome,
  SweepTransaction,
} from "./types";

const baseGasOracle = "0x420000000000000000000000000000000000000F";
const baseGasOracleAbi = parseAbi([
  "function getL1FeeUpperBound(uint256 unsignedTxSize) view returns (uint256)",
]);
const fundsCollectedEvent = parseAbiItem(
  "event FundsCollected(address indexed asset, uint256 amount)",
);
const MAX_COLLECTION_GAS = 1_000_000n;

export default {
  async queue(batch: MessageBatch<SweepMessage>, env: SweeperEnv): Promise<void> {
    // ponytail: one queue consumer serializes relayer nonces; split by chain only when throughput proves it necessary.
    for (const message of batch.messages) {
      try {
        await processMessage(message.body.jobId, env);
        message.ack();
      } catch (error) {
        console.error("collection message failed", message.body.jobId, safeErrorText(error));
        message.retry({ delaySeconds: retrySeconds(env) });
      }
    }
  },
};

async function processMessage(jobId: string, env: SweeperEnv): Promise<void> {
  const owner = `cf_${crypto.randomUUID()}`;
  const job = await env.GATEWAY.claimSweep(jobId, owner);
  if (!job) return;
  let outcome: SweepOutcome;
  try {
    outcome = await processCollection(job, owner, env);
  } catch (error) {
    outcome = {
      status: "queued",
      remainingUnits: "0",
      delaySeconds: retrySeconds(env),
      error: safeErrorText(error),
    };
  }
  const released = await env.GATEWAY.releaseSweep(job.id, owner, outcome);
  if (outcome.status === "queued") {
    await env.SWEEP_QUEUE.send({ jobId: job.id }, { delaySeconds: released.delaySeconds });
  }
}

async function processCollection(
  job: SweepJob,
  owner: string,
  env: SweeperEnv,
): Promise<SweepOutcome> {
  const networks = loadNetworks(env.SWEEPER_NETWORKS_JSON, true);
  const network = networks.get(job.chain);
  if (!network) throw new Error(`network ${job.chain} is not configured in the sweeper`);
  validateJobNetwork(job, network);
  const client = createPublicClient({
    transport: rpcTransport(network.rpcUrls, { timeout: 30_000 }),
  });
  const [chainId, factoryCode] = await Promise.all([
    client.getChainId(),
    client.getCode({ address: network.factoryAddress }),
  ]);
  if (chainId !== network.chainId) throw new Error("sweeper RPC chain ID mismatch");
  if (!factoryCode || keccak256(factoryCode).toLowerCase() !== network.factoryCodeHash)
    throw new Error("factory code hash mismatch");

  let confirmedCollection = false;
  for (const transaction of job.transactions) {
    if (transaction.status === "confirmed") confirmedCollection = true;
    if (transaction.status !== "prepared" && transaction.status !== "submitted") continue;
    const result = await reconcile(job, transaction, owner, env, client);
    if (result.confirmed) confirmedCollection = true;
    if (result.waiting) return queued(retrySeconds(env));
  }

  const [balance, forwarderCode] = await Promise.all([
    collectionBalance(client, job),
    client.getCode({ address: job.depositAddress }),
  ]);
  if (balance === 0n) {
    if (confirmedCollection) return complete("0");
    if (forwarderCode) return external("0");
    return queued(retrySeconds(env));
  }

  if (!network.relayerPrivateKey) throw new Error("relayer private key is missing");
  const account = privateKeyToAccount(network.relayerPrivateKey);
  const data = collectionCall(job.intentSalt, network.treasuryAddress, job.tokenAddress);
  const [gasPrice, nonce, estimated] = await Promise.all([
    client.getGasPrice(),
    client.getTransactionCount({ address: account.address, blockTag: "pending" }),
    client.estimateGas({ account: account.address, to: network.factoryAddress, data }),
  ]);
  validateGasPrice(gasPrice, network);
  const gas = buffered(estimated, bufferBps(env));
  if (gas < 21_000n || gas > MAX_COLLECTION_GAS)
    throw new Error(`collection gas estimate ${gas} is outside the allowed range`);
  const unsigned = serializeTransaction({
    type: "legacy",
    chainId: network.chainId,
    nonce,
    to: network.factoryAddress,
    value: 0n,
    gas,
    gasPrice,
    data,
  });
  const required = gas * gasPrice + (await l1FeeUpperBound(client, network.chainId, unsigned));
  if ((await client.getBalance({ address: account.address })) < required)
    throw new Error(`relayer ${account.address} has insufficient balance`);
  const raw = await account.signTransaction({
    type: "legacy",
    chainId: network.chainId,
    nonce,
    to: network.factoryAddress,
    value: 0n,
    gas,
    gasPrice,
    data,
  });
  await prepareAndBroadcast(
    job.id,
    owner,
    forwarderCode ? "collect" : "deploy_collect",
    raw,
    env,
    client,
  );
  return queued(retrySeconds(env), balance.toString());
}

async function collectionBalance(
  client: ReturnType<typeof createPublicClient>,
  job: SweepJob,
): Promise<bigint> {
  if (!job.tokenAddress) return client.getBalance({ address: job.depositAddress });
  return client.readContract({
    abi: erc20Abi,
    address: job.tokenAddress,
    functionName: "balanceOf",
    args: [job.depositAddress],
  });
}

async function reconcile(
  job: SweepJob,
  transaction: SweepTransaction,
  owner: string,
  env: SweeperEnv,
  client: ReturnType<typeof createPublicClient>,
): Promise<{ confirmed: boolean; waiting: boolean }> {
  try {
    const receipt = await client.getTransactionReceipt({ hash: transaction.hash });
    if (receipt.status !== "success") {
      await env.GATEWAY.reportSweepTransaction(
        transaction.id,
        owner,
        "failed",
        Number(receipt.blockNumber),
        "transaction reverted",
        "0",
        (receipt.gasUsed * receipt.effectiveGasPrice).toString(),
      );
      return { confirmed: false, waiting: false };
    }
    const head = await client.getBlockNumber();
    const confirmations = head >= receipt.blockNumber ? head - receipt.blockNumber + 1n : 0n;
    if (confirmations < BigInt(job.confirmations)) {
      await env.GATEWAY.reportSweepTransaction(
        transaction.id,
        owner,
        "submitted",
        Number(receipt.blockNumber),
        "",
        "0",
        "0",
      );
      return { confirmed: false, waiting: true };
    }
    await env.GATEWAY.reportSweepTransaction(
      transaction.id,
      owner,
      "confirmed",
      Number(receipt.blockNumber),
      "",
      collectedAmount(receipt.logs, job).toString(),
      (receipt.gasUsed * receipt.effectiveGasPrice).toString(),
    );
    return { confirmed: true, waiting: false };
  } catch (error) {
    if (!(error instanceof TransactionReceiptNotFoundError)) throw error;
  }

  try {
    await client.getTransaction({ hash: transaction.hash });
    await env.GATEWAY.reportSweepTransaction(transaction.id, owner, "submitted", 0, "", "0", "0");
    return { confirmed: false, waiting: true };
  } catch (error) {
    if (!(error instanceof TransactionNotFoundError)) throw error;
  }
  try {
    await client.sendRawTransaction({ serializedTransaction: transaction.rawTransaction });
  } catch (error) {
    if (!knownTransactionError(error)) throw error;
  }
  await env.GATEWAY.reportSweepTransaction(transaction.id, owner, "submitted", 0, "", "0", "0");
  return { confirmed: false, waiting: true };
}

function collectedAmount(
  logs: readonly { address: `0x${string}`; data: Hex; topics: readonly Hex[] }[],
  job: SweepJob,
): bigint {
  let total = 0n;
  for (const log of logs) {
    if (!isAddressEqual(log.address, job.depositAddress)) continue;
    try {
      const decoded = decodeEventLog({
        abi: [fundsCollectedEvent],
        data: log.data,
        topics: log.topics as [Hex, ...Hex[]],
        strict: true,
      });
      const expectedAsset = job.tokenAddress || zeroAddress;
      if (!isAddressEqual(decoded.args.asset, expectedAsset))
        throw new Error("collection event asset mismatch");
      total += decoded.args.amount;
    } catch (error) {
      if (errorText(error).includes("asset mismatch")) throw error;
    }
  }
  return total;
}

async function prepareAndBroadcast(
  jobId: string,
  owner: string,
  kind: "deploy_collect" | "collect",
  raw: Hex,
  env: SweeperEnv,
  client: ReturnType<typeof createPublicClient>,
): Promise<void> {
  const record = await env.GATEWAY.registerSweepTransaction(jobId, owner, kind, raw);
  try {
    await client.sendRawTransaction({ serializedTransaction: raw });
  } catch (error) {
    if (!knownTransactionError(error)) throw error;
  }
  await env.GATEWAY.reportSweepTransaction(record.id, owner, "submitted", 0, "", "0", "0");
}

async function l1FeeUpperBound(
  client: ReturnType<typeof createPublicClient>,
  chainId: number,
  raw: Hex,
): Promise<bigint> {
  if (chainId !== 8453 && chainId !== 84532) return 0n;
  return client.readContract({
    address: baseGasOracle,
    abi: baseGasOracleAbi,
    functionName: "getL1FeeUpperBound",
    args: [BigInt((raw.length - 2) / 2)],
  });
}

function validateJobNetwork(job: SweepJob, network: NetworkConfig): void {
  const expected = counterfactualAddress(
    network.factoryAddress,
    job.intentSalt,
    network.treasuryAddress,
    job.tokenAddress,
  );
  if (
    job.chainId !== network.chainId ||
    !isAddressEqual(job.treasuryAddress, network.treasuryAddress) ||
    !isAddressEqual(job.factoryAddress, network.factoryAddress) ||
    job.factoryCodeHash.toLowerCase() !== network.factoryCodeHash ||
    !isAddressEqual(job.relayerAddress, network.relayerAddress) ||
    !isAddressEqual(job.depositAddress, expected.address) ||
    job.forwarderInitCodeHash.toLowerCase() !== expected.initCodeHash.toLowerCase() ||
    job.confirmations !== network.confirmations ||
    job.maxGasPriceWei !== network.maxGasPriceWei.toString()
  ) {
    throw new Error("gateway and sweeper network configuration differ");
  }
  if (job.tokenAddress) {
    const token = network.tokens[job.asset];
    if (!token || !isAddressEqual(token.address, job.tokenAddress))
      throw new Error("gateway and sweeper token configuration differ");
  } else if (job.asset !== network.nativeAsset) {
    throw new Error("gateway and sweeper native asset configuration differ");
  }
}

function validateGasPrice(gasPrice: bigint, network: NetworkConfig): void {
  if (gasPrice <= 0n || gasPrice > network.maxGasPriceWei)
    throw new Error(`gas price exceeds the configured limit for ${network.name}`);
}

function buffered(value: bigint, bps: number): bigint {
  return (value * BigInt(bps) + 9_999n) / 10_000n;
}

function bufferBps(env: SweeperEnv): number {
  return intSetting(env.SWEEPER_GAS_BUFFER_BPS, "SWEEPER_GAS_BUFFER_BPS", 10_000, 20_000);
}

function retrySeconds(env: SweeperEnv): number {
  return intSetting(env.SWEEPER_RETRY_SECONDS, "SWEEPER_RETRY_SECONDS", 1, 300);
}

function knownTransactionError(error: unknown): boolean {
  const message = errorText(error).toLowerCase();
  return message.includes("already known") || message.includes("known transaction");
}

function queued(delaySeconds: number, remainingUnits = "0"): SweepOutcome {
  return { status: "queued", remainingUnits, delaySeconds, error: "" };
}

function complete(remainingUnits: string): SweepOutcome {
  return { status: "complete", remainingUnits, delaySeconds: 0, error: "" };
}

function external(remainingUnits: string): SweepOutcome {
  return { status: "external", remainingUnits, delaySeconds: 0, error: "" };
}
