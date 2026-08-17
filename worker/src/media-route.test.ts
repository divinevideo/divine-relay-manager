import { describe, it, expect } from 'vitest';
import worker from './index';

const ctx = {} as ExecutionContext;
const env = {
  ALLOWED_ORIGINS: 'https://relay.admin.divine.video',
  RELAY_URL: 'wss://relay.divine.video',
  ADMIN_API_KEY: 'test-admin-key',
} as never;

const SHA = 'a'.repeat(64);
const AUTH = { 'X-Admin-Key': 'test-admin-key' };

function get(path: string, headers: Record<string, string> = {}) {
  return worker.fetch(
    new Request(`https://api-relay-staging.divine.video${path}`, { method: 'GET', headers }),
    env,
    ctx,
  );
}

describe('GET /media/:sha256', () => {
  it('is gated: no admin auth is rejected, never serving the page', async () => {
    const res = await get(`/media/${SHA}`);
    expect(res.status).toBe(401);
    const body = await res.text();
    expect(body).not.toContain('/api/media-proxy/'); // page never rendered
  });

  it('serves the standalone page to an authenticated moderator', async () => {
    const res = await get(`/media/${SHA}`, AUTH);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    const body = await res.text();
    expect(body).toContain(`/api/media-proxy/${SHA}`);
    expect(body).toContain(SHA);
    expect(body.toLowerCase()).toContain('restricted');
  });

  it('sends document security headers so the CSAM hash stays off disk and the page is locked down', async () => {
    const res = await get(`/media/${SHA}`, AUTH);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('referrer-policy')).toBe('no-referrer');
    const csp = res.headers.get('content-security-policy') || '';
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("connect-src 'self'"); // the proxy fetch must be allowed
  });

  it('400s a non-hex sha rather than serving anything reflective', async () => {
    const res = await get('/media/not-a-real-hash', AUTH);
    expect(res.status).toBe(400);
    const body = await res.text();
    expect(body).not.toContain('not-a-real-hash');
  });

  it('400s an empty id', async () => {
    const res = await get('/media/', AUTH);
    expect(res.status).toBe(400);
  });

  it('tolerates a file extension on the path (…/media/<sha>.mp4) and passes it as a type hint', async () => {
    const res = await get(`/media/${SHA}.mp4`, AUTH);
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain(`/api/media-proxy/${SHA}`);
    expect(body).toContain('var ext = "mp4"');
  });

  it('normalises an uppercase sha in the path to lowercase (the form that ships)', async () => {
    const res = await get(`/media/${'A'.repeat(64)}`, AUTH);
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain(`/api/media-proxy/${SHA}`);
  });
});

describe('GET /api/media-proxy/:sha256 (the viewer page\'s media source)', () => {
  it('serves restricted bytes with no-store so they never reach the browser HTTP disk cache', async () => {
    // no-cache permits disk-cache storage subject to revalidation; the bytes this
    // route serves can be CSAM, so they must not be stored at all.
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response('bytes', { status: 200, headers: { 'content-type': 'image/jpeg' } })) as typeof fetch;
    try {
      const proxyEnv = {
        ALLOWED_ORIGINS: 'https://relay.admin.divine.video',
        RELAY_URL: 'wss://relay.divine.video',
        ADMIN_API_KEY: 'test-admin-key',
        BLOSSOM_WEBHOOK_SECRET: 'test-blossom-secret',
      } as never;
      const res = await worker.fetch(
        new Request(`https://api-relay-staging.divine.video/api/media-proxy/${SHA}`, {
          method: 'GET',
          headers: AUTH,
        }),
        proxyEnv,
        ctx,
      );
      expect(res.status).toBe(200);
      const cacheControl = res.headers.get('cache-control') || '';
      expect(cacheControl).toContain('no-store');
      expect(cacheControl).not.toContain('no-cache');
      // Stored-as-uploaded Content-Type means a text/html blob would otherwise
      // run script on the admin origin if navigated to directly; sandbox plus
      // nosniff closes that. The fetch-into-Blob consumers are unaffected.
      expect(res.headers.get('x-content-type-options')).toBe('nosniff');
      expect(res.headers.get('content-security-policy')).toBe('sandbox');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
