// ABOUTME: Pins how resolved history is paged: cursor to cursor, only while shown, one relay at a time.
// ABOUTME: And that nothing re-reads loaded pages on a timer or on window focus.

import { act, renderHook, waitFor } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider, useInfiniteQuery } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ResolvedReportsPage } from '@/lib/adminApi';
import { RESOLVED_HISTORY_PAGE_SIZE, useResolvedHistory } from './useResolvedHistory';

const fetchResolvedReportsPage = vi.hoisted(() => vi.fn());
vi.mock('@/hooks/useAdminApi', () => ({ useAdminApi: () => ({ fetchResolvedReportsPage }) }));

// Spy on the real hook to read the options history asks for.
vi.mock('@tanstack/react-query', async (orig) => {
  const actual = await orig<typeof import('@tanstack/react-query')>();
  return { ...actual, useInfiniteQuery: vi.fn(actual.useInfiniteQuery) };
});

const RELAY_A = 'wss://relay-a.example';
const RELAY_B = 'wss://relay-b.example';

function page(ids: string[], nextCursor: number | null, done: boolean): ResolvedReportsPage {
  return {
    events: ids.map((id, i) => ({
      id, pubkey: 'p', created_at: 1751000000 - i, kind: 1984, tags: [], content: '', sig: '',
    })),
    nextCursor,
    done,
    skippedWithinSecond: false,
    resolutionTruncated: false,
  };
}

function wrapper() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, retryDelay: 0 } } });
  return ({ children }: { children: ReactNode }) => createElement(QueryClientProvider, { client }, children);
}

beforeEach(() => {
  fetchResolvedReportsPage.mockReset();
  vi.mocked(useInfiniteQuery).mockClear();
});

describe('useResolvedHistory', () => {
  it('reads the first page without a cursor, then each next page from the cursor before it', async () => {
    fetchResolvedReportsPage
      .mockResolvedValueOnce(page(['a', 'b'], 1751000500, false))
      .mockResolvedValueOnce(page(['c'], null, true));
    const { result } = renderHook(() => useResolvedHistory(RELAY_A, true), { wrapper: wrapper() });

    await waitFor(() => expect(result.current.data?.pages).toHaveLength(1));
    expect(fetchResolvedReportsPage).toHaveBeenNthCalledWith(1, { cursor: undefined, limit: RESOLVED_HISTORY_PAGE_SIZE });
    expect(result.current.hasNextPage).toBe(true);

    await act(async () => { await result.current.fetchNextPage(); });
    expect(fetchResolvedReportsPage).toHaveBeenNthCalledWith(2, { cursor: 1751000500, limit: RESOLVED_HISTORY_PAGE_SIZE });
    // fetchNextPage()'s own promise already resolves with both pages, but the
    // hook's rendered result lags it by a microtask or two in this React
    // 18 + RTL 16 + TanStack Query 5 combination -- act() alone does not
    // reliably flush it. waitFor polls past that lag instead of asserting on
    // a render that has not landed yet.
    await waitFor(() => expect(result.current.data?.pages).toHaveLength(2));
    expect(result.current.hasNextPage).toBe(false);
  });

  it("offers no next page when a page leaves no cursor, and keeps that page's word on whether history ended", async () => {
    fetchResolvedReportsPage.mockResolvedValueOnce(page(['a'], null, false));
    const { result } = renderHook(() => useResolvedHistory(RELAY_A, true), { wrapper: wrapper() });

    await waitFor(() => expect(result.current.data?.pages).toHaveLength(1));
    expect(result.current.hasNextPage).toBe(false);
    expect(result.current.data?.pages[0].done).toBe(false);
  });

  it('reads nothing while the history view is closed', async () => {
    renderHook(() => useResolvedHistory(RELAY_A, false), { wrapper: wrapper() });
    await new Promise(resolve => setTimeout(resolve, 50));

    expect(fetchResolvedReportsPage).not.toHaveBeenCalled();
  });

  it("never shows one relay's pages under another", async () => {
    fetchResolvedReportsPage.mockResolvedValueOnce(page(['a'], null, true));
    const { result, rerender } = renderHook(
      ({ relay }) => useResolvedHistory(relay, true),
      { wrapper: wrapper(), initialProps: { relay: RELAY_A } },
    );
    await waitFor(() => expect(result.current.data?.pages).toHaveLength(1));

    // Relay B's first read never answers, so whatever shows meanwhile is not B's.
    fetchResolvedReportsPage.mockReturnValueOnce(new Promise(() => {}));
    rerender({ relay: RELAY_B });
    await waitFor(() => expect(fetchResolvedReportsPage).toHaveBeenCalledTimes(2));

    expect(result.current.data).toBeUndefined();
  });

  // A timer or a focus refetch would re-read every loaded page. New work
  // reaches the screen through the queue's own poll.
  it('is never re-read on a timer', () => {
    renderHook(() => useResolvedHistory(RELAY_A, false), { wrapper: wrapper() });
    const options = vi.mocked(useInfiniteQuery).mock.calls[0][0];

    expect(options).not.toHaveProperty('refetchInterval');
  });

  it('is never re-read on window focus', () => {
    renderHook(() => useResolvedHistory(RELAY_A, false), { wrapper: wrapper() });
    const options = vi.mocked(useInfiniteQuery).mock.calls[0][0];

    expect(options.refetchOnWindowFocus).toBe(false);
  });
});
