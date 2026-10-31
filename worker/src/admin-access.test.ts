// ABOUTME: Tests the admin API gate (verifyAdminAccess) through the Worker's fetch
// ABOUTME: handler: the Access JWT must verify, and the X-Admin-Key paths still work.

import { describe, it, expect, vi, afterEach } from 'vitest';
import worker from './index';
import { __resetAccessCertsCacheForTests } from './access-jwt';
import { makeAccessJwtSigner, TEAM_DOMAIN, AUDIENCE } from './test-helpers/access-jwt';

// Past the gate and matched by no route: authorized gets 404, refused gets 401.
const PROBE = 'https://api.test/api/no-such-route';
const ctx = { waitUntil: vi.fn(), passThroughOnException: vi.fn() } as unknown as ExecutionContext;

const baseEnv = {
  ALLOWED_ORIGINS: 'http://localhost:5173',
  ACCESS_TEAM_DOMAIN: TEAM_DOMAIN,
  API_ACCESS_AUD: AUDIENCE,
  ADMIN_API_KEY: 'admin-key',
};

async function status(headers: Record<string, string>, env: Record<string, unknown> = baseEnv) {
  const res = await worker.fetch(new Request(PROBE, { headers }), env as never, ctx);
  return res.status;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  __resetAccessCertsCacheForTests();
});

describe('verifyAdminAccess: Cloudflare Access JWT', () => {
  it('authorizes a token that verifies against the API audience', async () => {
    const signer = await makeAccessJwtSigner();
    vi.stubGlobal('fetch', signer.fetchFn);
    expect(await status({ 'Cf-Access-Jwt-Assertion': await signer.sign() })).toBe(404);
  });

  it('refuses a header that is merely present', async () => {
    const signer = await makeAccessJwtSigner();
    vi.stubGlobal('fetch', signer.fetchFn);
    expect(await status({ 'Cf-Access-Jwt-Assertion': 'test' })).toBe(401);
  });

  it('refuses a well-formed token signed by a key Access did not issue', async () => {
    const signer = await makeAccessJwtSigner();
    const forger = await makeAccessJwtSigner();
    vi.stubGlobal('fetch', signer.fetchFn);
    expect(await status({ 'Cf-Access-Jwt-Assertion': await forger.sign() })).toBe(401);
  });

  it('refuses a valid token issued for another Access application, and logs the reason', async () => {
    const signer = await makeAccessJwtSigner();
    vi.stubGlobal('fetch', signer.fetchFn);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const token = await signer.sign({ payload: { aud: ['aud-consent'] } });
    expect(await status({ 'Cf-Access-Jwt-Assertion': token })).toBe(401);
    expect(warn).toHaveBeenCalledWith('[auth] Cf-Access-Jwt-Assertion refused: audience');
  });

  it('refuses every token when API_ACCESS_AUD is unset, and logs why', async () => {
    const signer = await makeAccessJwtSigner();
    vi.stubGlobal('fetch', signer.fetchFn);
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { API_ACCESS_AUD: _unset, ...env } = baseEnv;
    expect(await status({ 'Cf-Access-Jwt-Assertion': await signer.sign() }, env)).toBe(401);
    expect(error).toHaveBeenCalledWith(expect.stringContaining('API_ACCESS_AUD'));
  });

  it('refuses every token when ACCESS_TEAM_DOMAIN is unset, and logs why', async () => {
    const signer = await makeAccessJwtSigner();
    vi.stubGlobal('fetch', signer.fetchFn);
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { ACCESS_TEAM_DOMAIN: _unset, ...env } = baseEnv;
    expect(await status({ 'Cf-Access-Jwt-Assertion': await signer.sign() }, env)).toBe(401);
    expect(error).toHaveBeenCalledWith(expect.stringContaining('ACCESS_TEAM_DOMAIN'));
  });

  it('reads API_ACCESS_AUD from a Secrets Store binding', async () => {
    const signer = await makeAccessJwtSigner();
    vi.stubGlobal('fetch', signer.fetchFn);
    const env = { ...baseEnv, API_ACCESS_AUD: { get: async () => AUDIENCE } };
    expect(await status({ 'Cf-Access-Jwt-Assertion': await signer.sign() }, env)).toBe(404);
  });

  it('refuses, rather than failing the request, when reading API_ACCESS_AUD throws', async () => {
    const signer = await makeAccessJwtSigner();
    vi.stubGlobal('fetch', signer.fetchFn);
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const env = { ...baseEnv, API_ACCESS_AUD: { get: async () => { throw new Error('secrets store down'); } } };
    expect(await status({ 'Cf-Access-Jwt-Assertion': await signer.sign() }, env)).toBe(401);
    expect(error).toHaveBeenCalledWith(expect.stringContaining('API_ACCESS_AUD'), expect.anything());
  });

  it('treats an empty API_ACCESS_AUD secret as unset', async () => {
    const signer = await makeAccessJwtSigner();
    vi.stubGlobal('fetch', signer.fetchFn);
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const token = await signer.sign({ payload: { aud: [''] } });
    expect(await status({ 'Cf-Access-Jwt-Assertion': token }, { ...baseEnv, API_ACCESS_AUD: '' })).toBe(401);
    expect(error).toHaveBeenCalledWith(expect.stringContaining('API_ACCESS_AUD'));
  });

  it('refuses when the certs cannot be fetched', async () => {
    const signer = await makeAccessJwtSigner();
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, json: async () => ({}) })));
    expect(await status({ 'Cf-Access-Jwt-Assertion': await signer.sign() })).toBe(401);
  });

  it('refuses a request with no credentials', async () => {
    expect(await status({})).toBe(401);
  });
});

describe('consent-video route sits before the admin gate', () => {
  it('answers a consent-audience token in the consent handler, never with the gate\'s 401', async () => {
    // The consent route has its own Access application (CONSENT_ACCESS_AUD), so
    // its tokens would fail the API audience check. With no storage bound the
    // consent handler answers 503; a 401 here means the gate ran first.
    const signer = await makeAccessJwtSigner();
    vi.stubGlobal('fetch', signer.fetchFn);
    const token = await signer.sign({ payload: { aud: ['aud-consent'] } });
    const env = { ...baseEnv, CONSENT_ACCESS_TEAM_DOMAIN: TEAM_DOMAIN, CONSENT_ACCESS_AUD: 'aud-consent' };
    const res = await worker.fetch(
      new Request('https://api.test/api/age-review/consent-video/r1', { headers: { 'Cf-Access-Jwt-Assertion': token } }),
      env as never, ctx,
    );
    expect(res.status).toBe(503);
  });
});

describe('protected-minor route sits before the admin gate', () => {
  it('answers a path-application token in the service handler, never with the gate\'s 401', async () => {
    // Funnelcake comes through this route's own path-scoped Access application
    // (docs/protected-minor-edge-auth.md), so its tokens would fail the API audience
    // check. With no D1 bound the handler answers 503 once the bearer token passes;
    // a 401 here means the gate ran first.
    const signer = await makeAccessJwtSigner();
    vi.stubGlobal('fetch', signer.fetchFn);
    const token = await signer.sign({ payload: { aud: ['aud-protected-minors'] } });
    const env = { ...baseEnv, PROTECTED_MINOR_SERVICE_TOKEN: 'service-token' };
    const res = await worker.fetch(
      new Request('https://api.test/api/internal/protected-minors/resolve', {
        method: 'POST',
        headers: { 'Cf-Access-Jwt-Assertion': token, Authorization: 'Bearer service-token' },
      }),
      env as never, ctx,
    );
    expect(res.status).toBe(503);
  });
});

describe('verifyAdminAccess: X-Admin-Key paths unchanged', () => {
  it('authorizes ADMIN_API_KEY without fetching certs', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    expect(await status({ 'X-Admin-Key': 'admin-key' })).toBe(404);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('authorizes ADMIN_API_KEY alongside an Access header, checking the key first', async () => {
    const signer = await makeAccessJwtSigner();
    vi.stubGlobal('fetch', signer.fetchFn);
    expect(await status({ 'X-Admin-Key': 'admin-key', 'Cf-Access-Jwt-Assertion': await signer.sign() })).toBe(404);
    expect(await status({ 'X-Admin-Key': 'admin-key', 'Cf-Access-Jwt-Assertion': 'test' })).toBe(404);
    expect(signer.fetchFn).not.toHaveBeenCalled();
  });

  it('still accepts a valid Access token sent with a wrong X-Admin-Key', async () => {
    const signer = await makeAccessJwtSigner();
    vi.stubGlobal('fetch', signer.fetchFn);
    expect(await status({ 'X-Admin-Key': 'wrong', 'Cf-Access-Jwt-Assertion': await signer.sign() })).toBe(404);
  });

  it('refuses a wrong X-Admin-Key', async () => {
    expect(await status({ 'X-Admin-Key': 'wrong' })).toBe(401);
  });

  it('still checks the Access token when the relay key binding is unavailable', async () => {
    const signer = await makeAccessJwtSigner();
    vi.stubGlobal('fetch', signer.fetchFn);
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const env = { ...baseEnv, MOD_RELAY_ADMIN_KEY: { get: async () => { throw new Error('binding unavailable'); } } };
    const probe = async (token?: string) => worker.fetch(new Request('https://api.test/api/relay-rpc', {
      method: 'POST',
      headers: { 'X-Admin-Key': 'wrong', ...(token ? { 'Cf-Access-Jwt-Assertion': token } : {}) },
      body: '{}',
    }), env as never, ctx);
    // An authorized empty RPC payload reaches route validation (400), not 500.
    expect((await probe(await signer.sign())).status).toBe(400);
    expect((await probe()).status).toBe(401);
    expect((await probe('test')).status).toBe(401);
    expect(error).toHaveBeenCalledWith('[auth] reading MOD_RELAY_ADMIN_KEY failed', 'Error');
  });

  // MOD_RELAY_ADMIN_KEY on /api/relay-rpc is covered in index.test.ts.
});
