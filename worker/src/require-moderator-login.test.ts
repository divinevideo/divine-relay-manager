// ABOUTME: With REQUIRE_MODERATOR_LOGIN on, a write from the admin UI needs a verified Divine login.
// ABOUTME: Fails closed when Keycast can't confirm it; reads and server (admin key) callers are unaffected.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import worker from './index';
import { __resetAccessCertsCacheForTests } from './access-jwt';
import { __clearModeratorLoginCache, needsModeratorLogin } from './moderator-identity';
import { makeAccessJwtSigner, TEAM_DOMAIN, AUDIENCE, type AccessJwtSigner } from './test-helpers/access-jwt';

const MODERATOR = 'b'.repeat(64);
// Past the gate and matched by no route: let through gets 404.
const PROBE = 'https://api.test/api/no-such-route';
const ctx = { waitUntil: vi.fn(), passThroughOnException: vi.fn() } as unknown as ExecutionContext;

const baseEnv = {
  ALLOWED_ORIGINS: 'http://localhost:5173',
  ACCESS_TEAM_DOMAIN: TEAM_DOMAIN,
  API_ACCESS_AUD: AUDIENCE,
  ADMIN_API_KEY: 'admin-key',
  MODERATOR_LOGIN_URL: 'https://login.example.test',
  REQUIRE_MODERATOR_LOGIN: 'true',
};

let signer: AccessJwtSigner;
let keycast: 'ok' | 'down' | 'refuses';

beforeEach(async () => {
  __clearModeratorLoginCache();
  signer = await makeAccessJwtSigner();
  keycast = 'ok';
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.endsWith('/api/nostr')) {
      if (keycast === 'down') return new Response('boom', { status: 503 });
      if (keycast === 'refuses') return new Response('{}', { status: 401 });
      return new Response(JSON.stringify({ result: MODERATOR }), { status: 200 });
    }
    return signer.fetchFn(url, { signal: init?.signal ?? undefined });
  }));
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  __resetAccessCertsCacheForTests();
});

async function call(
  opts: { method?: string; url?: string; body?: unknown; headers?: Record<string, string> },
  env: Record<string, unknown> = baseEnv,
) {
  const res = await worker.fetch(new Request(opts.url ?? PROBE, {
    method: opts.method ?? 'POST',
    headers: { 'Content-Type': 'application/json', ...opts.headers },
    body: opts.method === 'GET' ? undefined : JSON.stringify(opts.body ?? {}),
  }), env as never, ctx);
  const text = await res.text();
  let code: unknown;
  try { code = (JSON.parse(text) as { code?: unknown }).code; } catch { /* not JSON */ }
  return { status: res.status, code };
}

const browser = async (extra: Record<string, string> = {}) =>
  ({ 'Cf-Access-Jwt-Assertion': await signer.sign(), ...extra });
const REFUSED = { status: 401, code: 'moderator_login_required' };

describe('REQUIRE_MODERATOR_LOGIN on', () => {
  it('refuses a write from the admin UI with no login', async () => {
    expect(await call({ headers: await browser() })).toEqual(REFUSED);
  });

  it('lets a write through with a login Keycast confirms', async () => {
    expect((await call({ headers: await browser({ 'X-Divine-Login-Token': 'tok' }) })).status).toBe(404);
  });

  it('refuses a write when Keycast is down (fails closed)', async () => {
    keycast = 'down';
    expect(await call({ headers: await browser({ 'X-Divine-Login-Token': 'tok' }) })).toEqual(REFUSED);
  });

  it('refuses a write when Keycast rejects the login', async () => {
    keycast = 'refuses';
    expect(await call({ headers: await browser({ 'X-Divine-Login-Token': 'tok' }) })).toEqual(REFUSED);
  });

  it.each(['PUT', 'PATCH', 'DELETE'])('treats %s as a write', async (method) => {
    expect(await call({ method, headers: await browser() })).toEqual(REFUSED);
  });

  it('leaves reads alone', async () => {
    expect((await call({ method: 'GET', headers: await browser() })).status).toBe(404);
  });

  it('leaves server callers on the admin key alone', async () => {
    expect((await call({ headers: { 'X-Admin-Key': 'admin-key' } })).status).toBe(404);
  });

  it('leaves moderation-service alone on its relay key, for relay writes', async () => {
    // moderation-service bans and suspends over relay-rpc with MOD_RELAY_ADMIN_KEY.
    // If that key stopped counting as a server caller, turning the setting on
    // would silently refuse automated enforcement.
    const env = { ...baseEnv, MOD_RELAY_ADMIN_KEY: { get: async () => 'mod-relay-key' } };
    const res = await call(
      { url: 'https://api.test/api/relay-rpc', body: { method: 'banpubkey', params: ['c'.repeat(64)] }, headers: { 'X-Admin-Key': 'mod-relay-key' } },
      env,
    );
    // Past both gates the relay handler runs against a stub env and can't
    // confirm the ban. That answer proves the key authenticated and the login
    // gate let it through.
    expect(res.code).toBe('ban_unconfirmed');
  });

  it('lets a signed-out relay read through to the handler', async () => {
    const res = await call({ url: 'https://api.test/api/relay-rpc', body: { method: 'listbannedpubkeys', params: [] }, headers: await browser() })
      .catch(() => ({ status: 0, code: 'handler-threw' }));
    expect(res.code).not.toBe('moderator_login_required');
    expect(res.status).not.toBe(401);
  });

  it('refuses before a real write route runs, not only on unmatched paths', async () => {
    expect(await call({ url: 'https://api.test/api/moderate', body: { action: 'delete_event', eventId: 'e'.repeat(64) }, headers: await browser() }))
      .toEqual(REFUSED);
  });

  it('still requires a login when a wrong admin key rides along with the Access token', async () => {
    // A browser build can carry a local-dev admin key. Only a key that matches
    // counts as a server caller.
    expect(await call({ headers: await browser({ 'X-Admin-Key': 'local-dev-key' }) })).toEqual(REFUSED);
  });

  it.each(['banpubkey', 'suspendpubkey', 'banevent', 'allowevent', 'listbannedpubkeysANDban'])(
    'refuses the relay write %s with no login',
    async (method) => {
      const res = await call({ url: 'https://api.test/api/relay-rpc', body: { method, params: [] }, headers: await browser() });
      expect(res).toEqual(REFUSED);
    },
  );

  it.each(['/api/summarize-user', '/api/moderate-media/lift-check'])('leaves the read-only POST %s alone', async (path) => {
    const res = await call({ url: `https://api.test${path}`, body: {}, headers: await browser() });
    expect(res.code).not.toBe('moderator_login_required');
  });

  // The ReportWatcher health workflow restarts a stopped watcher with the Access
  // service token alone; the restart is an idempotent nudge, not a moderation action.
  it('leaves the watcher restart POST /api/report-watcher/start alone', async () => {
    const res = await call({ url: 'https://api.test/api/report-watcher/start', body: {}, headers: await browser() });
    expect(res.code).not.toBe('moderator_login_required');
  });
});

describe('REQUIRE_MODERATOR_LOGIN off', () => {
  it.each([undefined, 'false', 'TRUE', '1'])('lets a write through with no login when the setting is %s', async (value) => {
    const env = { ...baseEnv, REQUIRE_MODERATOR_LOGIN: value };
    expect((await call({ headers: await browser() }, env)).status).toBe(404);
  });
});

describe('needsModeratorLogin: which requests are writes', () => {
  const req = (method: string, path: string, body?: string) =>
    new Request(`https://api.test${path}`, { method, body, headers: { 'Content-Type': 'application/json' } });
  const rpc = (method: string) => req('POST', '/api/relay-rpc', JSON.stringify({ method, params: [] }));

  it.each(['GET', 'HEAD'])('%s is a read', async (method) => {
    expect(await needsModeratorLogin(req(method, '/api/anything'), '/api/anything')).toBe(false);
  });

  it.each(['listbannedpubkeys', 'listbannedevents', 'listsuspendedpubkeys', 'supportedmethods', 'getbannedevent'])(
    'relay %s is a read',
    async (method) => { expect(await needsModeratorLogin(rpc(method), '/api/relay-rpc')).toBe(false); },
  );

  it.each(['banpubkey', 'unbanpubkey', 'suspendpubkey', 'banevent', 'allowevent', 'listbannedpubkeys2', 'LISTBANNEDPUBKEYS', ''])(
    'relay "%s" is a write',
    async (method) => { expect(await needsModeratorLogin(rpc(method), '/api/relay-rpc')).toBe(true); },
  );

  it('a relay call with an unreadable body is a write', async () => {
    expect(await needsModeratorLogin(req('POST', '/api/relay-rpc', 'not json'), '/api/relay-rpc')).toBe(true);
  });

  it('leaves the request body for the handler', async () => {
    const r = rpc('listbannedpubkeys');
    await needsModeratorLogin(r, '/api/relay-rpc');
    expect(await r.json()).toEqual({ method: 'listbannedpubkeys', params: [] });
  });

  it.each(['/api/summarize-user', '/api/moderate-media/lift-check'])('POST %s is a read', async (path) => {
    expect(await needsModeratorLogin(req('POST', path, '{}'), path)).toBe(false);
  });

  it('POST /api/report-watcher/start needs no login', async () => {
    const path = '/api/report-watcher/start';
    expect(await needsModeratorLogin(req('POST', path, '{}'), path)).toBe(false);
  });

  it.each(['PUT', 'PATCH', 'DELETE'])('%s /api/report-watcher/start still needs a login', async (method) => {
    const path = '/api/report-watcher/start';
    expect(await needsModeratorLogin(req(method, path, '{}'), path)).toBe(true);
  });

  it('POST /api/report-watcher/stop still needs a login', async () => {
    const path = '/api/report-watcher/stop';
    expect(await needsModeratorLogin(req('POST', path, '{}'), path)).toBe(true);
  });

  it.each([['POST', '/api/moderate-media'], ['POST', '/api/decisions'], ['DELETE', '/api/decisions/x'], ['PUT', '/api/age-review/config']])(
    '%s %s is a write',
    async (method, path) => { expect(await needsModeratorLogin(req(method, path, '{}'), path)).toBe(true); },
  );
});
