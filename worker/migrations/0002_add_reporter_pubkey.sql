-- Migration: Add reporter_pubkey column for trusted reporter tracking
-- Date: January 31, 2026
-- Purpose: Track which pubkey submitted reports for false positive rate calculation

ALTER TABLE moderation_decisions ADD COLUMN reporter_pubkey TEXT;

CREATE INDEX IF NOT EXISTS idx_decisions_reporter ON moderation_decisions(reporter_pubkey);
