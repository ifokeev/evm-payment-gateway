CREATE TABLE withdrawal_nonce_reservations (
  chain TEXT NOT NULL,
  from_address TEXT NOT NULL,
  nonce INTEGER NOT NULL,
  withdrawal TEXT NOT NULL UNIQUE REFERENCES withdrawal_intents(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (chain, from_address, nonce)
);
INSERT INTO withdrawal_nonce_reservations (chain, from_address, nonce, withdrawal, created_at)
SELECT chain, from_address, nonce, withdrawal, MIN(created_at)
FROM withdrawal_transactions
GROUP BY chain, from_address, nonce, withdrawal;

DROP INDEX withdrawal_transactions_status_idx;
ALTER TABLE withdrawal_transactions RENAME TO withdrawal_transactions_old;
CREATE TABLE withdrawal_transactions (
  id TEXT PRIMARY KEY,
  withdrawal TEXT NOT NULL REFERENCES withdrawal_intents(id) ON DELETE CASCADE,
  replacement_of TEXT REFERENCES withdrawal_transactions(id),
  chain TEXT NOT NULL,
  tx_hash TEXT NOT NULL,
  raw_tx TEXT NOT NULL,
  from_address TEXT NOT NULL,
  to_address TEXT NOT NULL,
  nonce INTEGER NOT NULL,
  fee_wei TEXT NOT NULL DEFAULT '0',
  status TEXT NOT NULL DEFAULT 'prepared'
    CHECK (status IN ('prepared', 'submitted', 'confirmed', 'failed', 'replaced')),
  block_number INTEGER,
  block_hash TEXT,
  last_error TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  UNIQUE (chain, tx_hash)
);
INSERT INTO withdrawal_transactions
  (id,withdrawal,replacement_of,chain,tx_hash,raw_tx,from_address,to_address,nonce,fee_wei,status,
   block_number,block_hash,last_error,created_at,updated_at)
SELECT id,withdrawal,NULL,chain,tx_hash,raw_tx,from_address,to_address,nonce,fee_wei,status,
       block_number,block_hash,last_error,created_at,updated_at
FROM withdrawal_transactions_old;
DROP TABLE withdrawal_transactions_old;
CREATE INDEX withdrawal_transactions_status_idx
  ON withdrawal_transactions (status, updated_at);
CREATE INDEX withdrawal_transactions_withdrawal_idx
  ON withdrawal_transactions (withdrawal, created_at);

CREATE TABLE swaps (
  id TEXT PRIMARY KEY,
  idempotency_key TEXT NOT NULL UNIQUE,
  request_hash TEXT NOT NULL,
  external_id TEXT NOT NULL,
  deposit_intent TEXT NOT NULL UNIQUE REFERENCES deposit_intents(id) ON DELETE RESTRICT,
  withdrawal_intent TEXT UNIQUE REFERENCES withdrawal_intents(id) ON DELETE RESTRICT,
  refund_withdrawal TEXT UNIQUE REFERENCES withdrawal_intents(id) ON DELETE RESTRICT,
  output_chain TEXT NOT NULL,
  output_chain_id INTEGER NOT NULL,
  output_asset TEXT NOT NULL,
  output_token_address TEXT NOT NULL DEFAULT '',
  output_decimals INTEGER NOT NULL,
  output_source_address TEXT NOT NULL,
  output_confirmations INTEGER NOT NULL,
  output_max_gas_price_wei TEXT NOT NULL,
  output_amount TEXT NOT NULL,
  output_units TEXT NOT NULL,
  destination_address TEXT NOT NULL,
  refund_address TEXT NOT NULL,
  refund_source_address TEXT NOT NULL,
  refund_confirmations INTEGER NOT NULL,
  refund_max_gas_price_wei TEXT NOT NULL,
  quote_expires_at INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'awaiting_input'
    CHECK (status IN (
      'awaiting_input', 'input_confirming', 'input_confirmed', 'awaiting_signature',
      'output_submitted', 'complete', 'expired', 'refund_required', 'refund_awaiting_signature',
      'refund_submitted', 'refunded', 'reorged'
    )),
  last_error TEXT NOT NULL DEFAULT '',
  completed_at INTEGER,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX swaps_status_idx ON swaps (status, quote_expires_at, updated_at);
