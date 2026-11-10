import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent, act } from '@testing-library/react';

const { getSession, logout, startLogin, acceptSignOutFromOtherTab, getPublicKey, DivineRpcSigner } = vi.hoisted(() => {
  const getPublicKey = vi.fn();
  return {
    getSession: vi.fn(),
    logout: vi.fn(),
    startLogin: vi.fn(),
    acceptSignOutFromOtherTab: vi.fn(),
    getPublicKey,
    DivineRpcSigner: vi.fn().mockImplementation(() => ({ getPublicKey })),
  };
});
vi.mock('@/lib/divineLogin', () => ({ getSession, logout, startLogin, acceptSignOutFromOtherTab }));
vi.mock('@/lib/divineSigner', () => ({ DivineRpcSigner }));

import { DivineSessionProvider } from '@/components/DivineSessionProvider';
import { useDivineSession } from '@/hooks/useDivineSession';

const PUBKEY = 'a'.repeat(64);

function Probe() {
  const { credentials, pubkey, isResolving, logout } = useDivineSession();
  return (
    <div>
      <span data-testid="resolving">{String(isResolving)}</span>
      <span data-testid="token">{credentials?.accessToken ?? 'none'}</span>
      <span data-testid="pubkey">{pubkey ?? 'none'}</span>
      <button onClick={logout}>logout</button>
    </div>
  );
}

function renderProbe() {
  return render(
    <DivineSessionProvider>
      <Probe />
    </DivineSessionProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  getPublicKey.mockResolvedValue(PUBKEY);
});

describe('DivineSessionProvider / useDivineSession', () => {
  it('resolves the session and the moderator pubkey on mount', async () => {
    getSession.mockResolvedValue({ bunkerUrl: 'bunker://x', accessToken: 'tok' });
    renderProbe();
    expect(screen.getByTestId('resolving')).toHaveTextContent('true');
    await waitFor(() => expect(screen.getByTestId('pubkey')).toHaveTextContent(PUBKEY));
    expect(screen.getByTestId('token')).toHaveTextContent('tok');
    expect(screen.getByTestId('resolving')).toHaveTextContent('false');
    // signer built with the session token
    expect(DivineRpcSigner).toHaveBeenCalledTimes(1);
    const getter = DivineRpcSigner.mock.calls[0][0] as () => string | undefined;
    expect(getter()).toBe('tok');
  });

  it('settles to signed-out (not stuck resolving) when there is no session', async () => {
    getSession.mockResolvedValue(null);
    renderProbe();
    await waitFor(() => expect(screen.getByTestId('resolving')).toHaveTextContent('false'));
    expect(screen.getByTestId('pubkey')).toHaveTextContent('none');
  });

  it('keeps pubkey undefined (and settles) when getPublicKey rejects', async () => {
    getSession.mockResolvedValue({ bunkerUrl: 'bunker://x', accessToken: 'tok' });
    getPublicKey.mockRejectedValue(new Error('rpc down'));
    renderProbe();
    await waitFor(() => expect(screen.getByTestId('resolving')).toHaveTextContent('false'));
    expect(screen.getByTestId('pubkey')).toHaveTextContent('none');
  });

  it('ignores a non-canonical pubkey from getPublicKey', async () => {
    getSession.mockResolvedValue({ bunkerUrl: 'bunker://x', accessToken: 'tok' });
    getPublicKey.mockResolvedValue('not a pubkey at all');
    renderProbe();
    await waitFor(() => expect(screen.getByTestId('resolving')).toHaveTextContent('false'));
    expect(screen.getByTestId('pubkey')).toHaveTextContent('none');
  });

  it('normalizes an uppercase/whitespace pubkey to canonical lowercase', async () => {
    getSession.mockResolvedValue({ bunkerUrl: 'bunker://x', accessToken: 'tok' });
    getPublicKey.mockResolvedValue(`  ${'A'.repeat(64)}  `);
    renderProbe();
    await waitFor(() => expect(screen.getByTestId('pubkey')).toHaveTextContent('a'.repeat(64)));
  });

  it('stays resolving (no "Sign in" flash) while the pubkey resolves for a valid session', async () => {
    // credentials resolve first; the pubkey RPC is still pending. isResolving must
    // stay true across that window so the button shows a skeleton, not "Sign in".
    let releasePubkey!: (pk: string) => void;
    getSession.mockResolvedValue({ bunkerUrl: 'bunker://x', accessToken: 'tok' });
    getPublicKey.mockReturnValue(
      new Promise((resolve) => {
        releasePubkey = resolve;
      }),
    );
    renderProbe();
    await waitFor(() => expect(screen.getByTestId('token')).toHaveTextContent('tok'));
    expect(screen.getByTestId('resolving')).toHaveTextContent('true');
    expect(screen.getByTestId('pubkey')).toHaveTextContent('none');
    await act(async () => {
      releasePubkey(PUBKEY);
    });
    await waitFor(() => expect(screen.getByTestId('resolving')).toHaveTextContent('false'));
    expect(screen.getByTestId('pubkey')).toHaveTextContent(PUBKEY);
  });

  it('degrades to signed-out when getSession throws (storage disabled)', async () => {
    getSession.mockRejectedValue(new Error('SecurityError: localStorage disabled'));
    renderProbe();
    await waitFor(() => expect(screen.getByTestId('resolving')).toHaveTextContent('false'));
    expect(screen.getByTestId('token')).toHaveTextContent('none');
  });

  it('logout clears the session and pubkey and calls the SDK', async () => {
    getSession.mockResolvedValue({ bunkerUrl: 'bunker://x', accessToken: 'tok' });
    renderProbe();
    await waitFor(() => expect(screen.getByTestId('pubkey')).toHaveTextContent(PUBKEY));
    fireEvent.click(screen.getByText('logout'));
    expect(logout).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.getByTestId('token')).toHaveTextContent('none'));
    expect(screen.getByTestId('pubkey')).toHaveTextContent('none');
  });

  it('does not resurrect the session when logout races an in-flight refresh', async () => {
    // getSession resolves LATE so we can log out while it is in flight.
    let releaseSession!: (v: { bunkerUrl: string; accessToken: string }) => void;
    getSession.mockReturnValue(
      new Promise((resolve) => {
        releaseSession = resolve;
      }),
    );
    renderProbe();
    // Mount refresh is in flight; log out before it resolves.
    fireEvent.click(screen.getByText('logout'));
    expect(logout).toHaveBeenCalledTimes(1);
    // Now the in-flight getSession resolves with a (re-persisted) session.
    await act(async () => {
      releaseSession({ bunkerUrl: 'bunker://x', accessToken: 'tok' });
    });
    // The generation guard must discard it; stays signed out. Clearing what the
    // refresh re-persisted is getSession's job, under the session lock: a second
    // clear here would run outside the lock and could delete a newer sign-in.
    expect(screen.getByTestId('token')).toHaveTextContent('none');
    expect(logout).toHaveBeenCalledTimes(1); // the sign-out only
    expect(screen.getByTestId('resolving')).toHaveTextContent('false');
  });

  it('re-resolves the session on window focus', async () => {
    getSession.mockResolvedValue(null);
    renderProbe();
    await waitFor(() => expect(screen.getByTestId('resolving')).toHaveTextContent('false'));
    expect(getSession).toHaveBeenCalledTimes(1);
    getSession.mockResolvedValue({ bunkerUrl: 'bunker://x', accessToken: 'tok' });
    await act(async () => {
      window.dispatchEvent(new Event('focus'));
    });
    await waitFor(() => expect(screen.getByTestId('pubkey')).toHaveTextContent(PUBKEY));
    expect(getSession).toHaveBeenCalledTimes(2);
  });

  it('defaults to signed-out with no provider', () => {
    render(<Probe />);
    expect(screen.getByTestId('token')).toHaveTextContent('none');
    expect(screen.getByTestId('resolving')).toHaveTextContent('false');
  });
});

describe('getModeratorToken (synchronous login-token snapshot)', () => {
  function TokenProbe({ onReady }: { onReady: (get: () => string | undefined, logout: () => void) => void }) {
    const { getModeratorToken, logout, credentials } = useDivineSession();
    onReady(getModeratorToken, logout);
    return <span data-testid="token">{credentials?.accessToken ?? 'none'}</span>;
  }

  function renderTokenProbe() {
    const handle: { get: () => string | undefined; logout: () => void } = {
      get: () => 'unset',
      logout: () => {},
    };
    render(
      <DivineSessionProvider>
        <TokenProbe onReady={(get, logout) => { handle.get = get; handle.logout = logout; }} />
      </DivineSessionProvider>,
    );
    return handle;
  }

  it('returns the signed-in access token', async () => {
    getSession.mockResolvedValue({ bunkerUrl: 'bunker://x', accessToken: 'tok-a' });
    const handle = renderTokenProbe();
    await waitFor(() => expect(screen.getByTestId('token')).toHaveTextContent('tok-a'));
    expect(handle.get()).toBe('tok-a');
  });

  it('returns undefined after logout', async () => {
    getSession.mockResolvedValue({ bunkerUrl: 'bunker://x', accessToken: 'tok-a' });
    const handle = renderTokenProbe();
    await waitFor(() => expect(screen.getByTestId('token')).toHaveTextContent('tok-a'));
    act(() => handle.logout());
    await waitFor(() => expect(screen.getByTestId('token')).toHaveTextContent('none'));
    expect(handle.get()).toBeUndefined();
  });

  it('reads as signed out in the same act as logout, before React flushes', async () => {
    getSession.mockResolvedValue({ bunkerUrl: 'bunker://x', accessToken: 'tok-a' });
    let h: { token: () => string | undefined; logout: () => void } = {
      token: () => 'unset',
      logout: () => {},
    };
    function LogoutProbe() {
      const s = useDivineSession();
      h = { token: s.getModeratorToken, logout: s.logout };
      return <span data-testid="token">{s.credentials?.accessToken ?? 'none'}</span>;
    }
    render(
      <DivineSessionProvider>
        <LogoutProbe />
      </DivineSessionProvider>,
    );
    await waitFor(() => expect(screen.getByTestId('token')).toHaveTextContent('tok-a'));
    let tok: string | undefined = 'unset';
    act(() => {
      h.logout();
      tok = h.token();
    });
    expect(tok).toBeUndefined();
  });

  it('returns undefined when signed out from the start', async () => {
    getSession.mockResolvedValue(null);
    const handle = renderTokenProbe();
    await waitFor(() => expect(screen.getByTestId('token')).toHaveTextContent('none'));
    expect(handle.get()).toBeUndefined();
  });

  it('a token taken before an account switch keeps the old value', async () => {
    getSession.mockResolvedValue({ bunkerUrl: 'bunker://x', accessToken: 'tok-a' });
    const handle = renderTokenProbe();
    await waitFor(() => expect(screen.getByTestId('token')).toHaveTextContent('tok-a'));
    const captured = handle.get();
    // The moderator switches accounts: the next focus refresh yields new credentials.
    getSession.mockResolvedValue({ bunkerUrl: 'bunker://y', accessToken: 'tok-b' });
    await act(async () => {
      window.dispatchEvent(new Event('focus'));
    });
    await waitFor(() => expect(screen.getByTestId('token')).toHaveTextContent('tok-b'));
    expect(handle.get()).toBe('tok-b');
    expect(captured).toBe('tok-a');
  });

  it('defaults to undefined with no provider', () => {
    let got: string | undefined = 'sentinel';
    function Bare() {
      got = useDivineSession().getModeratorToken();
      return null;
    }
    render(<Bare />);
    expect(got).toBeUndefined();
  });
});

// The worker verifies the login token on every action (#178 phase 2), so an
// expired token records nobody. These pin that the session refreshes before
// expiry and never hands an expired token to an action.
describe('login token expiry', () => {
  const T0 = new Date('2026-11-06T12:00:00Z').getTime();
  const MIN = 60_000;

  function TokenProbe({ onReady }: { onReady: (get: () => string | undefined) => void }) {
    const { getModeratorToken, credentials } = useDivineSession();
    onReady(getModeratorToken);
    return <span data-testid="token">{credentials?.accessToken ?? 'none'}</span>;
  }

  function renderTokenProbe() {
    const handle: { get: () => string | undefined } = { get: () => 'unset' };
    render(
      <DivineSessionProvider>
        <TokenProbe onReady={(get) => { handle.get = get; }} />
      </DivineSessionProvider>,
    );
    return handle;
  }

  // waitFor polls on real timers, so flush with the fake clock instead.
  async function flush(ms = 0) {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(ms);
    });
  }

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('an expired token: getModeratorToken returns undefined and starts a refresh', async () => {
    getSession.mockResolvedValue({ bunkerUrl: 'bunker://x', accessToken: 'tok-a', expiresAt: T0 + 10 * MIN });
    const handle = renderTokenProbe();
    await flush();
    expect(handle.get()).toBe('tok-a');
    expect(getSession).toHaveBeenCalledTimes(1);

    // The clock passes expiresAt with no timer having run (a slept laptop).
    vi.setSystemTime(T0 + 11 * MIN);
    getSession.mockReturnValue(new Promise(() => {})); // the refresh is still in flight
    let taken: string | undefined = 'unset';
    act(() => {
      taken = handle.get();
    });

    expect(taken).toBeUndefined();
    expect(getSession).toHaveBeenCalledTimes(2);
  });

  it('a token whose expiry is not known is handed out as before', async () => {
    getSession.mockResolvedValue({ bunkerUrl: 'bunker://x', accessToken: 'tok-a' });
    const handle = renderTokenProbe();
    await flush();
    vi.setSystemTime(T0 + 365 * 24 * 60 * MIN);
    expect(handle.get()).toBe('tok-a');
    expect(getSession).toHaveBeenCalledTimes(1);
  });

  it('refreshes on a timer before the token expires', async () => {
    getSession.mockResolvedValue({ bunkerUrl: 'bunker://x', accessToken: 'tok-a', expiresAt: T0 + 10 * MIN });
    const handle = renderTokenProbe();
    await flush();
    expect(getSession).toHaveBeenCalledTimes(1);
    getSession.mockResolvedValue({ bunkerUrl: 'bunker://x', accessToken: 'tok-b', expiresAt: T0 + 70 * MIN });

    // Four minutes before expiry, not at it.
    await flush(6 * MIN - 1);
    expect(getSession).toHaveBeenCalledTimes(1);
    await flush(1);
    expect(getSession).toHaveBeenCalledTimes(2);
    expect(Date.now()).toBeLessThan(T0 + 10 * MIN);
    expect(screen.getByTestId('token')).toHaveTextContent('tok-b');
    expect(handle.get()).toBe('tok-b');
  });

  it('a token issued with less than the lead left refreshes at most every 30 seconds', async () => {
    let n = 0;
    getSession.mockImplementation(async () => {
      n += 1;
      return { bunkerUrl: 'bunker://x', accessToken: `tok-${n}`, expiresAt: Date.now() + 2 * MIN };
    });
    renderTokenProbe();
    await flush();
    await flush(29_999);
    expect(getSession).toHaveBeenCalledTimes(1);
    await flush(1);
    expect(getSession).toHaveBeenCalledTimes(2);
  });

  it('a token that expires beyond the timer range does not refresh at once', async () => {
    // setTimeout fires immediately for a delay over 2^31-1 ms (about 24.8 days).
    getSession.mockResolvedValue({ bunkerUrl: 'bunker://x', accessToken: 'tok-a', expiresAt: T0 + 30 * 24 * 60 * MIN });
    renderTokenProbe();
    await flush();
    await flush(60_000);
    expect(getSession).toHaveBeenCalledTimes(1);
  });

  // The expiry timer can run a moment before the SDK's clock reaches expiresAt.
  // A session with no refresh token then comes back unchanged, and without a
  // retry it would stay marked expired until the next focus.
  it('retries once just after expiry when the expiry refresh returns the same token', async () => {
    const same = () => ({ bunkerUrl: 'bunker://x', accessToken: 'tok-a', expiresAt: T0 + 10 * MIN });
    getSession.mockImplementation(async () => same());
    renderTokenProbe();
    await flush();

    // Pre-expiry refresh (6 min) and expiry refresh (10 min) both get tok-a back.
    await flush(10 * MIN);
    expect(getSession).toHaveBeenCalledTimes(3);
    expect(screen.getByTestId('token')).toHaveTextContent('tok-a');

    // Just after expiresAt the SDK reports the session expired: signed out.
    getSession.mockResolvedValue(null);
    await flush(1_000);
    expect(getSession).toHaveBeenCalledTimes(4);
    expect(screen.getByTestId('token')).toHaveTextContent('none');
  });

  it('retries only once, even if the retry also gets the same token back', async () => {
    getSession.mockImplementation(async () => ({ bunkerUrl: 'bunker://x', accessToken: 'tok-a', expiresAt: T0 + 10 * MIN }));
    renderTokenProbe();
    await flush();
    await flush(10 * MIN + 1_000);
    expect(getSession).toHaveBeenCalledTimes(4);
    await flush(60 * MIN);
    expect(getSession).toHaveBeenCalledTimes(4);
  });

  it('stops the schedule on unmount', async () => {
    getSession.mockResolvedValue({ bunkerUrl: 'bunker://x', accessToken: 'tok-a', expiresAt: T0 + 10 * MIN });
    const { unmount } = render(
      <DivineSessionProvider>
        <span />
      </DivineSessionProvider>,
    );
    await flush();
    unmount();
    await flush(20 * MIN);
    expect(getSession).toHaveBeenCalledTimes(1);
  });

  describe('visibilitychange', () => {
    let visibility: DocumentVisibilityState = 'visible';
    beforeEach(() => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visibility });
    });
    afterEach(() => {
      // Drop the own-property override so the prototype getter applies again.
      delete (document as { visibilityState?: unknown }).visibilityState;
    });

    it('refreshes when the tab becomes visible', async () => {
      getSession.mockResolvedValue({ bunkerUrl: 'bunker://x', accessToken: 'tok-a', expiresAt: T0 + 60 * MIN });
      renderTokenProbe();
      await flush();
      expect(getSession).toHaveBeenCalledTimes(1);

      visibility = 'visible';
      await act(async () => {
        document.dispatchEvent(new Event('visibilitychange'));
      });
      expect(getSession).toHaveBeenCalledTimes(2);
    });

    it('does not refresh when the tab is hidden', async () => {
      getSession.mockResolvedValue({ bunkerUrl: 'bunker://x', accessToken: 'tok-a', expiresAt: T0 + 60 * MIN });
      renderTokenProbe();
      await flush();

      visibility = 'hidden';
      await act(async () => {
        document.dispatchEvent(new Event('visibilitychange'));
      });
      expect(getSession).toHaveBeenCalledTimes(1);
    });
  });
});

// A sign-out in one tab signs out every tab of the app, without waiting for
// the others to be focused.
// A sign-out in one tab signs out every tab of the app, without waiting for
// the others to be focused. Which sessions a message ends is the library's
// call (acceptSignOutFromOtherTab), pinned with the real library in
// DivineSessionProvider.cross-tab.test.tsx; these pin the provider's wiring.
describe('sign-out across tabs', () => {
  // An in-memory BroadcastChannel: a message reaches every other open channel
  // of the same name, never the sender, and asynchronously, as in a browser.
  class FakeChannel {
    static open: FakeChannel[] = [];
    onmessage: ((event: MessageEvent) => void) | null = null;
    posted: unknown[] = [];
    closed = false;
    constructor(public name: string) {
      FakeChannel.open.push(this);
    }
    postMessage(data: unknown) {
      this.posted.push(data);
      for (const other of FakeChannel.open) {
        if (other !== this && other.name === this.name && !other.closed) {
          queueMicrotask(() => other.onmessage?.(new MessageEvent('message', { data })));
        }
      }
    }
    close() {
      this.closed = true;
      FakeChannel.open = FakeChannel.open.filter((c) => c !== this);
    }
  }

  const MESSAGE = { type: 'signed-out', endedRevision: 'rev-1' };
  const SESSION_A = { bunkerUrl: 'bunker://x', accessToken: 'tok-a' };
  let handle: { get: () => string | undefined; logout: () => void; refresh: () => Promise<void> };
  function SessionProbe() {
    const s = useDivineSession();
    handle = { get: s.getModeratorToken, logout: s.logout, refresh: s.refresh };
    return <span data-testid="signed-in">{String(s.isSignedIn)}</span>;
  }
  async function renderSignedIn() {
    getSession.mockResolvedValue(SESSION_A);
    const view = render(
      <DivineSessionProvider>
        <SessionProbe />
      </DivineSessionProvider>,
    );
    await waitFor(() => expect(screen.getByTestId('signed-in')).toHaveTextContent('true'));
    expect(handle.get()).toBe('tok-a');
    return view;
  }
  async function receive(data: unknown) {
    const otherTab = new FakeChannel('divine-login');
    await act(async () => {
      otherTab.postMessage(data);
    });
  }
  const providerChannel = () => FakeChannel.open.find((c) => c.name === 'divine-login');

  beforeEach(() => {
    FakeChannel.open = [];
    vi.stubGlobal('BroadcastChannel', FakeChannel);
    logout.mockReturnValue(MESSAGE);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('a message that ends this tab\'s session signs this tab out', async () => {
    await renderSignedIn();
    acceptSignOutFromOtherTab.mockReturnValue(true);
    await receive(MESSAGE);
    expect(acceptSignOutFromOtherTab).toHaveBeenCalledWith(MESSAGE, SESSION_A);
    expect(screen.getByTestId('signed-in')).toHaveTextContent('false');
    expect(handle.get()).toBeUndefined();
    // Storage is the library's to clear, and the sender already cleared it.
    expect(logout).not.toHaveBeenCalled();
  });

  it('a message that does not end this tab\'s session changes nothing', async () => {
    await renderSignedIn();
    acceptSignOutFromOtherTab.mockReturnValue(false);
    await receive(MESSAGE);
    expect(screen.getByTestId('signed-in')).toHaveTextContent('true');
    expect(handle.get()).toBe('tok-a');
  });

  // The message can arrive after a refresh's result is applied but before the
  // effect that mirrors it into tokenRef runs. The session matched is the one
  // applied, not the one the mirror still shows.
  it('matches the credentials a refresh just applied, even before effects run', async () => {
    await renderSignedIn();
    const refreshed = { bunkerUrl: 'bunker://x', accessToken: 'tok-refreshed' };
    getSession.mockResolvedValue(refreshed);
    acceptSignOutFromOtherTab.mockReturnValue(true);
    const otherTab = new FakeChannel('divine-login');
    await act(async () => {
      window.dispatchEvent(new Event('focus'));
      for (let i = 0; i < 5; i += 1) await Promise.resolve();
      otherTab.postMessage(MESSAGE);
      await Promise.resolve();
    });
    expect(acceptSignOutFromOtherTab).toHaveBeenCalledWith(MESSAGE, refreshed);
    expect(screen.getByTestId('signed-in')).toHaveTextContent('false');
  });

  it('a signed-out tab passes no session', async () => {
    getSession.mockResolvedValue(null);
    render(
      <DivineSessionProvider>
        <SessionProbe />
      </DivineSessionProvider>,
    );
    await waitFor(() => expect(getSession).toHaveBeenCalled());
    await receive(MESSAGE);
    expect(acceptSignOutFromOtherTab).toHaveBeenCalledWith(MESSAGE, null);
  });

  // Matt, 2026-11-09: the sign-out goes ahead even if the library throws.
  it('a throwing sdk logout still signs this tab out, broadcasts, and the tab recovers', async () => {
    await renderSignedIn();
    const otherTab = new FakeChannel('divine-login');
    const received: unknown[] = [];
    otherTab.onmessage = (event) => received.push(event.data);
    logout.mockImplementationOnce(() => { throw new DOMException('denied', 'SecurityError'); });
    let tok: string | undefined = 'unset';
    await act(async () => {
      expect(() => handle.logout()).toThrow('denied');
      tok = handle.get();
    });
    expect(tok).toBeUndefined();
    expect(screen.getByTestId('signed-in')).toHaveTextContent('false');
    // Without the library's message, the other tabs are told the ended
    // session is unknown, and end whatever they hold.
    expect(received).toEqual([{ type: 'signed-out' }]);

    // Not wedged: the next read is applied (the library refuses the ended
    // session itself, pinned in the cross-tab test), and a new sign-in shows.
    getSession.mockResolvedValue({ bunkerUrl: 'bunker://y', accessToken: 'tok-b' });
    await act(async () => {
      await handle.refresh();
    });
    expect(screen.getByTestId('signed-in')).toHaveTextContent('true');
    expect(handle.get()).toBe('tok-b');
  });

  it('receiving a sign-out does not re-broadcast', async () => {
    await renderSignedIn();
    acceptSignOutFromOtherTab.mockReturnValue(true);
    await receive(MESSAGE);
    expect(screen.getByTestId('signed-in')).toHaveTextContent('false');
    expect(providerChannel()?.posted).toEqual([]);
  });

  it('logout broadcasts the library\'s message once', async () => {
    await renderSignedIn();
    const otherTab = new FakeChannel('divine-login');
    const received: unknown[] = [];
    otherTab.onmessage = (event) => received.push(event.data);
    await act(async () => {
      handle.logout();
    });
    expect(received).toEqual([MESSAGE]);
    expect(logout).toHaveBeenCalledTimes(1);
  });

  it('logout still clears the token synchronously', async () => {
    await renderSignedIn();
    let tok: string | undefined = 'unset';
    act(() => {
      handle.logout();
      tok = handle.get();
    });
    expect(tok).toBeUndefined();
  });

  it('closes the channel on unmount', async () => {
    const view = await renderSignedIn();
    const channel = providerChannel();
    expect(channel).toBeDefined();
    view.unmount();
    expect(channel?.closed).toBe(true);
  });

  // The focus and visibility re-read still catches such a tab up later.
  it('without BroadcastChannel, logout still signs this tab out', async () => {
    vi.stubGlobal('BroadcastChannel', undefined);
    await renderSignedIn();
    act(() => handle.logout());
    expect(screen.getByTestId('signed-in')).toHaveTextContent('false');
    expect(logout).toHaveBeenCalledTimes(1);
  });
});
