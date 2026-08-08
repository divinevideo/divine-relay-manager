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
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

import { DivineSessionProvider } from '@/components/DivineSessionProvider';
import { useDivineSession } from '@/hooks/useDivineSession';
import { DivineLoginButton } from './DivineLoginButton';

const PUBKEY = 'a'.repeat(64);
const OTHER_PUBKEY = 'b'.repeat(64);

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

/**
 * Records the pubkey the session hands out on EVERY render. The header gates on
 * isResolving, but useCurrentUser does not expose it, so what the context VALUE
 * carries mid-transition is the contract consumers actually get.
 */
function PubkeyLog({ log }: { log: Array<string | undefined> }) {
  const { pubkey } = useDivineSession();
  log.push(pubkey);
  return null;
}

/**
 * Records identityUnavailable on EVERY render. Settled-state assertions cannot
 * see a value that is committed for one render and corrected by an effect, and
 * a one-render red alarm is still a red alarm on screen.
 */
function RenderLog({ log }: { log: boolean[] }) {
  const { identityUnavailable } = useDivineSession();
  log.push(identityUnavailable);
  return null;
}

// The provider warns by design on every identity failure, and most tests here
// drive exactly that. Capture it so assertions can read it and the suite output
// stays clean.
let warn: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  session.getSession.mockReset();
  session.logout.mockReset();
  session.startLogin.mockReset();
  getPublicKey.mockReset();
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  warn.mockRestore();
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
    expect(await screen.findByText(/actions unattributed/i))
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

// The trap is reachable from transitions, not just from boot. Each of these
// drives the provider through a change of session state.
describe('session transitions', () => {
  it('a rotated token whose identity fails does not keep showing the old moderator', async () => {
    session.getSession.mockResolvedValueOnce({ accessToken: 'tok-1' });
    getPublicKey.mockResolvedValueOnce(PUBKEY);

    renderButton();
    await screen.findByTitle(PUBKEY);

    // Token rotates (refresh on focus) and the new token cannot resolve an identity.
    session.getSession.mockResolvedValue({ accessToken: 'tok-2' });
    getPublicKey.mockRejectedValue(new Error('login server 500'));
    fireEvent.focus(window);

    // Must not keep asserting an identity that no longer resolves: attribution
    // writes read the live signer and would land null while the header claims a
    // moderator.
    await waitFor(() => expect(screen.queryByTitle(PUBKEY)).toBeNull());
    expect(await screen.findByText(/identity unavailable/i)).toBeInTheDocument();
    // The reason must be diagnosable: this is the only trace of WHY, and a
    // moderator reporting the banner leaves nothing else to go on.
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('getPublicKey failed'),
      expect.anything(),
    );
  });

  it('a healthy re-resolve of the same token does not flash the error state', async () => {
    // Resolve normally first, so this token counts as already resolved.
    session.getSession.mockResolvedValueOnce({ accessToken: 'tok-abc' });
    getPublicKey.mockResolvedValueOnce(PUBKEY);
    renderButton();
    await screen.findByTitle(PUBKEY);

    // A transient blip collapses the session to signed-out (documented provider
    // behaviour), clearing the pubkey.
    session.getSession.mockResolvedValueOnce(null);
    fireEvent.focus(window);
    await screen.findByRole('button', { name: /^sign in$/i });

    // The SAME token comes back and its pubkey is legitimately in flight. This
    // is a healthy re-resolve, not a failure, so it must not show a red error.
    session.getSession.mockResolvedValue({ accessToken: 'tok-abc' });
    getPublicKey.mockReturnValue(new Promise(() => {}));
    fireEvent.focus(window);

    await waitFor(() => expect(session.getSession).toHaveBeenCalledTimes(3));
    expect(screen.queryByText(/identity unavailable/i)).toBeNull();
  });

  it('a rotated token returning a malformed pubkey does not retain the old identity', async () => {
    session.getSession.mockResolvedValueOnce({ accessToken: 'tok-1' });
    getPublicKey.mockResolvedValueOnce(PUBKEY);

    renderButton();
    await screen.findByTitle(PUBKEY);

    session.getSession.mockResolvedValue({ accessToken: 'tok-2' });
    getPublicKey.mockResolvedValue('not-a-pubkey');
    fireEvent.focus(window);

    await waitFor(() => expect(screen.queryByTitle(PUBKEY)).toBeNull());
    expect(await screen.findByText(/identity unavailable/i)).toBeInTheDocument();
    expect(warn).toHaveBeenCalled();
  });

  it('never commits an error render while a returning token re-resolves', async () => {
    const log: boolean[] = [];
    session.getSession.mockResolvedValueOnce({ accessToken: 'tok-abc' });
    getPublicKey.mockResolvedValueOnce(PUBKEY);

    render(
      <DivineSessionProvider>
        <RenderLog log={log} />
      </DivineSessionProvider>,
    );
    await waitFor(() => expect(log.at(-1)).toBe(false));

    // Blip clears the session, then the SAME token returns and re-resolves.
    session.getSession.mockResolvedValueOnce(null);
    fireEvent.focus(window);
    await waitFor(() => expect(session.getSession).toHaveBeenCalledTimes(2));

    const before = log.length;
    session.getSession.mockResolvedValue({ accessToken: 'tok-abc' });
    getPublicKey.mockReturnValue(new Promise(() => {}));
    fireEvent.focus(window);
    await waitFor(() => expect(session.getSession).toHaveBeenCalledTimes(3));

    // Not one render may claim the identity is unavailable: this is a healthy
    // re-resolve, and the moderator would see a red alarm flash.
    expect(log.slice(before)).not.toContain(true);
  });

  it('never pairs the previous token\'s pubkey with the new token\'s signer', async () => {
    const log: Array<string | undefined> = [];
    session.getSession.mockResolvedValueOnce({ accessToken: 'tok-1' });
    getPublicKey.mockResolvedValueOnce(PUBKEY);

    render(
      <DivineSessionProvider>
        <PubkeyLog log={log} />
      </DivineSessionProvider>,
    );
    await waitFor(() => expect(log.at(-1)).toBe(PUBKEY));

    // Rotate to a new token whose pubkey is slow to resolve. The signer is
    // rebuilt from the new token immediately; the pubkey must not lag behind it.
    session.getSession.mockResolvedValue({ accessToken: 'tok-2' });
    let resolvePubkey: (pk: string) => void = () => {};
    getPublicKey.mockReturnValue(new Promise<string>((r) => { resolvePubkey = r; }));

    const before = log.length;
    fireEvent.focus(window);
    await waitFor(() => expect(session.getSession).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(log.length).toBeGreaterThan(before));

    // Not one render may hand out tok-1's identity while tok-2 is in flight:
    // that is one session's pubkey attached to another session's signer, and
    // useCurrentUser has no isResolving for a consumer to gate on.
    expect(log.slice(before)).not.toContain(PUBKEY);

    resolvePubkey(OTHER_PUBKEY);
    await waitFor(() => expect(log.at(-1)).toBe(OTHER_PUBKEY));
  });

  it('a stored session with no access token is still escapable', async () => {
    // StoredCredentials.accessToken is optional (a bunker-only session). There is
    // no signer, so no identity -- the original dead end in a different shape.
    session.getSession.mockResolvedValue({ bunkerUrl: 'bunker://x' });

    renderButton();

    expect(await screen.findByRole('button', { name: /sign out/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^sign in$/i })).toBeNull();
  });
});

describe('states that must not regress', () => {
  it('does not render the error state while the pubkey is in flight', async () => {
    session.getSession.mockResolvedValue({ accessToken: 'tok-abc' });
    getPublicKey.mockReturnValue(new Promise(() => {}));

    renderButton();

    await waitFor(() => expect(session.getSession).toHaveBeenCalled());
    expect(screen.queryByText(/identity unavailable/i)).toBeNull();
  });

  it('a fully resolved moderator still shows their identity and sign out', async () => {
    session.getSession.mockResolvedValue({ accessToken: 'tok-abc' });
    getPublicKey.mockResolvedValue(PUBKEY);

    renderButton();

    expect(await screen.findByRole('button', { name: /sign out/i })).toBeInTheDocument();
    expect(screen.getByTitle(PUBKEY)).toBeInTheDocument();
    // A working session is not the broken state.
    expect(screen.queryByText(/actions unattributed/i)).toBeNull();
  });

  it('a signed-out moderator still gets a plain sign-in', async () => {
    session.getSession.mockResolvedValue(null);

    renderButton();

    expect(await screen.findByRole('button', { name: /^sign in$/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /sign out/i })).toBeNull();
    expect(screen.queryByText(/actions unattributed/i)).toBeNull();
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
