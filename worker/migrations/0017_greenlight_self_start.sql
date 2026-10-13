-- Preserve report provenance when the family starts Greenlight before moderator review.
ALTER TABLE age_review_cases ADD COLUMN greenlight_requested_at TEXT;
