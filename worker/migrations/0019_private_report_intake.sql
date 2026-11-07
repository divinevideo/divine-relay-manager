-- Private DM reports handed over by moderation-service (POST /api/internal/private-reports).
-- One row per reportId, its idempotency key. Production schema is also healed by ensureSchema().
CREATE TABLE IF NOT EXISTS private_report_intake (
  report_id TEXT PRIMARY KEY,
  reported_pubkey TEXT NOT NULL,
  reporter_pubkey TEXT NOT NULL,
  report_type TEXT NOT NULL,
  gift_wrap_id TEXT NOT NULL,
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
  CHECK ((outcome IS NULL) = (completed_at IS NULL))
);
