import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent, act } from '@testing-library/react';

const { getSession, logout, startLogin, getPublicKey, DivineRpcSigner } = vi.hoisted(() => {
  const getPublicKey = vi.fn();
  return {
    getSession: vi.fn(),
    logout: vi.fn(),
    startLogin: vi.fn(),
    getPublicKey,
    DivineRpcSigner: vi.fn().mockImplementation(() => ({ getPublicKey })),
  };
});
vi.mock('@/lib/divineLogin', () => ({ getSession, logout, startLogin }));
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
    // The generation guard must discard it and re-clear storage; stays signed out.
    expect(screen.getByTestId('token')).toHaveTextContent('none');
    expect(logout).toHaveBeenCalledTimes(2); // logout + guard's re-clear
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
