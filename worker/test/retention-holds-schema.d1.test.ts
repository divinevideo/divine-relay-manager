// Real-D1 (Miniflare SQLite) check that ensureSchema widens an existing
// retention_legal_holds table to accept consent_video holds. This repo builds
// schema through ensureSchema rather than `wrangler d1 migrations apply`, so
// migration 0015's table rebuild never runs on a database created before
// #286, and CREATE TABLE IF NOT EXISTS keeps the old CHECK.
import { Miniflare } from 'miniflare';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ensureSchema } from '../src/db';

let mf: Miniflare;
let DB: D1Database;

// The table as ensureSchema created it before #286.
const PRE_286_HOLDS = `CREATE TABLE retention_legal_holds (
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
)`;

function insertHold(id: string, stage: string) {
  return DB.prepare(`INSERT INTO retention_legal_holds
    (id, record_type, record_key, disposal_stage, authorized_role, starts_at, review_at)
    VALUES (?, 'age_review_case', 'case-1', ?, 'trust_and_safety', '2026-10-01', '2026-11-01')`)
    .bind(id, stage).run();
}

beforeEach(async () => {
  mf = new Miniflare({
    modules: true,
    script: 'export default { fetch() { return new Response("ok"); } };',
    compatibilityDate: '2024-12-01',
    compatibilityFlags: ['nodejs_compat'],
    d1Databases: ['DB'],
  });
  DB = (await mf.getD1Database('DB')) as unknown as D1Database;
  await DB.prepare(PRE_286_HOLDS).run();
  await insertHold('existing-hold', 'all');
});

afterEach(async () => {
  await mf?.dispose();
});

describe('ensureSchema widens retention_legal_holds for consent_video holds', () => {
  it('accepts a consent_video hold on a table created before #286', async () => {
    await ensureSchema(DB);

    await insertHold('consent-hold', 'consent_video');
    const stages = await DB.prepare('SELECT id, disposal_stage FROM retention_legal_holds ORDER BY id')
      .all<{ id: string; disposal_stage: string }>();
    expect(stages.results).toEqual([
      { id: 'consent-hold', disposal_stage: 'consent_video' },
      { id: 'existing-hold', disposal_stage: 'all' },
    ]);
  });

  it('keeps existing holds and is safe to run again', async () => {
    await ensureSchema(DB);
    await ensureSchema(DB);

    const row = await DB.prepare('SELECT record_key, disposal_stage, authorized_role FROM retention_legal_holds WHERE id = ?')
      .bind('existing-hold').first();
    expect(row).toEqual({ record_key: 'case-1', disposal_stage: 'all', authorized_role: 'trust_and_safety' });
    const index = await DB.prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_retention_holds_active'`).first();
    expect(index).toEqual({ name: 'idx_retention_holds_active' });
  });
});
