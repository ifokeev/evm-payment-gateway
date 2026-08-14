import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

const network = JSON.stringify([{
  name: "test",
  chainId: 1337,
  rpcUrl: "https://rpc.test",
  treasuryAddress: "0x2222222222222222222222222222222222222222",
  confirmations: 2,
  maxGasPriceWei: "1000000000",
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
          TURNKEY_ORGANIZATION_ID: "test-org",
          TURNKEY_WALLET_ID: "test-wallet",
          TURNKEY_API_PUBLIC_KEY: "036b17d1f2e12c4247f8bce6e563a440f277037d812deb33a0f4a13945d898c296",
          TURNKEY_API_PRIVATE_KEY: "0000000000000000000000000000000000000000000000000000000000000001",
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
