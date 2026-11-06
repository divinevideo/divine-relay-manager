// ABOUTME: DebugPanel's Ban Pubkey keeps the shared authored-content state honest:
// ABOUTME: a ban that landed ends a "just restored" window, a failed one only resets.

import { act, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DebugPanel } from './DebugPanel';
import { markRestored, useJustRestored } from '@/lib/userStatsCache';

const api = vi.hoisted(() => ({
  getWorkerInfo: vi.fn(),
  banPubkey: vi.fn(),
  unbanPubkey: vi.fn(),
  listBannedPubkeys: vi.fn(),
  listBannedEvents: vi.fn(),
  getAllDecisions: vi.fn(),
  callRelayRpc: vi.fn(),
  logDecision: vi.fn(),
  verifyPubkeyBanned: vi.fn(),
  verifyPubkeyUnbanned: vi.fn(),
}));
vi.mock('@/hooks/useAdminApi', () => ({ useAdminApi: () => api }));
vi.mock('@/hooks/useToast', () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock('@/hooks/useCurrentUser', () => ({
  useCurrentUser: () => ({ user: { pubkey: 'e'.repeat(64) }, getModeratorPubkey: async () => 'e'.repeat(64) }),
}));

function renderPanel() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(<QueryClientProvider client={client}><DebugPanel /></QueryClientProvider>);
  return client;
}

async function banFromPanel(pubkey: string) {
  fireEvent.change(screen.getByPlaceholderText('Enter 64-character hex pubkey...'), { target: { value: pubkey } });
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Ban Pubkey' })); });
}

describe('DebugPanel Ban Pubkey and the restore window', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.getWorkerInfo.mockResolvedValue({});
    api.listBannedPubkeys.mockResolvedValue([]);
    api.listBannedEvents.mockResolvedValue([]);
    api.getAllDecisions.mockResolvedValue({ decisions: [] });
    api.callRelayRpc.mockResolvedValue([]);
    api.logDecision.mockResolvedValue({ success: true });
    api.verifyPubkeyBanned.mockResolvedValue(true);
  });

  it('ends the window when the ban landed', async () => {
    const pk = '1e'.repeat(32);
    const { result } = renderHook(() => useJustRestored(pk));
    await act(async () => { await markRestored(new QueryClient(), pk, undefined); });
    api.banPubkey.mockResolvedValue({ unconfirmed: null });
    const client = renderPanel();
    client.setQueryData(['user-stats', 'wss://relay.test', pk], { postCount: 0 });

    await banFromPanel(pk);

    await waitFor(() => expect(result.current).toBe(false));
    expect(client.getQueryData(['user-stats', 'wss://relay.test', pk])).toBeUndefined();
  });

  it('only resets the reads when the ban failed', async () => {
    const pk = '2f'.repeat(32);
    const { result } = renderHook(() => useJustRestored(pk));
    await act(async () => { await markRestored(new QueryClient(), pk, undefined); });
    api.banPubkey.mockRejectedValue(new Error('relay unreachable'));
    const client = renderPanel();
    client.setQueryData(['user-stats', 'wss://relay.test', pk], { postCount: 0 });

    await banFromPanel(pk);

    await waitFor(() => expect(client.getQueryData(['user-stats', 'wss://relay.test', pk])).toBeUndefined());
    expect(result.current).toBe(true);
  });
});
