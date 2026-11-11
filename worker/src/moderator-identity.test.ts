// ABOUTME: Tests for verifying a moderator's Divine login against Keycast, with fetch stubbed.
// ABOUTME: Covers the success path, every failure mode, caching, the timeout, and token-never-logged.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  MODERATOR_LOGIN_HEADER,
  MODERATOR_LOGIN_REQUIRED,
  __clearModeratorLoginCache,
  __moderatorLoginCacheSize,
  noteClaimedModerator,
  requireVerifiedModerator,
  verifyModeratorLogin,
} from './moderator-identity';

const PUBKEY = 'a'.repeat(64);
const OTHER = 'b'.repeat(64);
const env = { MODERATOR_LOGIN_URL: 'https://login.test' };

function okResponse(result: unknown): Response {
  return new Response(JSON.stringify({ result }), { status: 200 });
}

describe('verifyModeratorLogin', () => {
  beforeEach(() => {
    __clearModeratorLoginCache();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('exposes the header name', () => {
    expect(MODERATOR_LOGIN_HEADER).toBe('X-Divine-Login-Token');
  });

  it('returns the verified pubkey for a 2xx get_public_key result', async () => {
    const fetchMock = vi.fn().mockResolvedValue(okResponse(PUBKEY));
    vi.stubGlobal('fetch', fetchMock);
    expect(await verifyModeratorLogin(env, 'tok')).toBe(PUBKEY);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://login.test/api/nostr');
    expect(init.method).toBe('POST');
    expect(init.headers.Authorization).toBe('Bearer tok');
    expect(JSON.parse(init.body)).toEqual({ method: 'get_public_key', params: [] });
  });

  it('returns undefined with no token', async () => {
    const fetchMock = vi.fn();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.stubGlobal('fetch', fetchMock);
    expect(await verifyModeratorLogin(env, undefined)).toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  it('returns undefined with no MODERATOR_LOGIN_URL', async () => {
    const fetchMock = vi.fn();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.stubGlobal('fetch', fetchMock);
    expect(await verifyModeratorLogin({}, 'tok')).toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith('[moderator-identity] login check failed: MODERATOR_LOGIN_URL not set');
  });

  it('returns undefined when reading MODERATOR_LOGIN_URL throws', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const throwing = {
      get MODERATOR_LOGIN_URL(): string {
        throw new Error('secrets store unavailable');
      },
    };
    expect(await verifyModeratorLogin(throwing, 'tok')).toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns undefined for 401', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('no', { status: 401 })));
    expect(await verifyModeratorLogin(env, 'tok')).toBeUndefined();
  });

  it('returns undefined for 500', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('boom', { status: 500 })));
    expect(await verifyModeratorLogin(env, 'tok')).toBeUndefined();
  });

  it('returns undefined for a non-JSON body', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('<html>', { status: 200 })));
    expect(await verifyModeratorLogin(env, 'tok')).toBeUndefined();
  });

  it('returns undefined for a non-hex result', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(okResponse('not-a-pubkey')));
    expect(await verifyModeratorLogin(env, 'tok')).toBeUndefined();
  });

  it('returns undefined for an uppercase result', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(okResponse('A'.repeat(64))));
    expect(await verifyModeratorLogin(env, 'tok')).toBeUndefined();
  });

  it('returns undefined when fetch throws', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down')));
    expect(await verifyModeratorLogin(env, 'tok')).toBeUndefined();
  });

  it('passes a 3-second timeout', async () => {
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout');
    const fetchMock = vi.fn().mockResolvedValue(okResponse(PUBKEY));
    vi.stubGlobal('fetch', fetchMock);
    await verifyModeratorLogin(env, 'tok');
    expect(timeoutSpy).toHaveBeenCalledWith(3000);
    expect(fetchMock.mock.calls[0][1].signal).toBe(timeoutSpy.mock.results[0].value);
  });

  it('serves a second call within 60 s from the cache', async () => {
    const fetchMock = vi.fn().mockImplementation(async () => okResponse(PUBKEY));
    vi.stubGlobal('fetch', fetchMock);
    expect(await verifyModeratorLogin(env, 'tok')).toBe(PUBKEY);
    expect(await verifyModeratorLogin(env, 'tok')).toBe(PUBKEY);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('checks again after 60 s', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn().mockImplementation(async () => okResponse(PUBKEY));
    vi.stubGlobal('fetch', fetchMock);
    await verifyModeratorLogin(env, 'tok');
    vi.advanceTimersByTime(59_999);
    await verifyModeratorLogin(env, 'tok');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(2);
    await verifyModeratorLogin(env, 'tok');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('sweeps expired entries for other tokens when it caches a new one', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => okResponse(PUBKEY)));
    await verifyModeratorLogin(env, 'old-tok');
    expect(__moderatorLoginCacheSize()).toBe(1);
    vi.advanceTimersByTime(60_001);
    await verifyModeratorLogin(env, 'new-tok');
    expect(__moderatorLoginCacheSize()).toBe(1);
  });

  it('normalizes a trailing slash on MODERATOR_LOGIN_URL', async () => {
    const fetchMock = vi.fn().mockResolvedValue(okResponse(PUBKEY));
    vi.stubGlobal('fetch', fetchMock);
    await verifyModeratorLogin({ MODERATOR_LOGIN_URL: 'https://login.test/' }, 'tok');
    expect(fetchMock.mock.calls[0][0]).toBe('https://login.test/api/nostr');
  });

  it('does not cache a failure', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response('no', { status: 401 }))
      .mockResolvedValueOnce(okResponse(PUBKEY));
    vi.stubGlobal('fetch', fetchMock);
    expect(await verifyModeratorLogin(env, 'tok')).toBeUndefined();
    expect(await verifyModeratorLogin(env, 'tok')).toBe(PUBKEY);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  describe('fresh check', () => {
    it('calls Keycast even with a cached success', async () => {
      const fetchMock = vi.fn().mockImplementation(async () => okResponse(PUBKEY));
      vi.stubGlobal('fetch', fetchMock);
      expect(await verifyModeratorLogin(env, 'tok')).toBe(PUBKEY);
      expect(await verifyModeratorLogin(env, 'tok', { fresh: true })).toBe(PUBKEY);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('evicts the cached success when it fails', async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(okResponse(PUBKEY))
        .mockResolvedValueOnce(new Response('revoked', { status: 401 }))
        .mockResolvedValueOnce(new Response('revoked', { status: 401 }));
      vi.stubGlobal('fetch', fetchMock);
      expect(await verifyModeratorLogin(env, 'tok')).toBe(PUBKEY);
      expect(await verifyModeratorLogin(env, 'tok', { fresh: true })).toBeUndefined();
      // A plain call no longer trusts the old success: it asks Keycast again.
      expect(await verifyModeratorLogin(env, 'tok')).toBeUndefined();
      expect(fetchMock).toHaveBeenCalledTimes(3);
    });

    it('evicts the cached success when Keycast cannot be reached', async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(okResponse(PUBKEY))
        .mockRejectedValueOnce(Object.assign(new Error('timed out'), { name: 'TimeoutError' }))
        .mockResolvedValueOnce(new Response('revoked', { status: 401 }));
      vi.stubGlobal('fetch', fetchMock);
      expect(await verifyModeratorLogin(env, 'tok')).toBe(PUBKEY);
      expect(await verifyModeratorLogin(env, 'tok', { fresh: true })).toBeUndefined();
      expect(await verifyModeratorLogin(env, 'tok')).toBeUndefined();
      expect(fetchMock).toHaveBeenCalledTimes(3);
    });

    it('refreshes the cache on success', async () => {
      vi.useFakeTimers();
      const fetchMock = vi.fn().mockImplementation(async () => okResponse(PUBKEY));
      vi.stubGlobal('fetch', fetchMock);
      await verifyModeratorLogin(env, 'tok');
      vi.advanceTimersByTime(50_000);
      await verifyModeratorLogin(env, 'tok', { fresh: true });
      expect(fetchMock).toHaveBeenCalledTimes(2);
      // 100 s after the first check but 50 s after the fresh one: still cached.
      vi.advanceTimersByTime(50_000);
      await verifyModeratorLogin(env, 'tok');
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });
  });

  it('never logs the token', async () => {
    const token = 'super-secret-token-value';
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const failures: Array<() => Promise<Response>> = [
      async () => new Response('no', { status: 401 }),
      async () => new Response('boom', { status: 500 }),
      async () => new Response('<html>', { status: 200 }),
      async () => okResponse('nope'),
      async () => {
        throw new Error(`failed with ${token}`);
      },
    ];
    for (const failure of failures) {
      __clearModeratorLoginCache();
      vi.stubGlobal('fetch', vi.fn().mockImplementation(failure));
      expect(await verifyModeratorLogin(env, token)).toBeUndefined();
    }
    const throwing = {
      get MODERATOR_LOGIN_URL(): string {
        throw new Error(`store failed for ${token}`);
      },
    };
    expect(await verifyModeratorLogin(throwing, token)).toBeUndefined();
    expect(await verifyModeratorLogin({}, token)).toBeUndefined();
    expect(warn).toHaveBeenCalled();
    for (const spy of [warn, error, log]) {
      for (const call of spy.mock.calls) {
        expect(call.map(String).join(' ')).not.toContain(token);
      }
    }
  });
});

describe('noteClaimedModerator', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('logs once when the claim differs from the verified pubkey, naming both in full', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    noteClaimedModerator('/api/moderate', OTHER.toUpperCase(), PUBKEY);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      `[moderator-identity] /api/moderate: claimed moderator ${OTHER} differs from verified ${PUBKEY}`,
    );
  });

  it('stays silent when the claim matches, is absent, or nothing is verified', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    noteClaimedModerator('/r', PUBKEY.toUpperCase(), PUBKEY);
    noteClaimedModerator('/r', undefined, PUBKEY);
    noteClaimedModerator('/r', 42, PUBKEY);
    noteClaimedModerator('/r', OTHER, undefined);
    expect(warn).not.toHaveBeenCalled();
  });

  it('names a malformed claim "malformed"', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    noteClaimedModerator('/r', 'npub1whatever', PUBKEY);
    expect(warn).toHaveBeenCalledWith(
      `[moderator-identity] /r: claimed moderator malformed differs from verified ${PUBKEY}`,
    );
  });
});

describe('requireVerifiedModerator', () => {
  it('refuses an unverified moderator with 401 and code moderator_login_required', async () => {
    const result = requireVerifiedModerator(undefined, { 'Access-Control-Allow-Origin': '*' });
    expect(result).toBeInstanceOf(Response);
    const res = result as Response;
    expect(res.status).toBe(401);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*');
    expect(await res.json()).toEqual({
      success: false,
      error: 'Sign in with Divine to continue',
      code: MODERATOR_LOGIN_REQUIRED,
    });
    expect(MODERATOR_LOGIN_REQUIRED).toBe('moderator_login_required');
  });

  it('passes a verified pubkey through', () => {
    expect(requireVerifiedModerator(PUBKEY, {})).toEqual({ pubkey: PUBKEY });
  });
});
