-- Prevent duplicate auto_hidden decisions for the same target.
-- The ReportWatcher can receive the same report event twice via WebSocket
-- (relay replay on reconnect). Without this constraint, both pass the
-- dedup check before either commits, creating duplicate rows.
-- Scoped to auto_hidden only — human decisions (ban, unban, dismiss, etc.)
-- are intentionally allowed to repeat for the same target.
CREATE UNIQUE INDEX IF NOT EXISTS idx_decisions_autohide_dedup
ON moderation_decisions(target_id, action)
WHERE action = 'auto_hidden';
