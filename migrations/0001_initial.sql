PRAGMA foreign_keys = ON;

CREATE TABLE payment_intents (
  id TEXT PRIMARY KEY,
  idempotency_key TEXT NOT NULL UNIQUE,
  request_hash TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('payment', 'invoice')),
  external_id TEXT NOT NULL,
  chain TEXT NOT NULL,
  chain_id INTEGER NOT NULL,
  asset TEXT NOT NULL,
  token_address TEXT NOT NULL DEFAULT '',
  decimals INTEGER NOT NULL,
  expected_amount TEXT NOT NULL,
  expected_units TEXT NOT NULL,
  received_units TEXT NOT NULL DEFAULT '0',
  confirmed_units TEXT NOT NULL DEFAULT '0',
  deposit_address TEXT NOT NULL UNIQUE,
  intent_salt TEXT NOT NULL UNIQUE,
  factory_address TEXT NOT NULL,
  forwarder_init_code_hash TEXT NOT NULL,
  start_block INTEGER NOT NULL,
  confirmations INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  expires_at INTEGER NOT NULL,
  metadata TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX payment_intents_chain_idx ON payment_intents (chain, start_block);

CREATE TABLE payment_transactions (
  id TEXT PRIMARY KEY,
  payment_intent TEXT NOT NULL REFERENCES payment_intents(id) ON DELETE CASCADE,
  chain TEXT NOT NULL,
  tx_hash TEXT NOT NULL,
  event_index INTEGER NOT NULL,
  asset TEXT NOT NULL,
  from_address TEXT NOT NULL,
  to_address TEXT NOT NULL,
  amount_units TEXT NOT NULL,
  block_number INTEGER NOT NULL,
  block_hash TEXT NOT NULL,
  block_timestamp INTEGER NOT NULL,
  canonical INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  UNIQUE (chain, tx_hash, event_index)
);
CREATE INDEX payment_transactions_intent_idx ON payment_transactions (payment_intent, block_number, event_index);

CREATE TABLE chain_blocks (
  chain TEXT NOT NULL,
  block_number INTEGER NOT NULL,
  block_hash TEXT NOT NULL,
  parent_hash TEXT NOT NULL,
  block_timestamp INTEGER NOT NULL,
  PRIMARY KEY (chain, block_number)
);

CREATE TABLE chain_states (
  chain TEXT PRIMARY KEY,
  last_scanned INTEGER NOT NULL,
  lock_owner TEXT NOT NULL DEFAULT '',
  locked_until INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE webhook_events (
  event_id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  payment_intent TEXT NOT NULL REFERENCES payment_intents(id) ON DELETE CASCADE,
  body TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER NOT NULL,
  last_error TEXT NOT NULL DEFAULT '',
  delivered_at INTEGER,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX webhook_events_due_idx ON webhook_events (status, next_attempt_at);

CREATE TABLE sweep_jobs (
  id TEXT PRIMARY KEY,
  payment_intent TEXT NOT NULL UNIQUE REFERENCES payment_intents(id) ON DELETE CASCADE,
  chain TEXT NOT NULL,
  observed_units TEXT NOT NULL,
  collected_units TEXT NOT NULL DEFAULT '0',
  remaining_units TEXT NOT NULL DEFAULT '0',
  status TEXT NOT NULL DEFAULT 'queued',
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER NOT NULL,
  last_dispatched_at INTEGER NOT NULL DEFAULT 0,
  last_error TEXT NOT NULL DEFAULT '',
  lock_owner TEXT NOT NULL DEFAULT '',
  locked_until INTEGER NOT NULL DEFAULT 0,
  completed_at INTEGER,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX sweep_jobs_due_idx ON sweep_jobs (status, next_attempt_at, last_dispatched_at);

CREATE TABLE sweep_transactions (
  id TEXT PRIMARY KEY,
  sweep_job TEXT NOT NULL REFERENCES sweep_jobs(id) ON DELETE CASCADE,
  chain TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('deploy_collect', 'collect')),
  tx_hash TEXT NOT NULL,
  raw_tx TEXT NOT NULL,
  from_address TEXT NOT NULL,
  to_address TEXT NOT NULL,
  amount_units TEXT NOT NULL,
  fee_wei TEXT NOT NULL DEFAULT '0',
  nonce INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'prepared',
  block_number INTEGER,
  last_error TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  UNIQUE (chain, tx_hash)
);
CREATE INDEX sweep_transactions_job_idx ON sweep_transactions (sweep_job, created_at);
