-- Timed (auto-expiring) suspensions: one row per account, holding the end time and the
-- lift state machine. Keep in sync with ensureSchema() in src/db.ts.
CREATE TABLE IF NOT EXISTS timed_suspensions (
  pubkey TEXT PRIMARY KEY,
  ends_at TEXT,                       -- ISO-8601 UTC, NULL means no end date
  status TEXT NOT NULL CHECK (status IN ('active','lifting','keycast_pending','lifted','already_lifted','cancelled_unsuspend','cancelled_ban')),
  set_by TEXT, set_at TEXT NOT NULL,
  changed_by TEXT, changed_at TEXT,
  version INTEGER NOT NULL DEFAULT 0,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT, last_attempt_at TEXT, last_alerted_at TEXT, claimed_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_timed_suspensions_due ON timed_suspensions(status, ends_at);
