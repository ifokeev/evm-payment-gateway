ALTER TABLE deposit_intents DROP COLUMN kind;

CREATE INDEX withdrawal_signer_inbox_idx
  ON withdrawal_intents(status, created_at, id);
