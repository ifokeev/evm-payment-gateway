import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

const network = JSON.stringify([{
  name: "test",
  chainId: 1337,
  rpcUrl: "https://rpc.test",
  treasuryAddress: "0x2222222222222222222222222222222222222222",
  confirmations: 2,
  nativeAsset: "ETH",
  explorerUrl: "https://explorer.test",
  tokens: { USDC: { address: "0x9999999999999999999999999999999999999999", decimals: 6 } },
}]);

export default defineConfig(async () => ({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.api.jsonc" },
      miniflare: {
        bindings: {
          TEST_MIGRATIONS: await readD1Migrations("./migrations"),
          PAYMENT_API_KEY: "test-api-key-at-least-24-characters",
          DEPOSIT_XPUB: "xpub661MyMwAqRbcGGqHpjDfDPszxy4WFjzmLv1XKVDJFvhrj87fdpmTKZKPehK497rKqpB6TCtYrF41TxqatQdF6te88TEhsrpPo4Nnp4hPeBz",
          PAYMENT_WEBHOOK_URL: "https://webhook.test/events",
          PAYMENT_WEBHOOK_SECRET: "test-webhook-secret-at-least-24-characters",
          NETWORKS_JSON: network,
          SWEEPER_MAX_GAS_FUNDING_WEI: "100",
        },
      },
      additionalExports: { SweepCoordinator: "WorkerEntrypoint" },
    }),
  ],
  test: {
    setupFiles: ["./test/setup.ts"],
  },
}));
