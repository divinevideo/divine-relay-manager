// Real-D1 (Miniflare SQLite) check that /api/moderate-media ensures the schema
// before a note's Restore (#299). The Restore's open-review check fails closed,
// so on a database that has no age_review_cases table yet (a fresh local D1) a
// route that skipped the schema would refuse every Restore with 503. The media
// server and moderation-service are stubbed; the D1 is real and starts empty.
import { Miniflare } from 'miniflare';
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import worker from '../src/index';

const SHA = '5'.repeat(64);
const ACCOUNT = 'a1'.repeat(32);

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
afterEach(() => { vi.restoreAllMocks(); });

const moderationApi = {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/check-result/')) return Response.json({ sha256: SHA, status: 'quarantine', moderated: true });
    if (url.pathname === '/api/v1/moderate') return Response.json({ success: true, sha256: SHA, action: 'SAFE' });
    return new Response('not found', { status: 404 });
  },
};

describe('/api/moderate-media on a database with no schema yet', () => {
  it("restores a note's file instead of refusing it as an unchecked review", async () => {
    expect(await DB.prepare("SELECT name FROM sqlite_master WHERE name = 'age_review_cases'").first()).toBeNull();
    // Only the media server's blob read goes over fetch; nothing leaves the test.
    vi.spyOn(globalThis, 'fetch').mockImplementation((async (input: RequestInfo | URL) => {
      const url = new URL(String(input instanceof Request ? input.url : input));
      if (url.host === 'media.example' && url.pathname === `/admin/api/blob/${SHA}`) {
        return Response.json({ sha256: SHA, type: 'video/mp4', owner: ACCOUNT, status: 'restricted' });
      }
      return new Response('not found', { status: 404 });
    }) as typeof fetch);

    const res = await worker.fetch(new Request('https://relay.example/api/moderate-media', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Admin-Key': 'k' },
      body: JSON.stringify({ sha256: SHA, action: 'SAFE', from: 'QUARANTINE', pubkey: ACCOUNT }),
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

    expect(await res.json()).toMatchObject({ success: true });
    expect(res.status).toBe(200);
    expect(await DB.prepare("SELECT name FROM sqlite_master WHERE name = 'age_review_cases'").first()).not.toBeNull();
  });
});
