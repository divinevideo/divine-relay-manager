// Real-D1 (Miniflare SQLite) validation for the age-review identity columns.
// These record a human-readable identifier for the reported account, captured
// at case creation. Enforcement hides a suspended account's profile, so a later
// lookup returns nothing and the value can never be recovered — which is why
// the columns exist rather than resolving the name on read.
//
// This lives in a *.d1.test.ts file because the default vitest config runs
// against a MOCKED DB and would never exercise the real ALTER TABLE path.
import { Miniflare } from 'miniflare';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { ensureSchema } from '../src/db';

let mf: Miniflare;
let DB: D1Database;

beforeAll(async () => {
  mf = new Miniflare({
    modules: true,
    script: 'export default { fetch() { return new Response("ok"); } };',
    compatibilityDate: '2024-12-01',
    compatibilityFlags: ['nodejs_compat'],
    d1Databases: ['DB'],
  });
  DB = (await mf.getD1Database('DB')) as unknown as D1Database;
});

afterAll(async () => {
  await mf?.dispose();
});

async function columnsOf(table: string): Promise<string[]> {
  const rows = await DB.prepare(`PRAGMA table_info(${table})`).all<{ name: string }>();
  return rows.results.map((r) => r.name);
}

describe('ensureSchema adds the age-review identity columns', () => {
  it('creates all four identity columns on age_review_cases', async () => {
    await ensureSchema(DB);

    const columns = await columnsOf('age_review_cases');
    expect(columns).toContain('account_name');
    expect(columns).toContain('account_nip05');
    expect(columns).toContain('account_vine_username');
    expect(columns).toContain('identity_captured_at');
  });

  it('stores and reads back a captured identity', async () => {
    await ensureSchema(DB);

    await DB.prepare(`
      INSERT INTO age_review_cases
      (id, pubkey, suspected_age_band, state, allowed_resolution,
       account_name, account_nip05, account_vine_username, identity_captured_at)
      VALUES (?, ?, 'age_13_15', 'open_reported', 'parent_video_or_email', ?, ?, ?, ?)
    `).bind(
      'case-identity-1', 'pk_identity_1',
      'Some One', 'x@y.z', 'someuser', '2026-07-29T00:00:00.000Z',
    ).run();

    const row = await DB.prepare(`
      SELECT account_name, account_nip05, account_vine_username, identity_captured_at
      FROM age_review_cases WHERE id = ?
    `).bind('case-identity-1').first<{
      account_name: string;
      account_nip05: string;
      account_vine_username: string;
      identity_captured_at: string;
    }>();

    expect(row).toEqual({
      account_name: 'Some One',
      account_nip05: 'x@y.z',
      account_vine_username: 'someuser',
      identity_captured_at: '2026-07-29T00:00:00.000Z',
    });
  });

  it('distinguishes never-looked from looked-and-found-nothing', async () => {
    await ensureSchema(DB);

    // A case whose lookup ran but resolved to no profile: stamped, values null.
    // The backfill relies on this to know which rows are worth retrying.
    await DB.prepare(`
      INSERT INTO age_review_cases
      (id, pubkey, suspected_age_band, state, allowed_resolution, identity_captured_at)
      VALUES (?, ?, 'age_13_15', 'open_reported', 'parent_video_or_email', ?)
    `).bind('case-identity-2', 'pk_identity_2', '2026-07-29T00:00:00.000Z').run();

    // A case predating capture: never looked, so no stamp.
    await DB.prepare(`
      INSERT INTO age_review_cases
      (id, pubkey, suspected_age_band, state, allowed_resolution)
      VALUES (?, ?, 'age_13_15', 'open_reported', 'parent_video_or_email')
    `).bind('case-identity-3', 'pk_identity_3').run();

    const pending = await DB.prepare(`
      SELECT id FROM age_review_cases WHERE identity_captured_at IS NULL
    `).all<{ id: string }>();

    expect(pending.results.map((r) => r.id)).toContain('case-identity-3');
    expect(pending.results.map((r) => r.id)).not.toContain('case-identity-2');
  });

  it('is idempotent: calling ensureSchema twice does not error', async () => {
    await ensureSchema(DB);
    await expect(ensureSchema(DB)).resolves.not.toThrow();
  });
});
