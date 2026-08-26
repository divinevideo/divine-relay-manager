// Real-D1 (Miniflare SQLite) validation for the age-review counts endpoint that
// feeds the queue's drill-down chip counts and per-view totals. Exercises the
// GROUP BY over real rows and the age-band scoping.
import { Miniflare } from 'miniflare';
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { ensureSchema } from '../src/db';
import { handleGetAgeReviewCaseCounts } from '../src/age-review';

let mf: Miniflare;
let DB: D1Database;
let env: Parameters<typeof handleGetAgeReviewCaseCounts>[1];
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
  env = { DB };
});
afterAll(async () => { await mf?.dispose(); });

let seq = 0;
async function insertCase(state: string, band: string) {
  seq += 1;
  await DB.prepare(
    `INSERT INTO age_review_cases (id, pubkey, state, suspected_age_band, deadline_at, clock_paused, version)
     VALUES (?, ?, ?, ?, ?, 0, 0)`,
  ).bind(`c${seq}`, `pk${seq}`, state, band, new Date(Date.now() + 9 * 864e5).toISOString()).run();
}

async function reset() {
  await ensureSchema(DB);
  await DB.prepare('DELETE FROM age_review_cases').run();
  seq = 0;
}

function countsRequest(query = '') {
  return new Request(`https://api.example.com/api/age-review/counts${query}`);
}

async function bodyOf(res: Response) {
  return res.json() as Promise<{ success: boolean; by_state: Record<string, number> }>;
}

beforeEach(reset);

describe('handleGetAgeReviewCaseCounts', () => {
  it('returns a per-state count map from a real GROUP BY', async () => {
    await insertCase('open_reported', 'under_13');
    await insertCase('open_reported', 'age_13_15');
    await insertCase('under_moderator_review', 'under_13');
    await insertCase('cleared', 'age_13_15');
    await insertCase('cleared', 'age_16_plus_claimed');
    await insertCase('denied_closed', 'under_13');

    const res = await handleGetAgeReviewCaseCounts(countsRequest(), env, cors);
    expect(res.status).toBe(200);
    const { success, by_state } = await bodyOf(res);
    expect(success).toBe(true);
    expect(by_state).toEqual({
      open_reported: 2,
      under_moderator_review: 1,
      cleared: 2,
      denied_closed: 1,
    });
  });

  it('omits states with no rows rather than reporting them as 0', async () => {
    await insertCase('open_reported', 'under_13');
    const { by_state } = await bodyOf(await handleGetAgeReviewCaseCounts(countsRequest(), env, cors));
    // The client renders an absent state as 0; the endpoint does not pad.
    expect(by_state).toEqual({ open_reported: 1 });
  });

  it('scopes the counts to a valid age band', async () => {
    await insertCase('open_reported', 'under_13');
    await insertCase('open_reported', 'under_13');
    await insertCase('open_reported', 'age_13_15');

    const scoped = await bodyOf(await handleGetAgeReviewCaseCounts(countsRequest('?age_band=under_13'), env, cors));
    expect(scoped.by_state).toEqual({ open_reported: 2 });

    // An unrecognized band is ignored (not injected), so counts stay unscoped.
    const bogus = await bodyOf(await handleGetAgeReviewCaseCounts(countsRequest('?age_band=nonsense'), env, cors));
    expect(bogus.by_state).toEqual({ open_reported: 3 });
  });

  it('returns an empty map for an empty table', async () => {
    const { success, by_state } = await bodyOf(await handleGetAgeReviewCaseCounts(countsRequest(), env, cors));
    expect(success).toBe(true);
    expect(by_state).toEqual({});
  });
});
