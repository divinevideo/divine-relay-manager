// ABOUTME: Shared D1 schema initialization for worker and Durable Objects
// ABOUTME: Single source of truth for moderation_decisions and moderation_targets DDL

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
  } catch {
    // Column already exists
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
      ever_human_reviewed INTEGER DEFAULT 0
    )
  `).run();

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

  // Single-use NIP-98 replay nonces for the mobile minor-review endpoints (#195).
  await db.prepare(`
    CREATE TABLE IF NOT EXISTS nip98_used_nonces (
      event_id   TEXT PRIMARY KEY,
      expires_at INTEGER NOT NULL
    )
  `).run();

  try {
    await db.prepare(`CREATE INDEX IF NOT EXISTS idx_nip98_nonces_expires ON nip98_used_nonces(expires_at)`).run();
  } catch {
    // Index already exists
  }
}
