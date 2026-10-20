import { readFileSync } from 'node:fs';
import { Miniflare } from 'miniflare';
import { afterEach, describe, expect, it } from 'vitest';
import { ensureSchema } from '../src/db';

let mf: Miniflare;
afterEach(async () => { await mf?.dispose(); });

describe('consent payload schema upgrade', () => {
  it.each(['migration', 'lazy'])('preserves legacy submissions using %s initialization', async (mode) => {
    mf = new Miniflare({ modules: true, script: 'export default { fetch() { return new Response("ok"); } };',
      compatibilityDate: '2024-12-01', d1Databases: ['DB'] });
    const db = await mf.getD1Database('DB') as unknown as D1Database;
    const migrate = async (name: string) => {
      const sql = readFileSync(new URL(`../migrations/${name}`, import.meta.url), 'utf8');
      await db.batch(sql.replace(/^--.*$/gm, '').split(';').map(s => s.trim()).filter(Boolean).map(s => db.prepare(s)));
    };
    // Keep the supporting tables, then reconstruct the pre-0018 submission schema.
    await ensureSchema(db);
    await db.prepare('DROP TABLE age_review_parent_consent_submissions').run();
    await db.prepare('DROP TABLE age_review_consent_objects').run();
    await migrate('0014_parent_consent_submissions.sql');
    await migrate('0015_parent_consent_r2.sql');
    await db.prepare(`INSERT INTO age_review_parent_consent_submissions
      (case_id, status, created_at, object_key) VALUES ('legacy', 'stored', 1, 'legacy-key')`).run();
    if (mode === 'migration') await migrate('0018_parent_consent_payload.sql');
    await ensureSchema(db);
    await ensureSchema(db);
    expect(await db.prepare("SELECT status, object_key, payload_hash FROM age_review_parent_consent_submissions WHERE case_id = 'legacy'").first())
      .toEqual({ status: 'stored', object_key: 'legacy-key', payload_hash: null });
    await db.prepare(`INSERT INTO age_review_consent_objects (object_key, case_id, created_at)
      VALUES ('test-key', 'legacy', 1)`).run();
    expect(await db.prepare("SELECT state FROM age_review_consent_objects WHERE object_key = 'test-key'").first()).toEqual({ state: 'pending' });
  });
});
