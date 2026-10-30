// Real-D1 (Miniflare SQLite) check of /api/moderate-media's age-review lift
// guard (#335). The unit tests stub D1 and cannot see the lookup's SQL: this
// pins, against real SQL, that a SAFE (or an AGE_RESTRICTED over a hidden
// file) naming no account is held by the open
// case of the owner the media server names, and only by that. The media server
// and moderation-service are stubbed; the D1 is real and starts empty.
import { Miniflare } from 'miniflare';
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import worker from '../src/index';

const SHA = '5'.repeat(64);
const OWNER = 'a1'.repeat(32);
const OTHER = 'b2'.repeat(32);

let mf: Miniflare;
let DB: D1Database;
let writes: number;

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
afterEach(() => { vi.restoreAllMocks(); });

const moderationApi = {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/api/v1/moderate') { writes += 1; return Response.json({ success: true, sha256: SHA, action: 'SAFE' }); }
    return new Response('not found', { status: 404 });
  },
};

async function unblock(action = 'SAFE') {
  writes = 0;
  // Only the media server's blob read goes over fetch; nothing leaves the test.
  vi.spyOn(globalThis, 'fetch').mockImplementation((async (input: RequestInfo | URL) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    if (url.host === 'media.example' && url.pathname === `/admin/api/blob/${SHA}`) {
      return Response.json({ sha256: SHA, type: 'video/mp4', owner: OWNER, status: 'banned' });
    }
    return new Response('not found', { status: 404 });
  }) as typeof fetch);
  const res = await worker.fetch(new Request('https://relay.example/api/moderate-media', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Admin-Key': 'k' },
    body: JSON.stringify({ sha256: SHA, action, reason: 'Unblocked' }),
  }), {
    ADMIN_API_KEY: 'k',
    SERVICE_API_TOKEN: 'service-token',
    MODERATION_API: moderationApi,
    MODERATION_SERVICE_URL: 'https://moderation.example',
    MODERATION_ADMIN_URL: 'https://moderation.example',
    BLOSSOM_WEBHOOK_SECRET: 'blossom-secret',
    CDN_DOMAIN: 'media.example',
    DB,
  } as never, {} as ExecutionContext);
  return { status: res.status, json: await res.json() as Record<string, unknown> };
}

let seq = 0;
async function insertCase(pubkey: string, state: string) {
  seq += 1;
  await DB.prepare(
    `INSERT INTO age_review_cases (id, pubkey, state, suspected_age_band, deadline_at, clock_paused, version)
     VALUES (?, ?, ?, 'under_13', ?, 0, 0)`,
  ).bind(`c${seq}`, pubkey, state, new Date(Date.now() + 9 * 864e5).toISOString()).run();
}
const clearCases = () => DB.prepare('DELETE FROM age_review_cases').run();

// In order: the first runs on the empty database.
describe('/api/moderate-media lift guard on a real database', () => {
  it('lets an Unblock through on a database with no schema yet, instead of refusing it as an unchecked review', async () => {
    expect(await DB.prepare("SELECT name FROM sqlite_master WHERE name = 'age_review_cases'").first()).toBeNull();
    const res = await unblock();
    expect(res).toMatchObject({ status: 200, json: { success: true } });
    expect(writes).toBe(1);
    expect(await DB.prepare("SELECT name FROM sqlite_master WHERE name = 'age_review_cases'").first()).not.toBeNull();
  });

  it("refuses an Unblock while the file's owner has an open case, and writes nothing", async () => {
    await clearCases();
    await insertCase(OWNER, 'restricted_pending_user_response');
    const res = await unblock();
    expect(res).toMatchObject({ status: 409, json: { code: 'age_review_active', caseId: `c${seq}` } });
    expect(writes).toBe(0);
  });

  // A case's pubkey is the report's `p` tag as written (#313); the media
  // server's owner is lowercased.
  it('refuses an Unblock while the owner has an open case stored in uppercase', async () => {
    await clearCases();
    await insertCase(OWNER.toUpperCase(), 'open_reported');
    const res = await unblock();
    expect(res).toMatchObject({ status: 409, json: { code: 'age_review_active', caseId: `c${seq}` } });
    expect(writes).toBe(0);
  });

  it('refuses an Age Restrict of a blocked file while the owner has an open case stored in uppercase, and writes nothing', async () => {
    await clearCases();
    await insertCase(OWNER.toUpperCase(), 'open_reported');
    const res = await unblock('AGE_RESTRICTED');
    expect(res).toMatchObject({ status: 409, json: { code: 'age_review_active', caseId: `c${seq}` } });
    expect(writes).toBe(0);
  });

  it.each(['cleared', 'denied_closed'])('lets an Unblock through once the owner\'s case is %s', async (state) => {
    await clearCases();
    await insertCase(OWNER, state);
    const res = await unblock();
    expect(res.status).toBe(200);
    expect(writes).toBe(1);
  });

  it("lets an Unblock through when only another account has an open case", async () => {
    await clearCases();
    await insertCase(OTHER, 'open_reported');
    const res = await unblock();
    expect(res.status).toBe(200);
    expect(writes).toBe(1);
  });
});
