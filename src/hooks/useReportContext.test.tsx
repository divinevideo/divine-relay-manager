// ABOUTME: Tests that useReportContext leaves isFunnelcakeUser unresolved until the
// ABOUTME: profile lookup answers, so report detail shows no relay-profile badge early (#132).

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import type { NostrEvent } from '@nostrify/nostrify';
import { useReportContext } from './useReportContext';

vi.mock('@nostrify/react', () => ({ useNostr: () => ({ nostr: { query: async () => [] } }) }));
vi.mock('@/hooks/useAppContext', () => ({ useAppContext: () => ({ config: { apiUrl: 'https://api.example.test' } }) }));
vi.mock('@/hooks/useThread', () => ({ useThread: () => ({ data: undefined, isLoading: false, error: null }) }));
vi.mock('@/hooks/useUserStats', () => ({ useUserStats: () => ({ data: undefined, isLoading: false, error: null }) }));

const authorState = vi.hoisted(() => ({
  result: { data: undefined, isLoading: true, error: null } as {
    data: { isFunnelcakeUser: boolean } | undefined;
    isLoading: boolean;
    error: null;
  },
}));
vi.mock('@/hooks/useAuthor', () => ({ useAuthor: () => authorState.result }));

const report: NostrEvent = {
  id: '1'.repeat(64),
  pubkey: 'a'.repeat(64),
  kind: 1984,
  content: '',
  tags: [['p', 'b'.repeat(64), 'spam']],
  created_at: 1_750_000_000,
  sig: 'f'.repeat(128),
};

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

beforeEach(() => {
  authorState.result = { data: undefined, isLoading: true, error: null };
});

describe('useReportContext isFunnelcakeUser', () => {
  it('is unresolved while the profile lookup is in flight', () => {
    const { result } = renderHook(() => useReportContext(report), { wrapper });
    expect(result.current.reportedUser.isFunnelcakeUser).toBeUndefined();
    expect(result.current.reporter.isFunnelcakeUser).toBeUndefined();
  });

  it('carries the lookup answer once it arrives', () => {
    authorState.result = { data: { isFunnelcakeUser: false }, isLoading: false, error: null };
    const { result } = renderHook(() => useReportContext(report), { wrapper });
    expect(result.current.reportedUser.isFunnelcakeUser).toBe(false);
    expect(result.current.reporter.isFunnelcakeUser).toBe(false);
  });
});
