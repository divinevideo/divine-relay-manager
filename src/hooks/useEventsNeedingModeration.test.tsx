// ABOUTME: useEventsNeedingModeration wraps a full-table relay scan, so it must stay cheap:
// ABOUTME: off without an environment, cached 10 minutes, no retry/focus/reconnect refetch

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { createQueryClient } from '@/lib/queryClient';
import { useEventsNeedingModeration, EVENTS_NEEDING_MODERATION_STALE_MS } from './useEventsNeedingModeration';

const rpc = vi.hoisted(() => ({ fn: vi.fn() }));
vi.mock('@/hooks/useAdminApi', () => ({ useAdminApi: () => ({ callRelayRpc: rpc.fn }) }));

beforeEach(() => {
  rpc.fn.mockReset();
  rpc.fn.mockResolvedValue([]);
});

function setup(relayUrl: string | undefined) {
  const client = createQueryClient();
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return { client, ...renderHook(() => useEventsNeedingModeration(relayUrl), { wrapper }) };
}

describe('useEventsNeedingModeration', () => {
  it('does not call the relay without a relayUrl', async () => {
    const { result } = setup(undefined);
    await new Promise(r => setTimeout(r, 30));
    expect(rpc.fn).not.toHaveBeenCalled();
    expect(result.current.fetchStatus).toBe('idle');
  });

  it('calls the relay once with a relayUrl', async () => {
    setup('wss://relay.test');
    await waitFor(() => expect(rpc.fn).toHaveBeenCalledTimes(1));
    expect(rpc.fn).toHaveBeenCalledWith('listeventsneedingmoderation');
  });

  it('is cached 10 minutes, with no retry, focus or reconnect refetch', async () => {
    const { client } = setup('wss://relay.test');
    await waitFor(() => expect(rpc.fn).toHaveBeenCalled());
    const o = client.getQueryCache().find({ queryKey: ['events-needing-moderation', 'wss://relay.test'] })!.observers[0].options;
    expect(o.staleTime).toBeGreaterThanOrEqual(10 * 60_000);
    expect(EVENTS_NEEDING_MODERATION_STALE_MS).toBeGreaterThanOrEqual(10 * 60_000);
    expect(o.retry).toBe(false);
    expect(o.refetchOnWindowFocus).toBe(false);
    expect(o.refetchOnReconnect).toBe(false);
    expect(o.refetchInterval).toBe(false);
  });
});
