// ABOUTME: Covers the WIRING of the age-review guard redirect in UserManagement.
// The shared hook's own tests pin the predicate; these pin that each mutation
// actually calls it, which is the failure mode that shipped once.

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { TooltipProvider } from '@/components/ui/tooltip';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { UserManagement } from './UserManagement';
import { ApiError } from '@/lib/adminApi';

const api = vi.hoisted(() => ({
  callRelayRpc: vi.fn(),
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
    api.logDecision.mockResolvedValue(undefined);
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
