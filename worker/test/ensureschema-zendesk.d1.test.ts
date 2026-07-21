// Real-D1 (Miniflare SQLite) validation that ensureSchema self-heals the two
// Zendesk tables that previously existed ONLY in migrations/*.sql:
//   zendesk_preauth_nonces (migration 0003)
//   zendesk_tickets        (migration 0001)
// This repo builds schema via runtime ensureSchema, NOT
// `wrangler d1 migrations apply` (see db.ts header comment) — so a
// freshly-provisioned D1 that never had migrations manually applied was
// missing both tables, breaking Zendesk pre-auth and ticket dedup.
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

describe('ensureSchema self-heals Zendesk tables on a fresh D1', () => {
  it('creates zendesk_preauth_nonces and zendesk_tickets', async () => {
    await ensureSchema(DB);

    const rows = await DB.prepare(
      `SELECT name FROM sqlite_master WHERE type='table' AND name IN ('zendesk_preauth_nonces','zendesk_tickets')`
    ).all<{ name: string }>();
    const names = rows.results.map((r) => r.name).sort();
    expect(names).toEqual(['zendesk_preauth_nonces', 'zendesk_tickets']);
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

  it('zendesk_tickets is usable with the columns the app writes', async () => {
    await ensureSchema(DB);

    await DB.prepare(`
      INSERT INTO zendesk_tickets (ticket_id, event_id, author_pubkey, violation_type, status)
      VALUES (?, ?, ?, ?, 'open')
    `).bind(4242, 'evt_abc', 'pk_abc', 'spam').run();

    const row = await DB.prepare(
      'SELECT ticket_id, event_id, author_pubkey, violation_type, status FROM zendesk_tickets WHERE ticket_id = ?'
    ).bind(4242).first<{ ticket_id: number; event_id: string; author_pubkey: string; violation_type: string; status: string }>();

    expect(row).toEqual({
      ticket_id: 4242,
      event_id: 'evt_abc',
      author_pubkey: 'pk_abc',
      violation_type: 'spam',
      status: 'open',
    });
  });

  it('creates the expected indexes on both tables', async () => {
    await ensureSchema(DB);

    const rows = await DB.prepare(
      `SELECT name FROM sqlite_master WHERE type='index' AND name IN (
        'idx_nonces_expires', 'idx_zendesk_event', 'idx_zendesk_author', 'idx_zendesk_status'
      )`
    ).all<{ name: string }>();
    const names = rows.results.map((r) => r.name).sort();
    expect(names).toEqual(['idx_nonces_expires', 'idx_zendesk_author', 'idx_zendesk_event', 'idx_zendesk_status']);
  });

  it('is idempotent: calling ensureSchema twice does not error', async () => {
    await ensureSchema(DB);
    await expect(ensureSchema(DB)).resolves.not.toThrow();
  });
});
