// ABOUTME: Settings recent-events count reads a full-table relay scan: cached across remounts,
// ABOUTME: refreshed only by an explicit button, and that button is off without a relay

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClientProvider } from '@tanstack/react-query';
import { createQueryClient } from '@/lib/queryClient';
import { SettingsDashboard } from './SettingsDashboard';

const scan = vi.hoisted(() => vi.fn());
const cfg = vi.hoisted(() => ({ relayUrl: 'wss://relay.test' }));
vi.mock('@/hooks/useAdminApi', () => ({
  useAdminApi: () => ({
    callRelayRpc: async (method: string) => method === 'listeventsneedingmoderation' ? scan() : [],
    listBannedEvents: async () => [],
    getWorkerInfo: vi.fn().mockResolvedValue({}),
  }),
}));
vi.mock('@/hooks/useCurrentUser', () => ({ useCurrentUser: () => ({ user: undefined, getModeratorToken: () => undefined }) }));
vi.mock('@/hooks/useAuthor', () => ({ useAuthor: () => ({ data: undefined, isLoading: false }) }));
vi.mock('@/hooks/useNostr', () => ({ useNostr: () => ({ nostr: { query: vi.fn().mockResolvedValue([]) } }) }));
vi.mock('@/hooks/useAppContext', () => ({
  useAppContext: () => ({ config: { relayUrl: cfg.relayUrl, apiUrl: 'https://api.test', theme: 'light' }, updateConfig: vi.fn() }),
}));

const refreshButton = () => screen.getByRole('button', { name: /refresh recent events count/i });
const countTile = () => within(screen.getByText('Recent events (up to 100)').parentElement!);

function mount(client = createQueryClient()) {
  return { client, ...render(<QueryClientProvider client={client}><SettingsDashboard /></QueryClientProvider>) };
}

beforeEach(() => {
  cfg.relayUrl = 'wss://relay.test';
  scan.mockReset();
  scan.mockResolvedValue([{ id: 'a'.repeat(64) }, { id: 'b'.repeat(64) }]);
});

describe('SettingsDashboard recent events count', () => {
  it('labels the count as recent events, not a review queue', async () => {
    mount();
    expect(await screen.findByText('Recent events (up to 100)')).toBeInTheDocument();
    expect(screen.queryByText(/Pending Moderation/i)).toBeNull();
    expect(screen.getByTitle(/suspended, or deactivated accounts.*no approval tracking/i)).toBeInTheDocument();
  });

  it('does not rescan on remount after the cached count has aged', async () => {
    const first = mount();
    await waitFor(() => expect(refreshButton()).toBeEnabled());
    expect(scan).toHaveBeenCalledTimes(1);
    first.unmount();
    const later = Date.now() + 11 * 60_000;
    const clock = vi.spyOn(Date, 'now').mockReturnValue(later);
    try {
      mount(first.client);
    } finally {
      clock.mockRestore();
    }
    expect(scan).toHaveBeenCalledTimes(1);
  });

  it('does not rescan when the count query is invalidated', async () => {
    const { client } = mount();
    await waitFor(() => expect(refreshButton()).toBeEnabled());
    expect(scan).toHaveBeenCalledTimes(1);
    await act(async () => {
      await client.invalidateQueries({ queryKey: ['events-needing-moderation'] });
    });
    expect(scan).toHaveBeenCalledTimes(1);
  });

  it('updates the count on an explicit refresh', async () => {
    mount();
    expect(await countTile().findByText('2')).toBeInTheDocument();
    scan.mockResolvedValueOnce([{ id: 'a'.repeat(64) }]);
    fireEvent.click(refreshButton());
    expect(await countTile().findByText('1')).toBeInTheDocument();
    expect(scan).toHaveBeenCalledTimes(2);
  });

  it('distinguishes a failed first load from an empty count', async () => {
    scan.mockRejectedValueOnce(new Error('Relay unavailable'));
    mount();
    expect(await countTile().findByRole('status')).toHaveTextContent('Recent events count unavailable.');
    expect(countTile().queryByText('0')).toBeNull();
    expect(refreshButton()).toBeEnabled();
  });

  it('keeps the previous count and reports a failed refresh', async () => {
    mount();
    expect(await countTile().findByText('2')).toBeInTheDocument();
    scan.mockRejectedValueOnce(new Error('Relay unavailable'));
    fireEvent.click(refreshButton());
    expect(await countTile().findByRole('status')).toHaveTextContent('Refresh failed. Showing the last count.');
    expect(countTile().getByText('2')).toBeInTheDocument();
    expect(refreshButton()).toBeEnabled();
  });

  it('disables refresh and makes no call without a relayUrl', async () => {
    cfg.relayUrl = '';
    await act(async () => { mount(); });
    expect(scan).not.toHaveBeenCalled();
    expect(refreshButton()).toBeDisabled();
  });
});
