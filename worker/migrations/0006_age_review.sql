-- Age review cases: 15-day clock for under-16 account moderation
CREATE TABLE age_review_cases (
  id TEXT PRIMARY KEY,
  pubkey TEXT NOT NULL,
  reporter_pubkey TEXT,
  report_id TEXT,
  suspected_age_band TEXT NOT NULL DEFAULT 'age_13_15',
  state TEXT NOT NULL DEFAULT 'open_reported',
  allowed_resolution TEXT NOT NULL DEFAULT 'parent_video_or_email',
  parent_contact_email TEXT,
  deadline_at TEXT,
  clock_paused INTEGER DEFAULT 0,
  clock_paused_at TEXT,
  remaining_days_when_paused REAL,
  moderator_pubkey TEXT,
  resolution_note TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_age_review_pubkey ON age_review_cases(pubkey);
CREATE INDEX idx_age_review_state ON age_review_cases(state);
CREATE INDEX idx_age_review_deadline ON age_review_cases(deadline_at);
