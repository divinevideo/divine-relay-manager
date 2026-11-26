-- Relay Manager's own copy of reports, plus resolution labels. Keep in sync with ensureSchema() in src/db.ts.
CREATE TABLE IF NOT EXISTS report_index (
  report_id TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  reporter_pubkey TEXT NOT NULL,          -- '' once erased
  target_type TEXT,                       -- getReportTarget(): 'event' | 'pubkey' | NULL
  target_id TEXT,
  event_json TEXT,                        -- NULL once erased
  source TEXT NOT NULL CHECK (source IN ('live','catchup','incremental','full','backfill')),
  indexed_at INTEGER NOT NULL,
  last_seen_at INTEGER,
  hidden_reason TEXT CHECK (hidden_reason IS NULL OR hidden_reason IN
    ('reporter_banned','reporter_suspended','reporter_deactivated','reporter_divine_only','unknown')),
  erased_at INTEGER,
  erased_reason TEXT CHECK (erased_reason IS NULL OR erased_reason IN
    ('deleted','vanished','unknown_expired','handled_unknown'))
);
CREATE INDEX IF NOT EXISTS idx_report_index_created ON report_index(created_at, report_id);
CREATE INDEX IF NOT EXISTS idx_report_index_target ON report_index(target_type, target_id);
CREATE INDEX IF NOT EXISTS idx_report_index_live ON report_index(created_at, report_id) WHERE erased_at IS NULL;
-- Every e and p tag value, for target lookups (relay #e/#p match ANY tag, not just the first).
CREATE TABLE IF NOT EXISTS report_index_refs (
  ref_type TEXT NOT NULL CHECK (ref_type IN ('e','p')),
  ref_value TEXT NOT NULL,                -- canonicalHex64(value) ?? value
  report_id TEXT NOT NULL,
  PRIMARY KEY (ref_type, ref_value, report_id)
);
CREATE TABLE IF NOT EXISTS report_index_meta (key TEXT PRIMARY KEY, value INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS resolution_labels (
  label_id TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  signer_pubkey TEXT NOT NULL,
  target_event TEXT,
  target_pubkey TEXT,
  status TEXT,
  event_json TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('publish','backfill','reconcile')),
  recorded_at INTEGER NOT NULL
);
