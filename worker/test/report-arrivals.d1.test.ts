// Real-D1 (Miniflare SQLite) validation for the report arrival log (#324).
// The first time the watcher sees a report is the only clock the reporter
// cannot set, so the first write must win and reads must chunk past D1's
// bound-parameter limit.
import { Miniflare } from 'miniflare';
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { ensureSchema } from '../src/db';
import { recordReportArrival, readReportArrivals } from '../src/report-arrivals';

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
afterAll(async () => { await mf?.dispose(); });

beforeEach(async () => {
  await ensureSchema(DB);
  await DB.prepare('DELETE FROM report_arrivals').run();
});

describe('report_arrivals', () => {
  it('ensureSchema is idempotent', async () => {
    await ensureSchema(DB);
    await ensureSchema(DB);
    const row = await DB.prepare(`SELECT name FROM sqlite_master WHERE name = 'report_arrivals'`).first();
    expect(row).not.toBeNull();
  });

  it('keeps the first arrival when the same report is recorded again', async () => {
    await recordReportArrival(DB, 'a', 100);
    await recordReportArrival(DB, 'a', 200);
    expect((await readReportArrivals(DB, ['a'])).get('a')).toBe(100);
  });

  it('reads more ids than one statement holds, skipping unknown ids', async () => {
    const all = Array.from({ length: 250 }, (_, i) => `id${i}`);
    const stored = all.filter((_, i) => i % 2 === 0);
    for (const id of stored) await recordReportArrival(DB, id, 7);
    const found = await readReportArrivals(DB, all);
    expect([...found.keys()].sort()).toEqual([...stored].sort());
    expect(found.get('id0')).toBe(7);
    expect(found.has('id1')).toBe(false);
  });

  it('returns an empty map for no ids', async () => {
    expect((await readReportArrivals(DB, [])).size).toBe(0);
  });
});
