// ABOUTME: A moderator acting without a resolved identity must be told their
// ABOUTME: actions may not carry their name, and offered the way to fix it.
//
// Removing the login walls (this PR) restores access for everyone CF Access
// admits, but it also removes the loudest cue that you have no divine-login
// session. Without a replacement, a moderator sees a fully working tool, never
// signs in, and every decision they write lands moderator_pubkey = null --
// silently defeating the audit trail #181 exists to build. With
// REQUIRE_MODERATOR_LOGIN on, such a decision is refused instead, so the
// notice's wording has to hold in both cases.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';

import { DivineSessionProvider } from '@/components/DivineSessionProvider';
import { useDivineSession } from '@/hooks/useDivineSession';
import { useCurrentUser } from '@/hooks/useCurrentUser';
import { AttributionNotice } from './AttributionNotice';

const PUBKEY = 'a'.repeat(64);

const session = vi.hoisted(() => ({
  getSession: vi.fn(),
  startLogin: vi.fn(),
  logout: vi.fn(),
}));
vi.mock('@/lib/divineLogin', () => ({
  getSession: session.getSession,
  startLogin: session.startLogin,
  logout: session.logout,
  acceptSignOutFromOtherTab: vi.fn(() => false),
  completeLogin: vi.fn(),
  DIVINE_LOGIN_SERVER_URL: 'https://login.example.test',
  DIVINE_LOGIN_CLIENT_ID: 'divine-relay-admin',
}));

const getPublicKey = vi.hoisted(() => vi.fn());
vi.mock('@/lib/divineSigner', () => ({
  DivineRpcSigner: class {
    getPublicKey = getPublicKey;
    signEvent = vi.fn();
    getRelays = vi.fn();
  },
}));

vi.mock('@/hooks/useAuthor', () => ({
  useAuthor: () => ({ data: undefined, isLoading: false }),
}));

/**
 * Reports session state so the negative assertions below can wait for a real
 * settled state first. Without it, `expect(container).toBeEmptyDOMElement()` is
 * satisfied by the initial pre-resolve render and proves nothing.
 */
function Sentinel() {
  const { isResolving } = useDivineSession();
  const { user } = useCurrentUser();
  return <div data-testid='state'>{isResolving ? 'resolving' : `settled:${!!user}`}</div>;
}

// The session's own sign-out, as the header's Sign out button calls it.
function SignOut() {
  const { logout } = useDivineSession();
  return <button onClick={logout}>test-sign-out</button>;
}

function renderNotice() {
  return render(
    <DivineSessionProvider>
      <AttributionNotice />
      <Sentinel />
      <SignOut />
    </DivineSessionProvider>,
  );
}

const DISMISS_KEY = 'attribution-notice:dismissed';
// The signed-out line. Checks that the signed-out line shows use it, and so
// does the identity-unavailable test's check that it is absent.
const NOTICE = /not signed in with Divine/i;
// Either line: the signed-out one and the identity-unavailable one both say
// "recorded under your name". Checks that the notice is absent use it, so they
// cannot pass while the other line is on screen. The first test and the
// identity-unavailable test check that it matches their line, so a rewording
// that drops the phrase fails there rather than blinding the absence checks.
const ANY_NOTICE = /recorded under your name/i;

// The provider re-reads the session on window focus: how a sign-in made by the
// login redirect, or in another tab, reaches an open tab.
async function signInByFocus() {
  session.getSession.mockResolvedValue({ accessToken: 'tok-abc' });
  getPublicKey.mockResolvedValue(PUBKEY);
  act(() => {
    window.dispatchEvent(new Event('focus'));
  });
  await waitFor(() => expect(screen.getByTestId('state')).toHaveTextContent('settled:true'));
}

beforeEach(() => {
  const store = new Map<string, string>();
  Object.defineProperty(window, 'localStorage', {
    value: {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => store.set(key, value),
      removeItem: (key: string) => store.delete(key),
      clear: () => store.clear(),
    },
    writable: true,
  });
  session.getSession.mockReset();
  session.startLogin.mockReset();
  session.startLogin.mockResolvedValue(undefined);
  getPublicKey.mockReset();
});

describe('AttributionNotice', () => {
  it('tells a signed-out moderator to sign in, in words true whether or not sign-in is required', async () => {
    session.getSession.mockResolvedValue(null);

    renderNotice();

    // With REQUIRE_MODERATOR_LOGIN on, a signed-out write is refused rather than
    // recorded, and the frontend can't read that flag, so the copy must not claim
    // actions are being recorded.
    expect(
      await screen.findByText("You're not signed in with Divine. Sign in so your moderation actions are recorded under your name."),
    ).toBeInTheDocument();
    expect(screen.getByText(ANY_NOTICE)).toBeInTheDocument();
    expect(screen.queryByText(/being recorded without attribution/i)).toBeNull();
  });

  it('offers the way to fix it', async () => {
    session.getSession.mockResolvedValue(null);

    renderNotice();

    fireEvent.click(await screen.findByRole('button', { name: /sign in/i }));
    expect(session.startLogin).toHaveBeenCalled();
  });

  it('stays dismissed after the notice remounts', async () => {
    session.getSession.mockResolvedValue(null);

    const firstRender = renderNotice();
    fireEvent.click(await screen.findByRole('button', { name: /dismiss/i }));

    expect(screen.queryByText(ANY_NOTICE)).toBeNull();
    expect(localStorage.getItem('attribution-notice:dismissed')).toBe('1');

    firstRender.unmount();
    renderNotice();

    await waitFor(() => expect(screen.getByTestId('state')).toHaveTextContent('settled:false'));
    expect(screen.queryByText(ANY_NOTICE)).toBeNull();
  });

  it('still renders and dismisses when storage is unavailable', async () => {
    const getItem = vi.fn(() => { throw new Error('storage disabled'); });
    const setItem = vi.fn(() => { throw new Error('storage disabled'); });
    Object.defineProperty(window, 'localStorage', {
      value: { getItem, setItem },
      writable: true,
    });
    session.getSession.mockResolvedValue(null);

    renderNotice();
    fireEvent.click(await screen.findByRole('button', { name: /dismiss/i }));

    expect(getItem).toHaveBeenCalled();
    expect(setItem).toHaveBeenCalledWith('attribution-notice:dismissed', '1');
    expect(screen.queryByText(ANY_NOTICE)).toBeNull();
  });

  it('stays out of the way once the moderator is attributed', async () => {
    session.getSession.mockResolvedValue({ accessToken: 'tok-abc' });
    getPublicKey.mockResolvedValue(PUBKEY);

    renderNotice();

    // Wait for a genuinely settled, signed-in session before asserting absence.
    await waitFor(() => expect(screen.getByTestId('state')).toHaveTextContent('settled:true'));
    expect(screen.queryByText(ANY_NOTICE)).toBeNull();
  });

  it('says the identity is unavailable, not that the moderator is signed out, when a session exists', async () => {
    // A live session whose public-key lookup settles as a failure: the provider
    // keeps the credentials (identityUnavailable), so "not signed in" would be false.
    // The provider warns on that failure by design. Capture the warning so the
    // run stays quiet, and check it came from the failure this test drives.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      session.getSession.mockResolvedValue({ accessToken: 'tok-abc' });
      getPublicKey.mockRejectedValue(new Error('rpc down'));

      renderNotice();

      expect(
        await screen.findByText("Your Divine identity isn't available right now, so your moderation actions may not be recorded under your name. Try signing in again."),
      ).toBeInTheDocument();
      expect(screen.getByText(ANY_NOTICE)).toBeInTheDocument();
      expect(screen.queryByText(NOTICE)).toBeNull();
      expect(warn).toHaveBeenCalledWith(
        '[divine-login] getPublicKey failed; attribution unavailable',
        expect.objectContaining({ message: 'rpc down' }),
      );
    } finally {
      warn.mockRestore();
    }
  });

  it('does not flash while the session is still resolving', async () => {
    session.getSession.mockResolvedValue({ accessToken: 'tok-abc' });
    getPublicKey.mockReturnValue(new Promise(() => {}));

    renderNotice();

    await waitFor(() => expect(session.getSession).toHaveBeenCalled());
    expect(screen.getByTestId('state')).toHaveTextContent('resolving');
    expect(screen.queryByText(ANY_NOTICE)).toBeNull();
  });
});

// #397: a dismissal lasts only while the moderator stays signed out. Once they
// are identified it is forgotten, so the next sign-out or expiry brings the
// notice back, in this tab and in others.
describe('AttributionNotice dismissal (#397)', () => {
  it('returns after the moderator signs in and then signs out', async () => {
    session.getSession.mockResolvedValue(null);
    renderNotice();
    fireEvent.click(await screen.findByRole('button', { name: /dismiss/i }));
    expect(screen.queryByText(ANY_NOTICE)).toBeNull();

    await signInByFocus();
    fireEvent.click(screen.getByRole('button', { name: 'test-sign-out' }));

    expect(await screen.findByText(NOTICE)).toBeInTheDocument();
  });

  it('is forgotten once the moderator is identified, so it does not hide the notice on a later load', async () => {
    localStorage.setItem(DISMISS_KEY, '1');
    session.getSession.mockResolvedValue({ accessToken: 'tok-abc' });
    getPublicKey.mockResolvedValue(PUBKEY);

    renderNotice();

    await waitFor(() => expect(localStorage.getItem(DISMISS_KEY)).toBeNull());
  });

  it('returns when another tab forgets the dismissal', async () => {
    session.getSession.mockResolvedValue(null);
    renderNotice();
    fireEvent.click(await screen.findByRole('button', { name: /dismiss/i }));
    expect(screen.queryByText(ANY_NOTICE)).toBeNull();

    // Another tab saw the moderator signed in and removed the key.
    localStorage.removeItem(DISMISS_KEY);
    act(() => {
      window.dispatchEvent(new StorageEvent('storage', { key: DISMISS_KEY, oldValue: '1', newValue: null }));
    });

    expect(screen.getByText(NOTICE)).toBeInTheDocument();
  });

  // localStorage.clear() in another tab reports key null, not the key's name.
  it('returns when another tab clears all of storage', async () => {
    session.getSession.mockResolvedValue(null);
    renderNotice();
    fireEvent.click(await screen.findByRole('button', { name: /dismiss/i }));
    expect(screen.queryByText(ANY_NOTICE)).toBeNull();

    localStorage.clear();
    act(() => {
      window.dispatchEvent(new StorageEvent('storage', { key: null }));
    });

    expect(screen.getByText(NOTICE)).toBeInTheDocument();
  });

  // A tab that has not caught up with the sign-in yet still shows the notice,
  // and dismissing it there must not keep it hidden here after a sign-out.
  it('ignores a dismissal from another tab while identified here', async () => {
    session.getSession.mockResolvedValue({ accessToken: 'tok-abc' });
    getPublicKey.mockResolvedValue(PUBKEY);
    renderNotice();
    await waitFor(() => expect(screen.getByTestId('state')).toHaveTextContent('settled:true'));

    localStorage.setItem(DISMISS_KEY, '1');
    act(() => {
      window.dispatchEvent(new StorageEvent('storage', { key: DISMISS_KEY, oldValue: null, newValue: '1' }));
    });
    fireEvent.click(screen.getByRole('button', { name: 'test-sign-out' }));

    expect(await screen.findByText(NOTICE)).toBeInTheDocument();
    expect(localStorage.getItem(DISMISS_KEY)).toBeNull();
  });

  it('returns after a sign-in and sign-out when storage is unavailable', async () => {
    const fail = () => { throw new Error('storage disabled'); };
    Object.defineProperty(window, 'localStorage', {
      value: { getItem: fail, setItem: fail, removeItem: fail },
      writable: true,
    });
    session.getSession.mockResolvedValue(null);
    renderNotice();
    fireEvent.click(await screen.findByRole('button', { name: /dismiss/i }));
    expect(screen.queryByText(ANY_NOTICE)).toBeNull();

    await signInByFocus();
    fireEvent.click(screen.getByRole('button', { name: 'test-sign-out' }));

    expect(await screen.findByText(NOTICE)).toBeInTheDocument();
  });
});

// The worker records nobody for an expired login token (or, with
// REQUIRE_MODERATOR_LOGIN on, refuses the write), so the notice has to
// come back when the token expires and is not replaced (#178 phase 2). Before
// this, the pubkey stayed cached and the moderator kept looking attributed.
describe('AttributionNotice after the login token expires', () => {
  const T0 = new Date('2026-11-06T12:00:00Z').getTime();
  const MIN = 60_000;

  async function flush(ms = 0) {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(ms);
    });
  }

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    session.getSession.mockResolvedValue({ bunkerUrl: 'bunker://x', accessToken: 'tok-abc', expiresAt: T0 + 10 * MIN });
    getPublicKey.mockResolvedValue(PUBKEY);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('shows once the refresh before expiry fails', async () => {
    renderNotice();
    await flush();
    expect(screen.getByTestId('state')).toHaveTextContent('settled:true');
    expect(screen.queryByText(ANY_NOTICE)).toBeNull();

    // The scheduled refresh fails: the SDK answers null (and drops the session).
    session.getSession.mockResolvedValue(null);
    await flush(6 * MIN);

    expect(screen.getByText(NOTICE)).toBeInTheDocument();
  });

  it('shows once the refresh fails, though it was dismissed while signed out before', async () => {
    localStorage.setItem(DISMISS_KEY, '1');
    renderNotice();
    await flush();
    expect(screen.getByTestId('state')).toHaveTextContent('settled:true');

    session.getSession.mockResolvedValue(null);
    await flush(6 * MIN);

    expect(screen.getByText(NOTICE)).toBeInTheDocument();
  });

  it('shows at expiry while the refresh has not replaced the token', async () => {
    renderNotice();
    await flush();
    expect(screen.queryByText(ANY_NOTICE)).toBeNull();

    // Every refresh hangs, so the expired token stays in the session. The
    // session is still present, so the notice says the identity is unavailable
    // rather than that the moderator is signed out.
    session.getSession.mockReturnValue(new Promise(() => {}));
    await flush(10 * MIN);

    expect(screen.getByText(/identity isn't available right now/i)).toBeInTheDocument();
  });
});
