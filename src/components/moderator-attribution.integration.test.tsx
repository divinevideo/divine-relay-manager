// ABOUTME: The guarantee that matters, end to end: a signed-in moderator's pubkey
// reaches a real moderation audit write. Exercises the REAL DivineSessionProvider
// + REAL useCurrentUser + REAL EventActions, mocking only the SDK boundary and the
// admin API. Guards against "green units over an inert path" (#178).
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

const api = vi.hoisted(() => ({
  banEvent: vi.fn(),
  allowEvent: vi.fn(),
  deleteEvent: vi.fn(),
  moderateMedia: vi.fn(),
  deleteMedia: vi.fn(),
  callRelayRpc: vi.fn(),
  logDecision: vi.fn(),
}));
vi.mock('@/hooks/useAdminApi', () => ({ useAdminApi: () => api }));
vi.mock('@/hooks/useToast', () => ({ useToast: () => ({ toast: vi.fn() }) }));

import { DivineSessionProvider } from '@/components/DivineSessionProvider';
import { useCurrentUser } from '@/hooks/useCurrentUser';
import { EventActions } from './EventActions';

function Probe() {
  const { user } = useCurrentUser();
  return <span data-testid="resolved-mod">{user?.pubkey ?? 'none'}</span>;
}

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
  api.banEvent.mockResolvedValue({ success: true });
  api.logDecision.mockResolvedValue(undefined);
  getSession.mockResolvedValue({ bunkerUrl: 'bunker://x', accessToken: 'tok' });
  getPublicKey.mockResolvedValue(MOD_PUBKEY);
});

describe('moderator attribution (composed: provider -> useCurrentUser -> moderation action)', () => {
  it('carries the resolved moderator pubkey to a real moderation audit write', async () => {
    renderComposed();
    // The shared provider resolves the session + pubkey once; wait for it (the
    // same resolution EventActions reads) before acting.
    await waitFor(() => expect(screen.getByTestId('resolved-mod')).toHaveTextContent(MOD_PUBKEY));

    fireEvent.click(screen.getByRole('button', { name: /Ban Event/i }));

    await waitFor(() => expect(api.banEvent).toHaveBeenCalled());
    await waitFor(() =>
      expect(api.logDecision).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'ban_event', moderatorPubkey: MOD_PUBKEY }),
      ),
    );
  });

  it('captures the pubkey for an action fired during the boot-resolve window (no null attribution)', async () => {
    // getPublicKey is deferred: the moderator acts before their identity resolves.
    let releasePubkey!: (pk: string) => void;
    getPublicKey.mockReturnValue(
      new Promise((resolve) => {
        releasePubkey = resolve;
      }),
    );
    renderComposed();
    // Ban immediately, while the pubkey is still resolving (probe reads 'none').
    expect(screen.getByTestId('resolved-mod')).toHaveTextContent('none');
    fireEvent.click(await screen.findByRole('button', { name: /Ban Event/i }));
    await waitFor(() => expect(api.banEvent).toHaveBeenCalled());
    // The detached audit path waits for the in-flight identity; now it resolves.
    await act(async () => {
      releasePubkey(MOD_PUBKEY);
    });
    await waitFor(() =>
      expect(api.logDecision).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'ban_event', moderatorPubkey: MOD_PUBKEY }),
      ),
    );
  });

  it('attributes the moderator captured at action start, not one switched in mid-request (dcadenas #181)', async () => {
    // The exact race: identity must be captured BEFORE the authoritative request,
    // so a logout/account-switch WHILE the request is in flight can't retarget it.
    // This fails on the old code (which read identity after the request).
    const PK_A = 'a'.repeat(64);
    const PK_B = 'b'.repeat(64);
    getPublicKey.mockImplementation(async (token: string) => (token === 'tokB' ? PK_B : PK_A));
    getSession.mockResolvedValue({ bunkerUrl: 'bunker://x', accessToken: 'tokA' });
    let releaseBan!: () => void;
    api.banEvent.mockReturnValue(
      new Promise<{ success: true }>((resolve) => {
        releaseBan = () => resolve({ success: true });
      }),
    );

    renderComposed();
    await waitFor(() => expect(screen.getByTestId('resolved-mod')).toHaveTextContent(PK_A));

    // Start the ban: the mutation captures moderator A, then awaits banEvent.
    fireEvent.click(screen.getByRole('button', { name: /Ban Event/i }));
    await waitFor(() => expect(api.banEvent).toHaveBeenCalled());

    // Switch accounts WHILE banEvent is still in flight.
    getSession.mockResolvedValue({ bunkerUrl: 'bunker://y', accessToken: 'tokB' });
    await act(async () => {
      window.dispatchEvent(new Event('focus'));
    });
    await waitFor(() => expect(screen.getByTestId('resolved-mod')).toHaveTextContent(PK_B));

    // The request completes; the audit must attribute A (captured at start), not B.
    await act(async () => {
      releaseBan();
    });
    await waitFor(() => expect(api.logDecision).toHaveBeenCalled());
    const banCall = api.logDecision.mock.calls.find((c) => c[0]?.action === 'ban_event');
    expect(banCall?.[0].moderatorPubkey).toBe(PK_A);
  });

  it('writes null attribution (not a stale/other pubkey) when signed out', async () => {
    getSession.mockResolvedValue(null);
    renderComposed();
    await waitFor(() => expect(screen.getByTestId('resolved-mod')).toHaveTextContent('none'));

    fireEvent.click(screen.getByRole('button', { name: /Ban Event/i }));

    await waitFor(() => expect(api.logDecision).toHaveBeenCalled());
    const banCall = api.logDecision.mock.calls.find((c) => c[0]?.action === 'ban_event');
    expect(banCall?.[0].moderatorPubkey).toBeUndefined();
  });
});
