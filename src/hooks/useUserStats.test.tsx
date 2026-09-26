import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

const { req } = vi.hoisted(() => ({ req: vi.fn() }));
vi.mock('@nostrify/react', () => ({ useNostr: () => ({ nostr: { req } }) }));
vi.mock('@/hooks/useAppContext', () => ({
  useAppContext: () => ({ config: { relayUrl: 'wss://relay.test' } }),
}));

import { useUserStats, HISTORY_PAGE_SIZE, HISTORY_MAX_PAGES } from './useUserStats';

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
    expect(result.current.data?.authoredContentIncomplete).toBe(false);
    expect(result.current.data?.labelsIncomplete).toBe(false);
    expect(result.current.data?.reportsIncomplete).toBe(false);
  });

  it('flags an authored-content read the relay closed, so a zero count is not read as absence', async () => {
    // The whole point: without this flag, postCount 0 from a failed read is
    // indistinguishable from an account that has posted nothing.
    req.mockImplementation(closes());
    const { result } = show();
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.postCount).toBe(0);
    expect(result.current.data?.relayIncomplete).toBe(true);
    expect(result.current.data?.authoredContentIncomplete).toBe(true);
  });

  it('keeps a label-only failure separate from authored-content completeness', async () => {
    req
      .mockImplementationOnce(completes([post('a')]))
      .mockImplementationOnce(closes())
      .mockImplementationOnce(completes([]));
    const { result } = show();
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.relayIncomplete).toBe(true);
    expect(result.current.data?.authoredContentIncomplete).toBe(false);
    expect(result.current.data?.labelsIncomplete).toBe(true);
    expect(result.current.data?.reportsIncomplete).toBe(false);
  });

  it('keeps a report-only failure separate from authored-content completeness', async () => {
    req
      .mockImplementationOnce(completes([]))
      .mockImplementationOnce(completes([]))
      .mockImplementationOnce(closes());
    const { result } = show();
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.relayIncomplete).toBe(true);
    expect(result.current.data?.authoredContentIncomplete).toBe(false);
    expect(result.current.data?.labelsIncomplete).toBe(false);
    expect(result.current.data?.reportsIncomplete).toBe(true);
  });

  it('does not disguise a programming error as a relay problem', async () => {
    // A TypeError from our own code must surface as a query error, not as
    // "relay error, retry" that no retry can ever clear.
    req.mockImplementation(() => { throw new TypeError('nostr.req is not a function'); });
    const { result } = show();
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.data).toBeUndefined();
  });

  // Reports and labels against an account are the answer to "has this target
  // been reported before?". They were capped at 50 and the cap was shown as
  // the total, which understated a heavily-reported account.
  function relayWith(reportCount: number) {
    const reports = Array.from({ length: reportCount }, (_, i) => ({
      id: i.toString(16).padStart(64, '0'), pubkey: 'f'.repeat(64), created_at: 1_760_000_000 - i,
      kind: 1984, tags: [['p', PUBKEY]], content: '', sig: '',
    }));
    return (filters: Array<{ kinds?: number[]; limit?: number; until?: number }>) => {
      const f = filters[0];
      const events = f.kinds?.includes(1984)
        ? reports.filter(e => f.until === undefined || e.created_at <= f.until).slice(0, f.limit)
        : [];
      return completes(events)();
    };
  }

  it('returns every report against an account, past the old cap of 50', async () => {
    req.mockImplementation(relayWith(150));
    const { result } = show();
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.reportCount).toBe(150);
    expect(result.current.data?.previousReports).toHaveLength(150);
    expect(result.current.data?.reportsTruncated).toBe(false);
  });

  it('says the history is partial when it stops before the relay runs out', async () => {
    req.mockImplementation(relayWith(HISTORY_PAGE_SIZE * HISTORY_MAX_PAGES + 50));
    const { result } = show();
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.reportsTruncated).toBe(true);
  });

  it('asks each page for the page size it treats as full', async () => {
    req.mockImplementation(relayWith(1));
    const { result } = show();
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    const reportFilters = req.mock.calls
      .map(call => (call[0] as Array<{ kinds?: number[]; limit?: number }>)[0])
      .filter(f => f.kinds?.includes(1984));
    expect(reportFilters[0].limit).toBe(HISTORY_PAGE_SIZE);
  });
});
