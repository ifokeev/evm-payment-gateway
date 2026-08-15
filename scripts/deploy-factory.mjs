import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createPublicClient, createWalletClient, http, keccak256 } from "viem";
import { privateKeyToAccount } from "viem/accounts";

const environment = process.argv[2];
const expectedChainId = Number(process.argv[3]);
const supported = {
  testnet: new Set([11155111, 84532, 97]),
  mainnet: new Set([1, 8453, 56]),
};
if (!supported[environment]?.has(expectedChainId)) {
  console.error("Usage: npm run deploy:factory -- <testnet|mainnet> <supported-chain-id>");
  process.exit(1);
}
if (environment === "mainnet" && process.env.ALLOW_UNAUDITED_MAINNET !== "true") {
  console.error("Mainnet is unaudited; set ALLOW_UNAUDITED_MAINNET=true to accept the risk.");
  process.exit(1);
}
const rpcUrl = process.env.FACTORY_RPC_URL;
const privateKey = process.env.FACTORY_DEPLOYER_PRIVATE_KEY;
if (!rpcUrl?.startsWith("https://") || !/^0x[0-9a-f]{64}$/i.test(privateKey ?? "")) {
  console.error("FACTORY_RPC_URL and FACTORY_DEPLOYER_PRIVATE_KEY are required.");
  process.exit(1);
}

run("forge", ["test"]);
const artifact = JSON.parse(
  readFileSync("contracts/out/PaymentForwarderFactory.sol/PaymentForwarderFactory.json", "utf8"),
);
const account = privateKeyToAccount(privateKey);
const transport = http(rpcUrl, { timeout: 30_000 });
const publicClient = createPublicClient({ transport });
const chainId = await publicClient.getChainId();
if (chainId !== expectedChainId) {
  console.error(`RPC chain ID ${chainId} does not match expected ${expectedChainId}.`);
  process.exit(1);
}
const wallet = createWalletClient({ account, transport });
const hash = await wallet.deployContract({
  abi: artifact.abi,
  bytecode: artifact.bytecode.object,
});
const receipt = await publicClient.waitForTransactionReceipt({ hash, confirmations: 2 });
if (receipt.status !== "success" || !receipt.contractAddress) {
  console.error(`Factory deployment failed: ${hash}`);
  process.exit(1);
}
const code = await publicClient.getCode({ address: receipt.contractAddress });
if (!code) throw new Error("deployed factory has no code");
const factoryCodeHash = keccak256(code);
if (factoryCodeHash !== keccak256(artifact.deployedBytecode.object))
  throw new Error("deployed factory bytecode does not match the tested artifact");
console.log(
  JSON.stringify(
    {
      chainId,
      transactionHash: hash,
      factoryAddress: receipt.contractAddress,
      factoryCodeHash,
    },
    null,
    2,
  ),
);

function run(command, args) {
  const result = spawnSync(command, args, { stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
