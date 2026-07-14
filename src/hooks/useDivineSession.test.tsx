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
    getPublicKey.mockResolvedValue('NOT-HEX');
    renderProbe();
    await waitFor(() => expect(screen.getByTestId('resolving')).toHaveTextContent('false'));
    expect(screen.getByTestId('pubkey')).toHaveTextContent('none');
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
