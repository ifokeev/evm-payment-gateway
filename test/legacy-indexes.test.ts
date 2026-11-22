import type { D1Migration } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

const bindings = env as unknown as { DB: D1Database; TEST_MIGRATIONS: D1Migration[] };

// The intents line created these indexes before the tables were renamed. A database that ran both lines
// carries them next to the deposit-named copies from 0009_live_intent_indexes.sql.
const legacyIndexes = [
  ["payment_intents_status_chain_idx", "deposit_intents", "status, chain"],
  ["payment_intents_chain_expires_idx", "deposit_intents", "chain, expires_at"],
  ["payment_intents_chain_updated_idx", "deposit_intents", "chain, updated_at"],
  ["payment_transactions_chain_block_idx", "deposit_transfers", "chain, block_number"],
];
const depositIndexes = [
  "deposit_intents_status_chain_idx",
  "deposit_intents_chain_expires_idx",
  "deposit_intents_chain_updated_idx",
  "deposit_transfers_chain_block_idx",
];

async function indexNames(): Promise<string[]> {
  const rows = await bindings.DB.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'index' ORDER BY name",
  ).all<{ name: string }>();
  return rows.results.map((row) => row.name);
}

describe("legacy index cleanup", () => {
  it("drops the index names left by the intents line and keeps the deposit indexes", async () => {
    for (const [name, table, columns] of legacyIndexes)
      await bindings.DB.prepare(`CREATE INDEX ${name} ON ${table} (${columns})`).run();
    expect(await indexNames()).toEqual(expect.arrayContaining(legacyIndexes.map(([name]) => name)));

    const migration = bindings.TEST_MIGRATIONS.find(
      ({ name }) => name === "0010_drop_legacy_index_names.sql",
    );
    expect(migration).toBeDefined();
    await bindings.DB.batch(migration!.queries.map((query) => bindings.DB.prepare(query)));

    const remaining = await indexNames();
    for (const [name] of legacyIndexes) expect(remaining).not.toContain(name);
    expect(remaining).toEqual(expect.arrayContaining(depositIndexes));
  });
});
