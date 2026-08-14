import { HDKey } from "@scure/bip32";
import {
  TransactionNotFoundError,
  TransactionReceiptNotFoundError,
  createPublicClient,
  encodeFunctionData,
  erc20Abi,
  getAddress,
  http,
  isAddressEqual,
  parseAbi,
  type Address,
  type Hex,
  type LocalAccount,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { errorText } from "./monitor";
import { intSetting, loadNetworks, remainingGasFunding } from "./domain";
import type { NetworkConfig, SweepJob, SweepMessage, SweepOutcome, SweepTransaction, SweeperEnv } from "./types";

const baseGasOracle = "0x420000000000000000000000000000000000000F";
const baseGasOracleAbi = parseAbi(["function getL1FeeUpperBound(uint256 unsignedTxSize) view returns (uint256)"]);
const MAX_NATIVE_SWEEP_GAS = 1_000_000n;

export default {
  async queue(batch: MessageBatch<SweepMessage>, env: SweeperEnv): Promise<void> {
    // ponytail: one queue consumer serializes gas-wallet nonces; split by chain only when throughput proves it necessary.
    for (const message of batch.messages) {
      try {
        await processMessage(message.body.jobId, env);
        message.ack();
      } catch (error) {
        console.error("sweep message failed", message.body.jobId, error);
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
    outcome = await processSweep(job, owner, env);
  } catch (error) {
    outcome = { status: "queued", remainingUnits: "0", delaySeconds: retrySeconds(env), error: errorText(error) };
  }
  const released = await env.GATEWAY.releaseSweep(job.id, owner, outcome);
  if (outcome.status === "queued") {
    await env.SWEEP_QUEUE.send({ jobId: job.id }, { delaySeconds: released.delaySeconds });
  }
}

async function processSweep(job: SweepJob, owner: string, env: SweeperEnv): Promise<SweepOutcome> {
  const networks = loadNetworks(env.SWEEPER_NETWORKS_JSON, true);
  const network = networks.get(job.chain);
  if (!network) throw new Error(`network ${job.chain} is not configured in the sweeper`);
  validateJobNetwork(job, network);
  const client = createPublicClient({ transport: http(network.rpcUrl, { timeout: 30_000 }) });
  if (await client.getChainId() !== network.chainId) throw new Error("sweeper RPC chain ID mismatch");

  let confirmedSweep = false;
  for (const transaction of job.transactions) {
    if (transaction.kind === "sweep" && transaction.status === "confirmed") confirmedSweep = true;
    if (transaction.status !== "prepared" && transaction.status !== "submitted") continue;
    const result = await reconcile(job, transaction, owner, env, client);
    if (result.confirmed && transaction.kind === "sweep") confirmedSweep = true;
    if (result.waiting) return queued(retrySeconds(env));
  }

  const account = deriveDepositAccount(env.DEPOSIT_XPRV, job.derivationIndex, job.depositAddress);
  return job.tokenAddress
    ? processToken(job, owner, env, network, client, account, confirmedSweep)
    : processNative(job, owner, env, network, client, account, confirmedSweep);
}

async function processNative(
  job: SweepJob,
  owner: string,
  env: SweeperEnv,
  network: NetworkConfig,
  client: ReturnType<typeof createPublicClient>,
  account: LocalAccount,
  confirmedSweep: boolean,
): Promise<SweepOutcome> {
  const balance = await client.getBalance({ address: account.address });
  if (balance === 0n) return confirmedSweep ? complete("0") : external("0");
  const gasPrice = await client.getGasPrice();
  const nonce = await client.getTransactionCount({ address: account.address, blockTag: "pending" });
  const estimated = await client.estimateGas({ account: account.address, to: network.treasuryAddress, value: 1n });
  const gas = buffered(estimated, bufferBps(env));
  if (gas < 21_000n || gas > MAX_NATIVE_SWEEP_GAS) throw new Error(`native treasury gas estimate ${gas} is outside the allowed range`);
  const executionFee = gas * gasPrice;
  let l1Fee = 0n;
  let raw: Hex = "0x";
  for (let attempt = 0; attempt < 2; attempt++) {
    if (balance <= executionFee + l1Fee) return confirmedSweep ? complete(balance.toString()) : queued(retrySeconds(env), balance.toString());
    raw = await signLegacy(account, network.chainId, nonce, network.treasuryAddress, balance - executionFee - l1Fee, gas, gasPrice);
    l1Fee = await l1FeeUpperBound(client, network.chainId, raw);
  }
  if (balance <= executionFee + l1Fee) return confirmedSweep ? complete(balance.toString()) : queued(retrySeconds(env), balance.toString());
  raw = await signLegacy(account, network.chainId, nonce, network.treasuryAddress, balance - executionFee - l1Fee, gas, gasPrice);
  await prepareAndBroadcast(job.id, owner, "sweep", raw, env, client);
  return queued(retrySeconds(env), balance.toString());
}

async function processToken(
  job: SweepJob,
  owner: string,
  env: SweeperEnv,
  network: NetworkConfig,
  client: ReturnType<typeof createPublicClient>,
  account: LocalAccount,
  confirmedSweep: boolean,
): Promise<SweepOutcome> {
  const token = getAddress(job.tokenAddress);
  const balance = await client.readContract({ abi: erc20Abi, address: token, functionName: "balanceOf", args: [account.address] });
  if (balance === 0n) {
    if (!confirmedSweep) return external("0");
    const nativeBalance = await client.getBalance({ address: account.address });
    return complete(nativeBalance.toString());
  }
  const data = encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [network.treasuryAddress, balance] });
  const gas = buffered(await client.estimateGas({ account: account.address, to: token, data }), bufferBps(env));
  const gasPrice = await client.getGasPrice();
  const nonce = await client.getTransactionCount({ address: account.address, blockTag: "pending" });
  const raw = await signLegacy(account, network.chainId, nonce, token, 0n, gas, gasPrice, data);
  const required = gas * gasPrice + await l1FeeUpperBound(client, network.chainId, raw);
  const nativeBalance = await client.getBalance({ address: account.address });
  if (nativeBalance < required) {
    const shortfall = required - nativeBalance;
    const history = job.transactions
      .filter((transaction) => transaction.kind === "gas" && transaction.status !== "failed")
      .map((transaction) => transaction.amountUnits);
    const remaining = remainingGasFunding(maxGasFunding(env), history);
    if (shortfall <= 0n || shortfall > remaining) throw new Error(`required gas funding ${shortfall} exceeds remaining sweep allowance ${remaining}`);
    await fundGas(job, owner, env, network, client, account.address, shortfall);
    return queued(retrySeconds(env), balance.toString());
  }
  await prepareAndBroadcast(job.id, owner, "sweep", raw, env, client);
  return queued(retrySeconds(env), balance.toString());
}

async function fundGas(
  job: SweepJob,
  owner: string,
  env: SweeperEnv,
  network: NetworkConfig,
  client: ReturnType<typeof createPublicClient>,
  deposit: Address,
  amount: bigint,
): Promise<void> {
  if (!network.gasPrivateKey) throw new Error(`gas wallet is not configured for ${network.name}`);
  const account = privateKeyToAccount(network.gasPrivateKey);
  const [nonce, gasPrice] = await Promise.all([
    client.getTransactionCount({ address: account.address, blockTag: "pending" }),
    client.getGasPrice(),
  ]);
  const raw = await signLegacy(account, network.chainId, nonce, deposit, amount, 21_000n, gasPrice);
  const required = amount + 21_000n * gasPrice + await l1FeeUpperBound(client, network.chainId, raw);
  if (await client.getBalance({ address: account.address }) < required) throw new Error(`gas wallet ${account.address} has insufficient balance`);
  await prepareAndBroadcast(job.id, owner, "gas", raw, env, client);
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
      await env.GATEWAY.reportSweepTransaction(transaction.id, owner, "failed", Number(receipt.blockNumber), "transaction reverted");
      return { confirmed: false, waiting: false };
    }
    const head = await client.getBlockNumber();
    const required = transaction.kind === "sweep" ? BigInt(job.confirmations) : 1n;
    const confirmations = head >= receipt.blockNumber ? head - receipt.blockNumber + 1n : 0n;
    if (confirmations < required) {
      await env.GATEWAY.reportSweepTransaction(transaction.id, owner, "submitted", Number(receipt.blockNumber), "");
      return { confirmed: false, waiting: true };
    }
    await env.GATEWAY.reportSweepTransaction(transaction.id, owner, "confirmed", Number(receipt.blockNumber), "");
    return { confirmed: true, waiting: false };
  } catch (error) {
    if (!(error instanceof TransactionReceiptNotFoundError)) throw error;
  }

  try {
    await client.getTransaction({ hash: transaction.hash });
    await env.GATEWAY.reportSweepTransaction(transaction.id, owner, "submitted", 0, "");
    return { confirmed: false, waiting: true };
  } catch (error) {
    if (!(error instanceof TransactionNotFoundError)) throw error;
  }
  try {
    await client.sendRawTransaction({ serializedTransaction: transaction.rawTransaction });
  } catch (error) {
    if (!knownTransactionError(error)) throw error;
  }
  await env.GATEWAY.reportSweepTransaction(transaction.id, owner, "submitted", 0, "");
  return { confirmed: false, waiting: true };
}

async function prepareAndBroadcast(
  jobId: string,
  owner: string,
  kind: "gas" | "sweep",
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
  await env.GATEWAY.reportSweepTransaction(record.id, owner, "submitted", 0, "");
}

async function signLegacy(
  account: LocalAccount,
  chainId: number,
  nonce: number,
  to: Address,
  value: bigint,
  gas: bigint,
  gasPrice: bigint,
  data: Hex = "0x",
): Promise<Hex> {
  return account.signTransaction({ type: "legacy", chainId, nonce, to, value, gas, gasPrice, data });
}

async function l1FeeUpperBound(client: ReturnType<typeof createPublicClient>, chainId: number, raw: Hex): Promise<bigint> {
  if (chainId !== 8453 && chainId !== 84532) return 0n;
  const size = BigInt((raw.length - 2) / 2 + 16);
  return client.readContract({ address: baseGasOracle, abi: baseGasOracleAbi, functionName: "getL1FeeUpperBound", args: [size] });
}

function deriveDepositAccount(xprv: string, index: number, expected: Address): LocalAccount {
  let root: HDKey;
  try {
    root = HDKey.fromExtendedKey(xprv);
  } catch {
    throw new Error("DEPOSIT_XPRV must be a valid extended private key");
  }
  if (!root.privateKey || !Number.isSafeInteger(index) || index < 0 || index >= 0x80000000) throw new Error("DEPOSIT_XPRV or derivation index is invalid");
  const privateKey = root.deriveChild(index).privateKey;
  if (!privateKey) throw new Error("could not derive deposit private key");
  const account = privateKeyToAccount(`0x${[...privateKey].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`);
  if (!isAddressEqual(account.address, expected)) throw new Error("derived private key does not match deposit address");
  return account;
}

function validateJobNetwork(job: SweepJob, network: NetworkConfig): void {
  if (job.chainId !== network.chainId || !isAddressEqual(job.treasuryAddress, network.treasuryAddress)
    || job.confirmations !== network.confirmations) throw new Error("gateway and sweeper network configuration differ");
  if (job.tokenAddress) {
    const token = network.tokens[job.asset];
    if (!token || !isAddressEqual(token.address, job.tokenAddress)) throw new Error("gateway and sweeper token configuration differ");
  } else if (job.asset !== network.nativeAsset) {
    throw new Error("gateway and sweeper native asset configuration differ");
  }
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

function maxGasFunding(env: SweeperEnv): bigint {
  let value: bigint;
  try {
    value = BigInt(env.SWEEPER_MAX_GAS_FUNDING_WEI);
  } catch {
    throw new Error("SWEEPER_MAX_GAS_FUNDING_WEI is invalid");
  }
  if (value <= 0n) throw new Error("SWEEPER_MAX_GAS_FUNDING_WEI is invalid");
  return value;
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
