-- How a cleared age-review case was resolved (#192). Production schema is also healed by ensureSchema().
ALTER TABLE age_review_cases ADD COLUMN clear_resolution TEXT
  CHECK (clear_resolution IN ('approved_minor', 'not_minor'));
