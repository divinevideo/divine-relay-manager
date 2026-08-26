import { Miniflare } from 'miniflare';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ensureSchema } from '../src/db';
import { handleGetModerationStatus } from '../src/age-review';

let mf: Miniflare;
let DB: D1Database;
const cors: Record<string, string> = {};

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
});

async function insertCase(
  id: string,
  pubkey: string,
  values: { deadline: string; paused?: boolean; pausedAt?: string; remaining?: number },
) {
  await DB.prepare(`
    INSERT INTO age_review_cases
      (id, pubkey, suspected_age_band, state, allowed_resolution, deadline_at,
       clock_paused, clock_paused_at, remaining_days_when_paused)
    VALUES (?, ?, 'age_13_15', 'restricted_pending_user_response',
            'parent_video_or_email', ?, ?, ?, ?)
  `).bind(
    id,
    pubkey,
    values.deadline,
    values.paused ? 1 : 0,
    values.pausedAt ?? null,
    values.remaining ?? null,
  ).run();
}

describe('moderation status response deadline on real D1', () => {
  it('normalizes a SQLite datetime deadline from a real row', async () => {
    const pubkey = 'a'.repeat(64);
    await insertCase('sqlite-deadline', pubkey, { deadline: '2099-08-26 09:30:00' });

    const res = await handleGetModerationStatus(pubkey, { DB }, cors);
    const body = await res.json() as { minorReviewCase: { responseDeadline: unknown } };

    expect(body.minorReviewCase.responseDeadline).toEqual({
      clock: 'running',
      deadlineAt: '2099-08-26T09:30:00.000Z',
      pausedAt: null,
      remainingDaysWhenPaused: null,
    });
  });

  it('returns paused timing without leaking the stale stored deadline', async () => {
    const pubkey = 'b'.repeat(64);
    await insertCase('paused-deadline', pubkey, {
      deadline: '2026-08-30T12:00:00.000Z',
      paused: true,
      pausedAt: '2026-08-25 10:15:00',
      remaining: 5.25,
    });

    const res = await handleGetModerationStatus(pubkey, { DB }, cors);
    const body = await res.json() as { minorReviewCase: { responseDeadline: unknown } };

    expect(body.minorReviewCase.responseDeadline).toEqual({
      clock: 'paused',
      deadlineAt: null,
      pausedAt: '2026-08-25T10:15:00.000Z',
      remainingDaysWhenPaused: 5.25,
    });
  });
});
