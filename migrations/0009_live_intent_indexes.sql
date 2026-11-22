-- The scanner reads only intents that can still change (src/monitor.ts). These indexes let each of its lookups read
-- the live rows and not the whole table.
CREATE INDEX IF NOT EXISTS deposit_intents_status_chain_idx ON deposit_intents (status, chain);
CREATE INDEX IF NOT EXISTS deposit_intents_chain_expires_idx ON deposit_intents (chain, expires_at);
CREATE INDEX IF NOT EXISTS deposit_intents_chain_updated_idx ON deposit_intents (chain, updated_at);
CREATE INDEX IF NOT EXISTS deposit_transfers_chain_block_idx ON deposit_transfers (chain, block_number);
