-- Migration: Add moderation_targets table (previously created at runtime by ensureSchema)
-- and fix idx_decisions_target to composite index matching db.ts

CREATE TABLE IF NOT EXISTS moderation_targets (
  target_id TEXT PRIMARY KEY,
  target_type TEXT NOT NULL,
  ever_human_reviewed INTEGER DEFAULT 0
);

-- Fix: migration 0001 created idx_decisions_target on (target_id) only.
-- db.ts creates it on (target_type, target_id) which is strictly more useful.
-- Drop the old single-column index and recreate as composite.
DROP INDEX IF EXISTS idx_decisions_target;
CREATE INDEX IF NOT EXISTS idx_decisions_target ON moderation_decisions(target_type, target_id);

-- Also add report_id index if missing (db.ts creates this)
CREATE INDEX IF NOT EXISTS idx_decisions_report ON moderation_decisions(report_id);
