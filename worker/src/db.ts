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
    CREATE TABLE IF NOT EXISTS pending_verdicts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_id TEXT,
      pubkey TEXT,
      verdict TEXT NOT NULL DEFAULT 'flag_for_review',
      category TEXT,
      rule_name TEXT,
      source TEXT DEFAULT 'osprey',
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      status TEXT DEFAULT 'pending',
      resolved_at TEXT,
      resolved_by TEXT
    )
  `).run();

  try {
    await db.prepare(`CREATE INDEX IF NOT EXISTS idx_verdicts_status ON pending_verdicts(status, created_at)`).run();
  } catch {
    // Index already exists
  }
}
