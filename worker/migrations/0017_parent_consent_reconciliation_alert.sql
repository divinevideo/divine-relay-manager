-- When the manual-reconciliation alert for a stuck consent submission last
-- went out. The submission keeps its own timestamp, rather than sharing the
-- case's last_alerted_at, so this alert cannot silence the case's deadline
-- alerts or be silenced by them (#302).
ALTER TABLE age_review_parent_consent_submissions ADD COLUMN reconciliation_alerted_at TEXT;
