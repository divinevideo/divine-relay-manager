// ABOUTME: Settings recent-events count reads a full-table relay scan: cached across remounts,
// ABOUTME: refreshed only by an explicit button, and that button is off without a relay

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClientProvider } from '@tanstack/react-query';
import { createQueryClient } from '@/lib/queryClient';
import { SettingsDashboard } from './SettingsDashboard';

const rpc = vi.hoisted(() => ({ fn: vi.fn() }));
const cfg = vi.hoisted(() => ({ relayUrl: 'wss://relay.test' }));
vi.mock('@/hooks/useAdminApi', () => ({
  useAdminApi: () => ({
    callRelayRpc: rpc.fn,
    listBannedEvents: () => rpc.fn('listbannedevents'),
    getWorkerInfo: vi.fn().mockResolvedValue({}),
  }),
}));
vi.mock('@/hooks/useCurrentUser', () => ({ useCurrentUser: () => ({ user: undefined, getModeratorToken: () => undefined }) }));
vi.mock('@/hooks/useAuthor', () => ({ useAuthor: () => ({ data: undefined, isLoading: false }) }));
vi.mock('@/hooks/useNostr', () => ({ useNostr: () => ({ nostr: { query: vi.fn().mockResolvedValue([]) } }) }));
vi.mock('@/hooks/useAppContext', () => ({
  useAppContext: () => ({ config: { relayUrl: cfg.relayUrl, apiUrl: 'https://api.test', theme: 'light' }, updateConfig: vi.fn() }),
}));

const METHOD = 'listeventsneedingmoderation';
const scanCalls = () => rpc.fn.mock.calls.filter(c => c[0] === METHOD).length;
const refreshButton = () => screen.getByRole('button', { name: /refresh recent events count/i });

function mount(client = createQueryClient()) {
  return { client, ...render(<QueryClientProvider client={client}><SettingsDashboard /></QueryClientProvider>) };
}

beforeEach(() => {
  cfg.relayUrl = 'wss://relay.test';
  rpc.fn.mockReset();
  rpc.fn.mockImplementation(async (m: string) => (m === METHOD ? [{ id: 'a'.repeat(64) }, { id: 'b'.repeat(64) }] : []));
});

describe('SettingsDashboard pending moderation', () => {
  it('labels the count as recent events, not a review queue', async () => {
    mount();
    expect(await screen.findByText('Recent events (up to 100)')).toBeInTheDocument();
    expect(screen.queryByText(/Pending Moderation/i)).toBeNull();
    expect(screen.getByTitle(/suspended, or deactivated accounts.*no approval tracking/i)).toBeInTheDocument();
  });

  it('does not rescan on remount after the cached count has aged', async () => {
    const first = mount();
    await waitFor(() => expect(refreshButton()).toBeEnabled());
    expect(scanCalls()).toBe(1);
    first.unmount();
    const later = Date.now() + 11 * 60_000;
    const clock = vi.spyOn(Date, 'now').mockReturnValue(later);
    try {
      mount(first.client);
    } finally {
      clock.mockRestore();
    }
    expect(scanCalls()).toBe(1);
  });

  it('does not rescan when the count query is invalidated', async () => {
    const { client } = mount();
    await waitFor(() => expect(refreshButton()).toBeEnabled());
    expect(scanCalls()).toBe(1);
    await act(async () => {
      await client.invalidateQueries({ queryKey: ['events-needing-moderation'] });
    });
    expect(scanCalls()).toBe(1);
  });

  it('rescans on an explicit refresh', async () => {
    mount();
    await waitFor(() => expect(scanCalls()).toBe(1));
    await waitFor(() => expect(refreshButton()).not.toBeDisabled());
    fireEvent.click(refreshButton());
    await waitFor(() => expect(scanCalls()).toBe(2));
  });

  it('disables refresh and makes no call without a relayUrl', async () => {
    cfg.relayUrl = '';
    await act(async () => { mount(); });
    expect(scanCalls()).toBe(0);
    expect(refreshButton()).toBeDisabled();
  });
});
