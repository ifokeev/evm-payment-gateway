CREATE TABLE swap_deposit_intents (id TEXT PRIMARY KEY);
INSERT INTO swap_deposit_intents (id)
SELECT id FROM deposit_intents WHERE purpose = 'swap';

ALTER TABLE deposit_intents DROP COLUMN purpose;
ALTER TABLE deposit_intents ADD COLUMN purpose TEXT NOT NULL DEFAULT 'deposit'
  CHECK (purpose IN ('deposit', 'swap'));

UPDATE deposit_intents
SET purpose = 'swap'
WHERE id IN (SELECT id FROM swap_deposit_intents);
DROP TABLE swap_deposit_intents;
