// Real-D1 (Miniflare SQLite) validation for getActiveAgeReviewCase, the lookup
// behind the age-review guard and the bulk queue consumer's per-chunk check
// (#290). Unit tests stub D1 and cannot see the query's WHERE clause or binds;
// this pins the terminal-state filter and the pubkey scoping against real SQL.
import { Miniflare } from 'miniflare';
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import worker from '../src/index';
import { ensureSchema } from '../src/db';
import { getActiveAgeReviewCase } from '../src/age-review-lookup';
import { ageReviewActiveGuard } from '../src/age-review';
import { handleBulkJobStatus, handleBulkModerateEnqueue, processBulkJob } from '../src/bulk-moderate';
import type { BulkEnqueueResponse, BulkJob, BulkJobMessage } from '../../shared/bulk-moderation';

let mf: Miniflare;
let DB: D1Database;

const PK = 'a'.repeat(64);
const OTHER_PK = 'b'.repeat(64);

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

let seq = 0;
async function insertCase(pubkey: string, state: string) {
  seq += 1;
  await DB.prepare(
    `INSERT INTO age_review_cases (id, pubkey, state, suspected_age_band, deadline_at, clock_paused, version)
     VALUES (?, ?, ?, 'under_13', ?, 0, 0)`,
  ).bind(`c${seq}`, pubkey, state, new Date(Date.now() + 9 * 864e5).toISOString()).run();
}

beforeEach(async () => {
  await ensureSchema(DB);
  await DB.prepare('DELETE FROM age_review_cases').run();
  seq = 0;
});

describe('getActiveAgeReviewCase', () => {
  it('finds a non-terminal case for the pubkey', async () => {
    await insertCase(PK, 'restricted_pending_user_response');
    const found = await getActiveAgeReviewCase(PK, { DB });
    expect(found?.pubkey).toBe(PK);
    expect(found?.state).toBe('restricted_pending_user_response');
  });

  it.each(['cleared', 'denied_closed'])('ignores a %s (terminal) case, so the account is not held forever', async (state) => {
    await insertCase(PK, state);
    expect(await getActiveAgeReviewCase(PK, { DB })).toBeNull();
  });

  it('finds the open case among terminal ones', async () => {
    await insertCase(PK, 'cleared');
    await insertCase(PK, 'open_reported');
    expect((await getActiveAgeReviewCase(PK, { DB }))?.state).toBe('open_reported');
  });

  it("does not report another account's open case", async () => {
    await insertCase(OTHER_PK, 'open_reported');
    expect(await getActiveAgeReviewCase(PK, { DB })).toBeNull();
  });

  it('returns null with no DB binding', async () => {
    expect(await getActiveAgeReviewCase(PK, {})).toBeNull();
  });
});

// A case's pubkey is the report's `p` tag as written, so a case can be stored
// in uppercase while every caller asks in lowercase (#313). The lookup matches
// it only for the callers that would lift a hold by missing it: reversals,
// loosening bulk actions, a note's Restore and the active-case route. Suspend
// and the enforcing bulk actions match exactly, as before: matching there
// would keep no hold, only refuse enforcement.
describe('a case stored under an uppercase pubkey', () => {
  const MIXED = 'Ab'.repeat(32);
  const LOWER = MIXED.toLowerCase();
  const TEST_NSEC = 'nsec1vl029mgpspedva04g90vltkh6fvh240zqtv9k0t9af8935ke9laqsnlfe5';

  beforeEach(async () => { await insertCase(MIXED.toUpperCase(), 'open_reported'); });

  it('is found by the lowercase pubkey only when asked to match any case', async () => {
    expect(await getActiveAgeReviewCase(LOWER, { DB })).toBeNull();
    expect((await getActiveAgeReviewCase(LOWER, { DB }, { anyCase: true }))?.id).toBe('c1');
  });

  // Until #313 an account can have an open case under each spelling (an exact
  // insert beside an uppercase report case). The one stored as asked comes
  // first, wherever it sits in the table, so the route names the case main does.
  it('answers the case stored exactly as asked before one stored in uppercase', async () => {
    await insertCase(LOWER, 'open_reported'); // c2; c1 is the uppercase one
    expect((await getActiveAgeReviewCase(LOWER, { DB }, { anyCase: true }))?.id).toBe('c2');
    expect((await getActiveAgeReviewCase(MIXED.toUpperCase(), { DB }, { anyCase: true }))?.id).toBe('c1');
  });

  it('holds the guard when it fails closed, and only then', async () => {
    const held = await ageReviewActiveGuard(LOWER, { DB } as never, {}, 'held', { failClosed: true });
    expect(held?.status).toBe(409);
    expect(await held?.json()).toMatchObject({ code: 'age_review_active', caseId: 'c1' });
    expect(await ageReviewActiveGuard(LOWER, { DB } as never, {}, 'held')).toBeNull();
  });

  let queued: BulkJobMessage[] = [];
  beforeEach(() => { queued = []; });
  const env = () => ({
    ADMIN_API_KEY: 'k',
    SERVICE_API_TOKEN: 'service-token',
    MODERATION_SERVICE_URL: 'https://moderation.example',
    MODERATION_ADMIN_URL: 'https://moderation.example',
    BLOSSOM_WEBHOOK_SECRET: 'blossom-secret',
    CDN_DOMAIN: 'media.example',
    RELAY_URL: 'wss://relay.example',
    NOSTR_NSEC: TEST_NSEC,
    BULK_QUEUE: { send: async (m: BulkJobMessage) => { queued.push(m); } },
    DB,
  }) as never;

  // Every outbound call is answered here, and every waitUntil task settles
  // before the stub is removed, so nothing leaves the test.
  async function send(path: string, body?: unknown) {
    const tasks: Promise<unknown>[] = [];
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => Response.json({ result: true, success: true }));
    try {
      const res = await worker.fetch(
        new Request(`https://relay.example${path}`, body === undefined
          ? { headers: { 'X-Admin-Key': 'k' } }
          : { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Admin-Key': 'k' }, body: JSON.stringify(body) }),
        env(), { waitUntil: (task: Promise<unknown>) => { tasks.push(task); } } as unknown as ExecutionContext,
      );
      const json = await res.json() as Record<string, unknown>;
      await Promise.allSettled(tasks);
      return { status: res.status, json, outbound: fetchSpy.mock.calls.length };
    } finally {
      fetchSpy.mockRestore();
    }
  }

  // What the case hand-off and the panel's pause ask.
  it('is the open case the active-case route answers', async () => {
    const res = await send(`/api/age-review/active-case?pubkey=${LOWER}`);
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ success: true, case: { id: 'c1' } });
  });

  it("refuses a note's Restore, and writes nothing", async () => {
    const res = await send('/api/moderate-media', { sha256: '5'.repeat(64), action: 'SAFE', from: 'QUARANTINE', pubkey: LOWER });
    expect(res.status).toBe(409);
    expect(res.json).toMatchObject({ code: 'age_review_active', caseId: 'c1' });
    expect(res.outbound).toBe(0);
  });

  it.each(['unbanpubkey', 'unsuspendpubkey'])('refuses relay-RPC %s, and sends nothing', async (method) => {
    const res = await send('/api/relay-rpc', { method, params: [LOWER] });
    expect(res.status).toBe(409);
    expect(res.json).toMatchObject({ code: 'age_review_active', caseId: 'c1' });
    expect(res.outbound).toBe(0);
  });

  it('lets relay-RPC suspendpubkey through to the relay', async () => {
    const res = await send('/api/relay-rpc', { method: 'suspendpubkey', params: [LOWER, 'policy'] });
    expect(res).toMatchObject({ status: 200, json: { success: true } });
    expect(res.outbound).toBeGreaterThan(0);
  });

  it.each(['age-gate-all', 'un-age-restrict-all'])('refuses the bulk %s, and queues nothing', async (action) => {
    const res = await send('/api/bulk-moderate', { pubkey: LOWER, action });
    expect(res.status).toBe(409);
    expect(res.json).toMatchObject({ code: 'age_review_active', caseId: 'c1' });
    expect(queued).toEqual([]);
  });

  it.each(['delete-all', 'age-restrict-all'])('queues the bulk %s', async (action) => {
    const res = await send('/api/bulk-moderate', { pubkey: LOWER, action });
    expect(res).toMatchObject({ status: 200, json: { success: true } });
    expect(queued).toEqual([expect.objectContaining({ pubkey: LOWER, action })]);
  });

  // A loosening job queued before the case opened stops at its next chunk.
  it('stops a queued Un-age-restrict All before its next chunk sends anything', async () => {
    const enqueued = await handleBulkModerateEnqueue(new Request('https://relay.example/api/bulk-moderate', {
      method: 'POST', body: JSON.stringify({ pubkey: LOWER, action: 'un-age-restrict-all' }),
    }), env(), {});
    const { jobId } = await enqueued.json() as BulkEnqueueResponse;
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => Response.json({}));
    try {
      await processBulkJob(queued[0], env());
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
    const job = await (await handleBulkJobStatus(jobId, env(), {})).json() as BulkJob;
    expect(job.status).toBe('failed');
    expect(job.failures.join('\n')).toContain(`stopped: ${LOWER} is under age review`);
  });
});
