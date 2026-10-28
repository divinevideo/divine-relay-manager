-- Bind every recorded consent round to the exact authenticated multipart body.
ALTER TABLE age_review_parent_consent_submissions ADD COLUMN payload_hash TEXT;

-- Durable object inventory for retries of failed replacement/loser cleanup.
CREATE TABLE IF NOT EXISTS age_review_consent_objects (
    object_key TEXT PRIMARY KEY,
    case_id TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'deleting'))
  );
CREATE INDEX IF NOT EXISTS idx_parent_consent_object
  ON age_review_parent_consent_submissions (object_key);
CREATE INDEX IF NOT EXISTS idx_consent_objects_created
  ON age_review_consent_objects (created_at);
