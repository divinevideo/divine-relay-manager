-- How a cleared age-review case was resolved (#192).
-- Parity copy only: production schema is applied by ensureSchema(), which adds this column at
-- runtime. Do not apply this file to a database ensureSchema() has already touched: the ALTER is
-- not idempotent and fails with a duplicate column error.
ALTER TABLE age_review_cases ADD COLUMN clear_resolution TEXT
  CHECK (clear_resolution IN ('approved_minor', 'not_minor'));
