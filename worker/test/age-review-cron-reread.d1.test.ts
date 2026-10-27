// Real-D1 (Miniflare SQLite) check of the expiry cron's close (#299): its CAS,
// the note it writes, and the re-read after a close that committed and then
// threw (the response lost after commit). Only the close's run() is wrapped:
// it runs the real UPDATE and then throws. Every other statement is real; the
// bulk run is stubbed.
import { Miniflare } from 'miniflare';
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { ensureSchema } from '../src/db';
import { checkAgeReviewDeadlines } from '../src/age-review';
import { ensureBulkNotesTable } from '../src/bulk-notes';
import { runBulkModeration } from '../src/bulk-moderate';
import { autoDeletePendingWarning } from '../../shared/bulk-moderation';

vi.mock('../src/bulk-moderate', () => ({ runBulkModeration: vi.fn() }));

const PUBKEY = 'a'.repeat(64);
const CASE_ID = 'case-expired';
const CRON_NOTE = 'Auto-closed: deadline expired with no response';
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
     VALUES (?, ?, 'restricted_pending_user_response', '2020-01-01T00:00:00.000Z', 0, 3)`,
  ).bind(CASE_ID, PUBKEY).run();
  vi.mocked(runBulkModeration).mockReset().mockResolvedValue(DONE as never);
  // Nothing leaves the test: the ban legs have no bindings, and any fetch fails.
  vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('no network in this test'));
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => { vi.restoreAllMocks(); });

// The real DB, except that the cron's close runs through `hook`, which is
// handed the real run().
function withCloseHook(hook: (run: () => Promise<D1Result>) => Promise<D1Result>): D1Database {
  return new Proxy(DB, {
    get(target, prop) {
      if (prop !== 'prepare') return Reflect.get(target, prop).bind?.(target) ?? Reflect.get(target, prop);
      return (sql: string) => {
        const stmt = target.prepare(sql);
        if (!sql.includes("SET state = 'denied_closed'")) return stmt;
        return new Proxy(stmt, {
          get(s, p) {
            if (p !== 'bind') return Reflect.get(s, p).bind?.(s) ?? Reflect.get(s, p);
            return (...binds: unknown[]) => {
              const bound = s.bind(...binds);
              return { run: () => hook(() => bound.run()) };
            };
          },
        });
      };
    },
  }) as D1Database;
}

const commitsThenThrows = () => withCloseHook(async (run) => {
  await run();
  throw new Error('D1_ERROR: Network connection lost.');
});

const caseRow = () => DB.prepare('SELECT state, version, resolution_note FROM age_review_cases WHERE id = ?')
  .bind(CASE_ID).first();

describe("the expiry cron's close on real D1", () => {
  it("writes the cron's note, exactly, at the next version", async () => {
    await checkAgeReviewDeadlines({ DB } as never);
    expect(await caseRow()).toEqual({ state: 'denied_closed', version: 4, resolution_note: CRON_NOTE });
  });

  it('carries a close that committed and then threw on as closed, and deletes', async () => {
    await checkAgeReviewDeadlines({ DB: commitsThenThrows() } as never);

    expect(await caseRow()).toEqual({ state: 'denied_closed', version: 4, resolution_note: CRON_NOTE });
    expect(console.log).toHaveBeenCalledWith('[age-review] Close threw but had committed; continuing as closed');
    expect(runBulkModeration).toHaveBeenCalledOnce();
    expect(runBulkModeration).toHaveBeenCalledWith(expect.anything(), PUBKEY, 'delete-all', expect.any(String));
  });

  it('keeps the pending line for a close that committed and then threw, and clears it after the delete', async () => {
    let finish!: () => void;
    vi.mocked(runBulkModeration).mockImplementationOnce(() => new Promise((resolve) => { finish = () => resolve(DONE as never); }));
    const run = checkAgeReviewDeadlines({ DB: commitsThenThrows() } as never);
    await vi.waitFor(() => expect(runBulkModeration).toHaveBeenCalledOnce());

    const kept = await DB.prepare('SELECT job_id, kind, detail FROM bulk_job_notes').all();
    expect(kept.results).toEqual([{ job_id: `age-review:${CASE_ID}:4:denied_closed`, kind: 'failure', detail: autoDeletePendingWarning(PUBKEY) }]);

    finish();
    await run;
    expect((await DB.prepare('SELECT COUNT(*) AS n FROM bulk_job_notes').first<{ n: number }>())?.n).toBe(0);
  });

  // The close's CAS: a moderator who acts between the cron's read and its
  // close wins, and the cron leaves the case alone.
  it('does not close a case whose version changed before the close', async () => {
    const db = withCloseHook(async (run) => {
      await DB.prepare("UPDATE age_review_cases SET state = 'cleared', version = version + 1 WHERE id = ?").bind(CASE_ID).run();
      return run();
    });
    await checkAgeReviewDeadlines({ DB: db } as never);

    expect(await caseRow()).toEqual({ state: 'cleared', version: 4, resolution_note: null });
    expect(console.log).toHaveBeenCalledWith('[age-review] Skipped expired case modified concurrently');
    expect(runBulkModeration).not.toHaveBeenCalled();
  });
});
