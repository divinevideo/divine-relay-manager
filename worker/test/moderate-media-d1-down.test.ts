// /api/moderate-media when D1 cannot run a statement, on a cold isolate (#299).
//
// The account check reads age_review_cases, so a request that names an account
// ensures the schema first. That step is part of the check: when it throws, the
// open-review lookup fails the same way and refuses (503), as on relay-rpc. A
// request that names no account (the per-post buttons, automated callers) never
// waits on it, so it goes through with D1 down, as it did before the check.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const SHA = '5'.repeat(64);
const ACCOUNT = 'a1'.repeat(32);

type Call = { url: string; method: string; body: unknown };
let calls: Call[];
let statements: string[];

const downDb = {
  prepare(sql: string) {
    statements.push(sql);
    throw new Error('D1_ERROR: Network connection lost');
  },
  async batch() { throw new Error('D1_ERROR: Network connection lost'); },
  async exec() { throw new Error('D1_ERROR: Network connection lost'); },
};

function env() {
  return {
    ADMIN_API_KEY: 'k',
    SERVICE_API_TOKEN: 'service-token',
    MODERATION_API: {
      async fetch(request: Request): Promise<Response> {
        const url = new URL(request.url);
        const body = request.method === 'POST' ? await request.clone().json() : null;
        calls.push({ url: url.pathname, method: request.method, body });
        if (url.pathname.startsWith('/check-result/')) return Response.json({ sha256: SHA, status: 'quarantine', moderated: true });
        if (url.pathname === '/api/v1/moderate') return Response.json({ success: true, sha256: SHA });
        return new Response('not found', { status: 404 });
      },
    },
    MODERATION_SERVICE_URL: 'https://moderation.example',
    MODERATION_ADMIN_URL: 'https://moderation.example',
    BLOSSOM_WEBHOOK_SECRET: 'blossom-secret',
    CDN_DOMAIN: 'media.example',
    DB: downDb,
  } as unknown as Parameters<(typeof import('../src/index'))['default']['fetch']>[1];
}

function post(body: Record<string, unknown>) {
  return new Request('https://relay.example/api/moderate-media', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Admin-Key': 'k' },
    body: JSON.stringify(body),
  });
}

// A fresh module each time: the schema step is memoised per isolate, and only
// a cold one runs it.
async function coldWorker() {
  vi.resetModules();
  return (await import('../src/index')).default;
}

const writes = () => calls.filter((c) => c.url === '/api/v1/moderate');
// ensureSchema's first statement.
const isSchemaStep = (sql: string) => /CREATE TABLE IF NOT EXISTS moderation_decisions\b/i.test(sql);

beforeEach(() => {
  calls = [];
  statements = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation((async (input: RequestInfo | URL) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    if (url.host === 'media.example' && url.pathname.startsWith('/admin/api/blob/')) {
      return Response.json({ sha256: SHA, type: 'video/mp4', owner: ACCOUNT, status: 'restricted' });
    }
    return new Response('not found', { status: 404 });
  }) as typeof fetch);
});

afterEach(() => vi.restoreAllMocks());

describe('/api/moderate-media with D1 down on a cold isolate', () => {
  it.each(['AGE_RESTRICTED', 'PERMANENT_BAN'])('a %s that names no account goes through and writes, as before the account check', async (action) => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const worker = await coldWorker();
    const res = await worker.fetch(post({ sha256: SHA, action, reason: 'r' }), env(), {} as ExecutionContext);
    expect(res.status).toBe(200);
    expect(writes()).toHaveLength(1);
    expect(writes()[0].body).toMatchObject({ sha256: SHA, action });
    // It never waited on the schema step. (The Zendesk sync after the write
    // tries its own table, inside its own catch, as before the account check.)
    expect(statements.some(isSchemaStep)).toBe(false);
  });

  it('a Restore that names an account tries the schema step, then refuses with 503 and writes nothing', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const worker = await coldWorker();
    const res = await worker.fetch(
      post({ sha256: SHA, action: 'SAFE', from: 'QUARANTINE', pubkey: ACCOUNT }),
      env(),
      {} as ExecutionContext,
    );
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ success: false, code: 'age_review_check_failed' });
    expect(writes()).toHaveLength(0);
    expect(statements.some(isSchemaStep)).toBe(true);
    expect(errors.mock.calls.some((c) => String(c[0]).includes('[handleModerateMedia] age-review schema bootstrap failed'))).toBe(true);
  });
});
