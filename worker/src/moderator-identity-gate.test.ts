// ABOUTME: Pins where the worker checks a moderator's Divine login: once per request, after the access gate.
// ABOUTME: A failed check never blocks an action; the action simply goes ahead unattributed.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import worker from './index';
import * as identity from './moderator-identity';
import { __clearModeratorLoginCache } from './moderator-identity';

const PUBKEY = 'b'.repeat(64);
const ctx = { waitUntil: () => {} } as unknown as ExecutionContext;

const db = {
  prepare: () => {
    const stmt = {
      bind: () => stmt,
      run: async () => ({ success: true, meta: { changes: 1 } }),
      first: async () => null,
      all: async () => ({ results: [] }),
    };
    return stmt;
  },
  batch: async () => [],
  exec: async () => ({ count: 0 }),
};

const env = {
  ALLOWED_ORIGINS: 'https://app.divine.video',
  ADMIN_API_KEY: 'test-admin-key',
  MODERATOR_LOGIN_URL: 'https://login.example.test',
  DB: db,
} as never;

function post(headers: Record<string, string>): Request {
  return new Request('https://worker.test/api/decisions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify({ targetType: 'pubkey', targetId: 'c'.repeat(64), action: 'reviewed' }),
  });
}

describe('moderator login check in the fetch handler', () => {
  let nostrCalls: number;
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    __clearModeratorLoginCache();
    nostrCalls = 0;
    fetchSpy = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).endsWith('/api/nostr')) {
        nostrCalls++;
        return new Response(JSON.stringify({ result: PUBKEY }), { status: 200 });
      }
      return new Response('{}', { status: 200 });
    });
    vi.stubGlobal('fetch', fetchSpy);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('verifies the login once per request when the header is present', async () => {
    // The Keycast call alone cannot show this: a successful first verify is
    // cached, so a duplicate would hit the cache. Count the verify calls instead.
    const verify = vi.spyOn(identity, 'verifyModeratorLogin');
    const res = await worker.fetch(post({ 'X-Admin-Key': 'test-admin-key', 'X-Divine-Login-Token': 'tok' }), env, ctx);
    expect(res.status).toBe(200);
    expect(verify).toHaveBeenCalledTimes(1);
    expect(nostrCalls).toBe(1);
  });

  it('makes no login call without the header', async () => {
    const res = await worker.fetch(post({ 'X-Admin-Key': 'test-admin-key' }), env, ctx);
    expect(res.status).toBe(200);
    expect(nostrCalls).toBe(0);
  });

  it('verifies only after the access gate', async () => {
    const res = await worker.fetch(post({ 'X-Divine-Login-Token': 'tok' }), env, ctx);
    expect(res.status).toBe(401);
    expect(nostrCalls).toBe(0);
  });

  describe('fresh check for suspended-content views', () => {
    function viewer(path: string, method = 'POST'): Request {
      return new Request(`https://worker.test${path}`, {
        method,
        headers: { 'Content-Type': 'application/json', 'X-Admin-Key': 'test-admin-key', 'X-Divine-Login-Token': 'tok' },
        ...(method === 'POST' ? { body: '{}' } : {}),
      });
    }

    it('POST /api/suspended-content/event verifies fresh on every request', async () => {
      await worker.fetch(viewer('/api/suspended-content/event'), env, ctx);
      await worker.fetch(viewer('/api/suspended-content/event'), env, ctx);
      expect(nostrCalls).toBe(2);
    });

    it('POST /api/suspended-content/account verifies fresh on every request', async () => {
      await worker.fetch(viewer('/api/suspended-content/account'), env, ctx);
      await worker.fetch(viewer('/api/suspended-content/account'), env, ctx);
      expect(nostrCalls).toBe(2);
    });

    it('the quarantine snapshot=1 GET verifies fresh, and its plain poll uses the cache', async () => {
      const id = 'd'.repeat(64);
      await worker.fetch(viewer(`/api/report-watcher/sexual-quarantine/${id}?snapshot=1`, 'GET'), env, ctx);
      await worker.fetch(viewer(`/api/report-watcher/sexual-quarantine/${id}?snapshot=1`, 'GET'), env, ctx);
      expect(nostrCalls).toBe(2);
      await worker.fetch(viewer(`/api/report-watcher/sexual-quarantine/${id}`, 'GET'), env, ctx);
      expect(nostrCalls).toBe(2);
    });

    it('other routes still use the cache', async () => {
      await worker.fetch(post({ 'X-Admin-Key': 'test-admin-key', 'X-Divine-Login-Token': 'tok' }), env, ctx);
      await worker.fetch(post({ 'X-Admin-Key': 'test-admin-key', 'X-Divine-Login-Token': 'tok' }), env, ctx);
      expect(nostrCalls).toBe(1);
    });
  });

  describe('proceeds with the action, unattributed, when the login check fails', () => {
    beforeEach(() => vi.spyOn(console, 'warn').mockImplementation(() => {}));

    it('on a 500 from Keycast', async () => {
      fetchSpy.mockImplementation(async (input: RequestInfo | URL) => {
        if (String(input).endsWith('/api/nostr')) { nostrCalls++; return new Response('boom', { status: 500 }); }
        return new Response('{}', { status: 200 });
      });
      const res = await worker.fetch(post({ 'X-Admin-Key': 'test-admin-key', 'X-Divine-Login-Token': 'tok' }), env, ctx);
      expect(nostrCalls).toBe(1);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ success: true });
    });

    it('on a timeout', async () => {
      fetchSpy.mockImplementation(async (input: RequestInfo | URL) => {
        if (String(input).endsWith('/api/nostr')) {
          nostrCalls++;
          const err = new Error('timed out');
          err.name = 'TimeoutError';
          throw err;
        }
        return new Response('{}', { status: 200 });
      });
      const res = await worker.fetch(post({ 'X-Admin-Key': 'test-admin-key', 'X-Divine-Login-Token': 'tok' }), env, ctx);
      expect(nostrCalls).toBe(1);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ success: true });
    });
  });
});
