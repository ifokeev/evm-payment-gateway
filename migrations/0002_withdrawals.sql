ALTER TABLE payment_intents RENAME TO deposit_intents;
ALTER TABLE payment_transactions RENAME TO deposit_transfers;
ALTER TABLE deposit_transfers RENAME COLUMN payment_intent TO deposit_intent;
ALTER TABLE webhook_events RENAME COLUMN payment_intent TO deposit_intent;
ALTER TABLE sweep_jobs RENAME COLUMN payment_intent TO deposit_intent;
DROP INDEX payment_intents_chain_idx;
CREATE INDEX deposit_intents_chain_idx ON deposit_intents (chain, start_block);
DROP INDEX payment_transactions_intent_idx;
CREATE INDEX deposit_transfers_intent_idx
  ON deposit_transfers (deposit_intent, block_number, event_index);
ALTER TABLE deposit_intents ADD COLUMN treasury_address TEXT NOT NULL DEFAULT '';
ALTER TABLE deposit_intents ADD COLUMN purpose TEXT NOT NULL DEFAULT 'checkout'
  CHECK (purpose IN ('checkout', 'account_top_up', 'swap'));
UPDATE deposit_intents
SET purpose = json_extract(metadata, '$.purpose')
WHERE json_extract(metadata, '$.purpose') IN ('checkout', 'account_top_up', 'swap');

CREATE TABLE withdrawal_intents (
  id TEXT PRIMARY KEY,
  idempotency_key TEXT NOT NULL UNIQUE,
  request_hash TEXT NOT NULL,
  purpose TEXT NOT NULL CHECK (purpose IN ('withdrawal', 'swap', 'refund')),
  external_id TEXT NOT NULL,
  chain TEXT NOT NULL,
  chain_id INTEGER NOT NULL,
  asset TEXT NOT NULL,
  token_address TEXT NOT NULL DEFAULT '',
  decimals INTEGER NOT NULL,
  source_address TEXT NOT NULL,
  destination_address TEXT NOT NULL,
  amount TEXT NOT NULL,
  amount_units TEXT NOT NULL,
  confirmations INTEGER NOT NULL,
  max_gas_price_wei TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'awaiting_signature'
    CHECK (status IN ('awaiting_signature', 'submitted', 'confirming', 'complete', 'failed', 'expired')),
  expires_at INTEGER NOT NULL,
  last_error TEXT NOT NULL DEFAULT '',
  completed_at INTEGER,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX withdrawal_intents_status_idx ON withdrawal_intents (status, expires_at, updated_at);

CREATE TABLE withdrawal_transactions (
  id TEXT PRIMARY KEY,
  withdrawal TEXT NOT NULL UNIQUE REFERENCES withdrawal_intents(id) ON DELETE CASCADE,
  chain TEXT NOT NULL,
  tx_hash TEXT NOT NULL,
  raw_tx TEXT NOT NULL,
  from_address TEXT NOT NULL,
  to_address TEXT NOT NULL,
  nonce INTEGER NOT NULL,
  fee_wei TEXT NOT NULL DEFAULT '0',
  status TEXT NOT NULL DEFAULT 'prepared'
    CHECK (status IN ('prepared', 'submitted', 'confirmed', 'failed')),
  block_number INTEGER,
  block_hash TEXT,
  last_error TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  UNIQUE (chain, tx_hash),
  UNIQUE (chain, from_address, nonce)
);
CREATE INDEX withdrawal_transactions_status_idx ON withdrawal_transactions (status, updated_at);
