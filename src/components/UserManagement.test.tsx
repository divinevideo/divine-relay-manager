// ABOUTME: Covers the WIRING of the age-review guard redirect in UserManagement.
// The shared hook's own tests pin the predicate; these pin that each mutation
// actually calls it, which is the failure mode that shipped once.

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { TooltipProvider } from '@/components/ui/tooltip';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { UserManagement } from './UserManagement';
import { ApiError, BanNotConfirmedError } from '@/lib/adminApi';
import { banFailureToast, banSuccessNote } from '@/lib/banFeedback';

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
vi.mock('@/hooks/useAdminApi', () => ({ useAdminApi: () => api }));
vi.mock('@/hooks/useToast', () => ({ useToast: () => ({ toast }) }));
const MOD_PUBKEY = 'e'.repeat(64);
vi.mock('@/hooks/useCurrentUser', () => ({
  useCurrentUser: () => ({ user: { pubkey: MOD_PUBKEY }, getModeratorPubkey: async () => MOD_PUBKEY }),
}));
// UserIdentifier resolves profiles through Nostr; irrelevant to guard wiring.
vi.mock('@nostrify/react', () => ({
  useNostr: () => ({ nostr: { query: vi.fn().mockResolvedValue([]) } }),
}));
vi.mock('@/hooks/useAppContext', () => ({ useAppContext: () => ({ config: {}, updateConfig: vi.fn() }) }));
// Children are irrelevant here and drag in their own dependencies.
vi.mock('@/components/UserActions', () => ({ UserActions: () => null }));
// Render the action affordances it is handed, so the remove/unsuspend wiring
// is reachable; everything else about the card is irrelevant here.
vi.mock('@/components/BannedUserCard', () => ({
  BannedUserCard: ({ actionButton, onUnban }: { actionButton?: React.ReactNode; onUnban?: () => void }) => (
    <div>
      {actionButton}
      {onUnban ? <button onClick={onUnban}>Unban</button> : null}
    </div>
  ),
}));

const PUBKEY = 'a'.repeat(64);

const guardRefusal = () => new ApiError('under age review', 409, 'Conflict', 'age_review_active');

function renderWithProvider() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
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
