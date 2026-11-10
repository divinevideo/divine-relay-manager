-- When the report watcher first saw each report (#324). The reporter's client sets created_at, so
-- "reported after the last human handling" compares arrival, not created_at. No reporter or target
-- here: they are on the relay event. Production schema is also healed by ensureSchema().
CREATE TABLE IF NOT EXISTS report_arrivals (
  report_id TEXT PRIMARY KEY,
  first_seen_at INTEGER NOT NULL
);
