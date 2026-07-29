import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

const { req } = vi.hoisted(() => ({ req: vi.fn() }));
vi.mock('@nostrify/react', () => ({ useNostr: () => ({ nostr: { req } }) }));
vi.mock('@/hooks/useAppContext', () => ({
  useAppContext: () => ({ config: { relayUrl: 'wss://relay.test' } }),
}));

import { useUserStats } from './useUserStats';

const PUBKEY = 'd4'.repeat(32);

function post(id: string) {
  return { id, pubkey: PUBKEY, created_at: 2, kind: 1, tags: [], content: 'hi', sig: '' };
}

/** A completed read: events then EOSE. */
function completes(events: unknown[] = []) {
  return async function* () {
    for (const e of events) yield ['EVENT', 'sub', e];
    yield ['EOSE', 'sub'];
  };
}
/** A read the relay cut short. */
function closes() {
  return async function* () {
    yield ['CLOSED', 'sub', 'error: could not complete query'];
  };
}

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

const show = () => renderHook(() => useUserStats(PUBKEY), { wrapper });

beforeEach(() => vi.clearAllMocks());

describe('useUserStats', () => {
  it('reports a completed empty read as genuinely empty', async () => {
    req.mockImplementation(completes([]));
    const { result } = show();
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.postCount).toBe(0);
    expect(result.current.data?.relayIncomplete).toBe(false);
  });

  it('flags a read the relay closed, so a zero count is not read as absence', async () => {
    // The whole point: without this flag, postCount 0 from a failed read is
    // indistinguishable from an account that has posted nothing.
    req.mockImplementation(closes());
    const { result } = show();
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.postCount).toBe(0);
    expect(result.current.data?.relayIncomplete).toBe(true);
  });

  it('flags the result when only one of the three reads fails', async () => {
    req
      .mockImplementationOnce(completes([post('a')]))
      .mockImplementationOnce(closes())
      .mockImplementationOnce(completes([]));
    const { result } = show();
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.relayIncomplete).toBe(true);
  });

  it('does not disguise a programming error as a relay problem', async () => {
    // A TypeError from our own code must surface as a query error, not as
    // "relay error, retry" that no retry can ever clear.
    req.mockImplementation(() => { throw new TypeError('nostr.req is not a function'); });
    const { result } = show();
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.data).toBeUndefined();
  });
});
