// Real-D1 (Miniflare SQLite) validation for getActiveAgeReviewCase, the lookup
// behind the age-review guard and the bulk queue consumer's per-chunk check
// (#290). Unit tests stub D1 and cannot see the query's WHERE clause or binds;
// this pins the terminal-state filter and the pubkey scoping against real SQL.
import { Miniflare } from 'miniflare';
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { ensureSchema } from '../src/db';
import { getActiveAgeReviewCase } from '../src/age-review-lookup';

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
