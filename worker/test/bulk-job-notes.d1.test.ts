// Real-D1 (Miniflare SQLite) validation of the bulk_job_notes table (#299):
// created on demand beside an existing bulk_jobs table, each note stored once
// however often a job meets it, read back in full a page at a time in the
// order stored, and counted on the job's status once it ends. The unit tests'
// in-memory D1 accepts any SQL, so only real SQL can catch a broken statement.
import { Miniflare } from 'miniflare';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { ensureBulkJobsTable, handleBulkJobStatus } from '../src/bulk-moderate';
import { handleBulkJobNotes, storeBulkNotes } from '../src/bulk-notes';
import type { BulkJob, BulkNote, BulkNotesPage } from '../../shared/bulk-moderation';

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

const hash = (i: number) => i.toString(16).padStart(64, '0');
const OWNER = 'b2'.repeat(32);

function notesFor(count: number, from = 0): BulkNote[] {
  return Array.from({ length: count }, (_, i) => (
    (from + i) % 2 === 0
      ? { kind: 'still-hidden' as const, sha256: hash(from + i) }
      : { kind: 'not-owned' as const, sha256: hash(from + i), owner: OWNER }
  ));
}

async function readAll(jobId: string, limit: number): Promise<BulkNote[]> {
  const all: BulkNote[] = [];
  let after: string | null = null;
  for (;;) {
    const res = await handleBulkJobNotes(jobId, after, String(limit), { DB } as never, {});
    expect(res.status).toBe(200);
    const page = await res.json() as BulkNotesPage;
    expect(page.notes.length).toBeLessThanOrEqual(limit);
    all.push(...page.notes);
    if (page.next === null) return all;
    after = page.next;
  }
}

describe('bulk_job_notes', () => {
  it('is created beside a bulk_jobs table that predates it, and stores, pages and counts notes', async () => {
    // bulk_jobs as deployed before #299.
    await DB.prepare(`CREATE TABLE bulk_jobs (
      job_id TEXT PRIMARY KEY, pubkey TEXT NOT NULL, action TEXT NOT NULL, status TEXT NOT NULL,
      events_processed INTEGER NOT NULL DEFAULT 0, media_processed INTEGER NOT NULL DEFAULT 0,
      failures TEXT NOT NULL DEFAULT '[]', failures_dropped INTEGER NOT NULL DEFAULT 0,
      version INTEGER NOT NULL DEFAULT 0, media_skipped INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL, kind INTEGER)`).run();
    await DB.prepare(`INSERT INTO bulk_jobs (job_id, pubkey, action, status, created_at, updated_at)
      VALUES ('job-a', ?, 'delete-all', 'running', 't', 't')`).bind('a'.repeat(64)).run();

    await ensureBulkJobsTable(DB);

    // 45 notes, then the first 30 again with 10 new: each is stored once.
    expect(await storeBulkNotes(DB, 'job-a', notesFor(45))).toBe(45);
    expect(await storeBulkNotes(DB, 'job-a', [...notesFor(30), ...notesFor(10, 45)])).toBe(10);
    // Another job's note with the same hash is its own.
    expect(await storeBulkNotes(DB, 'job-b', notesFor(1))).toBe(1);

    expect(await readAll('job-a', 7)).toEqual(notesFor(55));
    expect(await readAll('job-b', 7)).toEqual(notesFor(1));
    expect(await readAll('job-none', 7)).toEqual([]);

    // A last page that is exactly full still ends the walk: the route reads one
    // row past the page to know, so no empty page is asked for.
    expect(await storeBulkNotes(DB, 'job-full', notesFor(14))).toBe(14);
    const first = await (await handleBulkJobNotes('job-full', null, '7', { DB } as never, {})).json() as BulkNotesPage;
    expect(first.notes).toEqual(notesFor(7));
    expect(first.next).not.toBeNull();
    const second = await (await handleBulkJobNotes('job-full', first.next, '7', { DB } as never, {})).json() as BulkNotesPage;
    expect(second).toEqual({ notes: notesFor(14).slice(7), next: null });

    // Counted only once the job ends.
    const running = await (await handleBulkJobStatus('job-a', { DB } as never, {})).json() as BulkJob;
    expect('noteCount' in running).toBe(false);
    await DB.prepare(`UPDATE bulk_jobs SET status = 'done' WHERE job_id = 'job-a'`).run();
    const done = await (await handleBulkJobStatus('job-a', { DB } as never, {})).json() as BulkJob;
    expect(done.noteCount).toBe(55);
  });

  it('binds at most 100 parameters per statement, D1\'s limit, whatever the number of notes', async () => {
    const binds: number[] = [];
    const recording = new Proxy(DB, {
      get(target, prop, receiver) {
        if (prop === 'prepare') {
          return (sql: string) => {
            const stmt = target.prepare(sql);
            return new Proxy(stmt, {
              get(s, p, r) {
                if (p === 'bind') return (...args: unknown[]) => { binds.push(args.length); return s.bind(...args); };
                const value = Reflect.get(s, p, r);
                return typeof value === 'function' ? value.bind(s) : value;
              },
            });
          };
        }
        const value = Reflect.get(target, prop, receiver);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    expect(await storeBulkNotes(recording as D1Database, 'job-c', notesFor(101))).toBe(101);
    expect(binds.length).toBeGreaterThan(1);
    expect(Math.max(...binds)).toBeLessThanOrEqual(100);
    expect(await readAll('job-c', 50)).toEqual(notesFor(101));
  });
});
