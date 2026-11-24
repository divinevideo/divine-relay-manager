// ABOUTME: Covers the WIRING of the age-review guard redirect in UserManagement.
// The shared hook's own tests pin the predicate; these pin that each mutation
// actually calls it, which is the failure mode that shipped once.

import React from 'react';
import { act, fireEvent, render, renderHook, screen, waitFor, within } from '@testing-library/react';
import type { UserActionChange } from '@/components/UserActions';
import { markRestored, RESTORE_SETTLE_MS, useJustRestored } from '@/lib/userStatsCache';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AppContext } from '@/contexts/AppContext';
import { nip19 } from 'nostr-tools';
import { TooltipProvider } from '@/components/ui/tooltip';
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { UserManagement } from './UserManagement';
import { ApiError, BanNotConfirmedError } from '@/lib/adminApi';
import { banFailureToast, banSuccessNote } from '@/lib/banFeedback';
import { tokensFor, withAsModerator } from '@/test/adminApiMock';
import { TIMED_SUSPENSIONS_KEY } from '@/hooks/useTimedSuspensions';
import { formatSuspensionEnd } from '../../shared/suspension';

const api = vi.hoisted(() => ({
  callRelayRpc: vi.fn(),
  banPubkey: vi.fn(),
  verifyPubkeyBanned: vi.fn(),
  verifyPubkeyUnbanned: vi.fn(),
  unbanPubkey: vi.fn(),
  unsuspendPubkey: vi.fn(),
  logDecision: vi.fn(),
  // Timed suspensions (F4): the Suspended tab's end lines and Change end date.
  listTimedSuspensions: vi.fn(),
  changeSuspensionEnd: vi.fn(),
}));
const toast = vi.hoisted(() => vi.fn());
const navigate = vi.hoisted(() => vi.fn());

vi.mock('react-router-dom', async (orig) => ({
  ...(await orig<typeof import('react-router-dom')>()),
  useNavigate: () => navigate,
}));
const moderatorApi = withAsModerator(api);
// useApiUrl: the timed-suspensions read keys its cache by environment.
vi.mock('@/hooks/useAdminApi', () => ({ useAdminApi: () => moderatorApi, useApiUrl: () => 'https://api.test' }));
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
// Render the action affordances and the status line it is handed, so the
// remove/unsuspend wiring and the end line are reachable (F4); everything else
// about the card is irrelevant here.
// Mounts are logged so a test can tell a card that survived a list change from
// one that was rebuilt or handed a different account (index keys move a card's
// open state, such as an expanded detail panel, onto the next account).
const cardMounts = vi.hoisted(() => ({ log: [] as string[] }));
vi.mock('@/components/BannedUserCard', () => ({
  BannedUserCard: ({ pubkey, actionButton, onUnban, suspended, statusLine }: {
    pubkey?: string; actionButton?: React.ReactNode; onUnban?: () => void; suspended?: boolean; statusLine?: React.ReactNode;
  }) => {
    React.useEffect(() => { cardMounts.log.push(pubkey ?? ''); }, [pubkey]);
    return (
      <div data-testid="user-card" data-pubkey={pubkey}>
        {statusLine}
        {actionButton}
        {onUnban ? <button onClick={onUnban}>Unban</button> : null}
        <span>{suspended ? 'card says suspended' : 'card says not suspended'}</span>
      </div>
    );
  },
}));

const PUBKEY = 'a'.repeat(64);

const guardRefusal = () => new ApiError('under age review', 409, 'Conflict', 'age_review_active');

// The Banned tab unbans with no prompt only once the suspended list has answered
// without the account (F6); clicked before then, the prompt opens and no unban is
// sent. Waiting for that answer states the precondition instead of relying on both
// lists settling in the same batch.
async function clickUnbanWithNoPrompt() {
  const button = await screen.findByRole('button', { name: /^Unban$/i });
  await waitFor(() => expect(api.callRelayRpc).toHaveBeenCalledWith('listsuspendedpubkeys'));
  await act(async () => {});
  fireEvent.click(button);
}

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
    api.verifyPubkeyUnbanned.mockResolvedValue(true);
    api.unbanPubkey.mockResolvedValue({ suspension: { state: 'none' } });
    api.listTimedSuspensions.mockResolvedValue({ suspensions: [], autoLift: true });
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
    await clickUnbanWithNoPrompt();

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
    api.verifyPubkeyUnbanned.mockResolvedValue(true);
    // An unban answers with what became of a timed suspension (B8).
    api.unbanPubkey.mockResolvedValue({ suspension: { state: 'none' } });
    api.unsuspendPubkey.mockResolvedValue(undefined);
    api.listTimedSuspensions.mockResolvedValue({ suspensions: [], autoLift: true });
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
    await clickUnbanWithNoPrompt();

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
    await clickUnbanWithNoPrompt();

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
    await clickUnbanWithNoPrompt();

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

// Timed suspensions on the User Management page: the Banned tab's unban asks
// what happens to a suspension, and Suspended-tab cards show its end and offer
// Change end date.
describe('UserManagement timed suspensions', () => {
  const OTHER = 'b'.repeat(64);
  // A minute-aligned end three days from now. A real-clock literal would turn
  // into "End time passed" once that date went by (F2).
  const threeDaysOut = () => new Date(Math.ceil((Date.now() + 3 * 86_400_000) / 60_000) * 60_000).toISOString();
  const timer = (pubkey: string, endsAt: string | null, status: 'active' | 'cancelled_ban' = 'active', version = 5) => ({
    pubkey, endsAt, status, setBy: null, setAt: '2026-11-20T00:00:00.000Z', changedAt: null, version,
  });
  // The timers read sets its own retry (1); keep its delay out of the tests.
  const client = () => new QueryClient({ defaultOptions: { queries: { retry: false, retryDelay: 0 }, mutations: { retry: false } } });
  const lists = (l: { banned?: unknown[] | (() => Promise<unknown>); suspended?: unknown[] | (() => Promise<unknown>) }) =>
    (method: string) => {
      const pick = method === 'listbannedpubkeys' ? l.banned : method === 'listsuspendedpubkeys' ? l.suspended : undefined;
      if (typeof pick === 'function') return pick();
      return Promise.resolve(pick ?? []);
    };
  const never = () => new Promise(() => {});
  const openSuspendedTab = async () => fireEvent.mouseDown(await screen.findByRole('tab', { name: /Suspended Users/i }));
  const confirmUnban = () => fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Unban' }));

  function renderPage(qc = client()) {
    return render(
      <QueryClientProvider client={qc}>
        <TooltipProvider><UserManagement /></TooltipProvider>
      </QueryClientProvider>,
    );
  }

  beforeEach(() => {
    vi.clearAllMocks();
    api.callRelayRpc.mockResolvedValue([]);
    api.logDecision.mockResolvedValue(undefined);
    api.verifyPubkeyUnbanned.mockResolvedValue(true);
    api.unbanPubkey.mockResolvedValue({ suspension: { state: 'none' } });
    api.unsuspendPubkey.mockResolvedValue(undefined);
    api.listTimedSuspensions.mockResolvedValue({ suspensions: [], autoLift: true });
    api.changeSuspensionEnd.mockResolvedValue({ endsAt: threeDaysOut(), decisionRecorded: true });
  });

  describe('Suspended tab cards', () => {
    it('show when the suspension ends', async () => {
      const endsAt = threeDaysOut();
      api.callRelayRpc.mockImplementation(lists({ suspended: [{ pubkey: PUBKEY }] }));
      api.listTimedSuspensions.mockResolvedValue({ suspensions: [timer(PUBKEY, endsAt)], autoLift: true });
      renderPage();
      await openSuspendedTab();
      expect(await screen.findByText(`Suspended until ${formatSuspensionEnd(endsAt)}`)).toBeInTheDocument();
    });

    it('say a card also in the banned list will not lift while the ban stands', async () => {
      const endsAt = threeDaysOut();
      // Uppercase in the banned list: the comparison is case-insensitive (F14).
      api.callRelayRpc.mockImplementation(lists({ banned: [{ pubkey: PUBKEY.toUpperCase() }], suspended: [{ pubkey: PUBKEY }] }));
      api.listTimedSuspensions.mockResolvedValue({ suspensions: [timer(PUBKEY, endsAt, 'cancelled_ban')], autoLift: true });
      renderPage();
      await openSuspendedTab();
      expect(await screen.findByText('Banned. The timed suspension will not lift while the ban stands')).toBeInTheDocument();
      expect(screen.queryByText(`Suspended until ${formatSuspensionEnd(endsAt)}`)).not.toBeInTheDocument();
    });

    it('offer Unsuspend and Change end date, which sends the new length', async () => {
      const endsAt = threeDaysOut();
      api.callRelayRpc.mockImplementation(lists({ suspended: [{ pubkey: PUBKEY }] }));
      api.listTimedSuspensions.mockResolvedValue({ suspensions: [timer(PUBKEY, endsAt)], autoLift: true });
      api.changeSuspensionEnd.mockResolvedValue({ endsAt, decisionRecorded: true });
      renderPage();
      await openSuspendedTab();
      expect(await screen.findByRole('button', { name: /^Unsuspend$/i })).toBeInTheDocument();
      fireEvent.click(screen.getByRole('button', { name: 'Change end date' }));
      const dialog = screen.getByRole('dialog');
      fireEvent.change(within(dialog).getByRole('combobox', { name: 'Unit' }), { target: { value: 'hours' } });
      fireEvent.change(within(dialog).getByLabelText('Length'), { target: { value: '12' } });
      fireEvent.click(within(dialog).getByRole('button', { name: 'Change end date' }));
      await waitFor(() => expect(api.changeSuspensionEnd).toHaveBeenCalledWith(PUBKEY, { value: 12, unit: 'hours' }));
      expect(tokensFor(moderatorApi, 'changeSuspensionEnd')).toEqual([MOD_TOKEN]);
      await waitFor(() => expect(toast).toHaveBeenCalledWith({ title: `End date changed to ${formatSuspensionEnd(endsAt)}` }));
      await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    });

    it('shows the timer and its edit on the exact relay row while preserving legacy cleanup', async () => {
      const endsAt = threeDaysOut();
      api.callRelayRpc.mockImplementation(lists({ suspended: [{ pubkey: PUBKEY.toUpperCase() }, { pubkey: PUBKEY }] }));
      api.listTimedSuspensions.mockResolvedValue({ suspensions: [timer(PUBKEY, endsAt)], autoLift: true });
      renderPage();
      await openSuspendedTab();
      expect(await screen.findAllByRole('button', { name: 'Unsuspend' })).toHaveLength(2);
      expect(await screen.findAllByText(`Suspended until ${formatSuspensionEnd(endsAt)}`)).toHaveLength(1);
      expect(screen.getAllByRole('button', { name: 'Change end date' })).toHaveLength(1);
    });

    // The Change end date dialog states the end it is changing.
    it('the Change end date dialog names the current end', async () => {
      const endsAt = threeDaysOut();
      api.callRelayRpc.mockImplementation(lists({ suspended: [{ pubkey: PUBKEY }] }));
      api.listTimedSuspensions.mockResolvedValue({ suspensions: [timer(PUBKEY, endsAt)], autoLift: true });
      renderPage();
      await openSuspendedTab();
      await screen.findByText(`Suspended until ${formatSuspensionEnd(endsAt)}`);
      fireEvent.click(screen.getByRole('button', { name: 'Change end date' }));
      expect(within(screen.getByRole('dialog')).getByText(`Currently: ${formatSuspensionEnd(endsAt)}`)).toBeInTheDocument();
    });

    // UserActions has its host re-read after these refusals; on this tab the
    // page is the host, so it re-reads the lists itself.
    it.each(['not_suspended', 'account_banned'] as const)('re-reads the account lists after a %s refusal', async (code) => {
      api.callRelayRpc.mockImplementation(lists({ suspended: [{ pubkey: PUBKEY }] }));
      api.changeSuspensionEnd.mockRejectedValue(new ApiError('refused', 409, 'Conflict', code));
      const qc = client();
      const invalidate = vi.spyOn(qc, 'invalidateQueries');
      renderPage(qc);
      await openSuspendedTab();
      fireEvent.click(await screen.findByRole('button', { name: 'Change end date' }));
      const dialog = screen.getByRole('dialog');
      fireEvent.change(within(dialog).getByLabelText('Length'), { target: { value: '2' } });
      fireEvent.click(within(dialog).getByRole('button', { name: 'Change end date' }));
      await waitFor(() => expect(invalidate).toHaveBeenCalledWith({ queryKey: ['suspended-users'] }));
      expect(invalidate).toHaveBeenCalledWith({ queryKey: ['banned-users'] });
    });

    it('does not re-read the account lists after another refusal', async () => {
      api.callRelayRpc.mockImplementation(lists({ suspended: [{ pubkey: PUBKEY }] }));
      api.changeSuspensionEnd.mockRejectedValue(new ApiError('refused', 409, 'Conflict', 'conflict'));
      const qc = client();
      const invalidate = vi.spyOn(qc, 'invalidateQueries');
      renderPage(qc);
      await openSuspendedTab();
      fireEvent.click(await screen.findByRole('button', { name: 'Change end date' }));
      const dialog = screen.getByRole('dialog');
      fireEvent.change(within(dialog).getByLabelText('Length'), { target: { value: '2' } });
      fireEvent.click(within(dialog).getByRole('button', { name: 'Change end date' }));
      await waitFor(() => expect(toast).toHaveBeenCalledWith(expect.objectContaining({ variant: 'destructive' })));
      expect(invalidate).not.toHaveBeenCalledWith({ queryKey: ['suspended-users'] });
    });
  });

  // F6 for the selected user's card: an unanswered suspended list is not a
  // confirmed "not suspended", so UserActions gets the unknown and its unban asks.
  describe('selected user status', () => {
    const lastProps = () => userActionsProps.last as Record<string, unknown>;

    it.each([
      ['still loading', never, true],
      ['failed', () => Promise.reject(new Error('relay down')), false],
    ] as const)('passes the suspension as unknown while the suspended list is %s', async (_name, suspended, pending) => {
      api.callRelayRpc.mockImplementation(lists({ banned: [{ pubkey: PUBKEY }], suspended }));
      renderWithProvider(client());
      await waitFor(() => expect(lastProps()?.isBanned).toBe(true));
      if (!pending) await waitFor(() => expect(lastProps().statusPending).toBe(false));
      expect(lastProps().isSuspended).toBeNull();
      // Loading says "checking"; a failure says it could not be confirmed.
      expect(lastProps().statusPending).toBe(pending);
    });

    // A failed refresh keeps the older copy, which may predate a suspend.
    it('passes the suspension as unknown when a refresh failed over an older copy', async () => {
      let suspendedReads = 0;
      api.callRelayRpc.mockImplementation((method: string) => {
        if (method === 'listsuspendedpubkeys') {
          suspendedReads += 1;
          return suspendedReads === 1 ? Promise.resolve([]) : Promise.reject(new Error('relay down'));
        }
        return Promise.resolve([]);
      });
      const qc = client();
      renderWithProvider(qc);
      await waitFor(() => expect(lastProps()?.isSuspended).toBe(false));
      await act(async () => { await qc.refetchQueries({ queryKey: ['suspended-users'] }); });
      await waitFor(() => expect(lastProps().isSuspended).toBeNull());
    });

    // isBanned follows the same rule as isSuspended: null until the banned list has
    // answered, never a guessed false.
    it.each([
      ['still loading', never, true],
      ['failed', () => Promise.reject(new Error('relay down')), false],
    ] as const)('passes the ban as unknown while the banned list is %s', async (_name, banned, pending) => {
      api.callRelayRpc.mockImplementation(lists({ banned, suspended: [] }));
      renderWithProvider(client());
      await waitFor(() => expect(lastProps()?.isSuspended).toBe(false));
      if (!pending) await waitFor(() => expect(lastProps().statusPending).toBe(false));
      expect(lastProps().isBanned).toBeNull();
      expect(lastProps().statusPending).toBe(pending);
    });

    it('passes the ban as unknown when a refresh of the banned list failed over an older copy', async () => {
      let bannedReads = 0;
      api.callRelayRpc.mockImplementation((method: string) => {
        if (method === 'listbannedpubkeys') {
          bannedReads += 1;
          return bannedReads === 1 ? Promise.resolve([{ pubkey: PUBKEY }]) : Promise.reject(new Error('relay down'));
        }
        return Promise.resolve([]);
      });
      const qc = client();
      renderWithProvider(qc);
      await waitFor(() => expect(lastProps()?.isBanned).toBe(true));
      await act(async () => { await qc.refetchQueries({ queryKey: ['banned-users'] }); });
      await waitFor(() => expect(lastProps().isBanned).toBeNull());
    });

    it.each([
      ['listed in uppercase', [{ pubkey: PUBKEY.toUpperCase() }], true],
      ['not listed', [{ pubkey: OTHER }], false],
    ] as const)('passes the answered ban when the account is %s', async (_name, banned, expected) => {
      api.callRelayRpc.mockImplementation(lists({ banned: [...banned] }));
      renderWithProvider(client());
      await waitFor(() => expect(lastProps()?.isBanned).toBe(expected));
    });

    it.each([
      ['listed', [{ pubkey: PUBKEY.toUpperCase() }], true],
      ['not listed', [{ pubkey: OTHER }], false],
    ] as const)('passes the answered suspension when the account is %s', async (_name, suspended, expected) => {
      api.callRelayRpc.mockImplementation(lists({ suspended: [...suspended] }));
      renderWithProvider(client());
      await waitFor(() => expect(lastProps()?.isSuspended).toBe(expected));
      expect(lastProps().statusPending).toBe(false);
    });
  });

  describe('Banned tab unban', () => {
    it('of a suspended account opens the prompt, and Keep suspended with no end date sends open_ended', async () => {
      api.callRelayRpc.mockImplementation(lists({ banned: [{ pubkey: PUBKEY }], suspended: [{ pubkey: PUBKEY }] }));
      api.listTimedSuspensions.mockResolvedValue({ suspensions: [timer(PUBKEY, threeDaysOut(), 'cancelled_ban')], autoLift: true });
      api.unbanPubkey.mockResolvedValue({ suspension: { state: 'open_ended', endsAt: null, decisionRecorded: true } });
      renderPage();
      fireEvent.click(await screen.findByRole('button', { name: /^Unban$/i }));
      const dialog = await screen.findByRole('dialog');
      expect(api.unbanPubkey).not.toHaveBeenCalled();
      await within(dialog).findByLabelText(/^Resume until /);
      fireEvent.click(within(dialog).getByLabelText('Keep suspended with no end date'));
      confirmUnban();
      // With the version of the timer the prompt showed, so a stale choice is refused.
      await waitFor(() => expect(api.unbanPubkey).toHaveBeenCalledWith(PUBKEY, 'open_ended', 5));
      expect(tokensFor(moderatorApi, 'unbanPubkey')).toEqual([MOD_TOKEN]);
      await waitFor(() => expect(toast).toHaveBeenCalledWith({ title: 'User unbanned. Still suspended, no end date' }));
      await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
      // The browser's unban_user row stays.
      expect(api.logDecision).toHaveBeenCalledWith(expect.objectContaining({ action: 'unban_user', targetId: PUBKEY }));
    });

    // The prompt and the toast take the switch from the cached timers list.
    it.each([
      [true, 'Resume. The end date has passed, so it lifts at the next check',
        'User unbanned. The end date has passed, so the suspension lifts at the next check'],
      [false, 'Resume. The end date has passed, so unsuspend to lift it',
        'User unbanned. The end date has passed, so unsuspend to lift the suspension'],
      [undefined, 'Resume. The end date has passed, so unsuspend to lift it',
        'User unbanned. The end date has passed, so unsuspend to lift the suspension'],
    ])('a passed end with automatic lifting %s: the prompt and the toast say so', async (autoLift, label, title) => {
      const past = new Date(Math.floor((Date.now() - 86_400_000) / 60_000) * 60_000).toISOString();
      api.callRelayRpc.mockImplementation(lists({ banned: [{ pubkey: PUBKEY }], suspended: [{ pubkey: PUBKEY }] }));
      api.listTimedSuspensions.mockResolvedValue({
        suspensions: [timer(PUBKEY, past, 'cancelled_ban')], ...(autoLift !== undefined && { autoLift }),
      });
      api.unbanPubkey.mockResolvedValue({ suspension: { state: 'resumed', endsAt: past, decisionRecorded: true } });
      renderPage();
      fireEvent.click(await screen.findByRole('button', { name: /^Unban$/i }));
      const dialog = await screen.findByRole('dialog');
      expect(await within(dialog).findByLabelText(label)).toBeChecked();
      confirmUnban();
      await waitFor(() => expect(toast).toHaveBeenCalledWith({ title }));
    });

    // The prompt can then name the end as it opens, rather than start unknown.
    it('reads the timers ahead only while a banned account may be suspended', async () => {
      api.callRelayRpc.mockImplementation(lists({ banned: [{ pubkey: PUBKEY }], suspended: [{ pubkey: PUBKEY }] }));
      renderPage();
      await waitFor(() => expect(api.listTimedSuspensions).toHaveBeenCalled());
    });

    it('does not read the timers ahead when no banned account is suspended', async () => {
      api.callRelayRpc.mockImplementation(lists({ banned: [{ pubkey: PUBKEY }], suspended: [] }));
      renderPage();
      await screen.findByRole('button', { name: /^Unban$/i });
      await waitFor(() => expect(api.callRelayRpc).toHaveBeenCalledWith('listsuspendedpubkeys'));
      await act(async () => {});
      expect(api.listTimedSuspensions).not.toHaveBeenCalled();
    });

    it('matches the suspended list case-insensitively (F14)', async () => {
      api.callRelayRpc.mockImplementation(lists({ banned: [{ pubkey: PUBKEY }], suspended: [{ pubkey: PUBKEY.toUpperCase() }] }));
      renderPage();
      fireEvent.click(await screen.findByRole('button', { name: /^Unban$/i }));
      expect(await screen.findByRole('dialog')).toBeInTheDocument();
    });

    it('of an account the suspended list answered without unbans with no prompt and no choice', async () => {
      api.callRelayRpc.mockImplementation(lists({ banned: [{ pubkey: PUBKEY }], suspended: [{ pubkey: OTHER }] }));
      renderPage();
      // The other account's card on the Suspended tab proves the list answered.
      await openSuspendedTab();
      await screen.findByRole('button', { name: /^Unsuspend$/i });
      fireEvent.mouseDown(screen.getByRole('tab', { name: /Banned Users/i }));
      fireEvent.click(await screen.findByRole('button', { name: /^Unban$/i }));
      await waitFor(() => expect(api.unbanPubkey).toHaveBeenCalledWith(PUBKEY));
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      await waitFor(() => expect(toast).toHaveBeenCalledWith({ title: 'User unbanned' }));
    });

    // F6: while the suspended list is loading, or after it failed, nobody knows
    // whether the account is suspended, so the unban asks.
    it.each([
      ['still loading', never],
      ['failed', () => Promise.reject(new Error('relay down'))],
    ] as const)('asks while the suspended list is %s', async (_name, suspended) => {
      api.callRelayRpc.mockImplementation(lists({ banned: [{ pubkey: PUBKEY }], suspended }));
      renderPage();
      fireEvent.click(await screen.findByRole('button', { name: /^Unban$/i }));
      expect(await screen.findByRole('dialog')).toBeInTheDocument();
      expect(api.unbanPubkey).not.toHaveBeenCalled();
      // Nobody knows whether it is suspended, so the prompt does not say it is.
      expect(screen.getByText('This account may also be suspended; its suspension status is not confirmed. Choose what happens to any suspension when the ban is lifted.')).toBeInTheDocument();
      expect(screen.queryByText('This account is also suspended. Choose what happens to the suspension when the ban is lifted.')).not.toBeInTheDocument();
    });

    // An older copy that lists the account is not a confirmation once its
    // refresh failed: the account may have been unsuspended since.
    it('does not call a suspension confirmed from an older copy whose refresh failed', async () => {
      let suspendedReads = 0;
      api.callRelayRpc.mockImplementation((method: string) => {
        if (method === 'listbannedpubkeys') return Promise.resolve([{ pubkey: PUBKEY }]);
        if (method === 'listsuspendedpubkeys') {
          suspendedReads += 1;
          return suspendedReads === 1 ? Promise.resolve([{ pubkey: PUBKEY }]) : Promise.reject(new Error('relay down'));
        }
        return Promise.resolve([]);
      });
      const qc = client();
      renderPage(qc);
      await screen.findByRole('button', { name: /^Unban$/i });
      await waitFor(() => expect(suspendedReads).toBe(1));
      await act(async () => { await qc.refetchQueries({ queryKey: ['suspended-users'] }); });
      await waitFor(() => expect(qc.getQueryState(['suspended-users'])?.status).toBe('error'));
      fireEvent.click(screen.getByRole('button', { name: /^Unban$/i }));
      expect(await screen.findByText('This account may also be suspended; its suspension status is not confirmed. Choose what happens to any suspension when the ban is lifted.')).toBeInTheDocument();
    });

    it('says a listed account is suspended', async () => {
      api.callRelayRpc.mockImplementation(lists({ banned: [{ pubkey: PUBKEY }], suspended: [{ pubkey: PUBKEY }] }));
      renderPage();
      fireEvent.click(await screen.findByRole('button', { name: /^Unban$/i }));
      expect(await screen.findByText('This account is also suspended. Choose what happens to the suspension when the ban is lifted.')).toBeInTheDocument();
      expect(screen.queryByText('This account may also be suspended; its suspension status is not confirmed. Choose what happens to any suspension when the ban is lifted.')).not.toBeInTheDocument();
    });

    // A failed refresh keeps the older copy on screen, which may predate a
    // suspend: that copy is not an answer, so the unban still asks.
    it('asks when a refresh of the suspended list failed over an older copy', async () => {
      let suspendedReads = 0;
      api.callRelayRpc.mockImplementation((method: string) => {
        if (method === 'listbannedpubkeys') return Promise.resolve([{ pubkey: PUBKEY }]);
        if (method === 'listsuspendedpubkeys') {
          suspendedReads += 1;
          return suspendedReads === 1 ? Promise.resolve([]) : Promise.reject(new Error('relay down'));
        }
        return Promise.resolve([]);
      });
      const qc = client();
      renderPage(qc);
      await screen.findByRole('button', { name: /^Unban$/i });
      await waitFor(() => expect(suspendedReads).toBe(1));
      await act(async () => { await qc.refetchQueries({ queryKey: ['suspended-users'] }); });
      await waitFor(() => expect(qc.getQueryState(['suspended-users'])?.status).toBe('error'));
      expect(qc.getQueryData(['suspended-users'])).toEqual([]);
      fireEvent.click(screen.getByRole('button', { name: /^Unban$/i }));
      expect(await screen.findByRole('dialog')).toBeInTheDocument();
      expect(api.unbanPubkey).not.toHaveBeenCalled();
    });

    it.each([
      [{ suspension: { state: 'end_failed' } }, {
        title: 'User unbanned, but the suspension could not be lifted',
        description: 'It is still suspended. Try Unsuspend.', variant: 'destructive',
      }],
      [{ suspension: { state: 'unknown' } }, {
        title: 'User unbanned, but the suspension status could not be checked',
        description: 'Check the account before acting again.',
      }],
      [{ suspension: { state: 'none' }, choiceSkipped: 'non_canonical_pubkey' }, {
        title: 'User unbanned, but the suspension choice was not applied',
        description: 'Check the account before acting again.',
      }],
    ] as const)('toasts the outcome honestly (%#)', async (outcome, expected) => {
      api.callRelayRpc.mockImplementation(lists({ banned: [{ pubkey: PUBKEY }], suspended: [{ pubkey: PUBKEY }] }));
      api.unbanPubkey.mockResolvedValue(outcome);
      renderPage();
      fireEvent.click(await screen.findByRole('button', { name: /^Unban$/i }));
      fireEvent.click(within(await screen.findByRole('dialog')).getByLabelText('End the suspension now'));
      confirmUnban();
      await waitFor(() => expect(toast).toHaveBeenCalledWith(expected));
      expect(toast).toHaveBeenCalledTimes(1);
    });

    // The unban landed before the audit write, so a failed write must not read
    // as "Failed to unban user", and must not hide what became of the suspension.
    it('carries the outcome on a failed audit write, without calling the unban failed', async () => {
      api.callRelayRpc.mockImplementation(lists({ banned: [{ pubkey: PUBKEY }], suspended: [{ pubkey: PUBKEY }] }));
      api.unbanPubkey.mockResolvedValue({ suspension: { state: 'end_failed' } });
      api.logDecision.mockRejectedValue(new Error('audit down'));
      renderPage();
      fireEvent.click(await screen.findByRole('button', { name: /^Unban$/i }));
      await screen.findByRole('dialog');
      confirmUnban();
      // A destructive outcome keeps its title and severity over the audit warning (G4).
      await waitFor(() => expect(toast).toHaveBeenCalledWith({
        title: 'User unbanned, but the suspension could not be lifted',
        description: 'It is still suspended. Try Unsuspend. Audit log not recorded.',
        variant: 'destructive',
      }));
      expect(toast).not.toHaveBeenCalledWith(expect.objectContaining({ title: 'Failed to unban user' }));
    });

    // Ask again if it changed: the worker refused a choice made against an older timer.
    it('a suspension_changed refusal re-reads the timers and asks again against the current end', async () => {
      const endsAt = threeDaysOut();
      api.callRelayRpc.mockImplementation(lists({ banned: [{ pubkey: PUBKEY }], suspended: [{ pubkey: PUBKEY }] }));
      api.listTimedSuspensions.mockResolvedValueOnce({ suspensions: [], autoLift: true }).mockResolvedValue({ suspensions: [timer(PUBKEY, endsAt, 'cancelled_ban', 6)], autoLift: true });
      api.unbanPubkey
        .mockRejectedValueOnce(new ApiError('changed', 409, 'Conflict', 'suspension_changed'))
        .mockResolvedValue({ suspension: { state: 'resumed', endsAt, decisionRecorded: true } });
      renderPage();
      fireEvent.click(await screen.findByRole('button', { name: /^Unban$/i }));
      const dialog = await screen.findByRole('dialog');
      expect(await within(dialog).findByLabelText('Keep suspended with no end date')).toBeChecked();
      confirmUnban();
      await waitFor(() => expect(api.unbanPubkey).toHaveBeenCalledWith(PUBKEY, 'open_ended', null));

      expect(await within(dialog).findByText('The suspension changed after this was opened. Check the options below and confirm again.')).toBeInTheDocument();
      expect(await within(dialog).findByLabelText(/^Resume until /)).toBeChecked();
      expect(toast).not.toHaveBeenCalledWith(expect.objectContaining({ title: 'Failed to unban user' }));

      confirmUnban();
      await waitFor(() => expect(api.unbanPubkey).toHaveBeenLastCalledWith(PUBKEY, 'resume', 6));
      await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    });

    // Cancel stays enabled during the unban, and a closed prompt is unmounted, so it can't say
    // why nothing happened: the refusal is a toast instead, and the account is still banned.
    const REFUSED = 'The suspension changed after this was opened. Check the end date and confirm again.';
    const refusedToast = expect.objectContaining({ title: 'Failed to unban user', description: REFUSED });

    it('a suspension_changed refusal after the prompt was closed says so in a toast, once the timers are re-read', async () => {
      api.callRelayRpc.mockImplementation(lists({ banned: [{ pubkey: PUBKEY }], suspended: [{ pubkey: PUBKEY }] }));
      let reread!: (v: unknown) => void;
      api.listTimedSuspensions.mockResolvedValue({ suspensions: [], autoLift: true }).mockResolvedValueOnce({ suspensions: [], autoLift: true })
        .mockReturnValueOnce(new Promise(r => { reread = r; }));
      let refuse!: (e: unknown) => void;
      api.unbanPubkey.mockReturnValueOnce(new Promise((_, reject) => { refuse = reject; }));
      renderPage();
      fireEvent.click(await screen.findByRole('button', { name: /^Unban$/i }));
      const dialog = await screen.findByRole('dialog');
      await within(dialog).findByLabelText('Keep suspended with no end date');
      confirmUnban();
      await waitFor(() => expect(api.unbanPubkey).toHaveBeenCalledWith(PUBKEY, 'open_ended', null));
      fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
      await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());

      await act(async () => { refuse(new ApiError(REFUSED, 409, 'Conflict', 'suspension_changed')); });
      await waitFor(() => expect(api.listTimedSuspensions).toHaveBeenCalledTimes(2));
      expect(toast).not.toHaveBeenCalledWith(refusedToast);

      await act(async () => { reread({ suspensions: [], autoLift: true }); });
      await waitFor(() => expect(toast).toHaveBeenCalledWith(refusedToast));
    });

    // The Banned tab's Unban stays clickable while an unban is pending, so another account's
    // prompt can be open when the first refusal comes back. That prompt can't say it either.
    it("a refusal whose prompt was closed is a toast even while another account's prompt is open", async () => {
      api.callRelayRpc.mockImplementation(lists({
        banned: [{ pubkey: PUBKEY }, { pubkey: OTHER }], suspended: [{ pubkey: PUBKEY }, { pubkey: OTHER }],
      }));
      api.listTimedSuspensions.mockResolvedValue({ suspensions: [], autoLift: true });
      let refuse!: (e: unknown) => void;
      api.unbanPubkey.mockReturnValueOnce(new Promise((_, reject) => { refuse = reject; }));
      renderPage();
      // The Banned tab lists PUBKEY, then OTHER.
      const unbanButtons = await screen.findAllByRole('button', { name: /^Unban$/i });
      expect(unbanButtons).toHaveLength(2);
      fireEvent.click(unbanButtons[0]);
      const first = await screen.findByRole('dialog');
      await within(first).findByLabelText('Keep suspended with no end date');
      confirmUnban();
      await waitFor(() => expect(api.unbanPubkey).toHaveBeenCalledWith(PUBKEY, 'open_ended', null));
      fireEvent.click(within(first).getByRole('button', { name: 'Cancel' }));
      await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
      fireEvent.click(screen.getAllByRole('button', { name: /^Unban$/i })[1]);
      const second = await screen.findByRole('dialog');

      await act(async () => { refuse(new ApiError(REFUSED, 409, 'Conflict', 'suspension_changed')); });

      await waitFor(() => expect(toast).toHaveBeenCalledWith(refusedToast));
      expect(screen.getByRole('dialog')).toBe(second);
      expect(api.unbanPubkey).toHaveBeenCalledTimes(1);
    });

    // Leaving the page with the prompt open unmounts it without a close: the refusal still
    // arrives (a mutation-level callback), and nothing on screen can say it but the toast.
    it('a suspension_changed refusal after the page unmounted with the prompt open is a toast', async () => {
      api.callRelayRpc.mockImplementation(lists({ banned: [{ pubkey: PUBKEY }], suspended: [{ pubkey: PUBKEY }] }));
      let refuse!: (e: unknown) => void;
      api.unbanPubkey.mockReturnValueOnce(new Promise((_, reject) => { refuse = reject; }));
      const { unmount } = renderPage();
      fireEvent.click(await screen.findByRole('button', { name: /^Unban$/i }));
      await within(await screen.findByRole('dialog')).findByLabelText('Keep suspended with no end date');
      confirmUnban();
      await waitFor(() => expect(api.unbanPubkey).toHaveBeenCalledWith(PUBKEY, 'open_ended', null));
      unmount();

      await act(async () => { refuse(new ApiError(REFUSED, 409, 'Conflict', 'suspension_changed')); });

      await waitFor(() => expect(toast).toHaveBeenCalledWith(refusedToast));
    });

    // Each opening gets a fresh form. In a browser the old form can still be mounted when a new
    // opening starts (a reopen during the close animation); jsdom runs no animation, so the new
    // opening starts here while the old prompt is still up. Its pick must not carry over.
    it("a new opening does not inherit the previous opening's pick", async () => {
      api.callRelayRpc.mockImplementation(lists({
        banned: [{ pubkey: PUBKEY }, { pubkey: OTHER }], suspended: [{ pubkey: PUBKEY }, { pubkey: OTHER }],
      }));
      api.listTimedSuspensions.mockResolvedValue({ suspensions: [timer(PUBKEY, threeDaysOut()), timer(OTHER, threeDaysOut())], autoLift: true });
      renderPage();
      const [first, second] = await screen.findAllByRole('button', { name: /^Unban$/i });
      fireEvent.click(first);
      const dialog = await screen.findByRole('dialog');
      await within(dialog).findByLabelText(/^Resume until /);
      fireEvent.click(within(dialog).getByLabelText('Keep suspended with no end date'));
      expect(within(dialog).getByLabelText('Keep suspended with no end date')).toBeChecked();

      fireEvent.click(second);

      const reopened = await screen.findByRole('dialog');
      await waitFor(() => expect(within(reopened).getByLabelText(/^Resume until /)).toBeChecked());
      expect(within(reopened).getByLabelText('Keep suspended with no end date')).not.toBeChecked();
    });

    it("a successful unban leaves another account's prompt open", async () => {
      api.callRelayRpc.mockImplementation(lists({
        banned: [{ pubkey: PUBKEY }, { pubkey: OTHER }],
        suspended: [{ pubkey: PUBKEY }, { pubkey: OTHER }],
      }));
      let finish!: () => void;
      api.unbanPubkey.mockReturnValueOnce(new Promise(resolve => {
        finish = () => resolve({ suspension: { state: 'resumed', endsAt: null } });
      }));
      renderPage();
      const [first, second] = await screen.findAllByRole('button', { name: 'Unban' });
      fireEvent.click(first);
      const firstPrompt = await screen.findByRole('dialog');
      await waitFor(() => expect(within(firstPrompt).getByRole('button', { name: 'Unban' })).toBeEnabled());
      confirmUnban();
      await waitFor(() => expect(api.unbanPubkey).toHaveBeenCalledWith(PUBKEY, 'open_ended', null));
      fireEvent.click(within(firstPrompt).getByRole('button', { name: 'Cancel' }));
      await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
      fireEvent.click(second);
      const secondPrompt = await screen.findByRole('dialog');

      await act(async () => { finish(); });
      await waitFor(() => expect(within(secondPrompt).getByRole('button', { name: 'Unban' })).toBeEnabled());
      expect(screen.getByRole('dialog')).toBe(secondPrompt);
    });

    it('blocks confirm while the timers are first loading', async () => {
      api.callRelayRpc.mockImplementation(lists({ banned: [{ pubkey: PUBKEY }], suspended: [{ pubkey: PUBKEY }] }));
      api.listTimedSuspensions.mockReturnValue(new Promise(() => {}));
      renderPage();
      fireEvent.click(await screen.findByRole('button', { name: /^Unban$/i }));
      const dialog = await screen.findByRole('dialog');
      await waitFor(() => expect(api.listTimedSuspensions).toHaveBeenCalled());
      expect(within(dialog).getByRole('button', { name: 'Unban' })).toBeDisabled();
    });

    it('keeps confirm disabled until the timers re-read after a suspension_changed refusal, and a failed re-read shows the end as unavailable', async () => {
      api.callRelayRpc.mockImplementation(lists({ banned: [{ pubkey: PUBKEY }], suspended: [{ pubkey: PUBKEY }] }));
      let fail!: (e: Error) => void;
      api.listTimedSuspensions.mockResolvedValueOnce({ suspensions: [], autoLift: true })
        .mockReturnValueOnce(new Promise((_r, rej) => { fail = rej; }))
        .mockRejectedValue(new Error('worker down'));
      api.unbanPubkey
        .mockRejectedValueOnce(new ApiError('changed', 409, 'Conflict', 'suspension_changed'))
        .mockResolvedValue({ suspension: { state: 'resumed', endsAt: null, decisionRecorded: true } });
      renderPage();
      fireEvent.click(await screen.findByRole('button', { name: /^Unban$/i }));
      const dialog = await screen.findByRole('dialog');
      expect(await within(dialog).findByLabelText('Keep suspended with no end date')).toBeChecked();
      confirmUnban();
      await waitFor(() => expect(api.listTimedSuspensions).toHaveBeenCalledTimes(2));
      expect(within(dialog).getByRole('button', { name: 'Unbanning...' })).toBeDisabled();
      await act(async () => { fail(new Error('worker down')); });

      expect(await within(dialog).findByText('Suspended. End date unavailable')).toBeInTheDocument();
      expect(within(dialog).getByLabelText('Resume the suspension as it is')).toBeChecked();
      expect(toast).not.toHaveBeenCalledWith(expect.objectContaining({ title: 'Failed to unban user' }));
      await waitFor(() => expect(within(dialog).getByRole('button', { name: 'Unban' })).toBeEnabled());
      confirmUnban();
      await waitFor(() => expect(api.unbanPubkey).toHaveBeenLastCalledWith(PUBKEY, 'resume'));
    });

    it('stays open after a failed unban, with the failure toast', async () => {
      api.callRelayRpc.mockImplementation(lists({ banned: [{ pubkey: PUBKEY }], suspended: [{ pubkey: PUBKEY }] }));
      api.unbanPubkey.mockRejectedValue(new ApiError('relay down', 502, 'Bad Gateway'));
      renderPage();
      fireEvent.click(await screen.findByRole('button', { name: /^Unban$/i }));
      await screen.findByRole('dialog');
      confirmUnban();
      await waitFor(() => expect(toast).toHaveBeenCalledWith(expect.objectContaining({ title: 'Failed to unban user' })));
      expect(screen.getByRole('dialog')).toBeInTheDocument();
    });

    // An older "no timer" copy whose refresh failed may predate a timed suspend, so
    // the prompt treats the end as unknown rather than default to "no end date".
    it('defaults to resume as it is when a timer refresh failed over an older copy', async () => {
      api.callRelayRpc.mockImplementation(lists({ banned: [{ pubkey: PUBKEY }], suspended: [{ pubkey: PUBKEY }] }));
      api.listTimedSuspensions.mockResolvedValueOnce({ suspensions: [], autoLift: true });
      const qc = client();
      renderPage(qc);
      await waitFor(() => expect(qc.getQueryState([...TIMED_SUSPENSIONS_KEY, 'https://api.test'])?.status).toBe('success'));
      api.listTimedSuspensions.mockRejectedValue(new Error('worker down'));
      await act(async () => { await qc.refetchQueries({ queryKey: TIMED_SUSPENSIONS_KEY }); });
      await waitFor(() => expect(qc.getQueryState([...TIMED_SUSPENSIONS_KEY, 'https://api.test'])?.status).toBe('error'));
      fireEvent.click(screen.getByRole('button', { name: /^Unban$/i }));
      const dialog = await screen.findByRole('dialog');
      expect(within(dialog).getByLabelText('Resume the suspension as it is')).toBeChecked();
    });

    // The unban may have ended or changed the timer: a failed re-read must not
    // leave the old end on screen as current.
    it('resets the timers after an unban', async () => {
      api.callRelayRpc.mockImplementation(lists({ banned: [{ pubkey: PUBKEY }], suspended: [{ pubkey: PUBKEY }] }));
      const qc = client();
      const reset = vi.spyOn(qc, 'resetQueries');
      renderPage(qc);
      fireEvent.click(await screen.findByRole('button', { name: /^Unban$/i }));
      await screen.findByRole('dialog');
      confirmUnban();
      await waitFor(() => expect(reset).toHaveBeenCalledWith({ queryKey: TIMED_SUSPENSIONS_KEY }));
    });
  });
});

// The Banned and Suspended tabs hold every account the relay lists (about 1,600
// banned in production). Rendering one card per account fired thousands of
// profile and content reads on open, so each tab shows one page at a time.
describe('UserManagement paged Banned and Suspended lists', () => {
  const hex = (i: number) => i.toString(16).padStart(64, '0');
  const entries = (n: number) => Array.from({ length: n }, (_, i) => ({ pubkey: hex(i + 1), reason: `r${i}` }));
  const pubkeysShown = () => screen.getAllByTestId('user-card').map(c => c.getAttribute('data-pubkey'));

  function serve(banned: unknown[], suspended: unknown[] = []) {
    api.callRelayRpc.mockImplementation((method: string) => {
      if (method === 'listbannedpubkeys') return Promise.resolve(banned);
      if (method === 'listsuspendedpubkeys') return Promise.resolve(suspended);
      return Promise.resolve([]);
    });
  }

  beforeEach(() => {
    vi.clearAllMocks();
    cardMounts.log.length = 0;
    api.unbanPubkey.mockResolvedValue({ suspension: { state: 'none' } });
    api.unsuspendPubkey.mockResolvedValue(undefined);
    api.logDecision.mockResolvedValue(undefined);
    api.verifyPubkeyUnbanned.mockResolvedValue(true);
    api.listTimedSuspensions.mockResolvedValue({ suspensions: [], autoLift: true });
  });

  it('renders only the first page of banned accounts', async () => {
    serve(entries(120));
    renderWithProvider();
    await screen.findAllByTestId('user-card');
    expect(pubkeysShown()).toEqual(entries(50).map(e => e.pubkey));
  });

  it('shows the next page, then the previous one again', async () => {
    serve(entries(120));
    renderWithProvider();
    await screen.findAllByTestId('user-card');

    fireEvent.click(screen.getByRole('button', { name: /^Next$/ }));
    expect(pubkeysShown()).toEqual(entries(120).slice(50, 100).map(e => e.pubkey));

    fireEvent.click(screen.getByRole('button', { name: /^Next$/ }));
    expect(pubkeysShown()).toHaveLength(20);
    expect(screen.getByRole('button', { name: /^Next$/ })).toBeDisabled();

    fireEvent.click(screen.getByRole('button', { name: /^Previous$/ }));
    expect(pubkeysShown()[0]).toBe(hex(51));
  });

  it('shows no pager when everything fits on one page', async () => {
    serve(entries(50));
    renderWithProvider();
    await screen.findAllByTestId('user-card');
    expect(screen.queryByRole('button', { name: /^Next$/ })).not.toBeInTheDocument();
  });

  it('pages the Suspended tab too', async () => {
    serve([], entries(70));
    renderWithProvider();
    fireEvent.mouseDown(await screen.findByRole('tab', { name: /Suspended Users/i }));
    await screen.findAllByTestId('user-card');
    expect(pubkeysShown()).toHaveLength(50);

    fireEvent.click(screen.getByRole('button', { name: /^Next$/ }));
    expect(pubkeysShown()).toEqual(entries(70).slice(50).map(e => e.pubkey));
  });

  it('unbans the account on a later page, not the one at the same index on page one', async () => {
    serve(entries(60));
    renderWithProvider();
    await screen.findAllByTestId('user-card');
    fireEvent.click(screen.getByRole('button', { name: /^Next$/ }));
    await waitFor(() => expect(api.callRelayRpc).toHaveBeenCalledWith('listsuspendedpubkeys'));
    await act(async () => {});

    fireEvent.click(screen.getAllByRole('button', { name: /^Unban$/ })[0]);

    await waitFor(() => expect(api.unbanPubkey).toHaveBeenCalledWith(hex(51)));
  });

  it('steps back a page when the last account on the last page is removed', async () => {
    let banned = entries(51);
    api.callRelayRpc.mockImplementation((method: string) => {
      if (method === 'listbannedpubkeys') return Promise.resolve(banned);
      return Promise.resolve([]);
    });
    api.unbanPubkey.mockImplementation(async (pk: string) => {
      banned = banned.filter(b => b.pubkey !== pk);
      return { suspension: { state: 'none' } };
    });
    renderWithProvider();
    await screen.findAllByTestId('user-card');
    fireEvent.click(screen.getByRole('button', { name: /^Next$/ }));
    await waitFor(() => expect(api.callRelayRpc).toHaveBeenCalledWith('listsuspendedpubkeys'));
    await act(async () => {});
    fireEvent.click(screen.getByRole('button', { name: /^Unban$/ }));

    await waitFor(() => expect(screen.getAllByTestId('user-card')).toHaveLength(50));
  });

  it('keeps the other cards mounted when one account is removed from the page', async () => {
    let banned = entries(5);
    api.callRelayRpc.mockImplementation((method: string) =>
      Promise.resolve(method === 'listbannedpubkeys' ? banned : []));
    api.unbanPubkey.mockImplementation(async (pk: string) => {
      banned = banned.filter(b => b.pubkey !== pk);
      return { suspension: { state: 'none' } };
    });
    renderWithProvider();
    await screen.findAllByTestId('user-card');
    await waitFor(() => expect(api.callRelayRpc).toHaveBeenCalledWith('listsuspendedpubkeys'));
    await act(async () => {});
    cardMounts.log.length = 0;

    fireEvent.click(screen.getAllByRole('button', { name: /^Unban$/ })[0]);
    await waitFor(() => expect(screen.getAllByTestId('user-card')).toHaveLength(4));

    expect(cardMounts.log).toEqual([]);
  });

  it('keeps the other Suspended cards mounted when one account is unsuspended', async () => {
    let suspended = entries(5);
    api.callRelayRpc.mockImplementation((method: string) =>
      Promise.resolve(method === 'listsuspendedpubkeys' ? suspended : []));
    api.unsuspendPubkey.mockImplementation(async (pk: string) => {
      suspended = suspended.filter(b => b.pubkey !== pk);
    });
    renderWithProvider();
    fireEvent.mouseDown(await screen.findByRole('tab', { name: /Suspended Users/i }));
    await screen.findAllByTestId('user-card');
    cardMounts.log.length = 0;

    fireEvent.click(screen.getAllByRole('button', { name: /^Unsuspend$/ })[0]);
    await waitFor(() => expect(screen.getAllByTestId('user-card')).toHaveLength(4));

    expect(cardMounts.log).toEqual([]);
  });

  it('disables Previous on the first page and names the range on every page', async () => {
    serve(entries(120));
    renderWithProvider();
    await screen.findAllByTestId('user-card');
    expect(screen.getByRole('button', { name: /^Previous$/ })).toBeDisabled();
    expect(screen.getByText('1-50 of 120')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /^Next$/ }));
    expect(screen.getByText('51-100 of 120')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /^Next$/ }));
    expect(screen.getByText('101-120 of 120')).toBeInTheDocument();
  });

  it('does not jump forward when a list shrinks past the page and then grows back', async () => {
    let banned = entries(101);
    api.callRelayRpc.mockImplementation((method: string) =>
      Promise.resolve(method === 'listbannedpubkeys' ? banned : []));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    renderWithProvider(client);
    await screen.findAllByTestId('user-card');
    fireEvent.click(screen.getByRole('button', { name: /^Next$/ }));
    fireEvent.click(screen.getByRole('button', { name: /^Next$/ }));
    expect(screen.getByText('101-101 of 101')).toBeInTheDocument();

    banned = entries(100);
    await act(async () => { await client.invalidateQueries({ queryKey: ['banned-users'] }); });
    expect(await screen.findByText('51-100 of 100')).toBeInTheDocument();

    banned = entries(101);
    await act(async () => { await client.invalidateQueries({ queryKey: ['banned-users'] }); });
    expect(await screen.findByText('51-100 of 101')).toBeInTheDocument();
  });

  it('returns to page one when the environment changes', async () => {
    serve(entries(120));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    const tree = (relayUrl: string) => (
      <AppContext.Provider value={{ config: { relayUrl } as never, updateConfig: vi.fn() }}>
        <QueryClientProvider client={client}>
          <TooltipProvider><UserManagement selectedPubkey={PUBKEY} /></TooltipProvider>
        </QueryClientProvider>
      </AppContext.Provider>
    );
    const { rerender } = render(tree('wss://one.test'));
    await screen.findAllByTestId('user-card');
    fireEvent.click(screen.getByRole('button', { name: /^Next$/ }));
    expect(screen.getByText('51-100 of 120')).toBeInTheDocument();
    fireEvent.change(screen.getByRole('searchbox', { name: /search banned users/i }), { target: { value: hex(77).slice(-4) } });
    await waitFor(() => expect(screen.getAllByTestId('user-card')).toHaveLength(1));
    expect(screen.queryByText(/of 120/)).not.toBeInTheDocument();

    rerender(tree('wss://two.test'));

    expect(await screen.findByText('1-50 of 120')).toBeInTheDocument();
    expect(screen.getByRole('searchbox', { name: /search banned users/i })).toHaveValue('');
  });

  describe('pager accessibility', () => {
    const scrollIntoView = vi.fn();
    const originalScroll = Element.prototype.scrollIntoView;
    beforeEach(() => {
      scrollIntoView.mockClear();
      Element.prototype.scrollIntoView = scrollIntoView;
    });
    afterEach(() => { Element.prototype.scrollIntoView = originalScroll; });

    it('is a labelled navigation landmark with plain buttons and a polite range line', async () => {
      serve(entries(120));
      renderWithProvider();
      await screen.findAllByTestId('user-card');
      const nav = screen.getByRole('navigation', { name: /banned users pages/i });
      expect(within(nav).getByRole('button', { name: /^Next$/ })).toHaveAttribute('type', 'button');
      expect(within(nav).getByRole('button', { name: /^Previous$/ })).toHaveAttribute('type', 'button');
      expect(within(nav).getByText('1-50 of 120')).toHaveAttribute('aria-live', 'polite');
    });

    it('labels the Suspended pager separately', async () => {
      serve([], entries(120));
      renderWithProvider();
      fireEvent.mouseDown(await screen.findByRole('tab', { name: /Suspended Users/i }));
      await screen.findAllByTestId('user-card');
      expect(screen.getByRole('navigation', { name: /suspended users pages/i })).toBeInTheDocument();
    });

    it('scrolls the list to its top when the page changes, but not on first render', async () => {
      serve(entries(120));
      renderWithProvider();
      await screen.findAllByTestId('user-card');
      expect(scrollIntoView).not.toHaveBeenCalled();
      fireEvent.click(screen.getByRole('button', { name: /^Next$/ }));
      expect(scrollIntoView).toHaveBeenCalledTimes(1);
    });

    it('hands focus to Next when Previous reaches the first page', async () => {
      serve(entries(120));
      renderWithProvider();
      await screen.findAllByTestId('user-card');
      fireEvent.click(screen.getByRole('button', { name: /^Next$/ }));
      screen.getByRole('button', { name: /^Previous$/ }).focus();
      fireEvent.click(screen.getByRole('button', { name: /^Previous$/ }));
      expect(screen.getByRole('button', { name: /^Previous$/ })).toBeDisabled();
      await waitFor(() => expect(screen.getByRole('button', { name: /^Next$/ })).toHaveFocus());
    });

    it('hands focus over without scrolling the page back down', async () => {
      serve(entries(120));
      renderWithProvider();
      await screen.findAllByTestId('user-card');
      fireEvent.click(screen.getByRole('button', { name: /^Next$/ }));
      const focus = vi.spyOn(HTMLElement.prototype, 'focus');
      fireEvent.click(screen.getByRole('button', { name: /^Next$/ }));
      await waitFor(() => expect(screen.getByRole('button', { name: /^Previous$/ })).toHaveFocus());
      expect(focus).toHaveBeenCalledWith({ preventScroll: true });
      focus.mockClear();
      fireEvent.click(screen.getByRole('button', { name: /^Previous$/ }));
      fireEvent.click(screen.getByRole('button', { name: /^Previous$/ }));
      await waitFor(() => expect(screen.getByRole('button', { name: /^Next$/ })).toHaveFocus());
      expect(focus).toHaveBeenCalledWith({ preventScroll: true });
      focus.mockRestore();
    });

    it('moves focus to the other button when the clicked one becomes disabled', async () => {
      serve(entries(120));
      renderWithProvider();
      await screen.findAllByTestId('user-card');
      fireEvent.click(screen.getByRole('button', { name: /^Next$/ }));
      screen.getByRole('button', { name: /^Next$/ }).focus();
      fireEvent.click(screen.getByRole('button', { name: /^Next$/ }));
      expect(screen.getByRole('button', { name: /^Next$/ })).toBeDisabled();
      await waitFor(() => expect(screen.getByRole('button', { name: /^Previous$/ })).toHaveFocus());
    });
  });

  describe('search', () => {
    const npubOf = (i: number) => nip19.npubEncode(hex(i));
    const search = () => screen.getByRole('searchbox', { name: /search banned users/i });
    const type = (el: HTMLElement, value: string) => fireEvent.change(el, { target: { value } });

    it('filters by a hex pubkey fragment', async () => {
      serve(entries(120));
      renderWithProvider();
      await screen.findAllByTestId('user-card');
      type(search(), hex(77).slice(-4));
      await waitFor(() => expect(pubkeysShown()).toEqual([hex(77)]));
    });

    it('accepts a full npub and matches its hex', async () => {
      serve(entries(120));
      renderWithProvider();
      await screen.findAllByTestId('user-card');
      type(search(), npubOf(88));
      await waitFor(() => expect(pubkeysShown()).toEqual([hex(88)]));
    });

    it('filters by reason, ignoring case', async () => {
      serve([{ pubkey: hex(1), reason: 'Comment SPAM' }, { pubkey: hex(2), reason: 'harassment' }]);
      renderWithProvider();
      await screen.findAllByTestId('user-card');
      type(search(), 'spam');
      await waitFor(() => expect(pubkeysShown()).toEqual([hex(1)]));
    });

    it('filters by a display name already in the profile cache', async () => {
      serve(entries(3));
      const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
      client.setQueryData(['author', hex(2), ''], { metadata: { display_name: 'Zebra Fan' }, isFunnelcakeUser: true });
      renderWithProvider(client);
      await screen.findAllByTestId('user-card');
      type(search(), 'zebra');
      await waitFor(() => expect(pubkeysShown()).toEqual([hex(2)]));
    });

    it('makes no list request, and pages the filtered result', async () => {
      const list = [
        ...Array.from({ length: 60 }, (_, i) => ({ pubkey: hex(i + 1), reason: 'spam' })),
        { pubkey: hex(500), reason: 'other' },
      ];
      serve(list);
      renderWithProvider();
      await screen.findAllByTestId('user-card');
      await act(async () => {});
      const rpcCalls = api.callRelayRpc.mock.calls.length;

      type(search(), 'spam');
      expect(await screen.findByText('1-50 of 60')).toBeInTheDocument();
      fireEvent.click(screen.getByRole('button', { name: /^Next$/ }));
      expect(pubkeysShown()).toHaveLength(10);
      expect(api.callRelayRpc.mock.calls.length).toBe(rpcCalls);
    });

    it('returns to page one when the filter changes', async () => {
      serve(entries(120));
      renderWithProvider();
      await screen.findAllByTestId('user-card');
      fireEvent.click(screen.getByRole('button', { name: /^Next$/ }));
      type(search(), '0');
      expect(await screen.findByText(/^1-50 of /)).toBeInTheDocument();
    });

    it('says when nothing matches', async () => {
      serve(entries(3));
      renderWithProvider();
      await screen.findAllByTestId('user-card');
      type(search(), 'nomatchanywhere');
      expect(await screen.findByText('No accounts match')).toBeInTheDocument();
      expect(screen.queryAllByTestId('user-card')).toHaveLength(0);
    });

    it('searches the Suspended tab independently', async () => {
      serve(entries(3), [{ pubkey: hex(9), reason: 'x' }, { pubkey: hex(10), reason: 'y' }]);
      renderWithProvider();
      fireEvent.mouseDown(await screen.findByRole('tab', { name: /Suspended Users/i }));
      await screen.findAllByTestId('user-card');
      type(screen.getByRole('searchbox', { name: /search suspended users/i }), hex(10).slice(-3));
      await waitFor(() => expect(pubkeysShown()).toEqual([hex(10)]));
    });
    it('matches an uppercase hex pubkey and an uppercase reason', async () => {
      serve([{ pubkey: hex(171), reason: 'comment spam' }, { pubkey: hex(2), reason: 'other' }]);
      renderWithProvider();
      await screen.findAllByTestId('user-card');
      type(search(), '  ' + hex(171).slice(-4).toUpperCase() + ' ');
      await waitFor(() => expect(pubkeysShown()).toEqual([hex(171)]));
      type(search(), 'SPAM');
      await waitFor(() => expect(pubkeysShown()).toEqual([hex(171)]));
    });

    it('waits for typing to pause before it swaps the cards', async () => {
      serve(entries(120));
      renderWithProvider();
      await screen.findAllByTestId('user-card');
      cardMounts.log.length = 0;

      type(search(), hex(77).slice(-5, -1));
      type(search(), hex(77).slice(-4));
      expect(pubkeysShown()).toHaveLength(50);
      expect(cardMounts.log).toEqual([]);

      await waitFor(() => expect(pubkeysShown()).toEqual([hex(77)]));
      // Only the settled filter mounted cards, not each keystroke's.
      expect(cardMounts.log).toEqual([hex(77)]);
    });

    it('applies the filter only after 250 ms of quiet', async () => {
      serve(entries(120));
      renderWithProvider();
      await screen.findAllByTestId('user-card');
      vi.useFakeTimers();
      try {
        type(search(), hex(77).slice(-4));
        act(() => { vi.advanceTimersByTime(200); });
        expect(pubkeysShown()).toHaveLength(50);
        // Another keystroke restarts the wait.
        type(search(), hex(77).slice(-4) + ' ');
        act(() => { vi.advanceTimersByTime(200); });
        expect(pubkeysShown()).toHaveLength(50);
        act(() => { vi.advanceTimersByTime(60); });
        expect(pubkeysShown()).toEqual([hex(77)]);
      } finally {
        vi.useRealTimers();
      }
    });

    it('does not scroll the list away from the search box while typing', async () => {
      const scrollIntoView = vi.fn();
      const original = Element.prototype.scrollIntoView;
      Element.prototype.scrollIntoView = scrollIntoView;
      onTestFinished(() => { Element.prototype.scrollIntoView = original; });
      serve(entries(120));
      renderWithProvider();
      await screen.findAllByTestId('user-card');
      fireEvent.click(screen.getByRole('button', { name: /^Next$/ }));
      scrollIntoView.mockClear();

      type(search(), hex(77).slice(-4));
      await waitFor(() => expect(pubkeysShown()).toEqual([hex(77)]));

      expect(scrollIntoView).not.toHaveBeenCalled();
    });

    it('announces the match count, and when nothing matches, outside the pager', async () => {
      serve([
        ...Array.from({ length: 60 }, (_, i) => ({ pubkey: hex(i + 1), reason: 'spam' })),
        { pubkey: hex(500), reason: 'other' },
      ]);
      renderWithProvider();
      await screen.findAllByTestId('user-card');
      const status = screen.getByRole('status');
      expect(status).toBeEmptyDOMElement();

      // Over a page of matches the pager's range line speaks; this line stays quiet.
      type(search(), 'spam');
      expect(await screen.findByText('1-50 of 60')).toBeInTheDocument();
      expect(status).toBeEmptyDOMElement();

      type(search(), hex(30).slice(-4));
      await waitFor(() => expect(status).toHaveTextContent(/^1 match$/));

      type(search(), 'nomatchanywhere');
      await waitFor(() => expect(status).toHaveTextContent('No accounts match'));
    });
  });
});
