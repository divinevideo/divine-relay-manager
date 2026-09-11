-- Protected-record retention foundations. Production schema is also healed by ensureSchema().
ALTER TABLE age_review_cases ADD COLUMN closed_at TEXT;
ALTER TABLE age_review_cases ADD COLUMN redacted_at TEXT;
ALTER TABLE protected_minor_subjects ADD COLUMN clear_reason_class TEXT NOT NULL DEFAULT 'unclassified'
  CHECK (clear_reason_class IN ('false_positive', 'valid_prior', 'unclassified'));
ALTER TABLE protected_minor_subjects ADD COLUMN clear_reason_alerted_at TEXT;

UPDATE age_review_cases SET closed_at = updated_at
  WHERE state IN ('cleared', 'denied_closed') AND closed_at IS NULL;
UPDATE protected_minor_subjects SET clear_reason_class = CASE
  WHEN clear_reason = 'false_positive' THEN 'false_positive'
  WHEN clear_reason IN ('age_review_denied', 'age_review_expired', 'age_up', 'age_verified') THEN 'valid_prior'
  ELSE 'unclassified' END
WHERE classification_state = 'cleared';
UPDATE protected_minor_account_bindings SET unbound_at = (
    SELECT s.cleared_at FROM protected_minor_subjects s
    WHERE s.subject_id = protected_minor_account_bindings.subject_id)
  WHERE unbound_at IS NULL AND subject_id IN (
    SELECT subject_id FROM protected_minor_subjects WHERE classification_state = 'cleared');

CREATE TRIGGER protected_minor_clear_reason_insert
BEFORE INSERT ON protected_minor_subjects
WHEN NEW.classification_state = 'cleared' AND (
  (NEW.clear_reason = 'false_positive' AND NEW.clear_reason_class != 'false_positive') OR
  (NEW.clear_reason IN ('age_review_denied', 'age_review_expired', 'age_up', 'age_verified') AND NEW.clear_reason_class != 'valid_prior') OR
  (NEW.clear_reason NOT IN ('false_positive', 'age_review_denied', 'age_review_expired', 'age_up', 'age_verified') AND NEW.clear_reason_class != 'unclassified')
) BEGIN SELECT RAISE(ABORT, 'clear reason classification mismatch'); END;

CREATE TRIGGER protected_minor_clear_reason_update
BEFORE UPDATE OF classification_state, clear_reason, clear_reason_class ON protected_minor_subjects
WHEN NEW.classification_state = 'cleared' AND (
  (NEW.clear_reason = 'false_positive' AND NEW.clear_reason_class != 'false_positive') OR
  (NEW.clear_reason IN ('age_review_denied', 'age_review_expired', 'age_up', 'age_verified') AND NEW.clear_reason_class != 'valid_prior') OR
  (NEW.clear_reason NOT IN ('false_positive', 'age_review_denied', 'age_review_expired', 'age_up', 'age_verified') AND NEW.clear_reason_class != 'unclassified')
) BEGIN SELECT RAISE(ABORT, 'clear reason classification mismatch'); END;

CREATE TABLE protected_minor_provisioning_tombstones (
  provisioning_operation_id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('onboarding', 'replacement')),
  terminal_outcome TEXT NOT NULL CHECK (terminal_outcome IN ('complete', 'failed')),
  completed_at TEXT NOT NULL,
  request_digest TEXT NOT NULL,
  result_digest TEXT,
  key_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE retention_legal_holds (
  id TEXT PRIMARY KEY,
  record_type TEXT NOT NULL CHECK (record_type IN ('protected_subject', 'account_binding', 'provisioning_operation', 'projection_job', 'age_review_case')),
  record_key TEXT,
  disposal_stage TEXT NOT NULL DEFAULT 'all' CHECK (disposal_stage IN ('all', 'claim_link', 'redaction', 'compaction', 'deletion')),
  authorized_role TEXT NOT NULL,
  starts_at TEXT NOT NULL,
  review_at TEXT NOT NULL,
  expires_at TEXT,
  released_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_retention_holds_active
  ON retention_legal_holds(record_type, record_key, disposal_stage, starts_at, released_at, expires_at);

CREATE TABLE retention_alert_state (
  alert_type TEXT PRIMARY KEY,
  last_alerted_at TEXT NOT NULL
);
