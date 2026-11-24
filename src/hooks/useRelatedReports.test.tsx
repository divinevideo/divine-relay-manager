// ABOUTME: Pins that the Related Reports split is not recomputed when only the identity of
// ABOUTME: the target object changes: the pane rebuilds it on every render.

import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider, focusManager } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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

beforeEach(() => {
  fetchByTarget.mockReset();
  fetchByTarget.mockResolvedValue({ events: [], truncated: false });
});

describe('useRelatedReports', () => {
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
  afterEach(() => focusManager.setFocused(undefined));

  it('asks the worker once, even when the tab regains focus', async () => {
    fetchByTarget.mockRejectedValue(new Error('relay timed out'));
    const client = new QueryClient({ defaultOptions: { queries: { retryDelay: 0, refetchOnWindowFocus: true } } });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
    const { result } = renderHook(
      () => useRelatedReports('e'.repeat(64), { type: 'event', value: '2'.repeat(64) }),
      { wrapper },
    );
    await waitFor(() => expect(result.current.status).toBe('error'));
    expect(fetchByTarget).toHaveBeenCalledTimes(1);

    await act(async () => {
      focusManager.setFocused(false);
      focusManager.setFocused(true);
    });
    expect(fetchByTarget).toHaveBeenCalledTimes(1);
  });
});
