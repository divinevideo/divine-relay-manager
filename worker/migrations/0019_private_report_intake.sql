-- Private DM reports handed over by moderation-service (POST /api/internal/private-reports).
-- One row per reporter and reportId, the idempotency key. Production schema is also healed by
-- ensureSchema(). A surrogate id, because redaction nulls reporter_pubkey.
-- Retention: an under-16 row's reporter link is cleared once its age-review case is redacted
-- or deleted (retention.ts, private-report-redaction). A Coop handoff is kept like
-- moderation_decisions. See the DDL comment in src/db.ts.
CREATE TABLE IF NOT EXISTS private_report_intake (
  id INTEGER PRIMARY KEY,
  report_id TEXT NOT NULL,
  reported_pubkey TEXT NOT NULL,
  reporter_pubkey TEXT,
  report_type TEXT NOT NULL,
  gift_wrap_id TEXT,
  has_excerpt INTEGER NOT NULL CHECK (has_excerpt IN (0, 1)),
  reported_at TEXT NOT NULL,
  outcome TEXT CHECK (outcome IN ('queued_in_coop', 'age_review_opened', 'age_review_exists')),
  case_id TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  lease_until INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  first_received_at TEXT NOT NULL,
  last_attempt_at TEXT,
  completed_at TEXT,
  redacted_at TEXT,
  CHECK ((outcome IS NULL) = (completed_at IS NULL)),
  CHECK (redacted_at IS NOT NULL OR (reporter_pubkey IS NOT NULL AND gift_wrap_id IS NOT NULL)),
  UNIQUE (reporter_pubkey, report_id)
);
CREATE INDEX IF NOT EXISTS idx_private_report_intake_unredacted_case
  ON private_report_intake (case_id) WHERE redacted_at IS NULL AND case_id IS NOT NULL;
