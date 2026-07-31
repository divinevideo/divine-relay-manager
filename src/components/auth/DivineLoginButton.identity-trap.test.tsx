// ABOUTME: A completed OAuth login whose pubkey never resolves must be visibly
// ABOUTME: broken and escapable, not a silent dead end with no way out.
//
// Reported by a moderator (2026-07-31): "there's no logout option and it
// encourages you to log in and then you log in and then ... you cannot execute
// anything." Mechanism: `user` needs BOTH pubkey and signer. OAuth yields the
// signer (from the access token), but the pubkey comes from a separate
// DivineRpc call to login.divine.video. When that call fails (an account with no
// Keycast-managed key, an RPC error, a token without signing scope) the provider
// swallows it, `user` stays undefined, and DivineLoginButton renders "Sign in"
// forever with no sign-out. The moderator is signed in, cannot tell, cannot
// leave, and every action they take records null attribution.
//
// These drive the REAL DivineSessionProvider and the REAL useCurrentUser; only
// the SDK boundary (session + signer) is mocked.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

import { DivineSessionProvider } from '@/components/DivineSessionProvider';
import { useDivineSession } from '@/hooks/useDivineSession';
import { DivineLoginButton } from './DivineLoginButton';

const PUBKEY = 'a'.repeat(64);

const session = vi.hoisted(() => ({
  getSession: vi.fn(),
  logout: vi.fn(),
  startLogin: vi.fn(),
}));
vi.mock('@/lib/divineLogin', () => ({
  getSession: session.getSession,
  logout: session.logout,
  startLogin: session.startLogin,
  completeLogin: vi.fn(),
  DIVINE_LOGIN_SERVER_URL: 'https://login.example.test',
  DIVINE_LOGIN_CLIENT_ID: 'divine-relay-admin',
}));

// The signer the provider builds from the access token. getPublicKey is the call
// that fails for the trapped moderator.
const getPublicKey = vi.hoisted(() => vi.fn());
vi.mock('@/lib/divineSigner', () => ({
  DivineRpcSigner: class {
    getPublicKey = getPublicKey;
    signEvent = vi.fn();
    getRelays = vi.fn();
  },
}));

// Profile metadata is useAuthor's concern.
vi.mock('@/hooks/useAuthor', () => ({
  useAuthor: () => ({ data: undefined, isLoading: false }),
}));

function renderButton() {
  return render(
    <DivineSessionProvider>
      <DivineLoginButton />
    </DivineSessionProvider>,
  );
}

/** Reads the session contract other code depends on. */
function SessionProbe() {
  const { identityUnavailable } = useDivineSession();
  return <div data-testid='probe'>{String(identityUnavailable)}</div>;
}

beforeEach(() => {
  session.getSession.mockReset();
  session.logout.mockReset();
  session.startLogin.mockReset();
  getPublicKey.mockReset();
  localStorage.clear();
});

describe('signed in but identity never resolves', () => {
  beforeEach(() => {
    session.getSession.mockResolvedValue({ accessToken: 'tok-abc' });
    getPublicKey.mockRejectedValue(new Error('no keycast key for this account'));
  });

  it('offers a way out instead of a dead-end "Sign in"', async () => {
    renderButton();
    expect(await screen.findByRole('button', { name: /sign out/i })).toBeInTheDocument();
  });

  it('does not present itself as signed out', async () => {
    renderButton();
    await screen.findByRole('button', { name: /sign out/i });
    expect(screen.queryByRole('button', { name: /^sign in$/i })).toBeNull();
  });

  it('says the moderator is unattributed rather than failing silently', async () => {
    renderButton();
    expect(await screen.findByText(/not attributed|unattributed|identity unavailable/i))
      .toBeInTheDocument();
  });

  it('signing out clears the stuck session', async () => {
    renderButton();
    fireEvent.click(await screen.findByRole('button', { name: /sign out/i }));
    expect(session.logout).toHaveBeenCalled();
    expect(await screen.findByRole('button', { name: /^sign in$/i })).toBeInTheDocument();
  });

  it('exposes identityUnavailable on the session', async () => {
    render(
      <DivineSessionProvider>
        <SessionProbe />
      </DivineSessionProvider>,
    );
    await waitFor(() => expect(screen.getByTestId('probe')).toHaveTextContent('true'));
  });
});

describe('states that must not regress', () => {
  it('a fully resolved moderator still shows their identity and sign out', async () => {
    session.getSession.mockResolvedValue({ accessToken: 'tok-abc' });
    getPublicKey.mockResolvedValue(PUBKEY);

    renderButton();

    expect(await screen.findByRole('button', { name: /sign out/i })).toBeInTheDocument();
    expect(screen.getByTitle(PUBKEY)).toBeInTheDocument();
    // A working session is not the broken state.
    expect(screen.queryByText(/not attributed|unattributed|identity unavailable/i)).toBeNull();
  });

  it('a signed-out moderator still gets a plain sign-in', async () => {
    session.getSession.mockResolvedValue(null);

    renderButton();

    expect(await screen.findByRole('button', { name: /^sign in$/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /sign out/i })).toBeNull();
    expect(screen.queryByText(/not attributed|unattributed|identity unavailable/i)).toBeNull();
  });

  it('is not "unavailable" while the pubkey is still in flight', async () => {
    session.getSession.mockResolvedValue({ accessToken: 'tok-abc' });
    // Never settles: the resolve window, where pubkey is legitimately absent.
    getPublicKey.mockReturnValue(new Promise(() => {}));

    render(
      <DivineSessionProvider>
        <SessionProbe />
      </DivineSessionProvider>,
    );

    // Give the session resolve a chance to land before asserting.
    await waitFor(() => expect(session.getSession).toHaveBeenCalled());
    expect(screen.getByTestId('probe')).toHaveTextContent('false');
  });

  it('signed out reports identityUnavailable as false', async () => {
    session.getSession.mockResolvedValue(null);
    render(
      <DivineSessionProvider>
        <SessionProbe />
      </DivineSessionProvider>,
    );
    await waitFor(() => expect(screen.getByTestId('probe')).toHaveTextContent('false'));
  });
});
