ALTER TABLE webhook_events RENAME TO webhook_events_old;
DROP INDEX IF EXISTS webhook_events_due_idx;

CREATE TABLE webhook_events (
  event_id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  subject_type TEXT NOT NULL DEFAULT 'deposit'
    CHECK (subject_type IN ('deposit', 'withdrawal', 'refund')),
  subject_id TEXT NOT NULL DEFAULT '',
  deposit_intent TEXT REFERENCES deposit_intents(id) ON DELETE CASCADE,
  body TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER NOT NULL,
  last_error TEXT NOT NULL DEFAULT '',
  delivered_at INTEGER,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);

INSERT INTO webhook_events
  (event_id,type,subject_type,subject_id,deposit_intent,body,status,attempts,
   next_attempt_at,last_error,delivered_at,created_at,updated_at)
SELECT event_id,type,
       CASE WHEN type LIKE 'refund.%' THEN 'refund' ELSE 'deposit' END,
       CASE WHEN type LIKE 'refund.%'
         THEN COALESCE(json_extract(body, '$.data.refund.id'), deposit_intent)
         ELSE deposit_intent END,
       deposit_intent,body,status,attempts,next_attempt_at,last_error,delivered_at,
       created_at,updated_at
FROM webhook_events_old;

DROP TABLE webhook_events_old;

CREATE INDEX webhook_events_due_idx ON webhook_events (status, next_attempt_at);
CREATE INDEX webhook_events_subject_idx ON webhook_events (subject_type, subject_id);
