// ABOUTME: Pins that the Related Reports split is not recomputed when only the identity of
// ABOUTME: the target object changes: the pane rebuilds it on every render.

import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useRelatedReports } from './useRelatedReports';

const split = vi.hoisted(() => vi.fn());
const fetchByTarget = vi.hoisted(() => vi.fn());

vi.mock('@/lib/relatedReports', async (orig) => {
  const actual = await orig<typeof import('@/lib/relatedReports')>();
  return {
    ...actual,
    splitRelatedReports: (...args: Parameters<typeof actual.splitRelatedReports>) => {
      split(...args);
      return actual.splitRelatedReports(...args);
    },
  };
});
vi.mock('@/hooks/useAdminApi', () => ({
  useAdminApi: () => ({ fetchReportsByTarget: fetchByTarget }),
}));
vi.mock('@/hooks/useAppContext', () => ({
  useAppContext: () => ({ config: { apiUrl: 'https://api.example' } }),
}));

describe('useRelatedReports', () => {
  beforeEach(() => {
    fetchByTarget.mockReset();
    fetchByTarget.mockResolvedValue({ events: [], truncated: false });
  });

  it('does not split the read again for an equal target that is a new object', async () => {
    const client = new QueryClient();
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
    const { result, rerender } = renderHook(
      () => useRelatedReports('d'.repeat(64), { type: 'event', value: '1'.repeat(64) }),
      { wrapper },
    );
    await waitFor(() => expect(result.current.status).toBe('ready'));
    const calls = split.mock.calls.length;

    rerender();
    rerender();

    expect(split.mock.calls.length).toBe(calls);
  });
});

// Each read is a full relay walk for the account; a retry re-runs it while the
// relay is still running the abandoned one. The card's Try again is the
// recovery. The client inherits React Query's default retry, so removing
// `retry: false` from the hook makes this go red.
describe('useRelatedReports does not retry a failed read', () => {
  it('asks the worker once', async () => {
    fetchByTarget.mockRejectedValue(new Error('relay timed out'));
    const client = new QueryClient({ defaultOptions: { queries: { retryDelay: 0 } } });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
    const { result } = renderHook(
      () => useRelatedReports('e'.repeat(64), { type: 'event', value: '2'.repeat(64) }),
      { wrapper },
    );
    await waitFor(() => expect(result.current.status).toBe('error'));
    await new Promise(resolve => setTimeout(resolve, 50));
    // Only this test's account: an earlier test's client can still be settling.
    const mine = fetchByTarget.mock.calls.filter(([t]) => t.pubkey === 'e'.repeat(64));
    expect(mine).toHaveLength(1);
  });
});
