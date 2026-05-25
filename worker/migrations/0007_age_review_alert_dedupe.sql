-- Track when Slack alerts were last sent per case to prevent duplicate notifications
ALTER TABLE age_review_cases ADD COLUMN last_alerted_at TEXT;
