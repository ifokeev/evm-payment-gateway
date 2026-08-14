import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";

const apiSecrets = process.argv[2] ?? ".api.secrets";
const sweeperSecrets = process.argv[3] ?? ".sweeper.secrets";
for (const file of [apiSecrets, sweeperSecrets]) {
  if (!existsSync(file)) {
    console.error(`Missing ${file}; copy and edit the matching .example file.`);
    process.exit(1);
  }
}

run("wrangler", ["deploy", "--config", "wrangler.api.jsonc", "--secrets-file", apiSecrets]);
run("wrangler", ["d1", "migrations", "apply", "evm-payment-gateway", "--remote", "--config", "wrangler.api.jsonc"]);
run("wrangler", ["deploy", "--config", "wrangler.sweeper.jsonc", "--secrets-file", sweeperSecrets]);

function run(command, args) {
  const result = spawnSync(command, args, { stdio: "inherit", shell: process.platform === "win32" });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
