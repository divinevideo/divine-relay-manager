// ABOUTME: Covers the WIRING of the age-review guard redirect in UserManagement.
// The shared hook's own tests pin the predicate; these pin that each mutation
// actually calls it, which is the failure mode that shipped once.

import { act, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import type { UserActionChange } from '@/components/UserActions';
import { markRestored, RESTORE_SETTLE_MS, useJustRestored } from '@/lib/userStatsCache';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { TooltipProvider } from '@/components/ui/tooltip';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { UserManagement } from './UserManagement';
import { ApiError, BanNotConfirmedError } from '@/lib/adminApi';
import { banFailureToast, banSuccessNote } from '@/lib/banFeedback';
import { tokensFor, withAsModerator } from '@/test/adminApiMock';

const api = vi.hoisted(() => ({
  callRelayRpc: vi.fn(),
  banPubkey: vi.fn(),
  verifyPubkeyBanned: vi.fn(),
  verifyPubkeyUnbanned: vi.fn(),
  unbanPubkey: vi.fn(),
  unsuspendPubkey: vi.fn(),
  logDecision: vi.fn(),
}));
const toast = vi.hoisted(() => vi.fn());
const navigate = vi.hoisted(() => vi.fn());

vi.mock('react-router-dom', async (orig) => ({
  ...(await orig<typeof import('react-router-dom')>()),
  useNavigate: () => navigate,
}));
const moderatorApi = withAsModerator(api);
vi.mock('@/hooks/useAdminApi', () => ({ useAdminApi: () => moderatorApi }));
vi.mock('@/hooks/useToast', () => ({ useToast: () => ({ toast }) }));
const MOD_PUBKEY = 'e'.repeat(64);
const MOD_TOKEN = 'moderator-login-token';
vi.mock('@/hooks/useCurrentUser', () => ({
  useCurrentUser: () => ({ user: { pubkey: MOD_PUBKEY }, getModeratorToken: () => MOD_TOKEN }),
}));
// UserIdentifier resolves profiles through Nostr; irrelevant to guard wiring.
vi.mock('@nostrify/react', () => ({
  useNostr: () => ({ nostr: { query: vi.fn().mockResolvedValue([]) } }),
}));
vi.mock('@/hooks/useAppContext', () => ({ useAppContext: () => ({ config: {}, updateConfig: vi.fn() }) }));
// Children are irrelevant here and drag in their own dependencies.
const userActionsProps = vi.hoisted(() => ({ last: null as Record<string, unknown> | null }));
vi.mock('@/components/UserActions', () => ({
  UserActions: (props: Record<string, unknown>) => {
    userActionsProps.last = props;
    return null;
  },
}));
// Render the action affordances it is handed, so the remove/unsuspend wiring
// is reachable; everything else about the card is irrelevant here.
vi.mock('@/components/BannedUserCard', () => ({
  BannedUserCard: ({ actionButton, onUnban, suspended }: { actionButton?: React.ReactNode; onUnban?: () => void; suspended?: boolean }) => (
    <div>
      {actionButton}
      {onUnban ? <button onClick={onUnban}>Unban</button> : null}
      <span>{suspended ? 'card says suspended' : 'card says not suspended'}</span>
    </div>
  ),
}));

const PUBKEY = 'a'.repeat(64);

const guardRefusal = () => new ApiError('under age review', 409, 'Conflict', 'age_review_active');

function renderWithProvider(client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })) {
  return render(
    <QueryClientProvider client={client}>
      <TooltipProvider>
        <UserManagement selectedPubkey={PUBKEY} />
      </TooltipProvider>
    </QueryClientProvider>,
  );
}

describe('UserManagement age-review guard wiring', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Empty lists: the account is neither banned, allowed, nor suspended, so the
    // Allow button renders.
    api.callRelayRpc.mockResolvedValue([]);
    api.banPubkey.mockResolvedValue({ unconfirmed: null });
    api.logDecision.mockResolvedValue(undefined);
    // The post-ban background check chains .then on this; an unset mock would
    // throw inside onSuccess, which TanStack routes to onError.
    api.verifyPubkeyBanned.mockResolvedValue(true);
  });

  it('routes an allow_user refusal to the case rather than a dead-end toast', async () => {
    // allow_user calls unbanpubkey, so it hits the guard. This is the call site
    // the original sweep missed; without the wiring it dead-ends here.
    api.callRelayRpc.mockImplementation((method: string) => {
      if (method === 'unbanpubkey') return Promise.reject(guardRefusal());
      return Promise.resolve([]);
    });

    renderWithProvider();
    fireEvent.click(await screen.findByRole('button', { name: /^Allow$/i }));

    await waitFor(() => expect(navigate).toHaveBeenCalledWith(`/age-review?pubkey=${PUBKEY}`));
  });

  it('routes an unban refusal to the case', async () => {
    api.callRelayRpc.mockImplementation((method: string) => {
      if (method === 'listbannedpubkeys') return Promise.resolve([{ pubkey: PUBKEY, reason: 'spam' }]);
      return Promise.resolve([]);
    });
    api.unbanPubkey.mockRejectedValue(guardRefusal());

    renderWithProvider();
    fireEvent.click(await screen.findByRole('button', { name: /^Unban$/i }));

    await waitFor(() => expect(navigate).toHaveBeenCalledWith(`/age-review?pubkey=${PUBKEY}`));
  });

  it('routes an unsuspend refusal to the case', async () => {
    // The one site this change rewrote from its own inline copy into the shared
    // hook, so the one a hoist can silently drop -- and the identifier stays in
    // use by the other two mutations, so eslint would not notice either.
    api.callRelayRpc.mockImplementation((method: string) => {
      if (method === 'listsuspendedpubkeys') return Promise.resolve([{ pubkey: PUBKEY, reason: 'age review' }]);
      return Promise.resolve([]);
    });
    api.unsuspendPubkey.mockRejectedValue(guardRefusal());

    renderWithProvider();
    // Radix tabs activate on mousedown, not click.
    fireEvent.mouseDown(await screen.findByRole('tab', { name: /Suspended Users/i }));
    fireEvent.click(await screen.findByRole('button', { name: /^Unsuspend$/i }));

    await waitFor(() => expect(navigate).toHaveBeenCalledWith(`/age-review?pubkey=${PUBKEY}`));
  });

  // The relay hides a suspended account's content, so the card must know which
  // list it was rendered from to say why it shows none.
  it('tells a card on the Suspended tab that the account is suspended', async () => {
    api.callRelayRpc.mockImplementation((method: string) => {
      if (method === 'listsuspendedpubkeys') return Promise.resolve([{ pubkey: PUBKEY, reason: 'spam' }]);
      return Promise.resolve([]);
    });

    renderWithProvider();
    fireEvent.mouseDown(await screen.findByRole('tab', { name: /Suspended Users/i }));

    expect(await screen.findByText('card says suspended')).toBeInTheDocument();
  });

  it('does not tell a card on the Banned tab that the account is suspended', async () => {
    api.callRelayRpc.mockImplementation((method: string) => {
      if (method === 'listbannedpubkeys') return Promise.resolve([{ pubkey: PUBKEY, reason: 'spam' }]);
      return Promise.resolve([]);
    });

    renderWithProvider();
    await screen.findByRole('button', { name: /^Unban$/i });

    expect(screen.getByText('card says not suspended')).toBeInTheDocument();
    expect(screen.queryByText('card says suspended')).not.toBeInTheDocument();
  });

  it('canonicalises an uppercase hex pubkey before it reaches the relay', async () => {
    // The input is validated case-insensitively, but every consumer matches
    // these bytes exactly: the relay's ban list, and the age-review guard's
    // lookup. Sending uppercase through bans nobody while reporting success,
    // and makes the guard miss a real open case.
    renderWithProvider();
    fireEvent.click(await screen.findByRole('button', { name: /Add User/i }));
    fireEvent.change(await screen.findByPlaceholderText(/hex pubkey or npub1/i), {
      target: { value: PUBKEY.toUpperCase() },
    });
    fireEvent.click(screen.getByRole('button', { name: /^Allow$/i }));
    fireEvent.click(screen.getByRole('button', { name: /^Allow User$/i }));

    await waitFor(() => expect(api.callRelayRpc).toHaveBeenCalledWith('unbanpubkey', [PUBKEY, undefined]));
    // The allow and its audit write go through asModerator(token) (#178).
    await waitFor(() => expect(tokensFor(moderatorApi, 'logDecision')).toEqual([MOD_TOKEN]));
    expect(tokensFor(moderatorApi, 'callRelayRpc')).toEqual([MOD_TOKEN]);
  });

  it('routes a ban through the moderation endpoint helper', async () => {
    renderWithProvider();
    fireEvent.click(await screen.findByRole('button', { name: /Add User/i }));
    fireEvent.change(await screen.findByPlaceholderText(/hex pubkey or npub1/i), {
      target: { value: PUBKEY },
    });
    fireEvent.click(screen.getByRole('button', { name: /^Ban User$/i }));

    await waitFor(() => expect(api.banPubkey).toHaveBeenCalledWith(PUBKEY, 'Account banned by moderator'));
    expect(api.callRelayRpc).not.toHaveBeenCalledWith('banpubkey', expect.anything());
    // The ban and its audit write go through asModerator(token) (#178).
    await waitFor(() => expect(tokensFor(moderatorApi, 'logDecision')).toEqual([MOD_TOKEN]));
    expect(tokensFor(moderatorApi, 'banPubkey')).toEqual([MOD_TOKEN]);
  });

  async function banViaDialog() {
    renderWithProvider();
    fireEvent.click(await screen.findByRole('button', { name: /Add User/i }));
    fireEvent.change(await screen.findByPlaceholderText(/hex pubkey or npub1/i), {
      target: { value: PUBKEY },
    });
    fireEvent.click(screen.getByRole('button', { name: /^Ban User$/i }));
  }

  // The ban has already landed when the audit write runs, so its failure must not
  // read as "Failed to ban user", which invites a retry of an applied ban.
  it('reports a failed audit write after a landed ban without calling the ban failed', async () => {
    api.logDecision.mockRejectedValue(new Error('audit down'));

    await banViaDialog();

    // One toast (the app shows one at a time): banned, and the audit gap named.
    await waitFor(() =>
      expect(toast).toHaveBeenCalledWith(
        expect.objectContaining({ title: 'User banned; audit log not recorded' }),
      ),
    );
    expect(toast).not.toHaveBeenCalledWith(expect.objectContaining({ variant: 'destructive' }));
  });

  it('reports an unconfirmed ban as not confirmed, not as a destructive failure', async () => {
    const notConfirmed = new BanNotConfirmedError('timed out');
    api.banPubkey.mockRejectedValue(notConfirmed);
    const invalidate = vi.spyOn(QueryClient.prototype, 'invalidateQueries');

    await banViaDialog();

    await waitFor(() => expect(toast).toHaveBeenCalledWith(banFailureToast(notConfirmed)));
    expect(toast).not.toHaveBeenCalledWith(expect.objectContaining({ variant: 'destructive' }));
    // The toast asks for a re-check; the ban lists must not be the stale ones.
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['banned-pubkeys'] });
    invalidate.mockRestore();
  });

  it('explains what was not confirmed on a ban that landed with unconfirmed follow-ups', async () => {
    api.banPubkey.mockResolvedValue({ unconfirmed: 'follow_ups_unknown' });

    await banViaDialog();

    await waitFor(() =>
      expect(toast).toHaveBeenCalledWith(expect.objectContaining({
        title: 'User banned successfully',
        description: banSuccessNote({ unconfirmed: 'follow_ups_unknown' }),
      })),
    );
  });

  it('still shows an error toast for a failure that is not a guard refusal', async () => {
    // The redirect must not swallow real errors, or a relay outage would look
    // like an age-review case.
    api.callRelayRpc.mockImplementation((method: string) => {
      if (method === 'unbanpubkey') return Promise.reject(new ApiError('relay down', 500, 'Server Error'));
      return Promise.resolve([]);
    });

    renderWithProvider();
    fireEvent.click(await screen.findByRole('button', { name: /^Allow$/i }));

    await waitFor(() =>
      expect(toast).toHaveBeenCalledWith(expect.objectContaining({ title: 'Failed to allow user' })),
    );
    expect(navigate).not.toHaveBeenCalledWith(expect.stringContaining('/age-review'));
  });
});

// The relay hides a banned or suspended account's content, so a stats read
// cached before the action describes the other state. ReportDetail and
// EventDetail would show it for useUserStats' 2 minute staleTime.
describe('UserManagement drops cached authored-content reads after an account action', () => {
  const STATS_KEY = ['user-stats', 'wss://relay.test', PUBKEY];

  function clientWithStats() {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    client.setQueryData(STATS_KEY, { postCount: 0 });
    return client;
  }

  beforeEach(() => {
    vi.clearAllMocks();
    userActionsProps.last = null;
    api.callRelayRpc.mockResolvedValue([]);
    api.banPubkey.mockResolvedValue({ unconfirmed: null });
    api.logDecision.mockResolvedValue(undefined);
    api.verifyPubkeyBanned.mockResolvedValue(true);
    api.unbanPubkey.mockResolvedValue(undefined);
    api.unsuspendPubkey.mockResolvedValue(undefined);
  });

  it('after an unsuspend', async () => {
    api.callRelayRpc.mockImplementation((method: string) =>
      Promise.resolve(method === 'listsuspendedpubkeys' ? [{ pubkey: PUBKEY }] : []));
    const client = clientWithStats();

    renderWithProvider(client);
    fireEvent.mouseDown(await screen.findByRole('tab', { name: /Suspended Users/i }));
    fireEvent.click(await screen.findByRole('button', { name: /^Unsuspend$/i }));

    await waitFor(() => expect(client.getQueryData(STATS_KEY)).toBeUndefined());
    // The unsuspend and its audit write go through asModerator(token) (#178).
    await waitFor(() => expect(tokensFor(moderatorApi, 'logDecision')).toEqual([MOD_TOKEN]));
    expect(tokensFor(moderatorApi, 'unsuspendPubkey')).toEqual([MOD_TOKEN]);
  });

  it('after an unban', async () => {
    api.callRelayRpc.mockImplementation((method: string) =>
      Promise.resolve(method === 'listbannedpubkeys' ? [{ pubkey: PUBKEY, reason: 'spam' }] : []));
    const client = clientWithStats();

    renderWithProvider(client);
    fireEvent.click(await screen.findByRole('button', { name: /^Unban$/i }));

    await waitFor(() => expect(client.getQueryData(STATS_KEY)).toBeUndefined());
    // The unban and its audit write go through asModerator(token) (#178).
    await waitFor(() => expect(tokensFor(moderatorApi, 'logDecision')).toEqual([MOD_TOKEN]));
    expect(tokensFor(moderatorApi, 'unbanPubkey')).toEqual([MOD_TOKEN]);
  });

  it('after an allow', async () => {
    const client = clientWithStats();

    renderWithProvider(client);
    fireEvent.click(await screen.findByRole('button', { name: /^Allow$/i }));

    await waitFor(() => expect(client.getQueryData(STATS_KEY)).toBeUndefined());
  });

  // A ban after a restore hides the account again: the window must end.
  it('ends the restore window after a ban', async () => {
    const pk = 'f6'.repeat(32);
    const { result } = renderHook(() => useJustRestored(pk));
    await act(async () => { await markRestored(new QueryClient(), pk, undefined); });
    expect(result.current).toBe(true);

    renderWithProvider(clientWithStats());
    fireEvent.click(await screen.findByRole('button', { name: /Add User/i }));
    fireEvent.change(await screen.findByPlaceholderText(/hex pubkey or npub1/i), { target: { value: pk } });
    fireEvent.click(screen.getByRole('button', { name: /^Ban User$/i }));

    await waitFor(() => expect(result.current).toBe(false));
  });

  // A refused ban did not hide the account: the reads reset (the failure
  // settled), and an earlier unsuspend's window stays.
  it('keeps the restore window when the ban was refused', async () => {
    const pk = 'a7'.repeat(32);
    api.banPubkey.mockRejectedValue(new ApiError('refused', 403, 'Forbidden'));
    const { result } = renderHook(() => useJustRestored(pk));
    await act(async () => { await markRestored(new QueryClient(), pk, undefined); });
    const client = clientWithStats();
    client.setQueryData(['user-stats', 'wss://relay.test', pk], { postCount: 0 });

    renderWithProvider(client);
    fireEvent.click(await screen.findByRole('button', { name: /Add User/i }));
    fireEvent.change(await screen.findByPlaceholderText(/hex pubkey or npub1/i), { target: { value: pk } });
    fireEvent.click(screen.getByRole('button', { name: /^Ban User$/i }));

    await waitFor(() => expect(client.getQueryData(['user-stats', 'wss://relay.test', pk])).toBeUndefined());
    expect(result.current).toBe(true);
  });

  // The ban may have landed even though it could not be confirmed.
  it('after a ban that could not be confirmed', async () => {
    api.banPubkey.mockRejectedValue(new BanNotConfirmedError('timed out'));
    const client = clientWithStats();

    renderWithProvider(client);
    fireEvent.click(await screen.findByRole('button', { name: /Add User/i }));
    fireEvent.change(await screen.findByPlaceholderText(/hex pubkey or npub1/i), { target: { value: PUBKEY } });
    fireEvent.click(screen.getByRole('button', { name: /^Ban User$/i }));

    await waitFor(() => expect(client.getQueryData(STATS_KEY)).toBeUndefined());
  });

  it('after a ban', async () => {
    const client = clientWithStats();

    renderWithProvider(client);
    fireEvent.click(await screen.findByRole('button', { name: /Add User/i }));
    fireEvent.change(await screen.findByPlaceholderText(/hex pubkey or npub1/i), { target: { value: PUBKEY } });
    fireEvent.click(screen.getByRole('button', { name: /^Ban User$/i }));

    await waitFor(() => expect(client.getQueryData(STATS_KEY)).toBeUndefined());
  });

  // These mutations await the audit write after the relay call, so a failed
  // write fails the mutation after the account status already changed.
  it('after an unsuspend whose audit write failed', async () => {
    api.callRelayRpc.mockImplementation((method: string) =>
      Promise.resolve(method === 'listsuspendedpubkeys' ? [{ pubkey: PUBKEY }] : []));
    api.logDecision.mockRejectedValue(new Error('audit down'));
    const client = clientWithStats();

    renderWithProvider(client);
    fireEvent.mouseDown(await screen.findByRole('tab', { name: /Suspended Users/i }));
    fireEvent.click(await screen.findByRole('button', { name: /^Unsuspend$/i }));

    await waitFor(() => expect(client.getQueryData(STATS_KEY)).toBeUndefined());
  });

  it('after an unban whose audit write failed', async () => {
    api.callRelayRpc.mockImplementation((method: string) =>
      Promise.resolve(method === 'listbannedpubkeys' ? [{ pubkey: PUBKEY, reason: 'spam' }] : []));
    api.logDecision.mockRejectedValue(new Error('audit down'));
    const client = clientWithStats();

    renderWithProvider(client);
    fireEvent.click(await screen.findByRole('button', { name: /^Unban$/i }));

    await waitFor(() => expect(client.getQueryData(STATS_KEY)).toBeUndefined());
  });

  it('after an allow whose audit write failed', async () => {
    api.logDecision.mockRejectedValue(new Error('audit down'));
    const client = clientWithStats();

    renderWithProvider(client);
    fireEvent.click(await screen.findByRole('button', { name: /^Allow$/i }));

    await waitFor(() => expect(client.getQueryData(STATS_KEY)).toBeUndefined());
  });

  // A ban usually purged the posts (funnelcake's inline purge), so "posts can
  // take a few minutes to reappear" would mislead after an unban or allow.
  // Both reset the account's reads and open no window.
  it('resets the reads after an unban, but opens no restore window', async () => {
    const UNBANNED = '6'.repeat(64);
    const { result } = renderHook(() => useJustRestored(UNBANNED));
    api.callRelayRpc.mockImplementation((method: string) =>
      Promise.resolve(method === 'listbannedpubkeys' ? [{ pubkey: UNBANNED, reason: 'spam' }] : []));
    const client = clientWithStats();
    client.setQueryData(['user-stats', 'wss://relay.test', UNBANNED], { postCount: 0 });
    renderWithProvider(client);
    fireEvent.click(await screen.findByRole('button', { name: /^Unban$/i }));

    await waitFor(() => expect(client.getQueryData(['user-stats', 'wss://relay.test', UNBANNED])).toBeUndefined());
    expect(result.current).toBe(false);
  });

  it('resets the reads after an allow, but opens no restore window', async () => {
    const ALLOWED = '5'.repeat(64);
    const { result } = renderHook(() => useJustRestored(ALLOWED));
    const client = clientWithStats();
    client.setQueryData(['user-stats', 'wss://relay.test', ALLOWED], { postCount: 0 });
    render(
      <QueryClientProvider client={client}>
        <TooltipProvider><UserManagement selectedPubkey={ALLOWED} /></TooltipProvider>
      </QueryClientProvider>,
    );
    fireEvent.click(await screen.findByRole('button', { name: /^Allow$/i }));

    await waitFor(() => expect(client.getQueryData(['user-stats', 'wss://relay.test', ALLOWED])).toBeUndefined());
    expect(result.current).toBe(false);
  });

  // Each test uses its own pubkey: an earlier test's window would still be open.
  const suspendedListOf = (pk: string) => (method: string) =>
    Promise.resolve(method === 'listsuspendedpubkeys' ? [{ pubkey: pk }] : []);
  const never = () => new Promise(() => {});
  const windowOpen = (pk: string) => renderHook(() => useJustRestored(pk)).result.current;

  // A failed or still-pending restore leaves the account hidden. The pending
  // cases fail if the window is opened before the relay call is awaited.
  it('does not start the restore window while the unsuspend is pending', async () => {
    const pk = '1'.repeat(64);
    api.callRelayRpc.mockImplementation(suspendedListOf(pk));
    api.unsuspendPubkey.mockImplementation(never);
    renderWithProvider(clientWithStats());
    fireEvent.mouseDown(await screen.findByRole('tab', { name: /Suspended Users/i }));
    fireEvent.click(await screen.findByRole('button', { name: /^Unsuspend$/i }));

    await waitFor(() => expect(api.unsuspendPubkey).toHaveBeenCalled());
    expect(windowOpen(pk)).toBe(false);
  });

  it('does not start the restore window when the unsuspend failed', async () => {
    const pk = '2'.repeat(64);
    api.callRelayRpc.mockImplementation(suspendedListOf(pk));
    api.unsuspendPubkey.mockRejectedValue(new Error('relay unreachable'));
    renderWithProvider(clientWithStats());
    fireEvent.mouseDown(await screen.findByRole('tab', { name: /Suspended Users/i }));
    fireEvent.click(await screen.findByRole('button', { name: /^Unsuspend$/i }));

    await waitFor(() => expect(toast).toHaveBeenCalled());
    expect(windowOpen(pk)).toBe(false);
  });

  // Positive control: the relay call landed, so the account is restored even
  // though the awaited audit write after it failed the mutation.
  it('starts the restore window after an unsuspend whose audit write failed', async () => {
    const pk = '6'.repeat(64);
    // Real timers: under fake ones a waitFor that never passes hangs rather
    // than failing. The window stays open on a pubkey no other test uses.
    {
      // Rendered once, before the action: a renderHook inside waitFor's
      // callback mounts a root per retry, which re-triggers waitFor, so a
      // failing assertion would loop until the heap runs out.
      const { result } = renderHook(() => useJustRestored(pk));
      api.logDecision.mockRejectedValue(new Error('audit down'));
      api.callRelayRpc.mockImplementation(suspendedListOf(pk));
      renderWithProvider(clientWithStats());
      fireEvent.mouseDown(await screen.findByRole('tab', { name: /Suspended Users/i }));
      fireEvent.click(await screen.findByRole('button', { name: /^Unsuspend$/i }));

      await waitFor(() => expect(api.logDecision).toHaveBeenCalled());
      await waitFor(() => expect(result.current).toBe(true));
    }
  });

  // The relay's read filter can lag an Unsuspend by a few minutes.
  it('starts the unsuspend window after an unsuspend', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      api.callRelayRpc.mockImplementation((method: string) =>
        Promise.resolve(method === 'listsuspendedpubkeys' ? [{ pubkey: PUBKEY }] : []));
      const client = clientWithStats();

      renderWithProvider(client);
      fireEvent.mouseDown(await screen.findByRole('tab', { name: /Suspended Users/i }));
      fireEvent.click(await screen.findByRole('button', { name: /^Unsuspend$/i }));

      const { result } = renderHook(() => useJustRestored(PUBKEY));
      await waitFor(() => expect(result.current).toBe(true));
      await act(async () => { await vi.advanceTimersByTimeAsync(RESTORE_SETTLE_MS + 1); });
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps them after a content action that leaves the account status as it was', async () => {
    const client = clientWithStats();

    renderWithProvider(client);
    await waitFor(() => expect(userActionsProps.last).not.toBeNull());
    const onActionComplete = userActionsProps.last?.onActionComplete as (c: UserActionChange) => void;
    await act(async () => { onActionComplete({ accountStatusChanged: false }); });

    expect(client.getQueryData(STATS_KEY)).toEqual({ postCount: 0 });
  });
});
