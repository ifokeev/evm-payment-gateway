import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";

const environment = process.argv[2];
if (!new Set(["testnet", "mainnet"]).has(environment)) {
  console.error("Usage: npm run deploy -- <testnet|mainnet> [api-secrets] [sweeper-secrets]");
  process.exit(1);
}

if (environment === "mainnet") {
  run("npm", ["run", "check"]);
  if (process.env.ALLOW_UNAUDITED_MAINNET !== "true") {
    console.error("Mainnet is unaudited; set ALLOW_UNAUDITED_MAINNET=true to accept the risk.");
    process.exit(1);
  }
}

const apiSecrets = process.argv[3] ?? `.api.${environment}.secrets`;
const sweeperSecrets = process.argv[4] ?? `.sweeper.${environment}.secrets`;
for (const file of [apiSecrets, sweeperSecrets]) {
  if (!existsSync(file)) {
    console.error(`Missing ${file}; copy and edit the matching .example file.`);
    process.exit(1);
  }
}

run("wrangler", [
  "deploy",
  "--env",
  environment,
  "--config",
  "wrangler.api.jsonc",
  "--secrets-file",
  apiSecrets,
]);
run("wrangler", [
  "d1",
  "migrations",
  "apply",
  "DB",
  "--remote",
  "--env",
  environment,
  "--config",
  "wrangler.api.jsonc",
]);
run("wrangler", [
  "deploy",
  "--env",
  environment,
  "--config",
  "wrangler.sweeper.jsonc",
  "--secrets-file",
  sweeperSecrets,
]);

function run(command, args) {
  const result = spawnSync(command, args, {
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
