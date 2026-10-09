// Real-D1 (Miniflare SQLite) validation that ensureBulkJobsTable adds the
// media_skipped column (#291) and the kind column (#294) to a bulk_jobs table
// created before either existed, that the status endpoint reads both back, and
// that adding them again is a no-op. Unit tests use an in-memory mock
// that accepts any column name, so only real SQL can catch a missing column.
import { Miniflare } from 'miniflare';
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { ensureBulkJobsTable, handleBulkJobStatus } from '../src/bulk-moderate';

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

describe('bulk_jobs media_skipped and kind columns', () => {
  it('are both added to a table created before either existed, and read back', async () => {
    // The table as deployed before #291 and #294.
    await DB.prepare(`CREATE TABLE bulk_jobs (
      job_id TEXT PRIMARY KEY, pubkey TEXT NOT NULL, action TEXT NOT NULL, status TEXT NOT NULL,
      events_processed INTEGER NOT NULL DEFAULT 0, media_processed INTEGER NOT NULL DEFAULT 0,
      failures TEXT NOT NULL DEFAULT '[]', failures_dropped INTEGER NOT NULL DEFAULT 0,
      version INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`).run();
    await DB.prepare(`INSERT INTO bulk_jobs (job_id, pubkey, action, status, created_at, updated_at)
      VALUES ('old-job', ?, 'age-gate-all', 'done', 't', 't')`).bind('a'.repeat(64)).run();

    await ensureBulkJobsTable(DB);

    const columns = await DB.prepare('PRAGMA table_info(bulk_jobs)').all<{ name: string }>();
    expect(columns.results.map((c) => c.name)).toEqual(expect.arrayContaining(['media_skipped', 'kind']));

    const old = await (await handleBulkJobStatus('old-job', { DB } as never, {})).json() as Record<string, unknown>;
    expect(old).toMatchObject({ mediaSkipped: 0 });
    expect('kind' in old).toBe(false);

    await DB.prepare(`UPDATE bulk_jobs SET media_skipped = 4 WHERE job_id = 'old-job'`).run();
    const updated = await handleBulkJobStatus('old-job', { DB } as never, {});
    expect(await updated.json()).toMatchObject({ mediaSkipped: 4 });

    await DB.prepare(`INSERT INTO bulk_jobs (job_id, pubkey, action, status, created_at, updated_at, kind)
      VALUES ('kind-job', ?, 'delete-kind', 'done', 't', 't', 7)`).bind('a'.repeat(64)).run();
    const kindJob = await handleBulkJobStatus('kind-job', { DB } as never, {});
    expect(await kindJob.json()).toMatchObject({ kind: 7, mediaSkipped: 0 });
  });

  it('adds nothing and keeps every row when both columns are already there', async () => {
    // A fresh isolate's first call runs every ALTER again, against a table that
    // already has the columns (the module memoizes per isolate).
    vi.resetModules();
    const fresh = await import('../src/bulk-moderate');
    await fresh.ensureBulkJobsTable(DB);

    const columns = await DB.prepare('PRAGMA table_info(bulk_jobs)').all<{ name: string }>();
    const names = columns.results.map((c) => c.name);
    expect(names.filter((n) => n === 'media_skipped' || n === 'kind')).toEqual(['media_skipped', 'kind']);
    expect(await (await fresh.handleBulkJobStatus('old-job', { DB } as never, {})).json()).toMatchObject({ mediaSkipped: 4 });
    expect(await (await fresh.handleBulkJobStatus('kind-job', { DB } as never, {})).json()).toMatchObject({ kind: 7 });
  });
});
