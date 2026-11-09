// ABOUTME: Pins what the moderation queue re-reads after approving an event.
// ABOUTME: An approve is a restore, so the banned-events list must re-read, as after a ban.

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EventModeration } from './EventModeration';

const PENDING_ID = 'c'.repeat(64);
const MOD_PUBKEY = 'e'.repeat(64);

const api = vi.hoisted(() => ({
  callRelayRpc: vi.fn(),
  banEvent: vi.fn(),
  restoreEvent: vi.fn(),
  verifyEventDeleted: vi.fn(),
}));

vi.mock('@/hooks/useAdminApi', () => ({ useAdminApi: () => api }));
vi.mock('@/hooks/useToast', () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock('@/hooks/useCurrentUser', () => ({
  useCurrentUser: () => ({ getModeratorPubkey: async () => MOD_PUBKEY }),
}));
vi.mock('@/hooks/useRelayBanLists', () => ({
  useBannedEvents: () => ({ data: [], isLoading: false, error: null }),
}));
vi.mock('@/components/EventActions', () => ({ EventActions: () => null }));

beforeEach(() => {
  vi.clearAllMocks();
  api.callRelayRpc.mockResolvedValue([{ id: PENDING_ID, reason: 'flagged' }]);
  api.restoreEvent.mockResolvedValue({ success: true, recorded: true, reconciled: true });
});

describe('EventModeration approve', () => {
  // Report detail and the event viewer read a post's ban status from this
  // list; without a re-read they keep calling an approved post banned.
  it('re-reads the banned-events list after approving an event', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    const invalidate = vi.spyOn(qc, 'invalidateQueries');
    render(
      <QueryClientProvider client={qc}>
        <EventModeration />
      </QueryClientProvider>,
    );

    fireEvent.click(await screen.findByRole('button', { name: /approve/i }));

    await waitFor(() => expect(api.restoreEvent).toHaveBeenCalled());
    await waitFor(() => expect(invalidate).toHaveBeenCalledWith({ queryKey: ['banned-events'] }));
  });
});
