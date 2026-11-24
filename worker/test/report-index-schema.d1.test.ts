// Real-D1 (Miniflare SQLite) validation of the report index and resolution label tables.
import { readFileSync } from 'node:fs';
import { Miniflare } from 'miniflare';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { ensureSchema } from '../src/db';

const TABLES = ['report_index', 'report_index_refs', 'report_index_meta', 'resolution_labels'];

const miniflareOptions = {
  modules: true,
  script: 'export default { fetch() { return new Response("ok"); } };',
  compatibilityDate: '2024-12-01',
  compatibilityFlags: ['nodejs_compat'],
  d1Databases: ['DB'],
};

let mf: Miniflare;
let DB: D1Database;

beforeAll(async () => {
  mf = new Miniflare(miniflareOptions);
  DB = (await mf.getD1Database('DB')) as unknown as D1Database;
  await ensureSchema(DB);
});
afterAll(async () => { await mf?.dispose(); });

const insertReport = (source: string, hidden: string | null = null) =>
  DB.prepare(`INSERT INTO report_index (report_id, created_at, reporter_pubkey, source, indexed_at, hidden_reason)
    VALUES (?, 1, 'a', ?, 1, ?)`).bind(`r-${Math.random()}`, source, hidden).run();

describe('report index schema', () => {
  it('ensureSchema creates the four report-index tables and is idempotent', async () => {
    await ensureSchema(DB);
    await ensureSchema(DB);
    for (const t of TABLES) {
      expect(await DB.prepare(`SELECT name FROM sqlite_master WHERE name = ?`).bind(t).first()).not.toBeNull();
    }
  });

  it('migration 0022 produces the same columns as ensureSchema', async () => {
    const fresh = new Miniflare(miniflareOptions);
    try {
      const db2 = (await fresh.getD1Database('DB')) as unknown as D1Database;
      const sql = readFileSync(new URL('../migrations/0022_report_index.sql', import.meta.url), 'utf8');
      await db2.batch(sql.replace(/^\s*--.*$/gm, '').split(';').map(s => s.trim()).filter(Boolean).map(s => db2.prepare(s)));
      const info = async (d: D1Database, t: string) =>
        (await d.prepare(`SELECT name, type, "notnull" AS nn, dflt_value, pk FROM pragma_table_info('${t}')`).all()).results;
      for (const t of TABLES) {
        const fromMigration = await info(db2, t);
        expect(fromMigration.length).toBeGreaterThan(0);
        expect(fromMigration).toEqual(await info(DB, t));
      }
      const idx = async (d: D1Database) =>
        (await d.prepare(`SELECT name FROM pragma_index_list('report_index') ORDER BY name`).all()).results;
      const names = (await idx(db2)).map(r => r.name);
      expect(names).toEqual(expect.arrayContaining(['idx_report_index_created', 'idx_report_index_target', 'idx_report_index_live']));
      expect(names).toEqual((await idx(DB)).map(r => r.name));
    } finally { await fresh.dispose(); }
  });

  it('rejects an unknown source or hidden_reason', async () => {
    await expect(insertReport('x')).rejects.toThrow();
    await expect(insertReport('live', 'bogus')).rejects.toThrow();
    await expect(insertReport('live', 'reporter_banned')).resolves.toBeDefined();
  });
});
