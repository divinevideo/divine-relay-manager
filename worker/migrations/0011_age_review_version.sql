-- optimistic-concurrency version column for age_review_cases.
-- The case PATCH and the deadline cron were read-modify-write with no guard, so
-- two concurrent writers (moderator + moderator, or moderator + cron) could
-- clobber each other's state and each independently fire enforcement side
-- effects, leaving the DB state and the actual Keycast/relay/media state
-- divergent. Callers now compare-and-swap on this version.
ALTER TABLE age_review_cases ADD COLUMN version INTEGER NOT NULL DEFAULT 0;
