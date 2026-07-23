// Real-D1 (Miniflare SQLite) validation that ensureSchema self-heals
// zendesk_preauth_nonces, which previously existed ONLY in migrations/0003.sql.
// This repo builds schema via runtime ensureSchema, NOT
// `wrangler d1 migrations apply` (see db.ts header comment) — so a
// freshly-provisioned D1 that never had migrations manually applied was
// missing the table, breaking Zendesk pre-auth.
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

describe('ensureSchema self-heals zendesk_preauth_nonces on a fresh D1', () => {
  it('creates zendesk_preauth_nonces', async () => {
    await ensureSchema(DB);

    const rows = await DB.prepare(
      `SELECT name FROM sqlite_master WHERE type='table' AND name = 'zendesk_preauth_nonces'`
    ).all<{ name: string }>();
    const names = rows.results.map((r) => r.name);
    expect(names).toEqual(['zendesk_preauth_nonces']);
  });

  it('zendesk_preauth_nonces is usable with the columns the app writes', async () => {
    await ensureSchema(DB);

    await DB.prepare(
      'INSERT INTO zendesk_preauth_nonces (nonce, pubkey, expires_at) VALUES (?, ?, ?)'
    ).bind('nonce-1', 'pk_abc', 9999999999).run();

    const row = await DB.prepare(
      'SELECT nonce, pubkey, expires_at FROM zendesk_preauth_nonces WHERE nonce = ?'
    ).bind('nonce-1').first<{ nonce: string; pubkey: string; expires_at: number }>();

    expect(row).toEqual({ nonce: 'nonce-1', pubkey: 'pk_abc', expires_at: 9999999999 });
  });

  it('defaults created_at to unixepoch() when not specified', async () => {
    await ensureSchema(DB);

    // Deliberately omit created_at to exercise the column's NOT NULL DEFAULT.
    await DB.prepare(
      'INSERT INTO zendesk_preauth_nonces (nonce, pubkey, expires_at) VALUES (?, ?, ?)'
    ).bind('nonce-2', 'pk_def', 9999999999).run();

    const row = await DB.prepare(
      'SELECT created_at FROM zendesk_preauth_nonces WHERE nonce = ?'
    ).bind('nonce-2').first<{ created_at: number }>();

    expect(typeof row?.created_at).toBe('number');
    expect(row?.created_at).toBeGreaterThan(0);
  });

  it('creates the expected index', async () => {
    await ensureSchema(DB);

    const rows = await DB.prepare(
      `SELECT name FROM sqlite_master WHERE type='index' AND name = 'idx_nonces_expires'`
    ).all<{ name: string }>();
    const names = rows.results.map((r) => r.name);
    expect(names).toEqual(['idx_nonces_expires']);
  });

  it('is idempotent: calling ensureSchema twice does not error', async () => {
    await ensureSchema(DB);
    await expect(ensureSchema(DB)).resolves.not.toThrow();
  });
});
