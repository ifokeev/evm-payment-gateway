DROP INDEX IF EXISTS swaps_status_idx;
DROP TABLE IF EXISTS swaps;

UPDATE deposit_intents SET purpose = 'deposit' WHERE purpose = 'swap';
UPDATE withdrawal_intents SET purpose = 'withdrawal' WHERE purpose IN ('swap', 'refund');
