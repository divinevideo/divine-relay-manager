// Real-D1 (Miniflare SQLite) validation that ensureBulkJobsTable adds the
// media_skipped column (#291) to a bulk_jobs table created before it existed,
// and that the status endpoint reads it back. Unit tests use an in-memory mock
// that accepts any column name, so only real SQL can catch a missing column.
import { Miniflare } from 'miniflare';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
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

describe('bulk_jobs media_skipped column', () => {
  it('is added to a table created before it existed, defaults to 0, and is read back', async () => {
    // The table as deployed before #291.
    await DB.prepare(`CREATE TABLE bulk_jobs (
      job_id TEXT PRIMARY KEY, pubkey TEXT NOT NULL, action TEXT NOT NULL, status TEXT NOT NULL,
      events_processed INTEGER NOT NULL DEFAULT 0, media_processed INTEGER NOT NULL DEFAULT 0,
      failures TEXT NOT NULL DEFAULT '[]', failures_dropped INTEGER NOT NULL DEFAULT 0,
      version INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`).run();
    await DB.prepare(`INSERT INTO bulk_jobs (job_id, pubkey, action, status, created_at, updated_at)
      VALUES ('old-job', ?, 'age-gate-all', 'done', 't', 't')`).bind('a'.repeat(64)).run();

    await ensureBulkJobsTable(DB);

    const columns = await DB.prepare('PRAGMA table_info(bulk_jobs)').all<{ name: string }>();
    expect(columns.results.map((c) => c.name)).toContain('media_skipped');

    const old = await handleBulkJobStatus('old-job', { DB } as never, {});
    expect(await old.json()).toMatchObject({ mediaSkipped: 0 });

    await DB.prepare(`UPDATE bulk_jobs SET media_skipped = 4 WHERE job_id = 'old-job'`).run();
    const updated = await handleBulkJobStatus('old-job', { DB } as never, {});
    expect(await updated.json()).toMatchObject({ mediaSkipped: 4 });
  });
});
