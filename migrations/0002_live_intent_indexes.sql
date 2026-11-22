-- The scanner reads only intents that can still change (src/monitor.ts). These indexes let each of its lookups read
-- the live rows and not the whole table.
CREATE INDEX IF NOT EXISTS payment_intents_status_chain_idx ON payment_intents (status, chain);
CREATE INDEX IF NOT EXISTS payment_intents_chain_expires_idx ON payment_intents (chain, expires_at);
CREATE INDEX IF NOT EXISTS payment_intents_chain_updated_idx ON payment_intents (chain, updated_at);
CREATE INDEX IF NOT EXISTS payment_transactions_chain_block_idx ON payment_transactions (chain, block_number);
