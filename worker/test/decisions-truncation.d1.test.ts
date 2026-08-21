// Real-D1 (Miniflare SQLite) proof that /api/decisions caps at 1000 rows and
// reports how far back the returned window reaches. The stubbed-DB test in
// src/index.test.ts cannot catch a bad ORDER BY or a bind mismatch, because
// the stub does the ordering itself.
import { Miniflare } from 'miniflare';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { ensureSchema } from '../src/db';
import worker from '../src/index';

let mf: Miniflare;
let DB: D1Database;

const ctx = {} as ExecutionContext;

beforeAll(async () => {
  mf = new Miniflare({
    modules: true,
    script: 'export default { fetch() { return new Response("ok"); } };',
    compatibilityDate: '2024-12-01',
    compatibilityFlags: ['nodejs_compat'],
    d1Databases: ['DB'],
  });
  DB = (await mf.getD1Database('DB')) as unknown as D1Database;
  await ensureSchema(DB);

  // 1005 rows, oldest first, so row N has a strictly increasing created_at.
  const stmt = DB.prepare(
    `INSERT INTO moderation_decisions (target_type, target_id, action, created_at)
     VALUES (?, ?, ?, ?)`
  );
  const batch = [];
  for (let i = 0; i < 1005; i++) {
    const day = String(1 + Math.floor(i / 100)).padStart(2, '0');
    const sec = String(i % 60).padStart(2, '0');
    const min = String(Math.floor((i % 100) / 60)).padStart(2, '0');
    batch.push(stmt.bind('pubkey', 'a'.repeat(64), 'dismissed', `2026-06-${day} 00:${min}:${sec}`));
  }
  await DB.batch(batch);
});

afterAll(async () => {
  await mf?.dispose();
});

function env() {
  return {
    ALLOWED_ORIGINS: 'https://app.divine.video',
    RELAY_URL: 'wss://relay.divine.video',
    ADMIN_API_KEY: 'test-admin-key',
    DB,
  } as never;
}

describe('/api/decisions truncation against real D1 (#221)', () => {
  it('returns the newest 1000 rows and flags truncation', async () => {
    const res = await worker.fetch(
      new Request('https://api.example/api/decisions', { headers: { 'X-Admin-Key': 'test-admin-key' } }),
      env(),
      ctx
    );
    const body = await res.json() as {
      decisions: Array<{ created_at: string }>;
      truncated: boolean;
      oldest_covered: string | null;
    };

    expect(res.status).toBe(200);
    expect(body.decisions).toHaveLength(1000);
    expect(body.truncated).toBe(true);

    // Newest first, and oldest_covered matches the last row actually returned.
    const first = body.decisions[0].created_at;
    const last = body.decisions[body.decisions.length - 1].created_at;
    expect(first > last).toBe(true);
    expect(body.oldest_covered).toBe(last);

    // The 5 rows beyond the cap are the OLDEST ones, not an arbitrary slice.
    const oldestInTable = await DB.prepare(
      'SELECT created_at FROM moderation_decisions ORDER BY created_at ASC LIMIT 1'
    ).first<{ created_at: string }>();
    expect(body.oldest_covered! > oldestInTable!.created_at).toBe(true);
  });
});
