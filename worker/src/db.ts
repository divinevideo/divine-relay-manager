// ABOUTME: Shared D1 schema initialization for worker and Durable Objects
// ABOUTME: Creates moderation_decisions, moderation_targets, age_review_cases,
// ABOUTME: age_review_config, protected-minor registry, and Zendesk DDL on a fresh D1

/**
 * Ensure all moderation tables and indexes exist.
 * Safe to call multiple times (CREATE IF NOT EXISTS / ALTER wrapped in try-catch).
 */
export async function ensureSchema(db: D1Database): Promise<void> {
  await db.prepare(`
    CREATE TABLE IF NOT EXISTS moderation_decisions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      target_type TEXT NOT NULL,
      target_id TEXT NOT NULL,
      action TEXT NOT NULL,
      reason TEXT,
      moderator_pubkey TEXT,
      report_id TEXT,
      reporter_pubkey TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `).run();

  // Add reporter_pubkey to existing tables that were created without it
  try {
    await db.prepare(`ALTER TABLE moderation_decisions ADD COLUMN reporter_pubkey TEXT`).run();
  } catch (error) {
    if (!String(error).includes('duplicate column name')) throw error;
  }

  try {
    await db.prepare(`CREATE INDEX IF NOT EXISTS idx_decisions_target ON moderation_decisions(target_type, target_id)`).run();
  } catch {
    // Index already exists
  }

  try {
    await db.prepare(`CREATE INDEX IF NOT EXISTS idx_decisions_report ON moderation_decisions(report_id)`).run();
  } catch {
    // Index already exists
  }

  // Per-target state — separated from the append-only decision log.
  // DEPLOY NOTE: After first deploy, backfill from existing decisions:
  //   wrangler d1 execute <db-name> --remote --config <wrangler.toml> --command "INSERT INTO moderation_targets (target_id, target_type, ever_human_reviewed) SELECT DISTINCT target_id, target_type, 1 FROM moderation_decisions WHERE action != 'auto_hidden' ON CONFLICT(target_id) DO UPDATE SET ever_human_reviewed = 1;"
  //   Staging: done 2026-02-11. Production: pending.
  await db.prepare(`
    CREATE TABLE IF NOT EXISTS moderation_targets (
      target_id TEXT PRIMARY KEY,
      target_type TEXT NOT NULL,
      ever_human_reviewed INTEGER DEFAULT 0,
      last_human_action TEXT
    )
  `).run();

  try {
    await db.prepare(`ALTER TABLE moderation_targets ADD COLUMN last_human_action TEXT`).run();
  } catch (error) {
    if (!String(error).includes('duplicate column name')) throw error;
  }

  await db.prepare(`
    CREATE TABLE IF NOT EXISTS age_review_cases (
      id TEXT PRIMARY KEY,
      pubkey TEXT NOT NULL,
      reporter_pubkey TEXT,
      report_id TEXT,
      suspected_age_band TEXT NOT NULL DEFAULT 'age_13_15',
      state TEXT NOT NULL DEFAULT 'open_reported',
      allowed_resolution TEXT NOT NULL DEFAULT 'parent_video_or_email',
      parent_contact_email TEXT,
      deadline_at TEXT,
      clock_paused INTEGER DEFAULT 0,
      clock_paused_at TEXT,
      remaining_days_when_paused REAL,
      moderator_pubkey TEXT,
      resolution_note TEXT,
      last_alerted_at TEXT,
      zendesk_ticket_id INTEGER,
      created_via TEXT DEFAULT 'report',
      claim_link_url TEXT,
      claim_link_expires_at TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
      version INTEGER NOT NULL DEFAULT 0
    )
  `).run();

  // Add columns to existing tables that were created without them
  try {
    await db.prepare(`ALTER TABLE age_review_cases ADD COLUMN zendesk_ticket_id INTEGER`).run();
  } catch {
    // Column already exists
  }

  try {
    await db.prepare(`ALTER TABLE age_review_cases ADD COLUMN created_via TEXT DEFAULT 'report'`).run();
  } catch {
    // Column already exists
  }

  try {
    await db.prepare(`ALTER TABLE age_review_cases ADD COLUMN claim_link_url TEXT`).run();
  } catch {
    // Column already exists
  }

  try {
    await db.prepare(`ALTER TABLE age_review_cases ADD COLUMN claim_link_expires_at TEXT`).run();
  } catch {
    // Column already exists
  }

  try {
    await db.prepare(`ALTER TABLE age_review_cases ADD COLUMN version INTEGER NOT NULL DEFAULT 0`).run();
  } catch {
    // Column already exists
  }

  // Human-readable identity for the reported account, captured when the case is
  // created. Enforcement hides a suspended account's content from relay queries,
  // so a later lookup returns nothing and the name is unrecoverable -- these
  // columns preserve whatever was visible at the time.
  //
  // identity_captured_at is stamped whenever the lookup reached a confirmed
  // answer -- including a confirmed "this account has no profile". A null means
  // no confirmed answer: never looked, or looked and timed out, errored, or had
  // no relay configured. So a null is never "looked and found nothing", and the
  // backfill uses exactly that to know which rows are worth re-querying.
  for (const column of [
    `account_name TEXT`,
    `account_nip05 TEXT`,
    `account_vine_username TEXT`,
    `identity_captured_at TEXT`,
  ]) {
    try {
      await db.prepare(`ALTER TABLE age_review_cases ADD COLUMN ${column}`).run();
    } catch {
      // Column already exists
    }
  }

  try {
    await db.prepare(`CREATE INDEX IF NOT EXISTS idx_age_review_pubkey ON age_review_cases(pubkey)`).run();
    await db.prepare(`CREATE INDEX IF NOT EXISTS idx_age_review_state ON age_review_cases(state)`).run();
    await db.prepare(`CREATE INDEX IF NOT EXISTS idx_age_review_deadline ON age_review_cases(deadline_at)`).run();
  } catch {
    // Indexes already exist
  }

  try {
    await db.prepare(`CREATE INDEX IF NOT EXISTS idx_age_review_zendesk_ticket ON age_review_cases(zendesk_ticket_id)`).run();
  } catch {
    // Index already exists
  }

  await db.prepare(`
    CREATE TABLE IF NOT EXISTS age_review_config (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )
  `).run();

  // zendesk_preauth_nonces previously existed only in migrations/0003, which
  // is legacy/manual and not run against fresh D1 instances (this repo's
  // schema path is ensureSchema, not `wrangler d1 migrations apply`).
  // (zendesk_tickets is self-healed separately by ensureZendeskTable() in
  // zendesk-sync.ts — not duplicated here.)
  await db.prepare(`
    CREATE TABLE IF NOT EXISTS zendesk_preauth_nonces (
      nonce TEXT PRIMARY KEY,
      pubkey TEXT NOT NULL,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      expires_at INTEGER NOT NULL
    )
  `).run();

  try {
    await db.prepare(`CREATE INDEX IF NOT EXISTS idx_nonces_expires ON zendesk_preauth_nonces(expires_at)`).run();
  } catch {
    // Index already exists
  }

  // Protected-minor classification belongs to a durable subject, not to the
  // replaceable Keycast account row. Keep this DDL in sync with migration 0012;
  // ensureSchema is the applied production schema path in this repository.
  await db.prepare(`
    CREATE TABLE IF NOT EXISTS protected_minor_subjects (
      subject_id TEXT PRIMARY KEY,
      source_case_id TEXT UNIQUE,
      classification_state TEXT NOT NULL CHECK (classification_state IN ('active', 'cleared')),
      classified_at TEXT NOT NULL,
      cleared_at TEXT,
      cleared_by TEXT,
      clear_reason TEXT,
      CHECK (
        (classification_state = 'active' AND cleared_at IS NULL AND cleared_by IS NULL AND clear_reason IS NULL)
        OR (classification_state = 'cleared' AND cleared_at IS NOT NULL AND clear_reason IS NOT NULL)
      )
    )
  `).run();

  await db.prepare(`
    CREATE TABLE IF NOT EXISTS protected_minor_account_bindings (
      id TEXT PRIMARY KEY,
      subject_id TEXT NOT NULL,
      pubkey TEXT NOT NULL CHECK (length(pubkey) = 64 AND pubkey = lower(pubkey)),
      bound_at TEXT NOT NULL,
      unbound_at TEXT,
      deletion_attempt_id TEXT UNIQUE,
      FOREIGN KEY (subject_id) REFERENCES protected_minor_subjects(subject_id)
    )
  `).run();

  await db.prepare(`
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
    )
  `).run();

  await db.prepare(`
    CREATE TABLE IF NOT EXISTS protected_minor_projection_jobs (
      subject_id TEXT PRIMARY KEY,
      pubkey TEXT NOT NULL,
      reason TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('pending', 'complete')),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (subject_id) REFERENCES protected_minor_subjects(subject_id)
    )
  `).run();

  await db.prepare(`CREATE UNIQUE INDEX IF NOT EXISTS idx_protected_minor_active_subject_binding
    ON protected_minor_account_bindings(subject_id) WHERE unbound_at IS NULL`).run();
  await db.prepare(`CREATE UNIQUE INDEX IF NOT EXISTS idx_protected_minor_active_pubkey_binding
    ON protected_minor_account_bindings(pubkey) WHERE unbound_at IS NULL`).run();
  await db.prepare(`CREATE INDEX IF NOT EXISTS idx_protected_minor_binding_history
    ON protected_minor_account_bindings(subject_id, bound_at)`).run();
  await db.prepare(`CREATE INDEX IF NOT EXISTS idx_protected_minor_operation_subject
    ON protected_minor_provisioning_operations(subject_id, created_at)`).run();
  await db.prepare(`CREATE INDEX IF NOT EXISTS idx_protected_minor_projection_pending
    ON protected_minor_projection_jobs(state, created_at)`).run();
}
