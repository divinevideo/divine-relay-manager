import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the SDK before importing the module under test. vi.hoisted lets the
// mock factory reference these without tripping the hoist-before-init error.
const { oauth, createDivineClient } = vi.hoisted(() => {
  const oauth = {
    getAuthorizationUrl: vi.fn(),
    parseCallback: vi.fn(),
    exchangeCode: vi.fn(),
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

  it('logout delegates to the SDK', () => {
    logout();
    expect(oauth.logout).toHaveBeenCalled();
  });
});
