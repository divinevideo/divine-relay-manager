-- Persist the claim link expiry for minor onboarding cases
ALTER TABLE age_review_cases ADD COLUMN claim_link_expires_at TEXT;
