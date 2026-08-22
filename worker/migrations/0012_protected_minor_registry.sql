-- Parity copy only: production schema is applied by ensureSchema().
CREATE TABLE IF NOT EXISTS protected_minor_subjects (
  subject_id TEXT PRIMARY KEY,
  source_case_id TEXT UNIQUE,
  classification_state TEXT NOT NULL CHECK (classification_state IN ('active', 'cleared')),
  classified_at TEXT NOT NULL,
  cleared_at TEXT,
  cleared_by TEXT,
  clear_reason TEXT,
  CHECK ((classification_state = 'active' AND cleared_at IS NULL AND cleared_by IS NULL AND clear_reason IS NULL)
    OR (classification_state = 'cleared' AND cleared_at IS NOT NULL AND clear_reason IS NOT NULL))
);
CREATE TABLE IF NOT EXISTS protected_minor_account_bindings (
  id TEXT PRIMARY KEY,
  subject_id TEXT NOT NULL,
  pubkey TEXT NOT NULL CHECK (length(pubkey) = 64 AND pubkey = lower(pubkey)),
  bound_at TEXT NOT NULL,
  unbound_at TEXT,
  deletion_attempt_id TEXT UNIQUE,
  FOREIGN KEY (subject_id) REFERENCES protected_minor_subjects(subject_id)
);
CREATE TABLE IF NOT EXISTS protected_minor_provisioning_operations (
  provisioning_operation_id TEXT PRIMARY KEY,
  subject_id TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('onboarding', 'replacement')),
  request_fingerprint TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('pending', 'complete', 'failed')),
  result_pubkey TEXT CHECK (result_pubkey IS NULL OR (length(result_pubkey) = 64 AND result_pubkey = lower(result_pubkey))),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (subject_id) REFERENCES protected_minor_subjects(subject_id),
  CHECK ((state = 'complete' AND result_pubkey IS NOT NULL AND subject_id IS NOT NULL) OR state != 'complete')
);
CREATE TABLE IF NOT EXISTS protected_minor_projection_jobs (
  subject_id TEXT PRIMARY KEY,
  pubkey TEXT NOT NULL,
  reason TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('pending', 'complete')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (subject_id) REFERENCES protected_minor_subjects(subject_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_protected_minor_active_subject_binding ON protected_minor_account_bindings(subject_id) WHERE unbound_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_protected_minor_active_pubkey_binding ON protected_minor_account_bindings(pubkey) WHERE unbound_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_protected_minor_binding_history ON protected_minor_account_bindings(subject_id, bound_at);
CREATE INDEX IF NOT EXISTS idx_protected_minor_operation_subject ON protected_minor_provisioning_operations(subject_id, created_at);
CREATE INDEX IF NOT EXISTS idx_protected_minor_projection_pending ON protected_minor_projection_jobs(state, created_at);
