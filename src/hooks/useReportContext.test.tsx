// ABOUTME: Tests that useReportContext leaves isFunnelcakeUser unresolved until the
// ABOUTME: profile lookup answers, so report detail shows no relay-profile badge early (#132).

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import type { NostrEvent } from '@nostrify/nostrify';
import { useReportContext } from './useReportContext';

vi.mock('@/hooks/useAppContext', () => ({ useAppContext: () => ({ config: { apiUrl: 'https://api.example.test' } }) }));
vi.mock('@/hooks/useThread', () => ({ useThread: () => ({ data: undefined, isLoading: false, error: null }) }));
vi.mock('@/hooks/useUserStats', () => ({ useUserStats: () => ({ data: undefined, isLoading: false, error: null }) }));

const authorState = vi.hoisted(() => ({
  /** A pubkey whose lookup is still in flight while every other one answers with `result`. */
  loadingFor: undefined as string | undefined,
  result: { data: undefined, isLoading: true, error: null } as {
    data: { isFunnelcakeUser: boolean } | undefined;
    isLoading: boolean;
    error: null;
  },
}));
vi.mock('@/hooks/useAuthor', () => ({
  useAuthor: (pubkey?: string) =>
    pubkey !== undefined && pubkey === authorState.loadingFor
      ? { data: undefined, isLoading: true, error: null }
      : authorState.result,
}));

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
  authorState.loadingFor = undefined;
  authorState.result = { data: undefined, isLoading: true, error: null };
});

describe('useReportContext isFunnelcakeUser', () => {
  it('is unresolved while the profile lookup is in flight', () => {
    const { result } = renderHook(() => useReportContext(report), { wrapper });
    expect(result.current.reportedUser.isFunnelcakeUser).toBeUndefined();
  });

  it('carries the lookup answer once it arrives', () => {
    authorState.result = { data: { isFunnelcakeUser: false }, isLoading: false, error: null };
    const { result } = renderHook(() => useReportContext(report), { wrapper });
    expect(result.current.reportedUser.isFunnelcakeUser).toBe(false);
  });
});

describe('useReportContext reported pubkey', () => {
  // Cases, decisions and the active-case lookup all hold pubkeys in lowercase,
  // so the account actions and the Age Review hand-off get the lowercase form
  // even when the report's p tag spells it in uppercase (#316).
  it('lowercases a p tag written in uppercase hex', () => {
    const pubkey = 'cd'.repeat(32);
    const upper = { ...report, tags: [['p', pubkey.toUpperCase(), 'spam']] };
    const { result } = renderHook(() => useReportContext(upper), { wrapper });
    expect(result.current.reportedUser.pubkey).toBe(pubkey);
  });

  it('leaves a p tag that is not a 64-character hex id as written', () => {
    const odd = { ...report, tags: [['p', 'Not-A-Pubkey', 'spam']] };
    const { result } = renderHook(() => useReportContext(odd), { wrapper });
    expect(result.current.reportedUser.pubkey).toBe('Not-A-Pubkey');
  });
});

describe('useReportContext isLoading', () => {
  // The reporter's profile isn't returned, but the pane still waits for it.
  it('waits for the reporter lookup even when the reported user has loaded', () => {
    authorState.loadingFor = report.pubkey;
    authorState.result = { data: { isFunnelcakeUser: false }, isLoading: false, error: null };
    const { result } = renderHook(() => useReportContext(report), { wrapper });
    expect(result.current.isLoading).toBe(true);
  });
});
