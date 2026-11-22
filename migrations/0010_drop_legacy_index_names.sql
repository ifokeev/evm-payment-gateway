-- A database that ran the intents line's 0002_live_intent_indexes.sql keeps its four indexes under the names
-- they had before 0002_withdrawals.sql renamed the tables. 0009_live_intent_indexes.sql created the same
-- indexes under the deposit names, so each pair is redundant and every write maintains both copies.
-- A database created from this line never had the old names, and IF EXISTS leaves it unchanged.
DROP INDEX IF EXISTS payment_intents_status_chain_idx;
DROP INDEX IF EXISTS payment_intents_chain_expires_idx;
DROP INDEX IF EXISTS payment_intents_chain_updated_idx;
DROP INDEX IF EXISTS payment_transactions_chain_block_idx;
