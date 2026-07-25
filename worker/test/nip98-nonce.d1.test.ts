// Real-D1 (Miniflare SQLite) validation for the #195 NIP-98 replay nonce.
// The mocked D1 in vitest.config.ts cannot enforce a PRIMARY KEY, so the core
// "replay is rejected" guarantee can only be proven against real SQLite —
// this suite runs consumeNip98Nonce against a real Miniflare-backed D1.
import { Miniflare } from 'miniflare';
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { ensureSchema } from '../src/db';
import { consumeNip98Nonce } from '../src/index';

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

async function reset() {
  await ensureSchema(DB);
  await DB.prepare('DELETE FROM nip98_used_nonces').run();
}

describe('consumeNip98Nonce on real D1', () => {
  beforeEach(reset);

  it('replay is rejected: same event id succeeds once, then fails', async () => {
    const eventId = 'a'.repeat(64);
    expect(await consumeNip98Nonce(DB, eventId)).toBe(true);
    expect(await consumeNip98Nonce(DB, eventId)).toBe(false);
  });

  it('two different event ids both succeed', async () => {
    expect(await consumeNip98Nonce(DB, 'b'.repeat(64))).toBe(true);
    expect(await consumeNip98Nonce(DB, 'c'.repeat(64))).toBe(true);
  });

  it('cleanup purges only expired nonces', async () => {
    await DB.prepare(
      `INSERT INTO nip98_used_nonces (event_id, expires_at) VALUES (?, unixepoch() - 10)`
    ).bind('expired'.padEnd(64, '0')).run();
    await DB.prepare(
      `INSERT INTO nip98_used_nonces (event_id, expires_at) VALUES (?, unixepoch() + 120)`
    ).bind('future'.padEnd(64, '0')).run();

    await DB.prepare('DELETE FROM nip98_used_nonces WHERE expires_at < unixepoch()').run();

    const remaining = await DB.prepare('SELECT event_id FROM nip98_used_nonces').all();
    expect(remaining.results).toHaveLength(1);
    expect((remaining.results[0] as { event_id: string }).event_id).toBe('future'.padEnd(64, '0'));
  });
});
