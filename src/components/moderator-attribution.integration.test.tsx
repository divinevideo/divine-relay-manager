// ABOUTME: The guarantee that matters, end to end: a signed-in moderator's login
// token reaches every request of a real moderation action. Exercises the REAL
// DivineSessionProvider + REAL useCurrentUser + REAL EventActions + REAL
// useAdminApi, mocking only the SDK boundary and the adminApi functions it
// calls. Guards against "green units over an inert path" (#178).
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { TooltipProvider } from '@/components/ui/tooltip';

const MOD_PUBKEY = 'd'.repeat(64);

// SDK boundary: a live session, and a signer that resolves the moderator pubkey.
const { getSession, getPublicKey } = vi.hoisted(() => ({
  getSession: vi.fn(),
  getPublicKey: vi.fn(),
}));
vi.mock('@/lib/divineLogin', () => ({ getSession, logout: vi.fn(), startLogin: vi.fn() }));
// Token-aware: getPublicKey receives the signer's token, so a test can give two
// accounts distinct pubkeys. Existing tests ignore the arg (return one pubkey).
vi.mock('@/lib/divineSigner', () => ({
  DivineRpcSigner: vi.fn().mockImplementation((getToken?: () => string | undefined) => ({
    getPublicKey: () => getPublicKey(getToken?.()),
  })),
}));
// Profile metadata is not part of the attribution path; keep the relay out.
vi.mock('@/hooks/useAuthor', () => ({ useAuthor: () => ({ data: {} }) }));

const API_URL = 'https://api.example';
vi.mock('@/hooks/useAppContext', () => ({
  useAppContext: () => ({ config: { apiUrl: API_URL, relayUrl: 'wss://relay.example' } }),
}));
// The real useAdminApi binds the token; only the request functions are doubles,
// so each call shows the `{ loginToken }` the wrapper passed on.
const api = vi.hoisted(() => ({
  hideEvent: vi.fn(),
  restoreEvent: vi.fn(),
  deleteEvent: vi.fn(),
  moderateMedia: vi.fn(),
  deleteMedia: vi.fn(),
  callRelayRpc: vi.fn(),
  logDecision: vi.fn(),
}));
vi.mock('@/lib/adminApi', async (orig) => ({
  ...(await orig<typeof import('@/lib/adminApi')>()),
  ...api,
}));
vi.mock('@/hooks/useToast', () => ({ useToast: () => ({ toast: vi.fn() }) }));

import { DivineSessionProvider } from '@/components/DivineSessionProvider';
import { useCurrentUser } from '@/hooks/useCurrentUser';
import { useDivineSession } from '@/hooks/useDivineSession';
import { EventActions } from './EventActions';

function Probe() {
  const { user } = useCurrentUser();
  const { isSignedIn } = useDivineSession();
  return (
    <>
      <span data-testid="resolved-mod">{user?.pubkey ?? 'none'}</span>
      <span data-testid="signed-in">{isSignedIn ? 'yes' : 'no'}</span>
    </>
  );
}

// The login each call carried: the last argument the real wrapper passed on.
const loginOf = (call: unknown[]) => (call[call.length - 1] as { loginToken?: string } | undefined)?.loginToken;
const banAudit = () => api.logDecision.mock.calls.find((c) => (c[1] as { action?: string })?.action === 'ban_event');

function renderComposed() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <DivineSessionProvider>
        <TooltipProvider>
          <Probe />
          <EventActions eventId="event-1" pubkey={'a'.repeat(64)} />
        </TooltipProvider>
      </DivineSessionProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  api.hideEvent.mockResolvedValue({ success: true, recorded: true });
  api.logDecision.mockResolvedValue(undefined);
  getSession.mockResolvedValue({ bunkerUrl: 'bunker://x', accessToken: 'tok' });
  getPublicKey.mockResolvedValue(MOD_PUBKEY);
});

describe('moderator attribution (composed: provider -> useCurrentUser -> useAdminApi -> moderation action)', () => {
  it('sends the login token on a real moderation action and its audit write', async () => {
    renderComposed();
    await waitFor(() => expect(screen.getByTestId('resolved-mod')).toHaveTextContent(MOD_PUBKEY));

    fireEvent.click(screen.getByRole('button', { name: /Ban Event/i }));

    await waitFor(() => expect(api.hideEvent).toHaveBeenCalled());
    expect(api.hideEvent).toHaveBeenCalledWith(API_URL, 'event-1', 'Banned by moderator', { loginToken: 'tok' });
    await waitFor(() => expect(banAudit()).toBeDefined());
    expect(loginOf(banAudit()!)).toBe('tok');
  });

  it('sends the token for an action fired while the pubkey is still resolving', async () => {
    // getPublicKey is deferred: the moderator acts before their identity
    // resolves. The token does not wait on it, so the action is attributed.
    let releasePubkey!: (pk: string) => void;
    getPublicKey.mockReturnValue(
      new Promise((resolve) => {
        releasePubkey = resolve;
      }),
    );
    renderComposed();
    await waitFor(() => expect(screen.getByTestId('signed-in')).toHaveTextContent('yes'));
    expect(screen.getByTestId('resolved-mod')).toHaveTextContent('none');

    fireEvent.click(screen.getByRole('button', { name: /Ban Event/i }));

    await waitFor(() => expect(banAudit()).toBeDefined());
    expect(loginOf(api.hideEvent.mock.calls[0])).toBe('tok');
    expect(loginOf(banAudit()!)).toBe('tok');
    await act(async () => {
      releasePubkey(MOD_PUBKEY);
    });
  });

  it('an action and its follow-up logDecision both send the token taken at the click, even after an account switch mid-action', async () => {
    // The exact race (dcadenas #181): the token is taken BEFORE the
    // authoritative request, so a logout or account switch WHILE it is in
    // flight cannot retarget the action or its audit write.
    const PK_A = 'a'.repeat(64);
    const PK_B = 'b'.repeat(64);
    getPublicKey.mockImplementation(async (token: string) => (token === 'tokB' ? PK_B : PK_A));
    getSession.mockResolvedValue({ bunkerUrl: 'bunker://x', accessToken: 'tokA' });
    let releaseBan!: () => void;
    api.hideEvent.mockReturnValue(
      new Promise<{ success: true; recorded: true }>((resolve) => {
        releaseBan = () => resolve({ success: true, recorded: true });
      }),
    );

    renderComposed();
    await waitFor(() => expect(screen.getByTestId('resolved-mod')).toHaveTextContent(PK_A));

    fireEvent.click(screen.getByRole('button', { name: /Ban Event/i }));
    await waitFor(() => expect(api.hideEvent).toHaveBeenCalled());

    // Switch accounts WHILE the ban is still in flight.
    getSession.mockResolvedValue({ bunkerUrl: 'bunker://y', accessToken: 'tokB' });
    await act(async () => {
      window.dispatchEvent(new Event('focus'));
    });
    await waitFor(() => expect(screen.getByTestId('resolved-mod')).toHaveTextContent(PK_B));

    await act(async () => {
      releaseBan();
    });
    await waitFor(() => expect(banAudit()).toBeDefined());
    expect(loginOf(api.hideEvent.mock.calls[0])).toBe('tokA');
    expect(loginOf(banAudit()!)).toBe('tokA');
  });

  it('sends no login token (not a stale or other one) when signed out', async () => {
    getSession.mockResolvedValue(null);
    renderComposed();
    await waitFor(() => expect(screen.getByTestId('signed-in')).toHaveTextContent('no'));

    fireEvent.click(screen.getByRole('button', { name: /Ban Event/i }));

    await waitFor(() => expect(banAudit()).toBeDefined());
    expect(loginOf(api.hideEvent.mock.calls[0])).toBeUndefined();
    expect(loginOf(banAudit()!)).toBeUndefined();
  });

  // Lifts July's 494a0926: the worker takes the moderator from the token only,
  // so no request argument may still name one.
  it('no attribution call sends a moderator in the body when signed in', async () => {
    renderComposed();
    await waitFor(() => expect(screen.getByTestId('resolved-mod')).toHaveTextContent(MOD_PUBKEY));

    fireEvent.click(screen.getByRole('button', { name: /Ban Event/i }));
    await waitFor(() => expect(banAudit()).toBeDefined());

    const objects = Object.values(api)
      .flatMap((fn) => fn.mock.calls.flat())
      .filter((arg): arg is Record<string, unknown> => typeof arg === 'object' && arg !== null);
    expect(objects.length).toBeGreaterThan(0);
    for (const arg of objects) {
      expect(arg).not.toHaveProperty('moderatorPubkey');
      expect(arg).not.toHaveProperty('moderator_pubkey');
      expect(arg).not.toHaveProperty('actor');
    }
  });
});
