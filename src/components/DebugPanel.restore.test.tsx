// ABOUTME: DebugPanel's Ban Pubkey keeps the shared authored-content state honest:
// ABOUTME: a ban that landed ends a "just restored" window, a failed one only resets.

import { act, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DebugPanel } from './DebugPanel';
import { markRestored, useJustRestored } from '@/lib/userStatsCache';
import { BanNotConfirmedError } from '@/lib/adminApi';
import { withAsModerator } from '@/test/adminApiMock';

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
// Ban and unban go through asModerator(token) since #178 phase 2.
const moderatorApi = withAsModerator(api);
vi.mock('@/hooks/useAdminApi', () => ({ useAdminApi: () => moderatorApi }));
vi.mock('@/hooks/useToast', () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock('@/hooks/useCurrentUser', () => ({
  useCurrentUser: () => ({ user: { pubkey: 'e'.repeat(64) }, getModeratorToken: () => 'moderator-login-token' }),
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

  // It may have landed, so "just restored" could be wrong: the window ends.
  it('ends the window when the ban could not be confirmed', async () => {
    const pk = '5c'.repeat(32);
    const { result } = renderHook(() => useJustRestored(pk));
    await act(async () => { await markRestored(new QueryClient(), pk, undefined); });
    api.banPubkey.mockRejectedValue(new BanNotConfirmedError('timed out'));
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

  // A ban usually purged the posts, so "posts can take a few minutes to
  // reappear" would mislead: a successful unban resets the reads and opens no
  // restore window. The audit is held pending, so the reset has to come
  // before it settles.
  it('resets the reads after a successful unban, before the audit write settles, and opens no window', async () => {
    const pk = '3a'.repeat(32);
    const { result } = renderHook(() => useJustRestored(pk));
    api.unbanPubkey.mockResolvedValue({ success: true });
    let settleAudit: (v: unknown) => void = () => {};
    api.logDecision.mockImplementation(() => new Promise(r => { settleAudit = r; }));
    const client = renderPanel();
    client.setQueryData(['user-stats', 'wss://relay.test', pk], { postCount: 0 });

    fireEvent.change(screen.getByPlaceholderText('Enter 64-character hex pubkey...'), { target: { value: pk } });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Unban Pubkey' })); });

    await waitFor(() => expect(api.logDecision).toHaveBeenCalled());
    expect(client.getQueryData(['user-stats', 'wss://relay.test', pk])).toBeUndefined();
    expect(result.current).toBe(false);
    await act(async () => { settleAudit({ success: true }); });
  });

  it('only resets the reads when the unban failed', async () => {
    const pk = '4b'.repeat(32);
    const { result } = renderHook(() => useJustRestored(pk));
    api.unbanPubkey.mockRejectedValue(new Error('relay unreachable'));
    const client = renderPanel();
    client.setQueryData(['user-stats', 'wss://relay.test', pk], { postCount: 0 });

    fireEvent.change(screen.getByPlaceholderText('Enter 64-character hex pubkey...'), { target: { value: pk } });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Unban Pubkey' })); });

    await waitFor(() => expect(client.getQueryData(['user-stats', 'wss://relay.test', pk])).toBeUndefined());
    expect(result.current).toBe(false);
  });
});
