import { applyD1Migrations, type D1Migration } from "cloudflare:test";
import { env } from "cloudflare:workers";

const bindings = env as unknown as { DB: D1Database; TEST_MIGRATIONS: D1Migration[] };
await applyD1Migrations(bindings.DB, bindings.TEST_MIGRATIONS);
