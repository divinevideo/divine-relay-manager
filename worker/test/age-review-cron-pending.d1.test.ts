// Real-D1 (Miniflare SQLite) check of the expiry cron's pending auto-delete
// line (#299): kept under the case's notes key as soon as the cron closes the
// case, read back through the routes the case screen uses, and cleared once
// the auto-delete has run, leaving a failed delete's own lines. The bulk run is
// stubbed; the notes SQL and the routes are real.
import { Miniflare } from 'miniflare';
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { ensureSchema } from '../src/db';
import { checkAgeReviewDeadlines } from '../src/age-review';
import { deleteBulkFailure, ensureBulkNotesTable, handleBulkJobNotes, handleCaseBulkNotesJob, storeBulkNotes } from '../src/bulk-notes';
import { runBulkModeration } from '../src/bulk-moderate';
import { autoDeletePendingWarning, bulkLegStoppedWarning, type BulkNotesPage } from '../../shared/bulk-moderation';

vi.mock('../src/bulk-moderate', () => ({ runBulkModeration: vi.fn() }));

const PUBKEY = 'a'.repeat(64);
const CASE_ID = 'case-expired';
const JOB = `age-review:${CASE_ID}:1:denied_closed`;
const DONE = { success: true, eventsProcessed: 0, mediaProcessed: 0, mediaSkipped: 0, failures: [], notes: [] };

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
  await DB.prepare('DELETE FROM age_review_cases').run();
  await DB.prepare('DELETE FROM age_review_config').run();
  await ensureBulkNotesTable(DB);
  await DB.prepare('DELETE FROM bulk_job_notes').run();
  await DB.prepare(
    `INSERT INTO age_review_cases (id, pubkey, state, deadline_at, clock_paused, version)
     VALUES (?, ?, 'restricted_pending_user_response', '2020-01-01T00:00:00.000Z', 0, 0)`,
  ).bind(CASE_ID, PUBKEY).run();
  vi.mocked(runBulkModeration).mockReset();
  // Nothing leaves the test: the ban legs have no bindings, and any fetch fails.
  vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('no network in this test'));
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => { vi.restoreAllMocks(); });

// What the case screen reads: the case's latest notes key, then its lines.
async function caseScreen(): Promise<{ jobId: string | null; failures: string[] }> {
  const { jobId } = await (await handleCaseBulkNotesJob(CASE_ID, { DB }, {})).json() as { jobId: string | null };
  if (!jobId) return { jobId, failures: [] };
  const page = await (await handleBulkJobNotes(jobId, null, null, { DB }, {})).json() as BulkNotesPage;
  return { jobId, failures: page.failures ?? [] };
}

describe("the expiry cron's pending auto-delete line on real D1", () => {
  it('shows on the case screen while the delete has not run, and is gone once it has', async () => {
    let finish!: () => void;
    vi.mocked(runBulkModeration).mockImplementationOnce(() => new Promise((resolve) => { finish = () => resolve(DONE as never); }));
    const run = checkAgeReviewDeadlines({ DB } as never);
    await vi.waitFor(() => expect(runBulkModeration).toHaveBeenCalledOnce());

    expect(await caseScreen()).toEqual({ jobId: JOB, failures: [autoDeletePendingWarning(PUBKEY)] });

    finish();
    await run;
    expect(await caseScreen()).toEqual({ jobId: null, failures: [] });
  });

  it("is cleared after a failed delete, whose own line stays", async () => {
    vi.mocked(runBulkModeration).mockRejectedValueOnce(new Error('Relay query timed out before EOSE'));
    await checkAgeReviewDeadlines({ DB } as never);

    expect(await caseScreen()).toEqual({
      jobId: JOB,
      failures: [bulkLegStoppedWarning(PUBKEY, 'Relay query timed out before EOSE')],
    });
  });

  // The same account can have the same line kept under two cases (or two
  // closes of one case): the clear takes only the job it names.
  it("clears only the named job's line", async () => {
    const other = 'age-review:case-other:3:denied_closed';
    await storeBulkNotes(DB, JOB, [], [autoDeletePendingWarning(PUBKEY)]);
    await storeBulkNotes(DB, other, [], [autoDeletePendingWarning(PUBKEY)]);

    expect(await deleteBulkFailure(DB, JOB, autoDeletePendingWarning(PUBKEY))).toBe(1);

    const left = await DB.prepare('SELECT job_id, kind, detail FROM bulk_job_notes ORDER BY job_id').all();
    expect(left.results).toEqual([{ job_id: other, kind: 'failure', detail: autoDeletePendingWarning(PUBKEY) }]);
  });
});
