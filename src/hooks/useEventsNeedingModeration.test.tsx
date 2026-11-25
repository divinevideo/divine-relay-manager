// ABOUTME: useEventsNeedingModeration wraps a full-table relay scan, so it must stay cheap:
// ABOUTME: off without an environment, with subsequent reads requested explicitly

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { createQueryClient } from '@/lib/queryClient';
import { useEventsNeedingModeration } from './useEventsNeedingModeration';

const rpc = vi.hoisted(() => ({ fn: vi.fn() }));
vi.mock('@/hooks/useAdminApi', () => ({ useAdminApi: () => ({ callRelayRpc: rpc.fn }) }));

beforeEach(() => {
  rpc.fn.mockReset();
  rpc.fn.mockResolvedValue([]);
});

function setup(relayUrl: string | undefined, client = createQueryClient()) {
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return { client, ...renderHook(() => useEventsNeedingModeration(relayUrl), { wrapper }) };
}

describe('useEventsNeedingModeration', () => {
  it('does not call the relay without a relayUrl', () => {
    const { result } = setup(undefined);
    expect(result.current.fetchStatus).toBe('idle');
    expect(rpc.fn).not.toHaveBeenCalled();
  });

  it('calls the relay once with a relayUrl', async () => {
    setup('wss://relay.test');
    await waitFor(() => expect(rpc.fn).toHaveBeenCalledTimes(1));
    expect(rpc.fn).toHaveBeenCalledWith('listeventsneedingmoderation');
  });

  it('retries a failed first load only when explicitly refreshed', async () => {
    rpc.fn.mockRejectedValueOnce(new Error('Relay unavailable'));
    const first = setup('wss://relay.test');
    await waitFor(() => expect(first.result.current.isError).toBe(true));
    expect(rpc.fn).toHaveBeenCalledTimes(1);
    first.unmount();

    const next = setup('wss://relay.test', first.client);
    expect(next.result.current.isError).toBe(true);
    expect(rpc.fn).toHaveBeenCalledTimes(1);

    await act(async () => { await next.result.current.refetch(); });
    await waitFor(() => expect(next.result.current.isSuccess).toBe(true));
    expect(rpc.fn).toHaveBeenCalledTimes(2);
  });
});
