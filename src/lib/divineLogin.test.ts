import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

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
  // this read waits must stop it reading, or refreshing, the signed-out
  // session, and must still hold once the lock is granted: if the sign-out
  // could not remove the session this read started from, it is removed here.
  it('getSession skips the refresh and removes the ended session when a logout lands while it waits for the lock', async () => {
    let grant!: () => void;
    const request = vi.fn((_name: string, _opts: LockOptions, cb: () => Promise<unknown>) =>
      new Promise((resolve, reject) => { grant = () => cb().then(resolve, reject); }));
    Object.defineProperty(navigator, 'locks', { value: { request }, configurable: true });
    try {
      oauth.getSession.mockReturnValue({ bunkerUrl: 'bunker://x', accessToken: 'still-stored' });
      oauth.getSessionWithRefresh.mockResolvedValue({ bunkerUrl: 'bunker://x', accessToken: 'still-stored' });
      const pending = getSession();
      logout();
      grant();
      expect(await pending).toBeNull();
      expect(oauth.getSessionWithRefresh).not.toHaveBeenCalled();
      expect(oauth.logout).toHaveBeenCalledTimes(2); // the sign-out, then the removal under the lock
    } finally {
      delete (navigator as { locks?: unknown }).locks;
      oauth.getSession.mockReset();
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

// Another tab shares only storage and the Web Lock with this one, not this
// module's sessionGeneration. A logout there must still stop a refresh here
// from writing the session back.
describe('a logout in another tab', () => {
  const STORED = 'divine_session'; // the SDK's storage key, used only by this fake
  const REVISION_KEY = 'divine-login:session-revision';
  // Unique per test: a logout fences the token it ended for the life of this
  // module instance, as it does for the life of a tab.
  let OLD = '';
  let seq = 0;
  beforeEach(() => {
    seq += 1;
    OLD = `old-${seq}`;
  });

  // The SDK backed by the shared localStorage, as the real one is: a refresh
  // saves before it resolves, getSession reads storage, logout clears it.
  function sdkOnStorage() {
    oauth.getSession.mockImplementation(() => {
      const raw = localStorage.getItem(STORED);
      return raw ? JSON.parse(raw) : null;
    });
    oauth.logout.mockImplementation(() => localStorage.removeItem(STORED));
    let release!: (token: string) => void;
    oauth.getSessionWithRefresh.mockReturnValue(new Promise((resolve) => {
      release = (token) => {
        const session = { bunkerUrl: 'bunker://x', accessToken: token };
        localStorage.setItem(STORED, JSON.stringify(session));
        resolve(session);
      };
    }));
    return { refreshResolves: (token: string) => release(token) };
  }

  // One lock shared by every module instance, granted in request order.
  function fifoLock() {
    let tail: Promise<unknown> = Promise.resolve();
    const request = vi.fn((_name: string, _opts: LockOptions, cb: () => Promise<unknown>) => {
      const run = tail.then(() => cb());
      tail = run.catch(() => {});
      return run;
    });
    Object.defineProperty(navigator, 'locks', { value: { request }, configurable: true });
  }

  // What another tab's logout leaves in the storage this tab can see.
  function otherTabLogsOut() {
    localStorage.setItem(REVISION_KEY, 'other-tab-revision');
    localStorage.removeItem(STORED);
  }

  async function flush() {
    for (let i = 0; i < 5; i += 1) await Promise.resolve();
  }

  afterEach(() => {
    delete (navigator as { locks?: unknown }).locks;
    // clearAllMocks keeps implementations; drop the storage-backed fakes.
    oauth.getSession.mockReset();
    oauth.getSessionWithRefresh.mockReset();
    oauth.logout.mockReset();
  });

  it('during this tab\'s refresh clears the refreshed session and returns null', async () => {
    fifoLock();
    localStorage.setItem(STORED, JSON.stringify({ bunkerUrl: 'bunker://x', accessToken: OLD }));
    const sdk = sdkOnStorage();
    const pending = getSession();
    await flush();
    expect(oauth.getSessionWithRefresh).toHaveBeenCalledTimes(1);
    otherTabLogsOut();
    sdk.refreshResolves('refreshed');
    expect(await pending).toBeNull();
    expect(oauth.logout).toHaveBeenCalledTimes(1);
    expect(localStorage.getItem(STORED)).toBeNull();
  });

  // The ended session is the one this read started from. Another tab's
  // sign-out whose removal had not reached storage leaves it there; a sign-in
  // saved while this read waited is another session, and survives.
  it.each([
    ['removes the session it started from, still in storage', () => OLD, 1],
    ['leaves alone a sign-in saved while it waited', () => 'signed-in-meanwhile', 0],
  ] as const)('while this tab waits for the lock, a logout in another tab: %s', async (_name, atGrant, removals) => {
    let grant!: () => void;
    const request = vi.fn((_name: string, _opts: LockOptions, cb: () => Promise<unknown>) =>
      new Promise((resolve, reject) => { grant = () => cb().then(resolve, reject); }));
    Object.defineProperty(navigator, 'locks', { value: { request }, configurable: true });
    localStorage.setItem(STORED, JSON.stringify({ bunkerUrl: 'bunker://x', accessToken: OLD }));
    sdkOnStorage();
    oauth.getSessionWithRefresh.mockResolvedValue({ bunkerUrl: 'bunker://x', accessToken: 'refreshed' });
    const pending = getSession();
    localStorage.setItem(REVISION_KEY, 'other-tab-revision');
    localStorage.setItem(STORED, JSON.stringify({ bunkerUrl: 'bunker://x', accessToken: atGrant() }));
    grant();
    expect(await pending).toBeNull();
    expect(oauth.getSessionWithRefresh).not.toHaveBeenCalled();
    expect(oauth.logout).toHaveBeenCalledTimes(removals);
  });

  it('while this tab waits for the lock skips the refresh', async () => {
    let grant!: () => void;
    const request = vi.fn((_name: string, _opts: LockOptions, cb: () => Promise<unknown>) =>
      new Promise((resolve, reject) => { grant = () => cb().then(resolve, reject); }));
    Object.defineProperty(navigator, 'locks', { value: { request }, configurable: true });
    localStorage.setItem(STORED, JSON.stringify({ bunkerUrl: 'bunker://x', accessToken: OLD }));
    sdkOnStorage();
    // Resolves at once if it is ever called, so a failure here cannot leave a
    // hung read in this module's single flight for the next test to join.
    oauth.getSessionWithRefresh.mockResolvedValue({ bunkerUrl: 'bunker://x', accessToken: 'refreshed' });
    const pending = getSession();
    otherTabLogsOut();
    grant();
    expect(await pending).toBeNull();
    expect(oauth.getSessionWithRefresh).not.toHaveBeenCalled();
  });

  // Proves the bump is written where a separate module instance (another tab)
  // reads it, not only that a read honours a value a test planted.
  it('the same, driven by a second module instance\'s logout()', async () => {
    fifoLock();
    localStorage.setItem(STORED, JSON.stringify({ bunkerUrl: 'bunker://x', accessToken: OLD }));
    const sdk = sdkOnStorage();
    vi.resetModules();
    const tabA = await import('./divineLogin');
    vi.resetModules();
    const tabB = await import('./divineLogin');
    expect(tabA.logout).not.toBe(tabB.logout);

    const pending = tabB.getSession();
    await flush();
    expect(oauth.getSessionWithRefresh).toHaveBeenCalledTimes(1);
    tabA.logout();
    sdk.refreshResolves('refreshed');
    expect(await pending).toBeNull();
    expect(localStorage.getItem(STORED)).toBeNull();
  });

  it('leaves alone a sign-in another tab saved after the logout', async () => {
    fifoLock();
    localStorage.setItem(STORED, JSON.stringify({ bunkerUrl: 'bunker://x', accessToken: OLD }));
    const sdk = sdkOnStorage();
    const pending = getSession();
    await flush();
    otherTabLogsOut();
    sdk.refreshResolves('refreshed');
    // The other tab signs in again before this read checks: storage now holds
    // a session this read did not write.
    localStorage.setItem(STORED, JSON.stringify({ bunkerUrl: 'bunker://x', accessToken: 'newer' }));
    expect(await pending).toBeNull();
    expect(oauth.logout).not.toHaveBeenCalled();
    expect(JSON.parse(localStorage.getItem(STORED)!).accessToken).toBe('newer');
  });

  it('no revision change means the refreshed session is kept', async () => {
    fifoLock();
    localStorage.setItem(REVISION_KEY, 'unchanged');
    localStorage.setItem(STORED, JSON.stringify({ bunkerUrl: 'bunker://x', accessToken: OLD }));
    const sdk = sdkOnStorage();
    const pending = getSession();
    await flush();
    sdk.refreshResolves('refreshed');
    expect(await pending).toEqual({ bunkerUrl: 'bunker://x', accessToken: 'refreshed' });
    expect(oauth.logout).not.toHaveBeenCalled();
    expect(JSON.parse(localStorage.getItem(STORED)!).accessToken).toBe('refreshed');
  });

  // A browser whose storage always throws cannot share a revision. It keeps
  // the same-tab behaviour: a read is not stale just because both revision
  // reads failed, and a same-tab logout still discards a refresh in flight.
  it('storage that throws on every read keeps same-tab behaviour', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const blocked = () => { throw new DOMException('denied', 'SecurityError'); };
    Object.defineProperty(window, 'localStorage', {
      value: { getItem: blocked, setItem: blocked, removeItem: blocked, clear: blocked },
      writable: true,
      configurable: true,
    });
    try {
      oauth.getSessionWithRefresh.mockResolvedValue({ bunkerUrl: 'bunker://x', accessToken: 't' });
      expect(await getSession()).toEqual({ bunkerUrl: 'bunker://x', accessToken: 't' });

      let release!: (v: { bunkerUrl: string; accessToken: string }) => void;
      oauth.getSessionWithRefresh.mockReturnValue(new Promise((resolve) => { release = resolve; }));
      oauth.getSession.mockReturnValue({ bunkerUrl: 'bunker://x', accessToken: OLD });
      const pending = getSession();
      await Promise.resolve();
      expect(() => logout()).not.toThrow();
      release({ bunkerUrl: 'bunker://x', accessToken: OLD });
      expect(await pending).toBeNull();
    } finally {
      warn.mockRestore();
    }
  });

  // The fence, not the removal, makes the sign-out hold (see the cross-tab
  // integration test), so a failed removal is logged and the sign-out goes on.
  it('logout does not throw when the removal fails, and returns its message', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    localStorage.setItem(REVISION_KEY, 'rev-before');
    oauth.getSession.mockReturnValue({ bunkerUrl: 'bunker://x', accessToken: OLD });
    oauth.logout.mockImplementation(() => { throw new DOMException('denied', 'SecurityError'); });
    try {
      expect(logout()).toEqual({ type: 'signed-out', endedRevision: 'rev-before' });
      expect(warn).toHaveBeenCalledWith('[divine-login] could not remove the session; later reads refuse it:', 'SecurityError');
      // Fenced for a reload too, by fingerprint only.
      // (It may also hold the session an earlier test accepted in this
      // module instance: logout fences the tab's last accepted session too.)
      const fence: string[] = JSON.parse(localStorage.getItem('divine-login:ended-sessions')!);
      expect(fence.length).toBeGreaterThan(0);
      for (const fp of fence) expect(fp).toMatch(/^[0-9a-f]{16}$/);
    } finally {
      warn.mockRestore();
    }
  });

  it('the persisted fence keeps the latest 20 ended sessions, each once', async () => {
    // A fresh module instance: no session accepted yet, so each logout fences
    // only what storage holds.
    vi.resetModules();
    const { logout } = await import('./divineLogin');
    let stored = '';
    oauth.getSession.mockImplementation(() => ({ bunkerUrl: 'bunker://x', accessToken: stored }));
    stored = `${OLD}-repeat`;
    logout();
    const once: string[] = JSON.parse(localStorage.getItem('divine-login:ended-sessions')!);
    expect(once).toHaveLength(1);
    logout();
    expect(JSON.parse(localStorage.getItem('divine-login:ended-sessions')!)).toEqual(once);
    for (let i = 0; i < 25; i += 1) {
      stored = `${OLD}-${i}`;
      logout();
    }
    const fence: string[] = JSON.parse(localStorage.getItem('divine-login:ended-sessions')!);
    expect(fence).toHaveLength(20);
    expect(new Set(fence).size).toBe(20);
    expect(fence).not.toContain(once[0]); // the oldest went first
  });

  // The warning names the error, never a value from storage.
  it('a revision write that throws is logged by name and does not stop the sign-out', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const setItem = vi.fn(() => { throw new DOMException('quota', 'QuotaExceededError'); });
    Object.defineProperty(window, 'localStorage', {
      value: { getItem: () => null, setItem, removeItem: () => {}, clear: () => {} },
      writable: true,
      configurable: true,
    });
    try {
      expect(() => logout()).not.toThrow();
      expect(setItem).toHaveBeenCalledWith(REVISION_KEY, expect.any(String));
      expect(warn).toHaveBeenCalledWith('[divine-login] could not record the sign-out for other tabs:', 'QuotaExceededError');
      expect(oauth.logout).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });
});
