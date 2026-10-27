// Real-D1 (Miniflare SQLite) validation of the bulk_job_notes table (#299):
// created on demand beside an existing bulk_jobs table, each note stored once
// however often a job meets it, read back in full a page at a time in the
// order stored, and counted on the job's status once it ends. The unit tests'
// in-memory D1 accepts any SQL, so only real SQL can catch a broken statement.
import { Miniflare } from 'miniflare';
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { ensureBulkJobsTable, handleBulkJobStatus } from '../src/bulk-moderate';
import { handleBulkJobNotes, handleCaseBulkNotesJob, storeBulkNotes } from '../src/bulk-notes';
import { ageReviewNotesJobId, type BulkJob, type BulkNote, type BulkNotesPage } from '../../shared/bulk-moderation';

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

// Age review keeps each transition's notes under age-review:<case>:<version>:<state>
// (ageReviewNotesJobId), and the case screen asks for its case's latest.
describe("an age-review case's notes", () => {
  async function latestFor(caseId: string) {
    return handleCaseBulkNotesJob(caseId, { DB } as never, {});
  }

  it("finds the case's most recent transition with notes, and reads its notes back in full", async () => {
    await ensureBulkJobsTable(DB);
    await storeBulkNotes(DB, ageReviewNotesJobId('case-1', 2, 'restricted_pending_user_response'), notesFor(3));
    await storeBulkNotes(DB, ageReviewNotesJobId('case-10', 5, 'cleared'), notesFor(2, 100));
    await storeBulkNotes(DB, ageReviewNotesJobId('case-1', 3, 'cleared'), notesFor(4, 200));
    await storeBulkNotes(DB, 'job-unrelated', notesFor(1, 300));

    const one = await latestFor('case-1');
    expect(one.status).toBe(200);
    const { jobId, state, keptAt } = await one.json() as { jobId: string | null; state?: string; keptAt?: string };
    expect(jobId).toBe('age-review:case-1:3:cleared');
    // The step and its time, so the case screen need not parse the key.
    expect(state).toBe('cleared');
    expect(Number.isNaN(Date.parse(keptAt!))).toBe(false);
    expect(await readAll(jobId!, 3)).toEqual(notesFor(4, 200));

    expect(await (await latestFor('case-10')).json()).toMatchObject({ jobId: 'age-review:case-10:5:cleared' });
    expect(await (await latestFor('case-2')).json()).toEqual({ jobId: null });
  });

  it('answers none for a case on a database that has no notes table yet', async () => {
    const fresh = new Miniflare({
      modules: true,
      script: 'export default { fetch() { return new Response("ok"); } };',
      compatibilityDate: '2024-12-01',
      compatibilityFlags: ['nodejs_compat'],
      d1Databases: ['DB'],
    });
    try {
      const empty = (await fresh.getD1Database('DB')) as unknown as D1Database;
      vi.resetModules();
      const mod = await import('../src/bulk-notes');
      const res = await mod.handleCaseBulkNotesJob('case-1', { DB: empty } as never, {});
      expect(await res.json()).toEqual({ jobId: null });
    } finally {
      await fresh.dispose();
    }
  });

  it('refuses a case id that could reach into another case', async () => {
    expect((await latestFor('case-1:3')).status).toBe(400);
  });

  it('says when the latest transition kept its notes', async () => {
    await storeBulkNotes(DB, ageReviewNotesJobId('case-when', 2, 'cleared'), notesFor(1));
    const { jobId, keptAt } = await (await latestFor('case-when')).json() as { jobId: string; keptAt: string };
    expect(jobId).toBe('age-review:case-when:2:cleared');
    expect(Number.isNaN(Date.parse(keptAt))).toBe(false);
  });
});

// Age review keeps a transition's failures beside its notes (#299), so the
// case screen can show both after a reload.
describe('failures kept beside notes', () => {
  async function readPages(jobId: string, limit: number) {
    const notes: BulkNote[] = [];
    const failures: string[] = [];
    let after: string | null = null;
    for (;;) {
      const page = await (await handleBulkJobNotes(jobId, after, String(limit), { DB } as never, {})).json() as BulkNotesPage;
      notes.push(...page.notes);
      failures.push(...(page.failures ?? []));
      if (page.next === null) return { notes, failures };
      after = page.next;
    }
  }

  it('stores failures once each, reads them back apart from the notes, in the order stored', async () => {
    const failures = ['enumeration:x:list failed', 'media:' + hash(1) + ':write failed', 'enumeration:x:list failed'];
    await storeBulkNotes(DB, 'age-review:case-f:4:cleared', notesFor(3), failures);
    const read = await readPages('age-review:case-f:4:cleared', 2);
    expect(read.failures).toEqual(['enumeration:x:list failed', 'media:' + hash(1) + ':write failed']);
    expect(read.notes).toEqual(notesFor(3));
  });

  it('binds at most 100 parameters per statement with failures too', async () => {
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
    const failures = Array.from({ length: 40 }, (_, i) => `media:${hash(i)}:failed`);
    await storeBulkNotes(recording as D1Database, 'job-mixed', notesFor(60), failures);
    expect(Math.max(...binds)).toBeLessThanOrEqual(100);
    const read = await readPages('job-mixed', 1000);
    expect(read.failures).toHaveLength(40);
    expect(read.notes).toHaveLength(60);
  });
});

// A guarded restore marks the file's still-hidden notes restored (#299), so a
// reload shows it.
