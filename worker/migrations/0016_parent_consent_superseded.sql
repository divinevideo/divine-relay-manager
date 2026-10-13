-- A consent clip from a round a moderator sent back for a new clip. The new
-- round used to delete it on the spot, before the new upload was checked and
-- without consulting legal holds. It is kept here with its receipt, so the
-- reviewer link already on the ticket still resolves, until retention
-- disposes of it under the same rules as the current clip (#302).
CREATE TABLE IF NOT EXISTS age_review_parent_consent_superseded (
  receipt_id TEXT PRIMARY KEY,
  case_id TEXT NOT NULL,
  object_key TEXT NOT NULL,
  content_type TEXT,
  size_bytes INTEGER,
  superseded_at INTEGER NOT NULL,
  disposed_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_parent_consent_superseded_case
  ON age_review_parent_consent_superseded (case_id);
