-- Track how age review cases were created and store claim links for minor onboarding
ALTER TABLE age_review_cases ADD COLUMN created_via TEXT DEFAULT 'report';
ALTER TABLE age_review_cases ADD COLUMN claim_link_url TEXT;
