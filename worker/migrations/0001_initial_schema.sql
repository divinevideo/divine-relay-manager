-- Initial schema for moderation_decisions table
-- This represents the schema as of January 2026

CREATE TABLE IF NOT EXISTS moderation_decisions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  target_type TEXT NOT NULL,
  target_id TEXT NOT NULL,
  action TEXT NOT NULL,
  reason TEXT,
  moderator_pubkey TEXT,
  report_id TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_decisions_target ON moderation_decisions(target_id);
CREATE INDEX IF NOT EXISTS idx_decisions_action ON moderation_decisions(action);

-- Zendesk ticket mapping table
CREATE TABLE IF NOT EXISTS zendesk_tickets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket_id INTEGER NOT NULL UNIQUE,
  event_id TEXT,
  author_pubkey TEXT,
  violation_type TEXT,
  status TEXT DEFAULT 'open',
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  resolved_at TEXT,
  resolution_action TEXT,
  resolution_moderator TEXT
);

CREATE INDEX IF NOT EXISTS idx_zendesk_event ON zendesk_tickets(event_id);
CREATE INDEX IF NOT EXISTS idx_zendesk_author ON zendesk_tickets(author_pubkey);
CREATE INDEX IF NOT EXISTS idx_zendesk_status ON zendesk_tickets(status);
