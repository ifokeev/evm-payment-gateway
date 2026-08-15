import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
import { privateKeyToAccount } from "viem/accounts";
import { defineConfig } from "vitest/config";
import { PAYMENT_FORWARDER_FACTORY_RUNTIME_CODE_HASH as factoryCodeHash } from "./src/contracts.generated.ts";

const relayer = privateKeyToAccount(
  "0xabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcd",
);
const network = JSON.stringify([
  {
    name: "test",
    chainId: 1337,
    rpcUrls: ["https://rpc.test"],
    treasuryAddress: "0x2222222222222222222222222222222222222222",
    factoryAddress: "0x3333333333333333333333333333333333333333",
    factoryCodeHash,
    relayerAddress: relayer.address,
    confirmations: 2,
    maxGasPriceWei: "1000000000",
    nativeAsset: "ETH",
    explorerUrl: "https://explorer.test",
    tokens: { USDC: { address: "0x9999999999999999999999999999999999999999", decimals: 6 } },
  },
]);

export default defineConfig(async () => ({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.api.jsonc" },
      miniflare: {
        bindings: {
          TEST_MIGRATIONS: await readD1Migrations("./migrations"),
          PAYMENT_API_KEY: "test-api-key-at-least-24-characters",
          PAYMENT_WEBHOOK_URL: "https://webhook.test/events",
          PAYMENT_WEBHOOK_SECRET: "test-webhook-secret-at-least-24-characters",
          NETWORKS_JSON: network,
        },
      },
      additionalExports: { SweepCoordinator: "WorkerEntrypoint" },
    }),
  ],
  test: {
    setupFiles: ["./test/setup.ts"],
  },
}));
