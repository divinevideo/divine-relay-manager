CREATE TABLE IF NOT EXISTS age_review_parent_consent_submissions (
  case_id TEXT PRIMARY KEY,
  status TEXT NOT NULL DEFAULT 'processing',
  upload_token TEXT,
  ticket_id INTEGER,
  lease_until INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
