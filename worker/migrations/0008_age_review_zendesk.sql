-- Link age review cases to Zendesk tickets for parent contact workflow
ALTER TABLE age_review_cases ADD COLUMN zendesk_ticket_id INTEGER;
CREATE INDEX IF NOT EXISTS idx_age_review_zendesk_ticket ON age_review_cases(zendesk_ticket_id);
