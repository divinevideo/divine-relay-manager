import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the SDK before importing the module under test. vi.hoisted lets the
// mock factory reference these without tripping the hoist-before-init error.
const { oauth, createDivineClient } = vi.hoisted(() => {
  const oauth = {
    getAuthorizationUrl: vi.fn(),
    parseCallback: vi.fn(),
    exchangeCode: vi.fn(),
    getSession: vi.fn(),
    getSessionWithRefresh: vi.fn(),
    logout: vi.fn(),
  };
  const createDivineClient = vi.fn(() => ({ oauth, createRpc: vi.fn() }));
  return { oauth, createDivineClient };
});
vi.mock('@divinevideo/login', () => ({ createDivineClient }));

import {
  DIVINE_LOGIN_CLIENT_ID,
  startLogin,
  completeLogin,
  getSession,
  logout,
} from './divineLogin';

beforeEach(() => {
  vi.clearAllMocks();
  // The global test setup stubs localStorage with no-ops; this module needs
  // real persistence for the return-path round-trip, so install an in-memory one.
  const store = new Map<string, string>();
  Object.defineProperty(window, 'localStorage', {
    value: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => store.set(k, v),
      removeItem: (k: string) => store.delete(k),
      clear: () => store.clear(),
    },
    writable: true,
    configurable: true,
  });
  oauth.getAuthorizationUrl.mockResolvedValue({
    url: 'https://login.divine.video/api/oauth/authorize?x=1',
    pkce: { verifier: 'v', challenge: 'c' },
  });
});

describe('divineLogin', () => {
  it('configures the client with the relay-admin client id and origin callback', async () => {
    await startLogin();
    expect(createDivineClient).toHaveBeenCalledWith(
      expect.objectContaining({
        clientId: DIVINE_LOGIN_CLIENT_ID,
        redirectUri: `${window.location.origin}/auth/callback`,
        storage: localStorage,
        fetch: expect.any(Function), // timeout-wrapped fetch (OAuth methods have no built-in timeout)
      }),
    );
  });

  it('startLogin stores the return path and redirects to the authorize url', async () => {
    const assign = vi.fn();
    Object.defineProperty(window, 'location', {
      value: { ...window.location, assign },
      writable: true,
    });
    await startLogin('/age-review');
    expect(assign).toHaveBeenCalledWith('https://login.divine.video/api/oauth/authorize?x=1');
  });

  it('completeLogin exchanges the code and returns the stored return path', async () => {
    localStorage.setItem('divine-login:return-path', '/age-review');
    oauth.parseCallback.mockReturnValue({ code: 'abc' });
    oauth.exchangeCode.mockResolvedValue({
      access_token: 't',
      bunker_url: 'bunker://x',
      token_type: 'Bearer',
      expires_in: 3600,
    });
    const result = await completeLogin('https://relay.admin.divine.video/auth/callback?code=abc');
    expect(oauth.exchangeCode).toHaveBeenCalledWith('abc');
    expect(result).toEqual({ returnPath: '/age-review' });
  });

  it('completeLogin defaults the return path to /reports', async () => {
    oauth.parseCallback.mockReturnValue({ code: 'abc' });
    oauth.exchangeCode.mockResolvedValue({
      access_token: 't',
      bunker_url: 'bunker://x',
      token_type: 'Bearer',
      expires_in: 3600,
    });
    const result = await completeLogin('https://relay.admin.divine.video/auth/callback?code=abc');
    expect(result).toEqual({ returnPath: '/reports' });
  });

  it('completeLogin throws when the token response has no access token (attribution would be dead)', async () => {
    oauth.parseCallback.mockReturnValue({ code: 'abc' });
    oauth.exchangeCode.mockResolvedValue({
      bunker_url: 'bunker://x', // no access_token
      token_type: 'Bearer',
      expires_in: 3600,
    });
    await expect(
      completeLogin('https://relay.admin.divine.video/auth/callback?code=abc'),
    ).rejects.toThrow(/access token/i);
  });

  it('completeLogin throws on an OAuth error callback', async () => {
    oauth.parseCallback.mockReturnValue({ error: 'access_denied', description: 'user cancelled' });
    await expect(
      completeLogin('https://relay.admin.divine.video/auth/callback?error=access_denied'),
    ).rejects.toThrow('user cancelled');
  });

  it('getSession delegates to getSessionWithRefresh', async () => {
    oauth.getSessionWithRefresh.mockResolvedValue({ bunkerUrl: 'bunker://x', accessToken: 't' });
    expect(await getSession()).toEqual({ bunkerUrl: 'bunker://x', accessToken: 't' });
  });

  // Keycast refresh tokens are single use, so two overlapping refreshes sign the
  // moderator out: the second is refused and the SDK deletes the session.
  it('getSession shares one in-flight call between concurrent callers', async () => {
    let release!: (v: { bunkerUrl: string; accessToken: string }) => void;
    oauth.getSessionWithRefresh.mockReturnValue(new Promise((resolve) => { release = resolve; }));
    const first = getSession();
    const second = getSession();
    release({ bunkerUrl: 'bunker://x', accessToken: 't' });
    expect(await first).toEqual({ bunkerUrl: 'bunker://x', accessToken: 't' });
    expect(await second).toEqual({ bunkerUrl: 'bunker://x', accessToken: 't' });
    expect(oauth.getSessionWithRefresh).toHaveBeenCalledTimes(1);

    // Once it settles, the next call reads again.
    oauth.getSessionWithRefresh.mockResolvedValue(null);
    expect(await getSession()).toBeNull();
    expect(oauth.getSessionWithRefresh).toHaveBeenCalledTimes(2);
  });

  it('getSession runs under a cross-tab Web Lock when one is available', async () => {
    let grant!: () => void;
    const request = vi.fn((_name: string, _opts: LockOptions, cb: () => Promise<unknown>) =>
      new Promise((resolve, reject) => { grant = () => cb().then(resolve, reject); }));
    Object.defineProperty(navigator, 'locks', { value: { request }, configurable: true });
    try {
      oauth.getSessionWithRefresh.mockResolvedValue({ bunkerUrl: 'bunker://x', accessToken: 't' });
      const pending = getSession();
      expect(request).toHaveBeenCalledWith(
        'divine-login:session', { signal: expect.any(AbortSignal) }, expect.any(Function),
      );
      // Another tab holds the lock: nothing reads or refreshes until it is granted.
      expect(oauth.getSessionWithRefresh).not.toHaveBeenCalled();
      grant();
      expect(await pending).toEqual({ bunkerUrl: 'bunker://x', accessToken: 't' });
      expect(oauth.getSessionWithRefresh).toHaveBeenCalledTimes(1);
    } finally {
      delete (navigator as { locks?: unknown }).locks;
    }
  });

  // A tab that holds the lock and never lets go must not leave this one
  // resolving forever, with every action unattributed.
  it('getSession reads without the lock once the wait for it times out', async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // Never grants; rejects as the platform does when the signal aborts.
    const request = vi.fn((_name: string, opts: LockOptions) => new Promise((_resolve, reject) => {
      opts.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
    }));
    Object.defineProperty(navigator, 'locks', { value: { request }, configurable: true });
    try {
      oauth.getSessionWithRefresh.mockResolvedValue({ bunkerUrl: 'bunker://x', accessToken: 't' });
      let settled: unknown = 'pending';
      void getSession().then((v) => { settled = v; });

      await vi.advanceTimersByTimeAsync(19_999);
      expect(settled).toBe('pending');
      expect(oauth.getSessionWithRefresh).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1);
      expect(settled).toEqual({ bunkerUrl: 'bunker://x', accessToken: 't' });
      expect(oauth.getSessionWithRefresh).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledWith('[divine-login] session lock not granted in time; reading without it');
    } finally {
      delete (navigator as { locks?: unknown }).locks;
      warn.mockRestore();
      vi.useRealTimers();
    }
  });

  it('getSession does not fall back when the read under the lock fails', async () => {
    const request = vi.fn((_name: string, _opts: LockOptions, cb: () => Promise<unknown>) => cb());
    Object.defineProperty(navigator, 'locks', { value: { request }, configurable: true });
    try {
      oauth.getSessionWithRefresh.mockRejectedValue(new Error('storage disabled'));
      await expect(getSession()).rejects.toThrow('storage disabled');
      expect(oauth.getSessionWithRefresh).toHaveBeenCalledTimes(1);
    } finally {
      delete (navigator as { locks?: unknown }).locks;
    }
  });

  // Another tab's lock can be held for the length of a refresh. A logout while
  // this read waits must stop it reading, or refreshing, the signed-out session,
  // and must still hold once the lock is granted: the holder's refresh may have
  // saved the old session after the logout cleared it. This read cannot tell
  // that from a sign-in made meanwhile, so it fails closed and clears storage.
  it('getSession skips the refresh and clears storage when a logout lands while it waits for the lock', async () => {
    let grant!: () => void;
    const request = vi.fn((_name: string, _opts: LockOptions, cb: () => Promise<unknown>) =>
      new Promise((resolve, reject) => { grant = () => cb().then(resolve, reject); }));
    Object.defineProperty(navigator, 'locks', { value: { request }, configurable: true });
    try {
      oauth.getSessionWithRefresh.mockResolvedValue({ bunkerUrl: 'bunker://x', accessToken: 'old' });
      const pending = getSession();
      logout();
      grant();
      expect(await pending).toBeNull();
      expect(oauth.getSessionWithRefresh).not.toHaveBeenCalled();
      expect(oauth.logout).toHaveBeenCalledTimes(2); // the sign-out, then the clear under the lock
    } finally {
      delete (navigator as { locks?: unknown }).locks;
    }
  });

  // The SDK can persist a refresh that finishes after a logout. That session is
  // cleared; anything else in storage by then was written by a newer sign-in in
  // another tab, and is left alone.
  it.each([
    ['clears the session a refresh re-persisted after a logout', 'old', 2],
    ['leaves a newer sign-in alone when a refresh finishes after a logout', 'newer', 1],
  ] as const)('getSession %s', async (_name, storedToken, logoutCalls) => {
    let release!: (v: { bunkerUrl: string; accessToken: string }) => void;
    oauth.getSessionWithRefresh.mockReturnValue(new Promise((resolve) => { release = resolve; }));
    oauth.getSession.mockReturnValue({ bunkerUrl: 'bunker://x', accessToken: storedToken });
    const pending = getSession();
    await Promise.resolve();
    logout();
    release({ bunkerUrl: 'bunker://x', accessToken: 'old' });
    expect(await pending).toBeNull();
    expect(oauth.logout).toHaveBeenCalledTimes(logoutCalls);
  });

  // Nothing to match on: a session without an access token is not proof that
  // storage holds this read's write, and an empty storage may hold another
  // tab's sign-in in progress (its PKCE verifier), which logout would delete.
  it('getSession clears nothing after a logout when the stale refresh has no access token', async () => {
    let release!: (v: { bunkerUrl: string }) => void;
    oauth.getSessionWithRefresh.mockReturnValue(new Promise((resolve) => { release = resolve; }));
    oauth.getSession.mockReturnValue(null);
    const pending = getSession();
    await Promise.resolve();
    logout();
    release({ bunkerUrl: 'bunker://x' });
    expect(await pending).toBeNull();
    expect(oauth.logout).toHaveBeenCalledTimes(1); // the sign-out only
  });

  it('logout delegates to the SDK', () => {
    logout();
    expect(oauth.logout).toHaveBeenCalled();
  });
});
