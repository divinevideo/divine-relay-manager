-- Preserve report provenance when the family starts Greenlight before moderator review.
ALTER TABLE age_review_cases ADD COLUMN greenlight_requested_at TEXT;

-- Attribution is optional; moderator intervention must remain durable.
ALTER TABLE age_review_cases ADD COLUMN moderation_started_at TEXT;
