// Real-D1 (Miniflare SQLite) validation of the report index write and lookup helpers.
import { Miniflare } from 'miniflare';
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { ensureSchema } from '../src/db';
import {
  indexReports,
  findUnseenReportIds,
  readMeta,
  metaStatement,
  reportIndexRefStatements,
  runStatements,
  type SignedReport,
} from '../src/report-index';
import { recordReportArrival } from '../src/report-arrivals';

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
  for (const t of ['report_index', 'report_index_refs', 'report_index_meta', 'report_arrivals']) {
    await DB.prepare(`DELETE FROM ${t}`).run();
  }
});

const hex = (n: number) => n.toString(16).padStart(64, '0');
const PK = 'a'.repeat(64);

function report(n: number, tags: string[][] = [['e', hex(n + 100000)], ['p', PK]]): SignedReport {
  return { id: hex(n), pubkey: PK, created_at: 1000 + n, kind: 1984, tags, content: `c${n}`, sig: 'f'.repeat(128) };
}

/** DB whose batch calls record their statement counts, to assert the 50-statement cap. */
function withBatchSizes(db: D1Database): { db: D1Database; sizes: number[] } {
  const sizes: number[] = [];
  const wrapped = new Proxy(db, {
    get(target, prop) {
      if (prop === 'batch') {
        return (statements: D1PreparedStatement[]) => { sizes.push(statements.length); return target.batch(statements); };
      }
      const v = Reflect.get(target, prop);
      return typeof v === 'function' ? v.bind(target) : v;
    },
  }) as D1Database;
  return { db: wrapped, sizes };
}

describe('report index helpers', () => {
  it('indexes 250 reports across statements within 100 parameters', async () => {
    const reports = Array.from({ length: 250 }, (_, i) => report(i + 1));
    const bound: number[] = [];
    const wrapped = new Proxy(DB, {
      get(target, prop) {
        if (prop === 'prepare') {
          return (sql: string) => {
            const stmt = target.prepare(sql);
            return new Proxy(stmt, {
              get(s, p) {
                if (p === 'bind') {
                  return (...args: unknown[]) => { bound.push(args.length); return s.bind(...args); };
                }
                const v = Reflect.get(s, p);
                return typeof v === 'function' ? v.bind(s) : v;
              },
            });
          };
        }
        const v = Reflect.get(target, prop);
        return typeof v === 'function' ? v.bind(target) : v;
      },
    }) as D1Database;

    await indexReports(wrapped, reports, 'live', 100);

    const count = await DB.prepare('SELECT COUNT(*) AS n FROM report_index').first<{ n: number }>();
    expect(count?.n).toBe(250);
    const refs = await DB.prepare('SELECT COUNT(*) AS n FROM report_index_refs').first<{ n: number }>();
    expect(refs?.n).toBe(500);
    expect(bound.length).toBeGreaterThan(2);
    expect(Math.max(...bound)).toBeLessThanOrEqual(100);
    const row = await DB.prepare('SELECT event_json FROM report_index WHERE report_id = ?').bind(hex(1)).first<{ event_json: string }>();
    expect(JSON.parse(row!.event_json)).toEqual(reports[0]);
    expect(Object.keys(JSON.parse(row!.event_json))).toEqual(['id', 'pubkey', 'created_at', 'kind', 'tags', 'content', 'sig']);
  });

  it('keeps the first source and indexed_at when a report is indexed again', async () => {
    const r = report(1);
    await indexReports(DB, [r], 'live', 100);
    await indexReports(DB, [r], 'full', 200);
    const row = await DB.prepare('SELECT source, indexed_at FROM report_index WHERE report_id = ?').bind(r.id).first<{ source: string; indexed_at: number }>();
    expect(row).toEqual({ source: 'live', indexed_at: 100 });
  });

  it('writes a ref for every e and p tag, lowercasing 64-hex values', async () => {
    const upper = 'AB'.repeat(32);
    const other = hex(77);
    const r = report(1, [['e', upper], ['e', other], ['p', PK]]);
    await indexReports(DB, [r], 'live', 100);
    const refs = await DB.prepare('SELECT ref_type, ref_value FROM report_index_refs WHERE report_id = ? ORDER BY ref_type, ref_value').bind(r.id).all<{ ref_type: string; ref_value: string }>();
    expect(refs.results).toHaveLength(3);
    expect(refs.results).toContainEqual({ ref_type: 'e', ref_value: upper.toLowerCase() });
    expect(refs.results).toContainEqual({ ref_type: 'e', ref_value: other });
    expect(refs.results).toContainEqual({ ref_type: 'p', ref_value: PK });
  });

  it('writes one ref row for 2,000 duplicate e tags, in one statement', async () => {
    const target = hex(55);
    // Same id in both casings: duplicates once lowercased.
    const tags = Array.from({ length: 2000 }, (_, i) => ['e', i % 2 ? target : target.toUpperCase()]);
    const r = report(2, tags);
    expect(reportIndexRefStatements(DB, [r])).toHaveLength(1);
    await indexReports(DB, [r], 'live', 100);
    const refs = await DB.prepare('SELECT ref_type, ref_value FROM report_index_refs WHERE report_id = ?').bind(r.id).all();
    expect(refs.results).toEqual([{ ref_type: 'e', ref_value: target }]);
  });

  it('sets the target from the first e tag, else the first p tag', async () => {
    const upper = 'CD'.repeat(32);
    const withE = report(1, [['p', PK], ['e', upper], ['e', hex(9)]]);
    const onlyP = report(2, [['p', 'EF'.repeat(32)]]);
    const none = report(3, []);
    await indexReports(DB, [withE, onlyP, none], 'live', 100);
    const get = (id: string) => DB.prepare('SELECT target_type, target_id FROM report_index WHERE report_id = ?').bind(id).first();
    expect(await get(withE.id)).toEqual({ target_type: 'event', target_id: upper.toLowerCase() });
    expect(await get(onlyP.id)).toEqual({ target_type: 'pubkey', target_id: 'ef'.repeat(32) });
    expect(await get(none.id)).toEqual({ target_type: null, target_id: null });
  });

  it('findUnseenReportIds excludes ids in report_index and in report_arrivals, across 250 ids', async () => {
    const ids = Array.from({ length: 250 }, (_, i) => hex(i + 1));
    await indexReports(DB, [report(1), report(150)], 'live', 100);
    await recordReportArrival(DB, hex(2), 100);
    await recordReportArrival(DB, hex(249), 100);
    const unseen = await findUnseenReportIds(DB, ids);
    expect(unseen.size).toBe(246);
    for (const seen of [1, 150, 2, 249]) expect(unseen.has(hex(seen))).toBe(false);
    expect(unseen.has(hex(3))).toBe(true);
    expect((await findUnseenReportIds(DB, [])).size).toBe(0);
  });

  it('findUnseenReportIds treats an id stored lowercase and queried uppercase as seen, and returns unseen ids lowercase', async () => {
    const stored = report(0xabc);
    await indexReports(DB, [stored], 'live', 100);
    await recordReportArrival(DB, hex(0xdef), 100);
    const fresh = 'AB'.repeat(32);
    const unseen = await findUnseenReportIds(DB, [stored.id.toUpperCase(), hex(0xdef).toUpperCase(), fresh]);
    expect([...unseen]).toEqual([fresh.toLowerCase()]);
  });

  it('indexReports sends at most 50 statements per batch call and indexes every report', async () => {
    const reports = Array.from({ length: 400 }, (_, i) => report(i + 1));
    const { db, sizes } = withBatchSizes(DB);
    await indexReports(db, reports, 'live', 100);
    expect(sizes.length).toBeGreaterThan(1);
    expect(Math.max(...sizes)).toBeLessThanOrEqual(50);
    const count = await DB.prepare('SELECT COUNT(*) AS n FROM report_index').first<{ n: number }>();
    expect(count?.n).toBe(400);
  });

  it('findUnseenReportIds sends at most 50 statements per batch call and merges results across groups', async () => {
    const ids = Array.from({ length: 3000 }, (_, i) => hex(i + 1));
    // One seen id in the first group, one in the last, one in report_arrivals in the middle.
    await indexReports(DB, [report(1), report(3000)], 'live', 100);
    await recordReportArrival(DB, hex(1500), 100);
    const { db, sizes } = withBatchSizes(DB);
    const unseen = await findUnseenReportIds(db, ids);
    expect(sizes.length).toBeGreaterThan(1);
    expect(Math.max(...sizes)).toBeLessThanOrEqual(50);
    expect(unseen.size).toBe(2997);
    for (const seen of [1, 1500, 3000]) expect(unseen.has(hex(seen))).toBe(false);
  });

  it('readMeta returns only stored keys; metaStatement overwrites', async () => {
    expect(await readMeta(DB)).toEqual({});
    await runStatements(DB, [metaStatement(DB, 'last_full_ok_at', 5), metaStatement(DB, 'watcher_last_alive_at', 7)]);
    expect(await readMeta(DB)).toEqual({ last_full_ok_at: 5, watcher_last_alive_at: 7 });
    await runStatements(DB, [metaStatement(DB, 'last_full_ok_at', 9)]);
    expect(await readMeta(DB)).toEqual({ last_full_ok_at: 9, watcher_last_alive_at: 7 });
  });
});
