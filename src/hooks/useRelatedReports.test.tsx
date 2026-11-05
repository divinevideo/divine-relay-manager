// ABOUTME: Pins that the Related Reports split is not recomputed when only the identity of
// ABOUTME: the target object changes: the pane rebuilds it on every render.

import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { useRelatedReports } from './useRelatedReports';

const split = vi.hoisted(() => vi.fn());

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
  useAdminApi: () => ({ fetchReportsByTarget: async () => ({ events: [], truncated: false }) }),
}));
vi.mock('@/hooks/useAppContext', () => ({
  useAppContext: () => ({ config: { apiUrl: 'https://api.example' } }),
}));

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
