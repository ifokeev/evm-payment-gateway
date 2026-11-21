ALTER TABLE withdrawal_intents ADD COLUMN deposit_intent TEXT
  REFERENCES deposit_intents(id) ON DELETE RESTRICT;

CREATE UNIQUE INDEX withdrawal_active_refund_idx
  ON withdrawal_intents (deposit_intent)
  WHERE purpose = 'refund' AND status IN ('awaiting_signature', 'submitted', 'confirming');

CREATE INDEX withdrawal_refund_deposit_idx
  ON withdrawal_intents (deposit_intent, created_at)
  WHERE purpose = 'refund';
