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

// Every path opens cases under a lowercase pubkey (#313), so the lookup matches
// exactly everywhere. A case stored in another spelling is not found, and each
// negative test below is paired with one where the same caller does find the
// lowercase case, so they pin both that no caller widens the match again and
// that each caller still holds on the case it should.
describe('a case stored under an uppercase pubkey', () => {
  const MIXED = 'Ab'.repeat(32);
  const LOWER = MIXED.toLowerCase();
  const TEST_NSEC = 'nsec1vl029mgpspedva04g90vltkh6fvh240zqtv9k0t9af8935ke9laqsnlfe5';

  beforeEach(async () => { await insertCase(MIXED.toUpperCase(), 'open_reported'); });

  it('is not found by the lowercase pubkey', async () => {
    expect(await getActiveAgeReviewCase(LOWER, { DB })).toBeNull();
  });

  it('leaves the lowercase case to be found', async () => {
    await insertCase(LOWER, 'open_reported'); // c2; c1 is the uppercase one
    expect((await getActiveAgeReviewCase(LOWER, { DB }))?.id).toBe('c2');
  });

  it('does not hold the guard, even when it fails closed', async () => {
    expect(await ageReviewActiveGuard(LOWER, { DB } as never, {}, 'held', { failClosed: true })).toBeNull();
    expect(await ageReviewActiveGuard(LOWER, { DB } as never, {}, 'held')).toBeNull();
  });

  it('leaves the guard holding on the lowercase case', async () => {
    await insertCase(LOWER, 'open_reported');
    const held = await ageReviewActiveGuard(LOWER, { DB } as never, {}, 'held', { failClosed: true });
    expect(held?.status).toBe(409);
    expect(await held?.json()).toMatchObject({ code: 'age_review_active', caseId: 'c2' });
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

  it('is not the open case the active-case route answers', async () => {
    const res = await send(`/api/age-review/active-case?pubkey=${LOWER}`);
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ success: true, case: null });
  });

  it('leaves the active-case route answering the lowercase case', async () => {
    await insertCase(LOWER, 'open_reported');
    const res = await send(`/api/age-review/active-case?pubkey=${LOWER}`);
    expect(res.json).toMatchObject({ success: true, case: { id: 'c2' } });
  });

  it.each(['unbanpubkey', 'unsuspendpubkey'])('does not refuse relay-RPC %s', async (method) => {
    const res = await send('/api/relay-rpc', { method, params: [LOWER] });
    expect(res).toMatchObject({ status: 200, json: { success: true } });
    expect(res.outbound).toBeGreaterThan(0);
  });

  it.each(['unbanpubkey', 'unsuspendpubkey'])('leaves relay-RPC %s refused for the lowercase case, sending nothing', async (method) => {
    await insertCase(LOWER, 'open_reported');
    const res = await send('/api/relay-rpc', { method, params: [LOWER] });
    expect(res.status).toBe(409);
    expect(res.json).toMatchObject({ code: 'age_review_active', caseId: 'c2' });
    expect(res.outbound).toBe(0);
  });

  // The stubbed media server's answer is not a file record, so the Restore
  // stops later, at the owner read; what this pins is that the age-review guard
  // let it past (it went on to call out) rather than refusing it with a 409.
  it("does not hold a note's Restore at the age-review guard", async () => {
    const res = await send('/api/moderate-media', { sha256: '5'.repeat(64), action: 'SAFE', from: 'QUARANTINE', pubkey: LOWER });
    expect(res.status).not.toBe(409);
    expect(res.json).not.toMatchObject({ code: 'age_review_active' });
    expect(res.outbound).toBeGreaterThan(0);
  });

  it("leaves a note's Restore refused for the lowercase case, writing nothing", async () => {
    await insertCase(LOWER, 'open_reported');
    const res = await send('/api/moderate-media', { sha256: '5'.repeat(64), action: 'SAFE', from: 'QUARANTINE', pubkey: LOWER });
    expect(res.status).toBe(409);
    expect(res.json).toMatchObject({ code: 'age_review_active', caseId: 'c2' });
    expect(res.outbound).toBe(0);
  });

  it.each(['age-gate-all', 'un-age-restrict-all'])('does not refuse the bulk %s', async (action) => {
    const res = await send('/api/bulk-moderate', { pubkey: LOWER, action });
    expect(res).toMatchObject({ status: 200, json: { success: true } });
    expect(queued).toEqual([expect.objectContaining({ pubkey: LOWER, action })]);
  });

  it.each(['age-gate-all', 'un-age-restrict-all'])('leaves the bulk %s refused for the lowercase case, queueing nothing', async (action) => {
    await insertCase(LOWER, 'open_reported');
    const res = await send('/api/bulk-moderate', { pubkey: LOWER, action });
    expect(res.status).toBe(409);
    expect(res.json).toMatchObject({ code: 'age_review_active', caseId: 'c2' });
    expect(queued).toEqual([]);
  });

  // The per-chunk check the bulk queue consumer runs for a loosening job.
  it('does not stop a queued Un-age-restrict All at its next chunk', async () => {
    const enqueued = await handleBulkModerateEnqueue(new Request('https://relay.example/api/bulk-moderate', {
      method: 'POST', body: JSON.stringify({ pubkey: LOWER, action: 'un-age-restrict-all' }),
    }), env(), {}, undefined);
    expect(enqueued.status).toBe(200);
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => Response.json({}));
    try {
      await processBulkJob(queued[0], env());
      expect(fetchSpy).toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('leaves a queued Un-age-restrict All stopping at its next chunk for the lowercase case', async () => {
    const enqueued = await handleBulkModerateEnqueue(new Request('https://relay.example/api/bulk-moderate', {
      method: 'POST', body: JSON.stringify({ pubkey: LOWER, action: 'un-age-restrict-all' }),
    }), env(), {}, undefined);
    expect(enqueued.status).toBe(200);
    const { jobId } = await enqueued.json() as BulkEnqueueResponse;
    await insertCase(LOWER, 'open_reported'); // opened after the job was queued
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
