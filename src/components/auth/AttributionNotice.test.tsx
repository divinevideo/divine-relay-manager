// ABOUTME: A moderator acting without a resolved identity must be told their
// ABOUTME: actions are recorded unattributed, and offered the way to fix it.
//
// Removing the login walls (this PR) restores access for everyone CF Access
// admits, but it also removes the loudest cue that you have no divine-login
// session. Without a replacement, a moderator sees a fully working tool, never
// signs in, and every decision they write lands moderator_pubkey = null --
// silently defeating the audit trail #181 exists to build.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

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

function renderNotice() {
  return render(
    <DivineSessionProvider>
      <AttributionNotice />
      <Sentinel />
    </DivineSessionProvider>,
  );
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
  it('warns a signed-out moderator that their actions are unattributed', async () => {
    session.getSession.mockResolvedValue(null);

    renderNotice();

    expect(await screen.findByText(/without attribution/i)).toBeInTheDocument();
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

    expect(screen.queryByText(/without attribution/i)).toBeNull();
    expect(localStorage.getItem('attribution-notice:dismissed')).toBe('1');

    firstRender.unmount();
    renderNotice();

    await waitFor(() => expect(screen.getByTestId('state')).toHaveTextContent('settled:false'));
    expect(screen.queryByText(/without attribution/i)).toBeNull();
  });

  it('stays out of the way once the moderator is attributed', async () => {
    session.getSession.mockResolvedValue({ accessToken: 'tok-abc' });
    getPublicKey.mockResolvedValue(PUBKEY);

    renderNotice();

    // Wait for a genuinely settled, signed-in session before asserting absence.
    await waitFor(() => expect(screen.getByTestId('state')).toHaveTextContent('settled:true'));
    expect(screen.queryByText(/without attribution/i)).toBeNull();
  });

  it('does not flash while the session is still resolving', async () => {
    session.getSession.mockResolvedValue({ accessToken: 'tok-abc' });
    getPublicKey.mockReturnValue(new Promise(() => {}));

    renderNotice();

    await waitFor(() => expect(session.getSession).toHaveBeenCalled());
    expect(screen.getByTestId('state')).toHaveTextContent('resolving');
    expect(screen.queryByText(/without attribution/i)).toBeNull();
  });
});
