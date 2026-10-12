-- Greenlight in-app consent: the clip moves from a Zendesk attachment to a
-- private R2 object. The receipt is the opaque capability in the reviewer
-- link on the ticket; the object key carries no pubkey, email, or case ID.
ALTER TABLE age_review_parent_consent_submissions ADD COLUMN receipt_id TEXT;
ALTER TABLE age_review_parent_consent_submissions ADD COLUMN object_key TEXT;
ALTER TABLE age_review_parent_consent_submissions ADD COLUMN content_type TEXT;
ALTER TABLE age_review_parent_consent_submissions ADD COLUMN size_bytes INTEGER;
ALTER TABLE age_review_parent_consent_submissions ADD COLUMN disposed_at INTEGER;
CREATE INDEX IF NOT EXISTS idx_parent_consent_receipt
  ON age_review_parent_consent_submissions (receipt_id);

-- Allow legal holds scoped to the consent-video disposal stage. SQLite
-- cannot widen a CHECK in place, so the table is rebuilt with its rows kept.
CREATE TABLE retention_legal_holds_new (
  id TEXT PRIMARY KEY,
  record_type TEXT NOT NULL CHECK (record_type IN ('protected_subject', 'account_binding', 'provisioning_operation', 'projection_job', 'age_review_case')),
  record_key TEXT,
  disposal_stage TEXT NOT NULL DEFAULT 'all' CHECK (disposal_stage IN ('all', 'claim_link', 'redaction', 'compaction', 'deletion', 'consent_video')),
  authorized_role TEXT NOT NULL,
  starts_at TEXT NOT NULL,
  review_at TEXT NOT NULL,
  expires_at TEXT,
  released_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
INSERT INTO retention_legal_holds_new
  (id, record_type, record_key, disposal_stage, authorized_role, starts_at, review_at, expires_at, released_at, created_at)
  SELECT id, record_type, record_key, disposal_stage, authorized_role, starts_at, review_at, expires_at, released_at, created_at
  FROM retention_legal_holds;
DROP TABLE retention_legal_holds;
ALTER TABLE retention_legal_holds_new RENAME TO retention_legal_holds;
CREATE INDEX IF NOT EXISTS idx_retention_holds_active
  ON retention_legal_holds(record_type, record_key, disposal_stage, starts_at, released_at, expires_at);
