// ABOUTME: Tests that useReportContext leaves isFunnelcakeUser unresolved until the
// ABOUTME: profile lookup answers, so report detail shows no relay-profile badge early (#132).

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import type { NostrEvent } from '@nostrify/nostrify';
import { useReportContext } from './useReportContext';

vi.mock('@/hooks/useAppContext', () => ({ useAppContext: () => ({ config: { apiUrl: 'https://api.example.test' } }) }));
// What the thread read holds right now: a post, a read that found none, or no read.
const threadState = vi.hoisted(() => ({ event: undefined as NostrEvent | null | undefined }));
vi.mock('@/hooks/useThread', () => ({
  useThread: () => ({
    data: threadState.event === undefined ? undefined : { event: threadState.event, ancestors: [], replies: [] },
    isLoading: false,
    error: null,
  }),
}));
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
  threadState.event = undefined;
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

describe('useReportContext reported account after a re-read finds no post', () => {
  // Right after this tab suspends, bans or unsuspends the post's author, the
  // report pane reads the post again and the relay withholds it. The pane must
  // keep acting on the author it already read, not switch to the p tag.
  const POST_ID = '2'.repeat(64);
  const AUTHOR = '3'.repeat(64);
  const OTHER = '4'.repeat(64);
  const post: NostrEvent = { ...report, id: POST_ID, pubkey: AUTHOR, kind: 1, tags: [] };

  it.each([
    ['the p tag names another account', [['e', POST_ID], ['p', OTHER]]],
    ['the report has no p tag', [['e', POST_ID]]],
  ])('keeps the post\'s author when %s', (_, tags) => {
    const postReport = { ...report, tags };
    threadState.event = post;
    const { result, rerender } = renderHook(() => useReportContext(postReport), { wrapper });
    expect(result.current.reportedUser.pubkey).toBe(AUTHOR);

    threadState.event = null;
    rerender();
    expect(result.current.reportedUser.pubkey).toBe(AUTHOR);
  });

  it('keeps the author after the moderator opens a report on another post and comes back', () => {
    threadState.event = post;
    const first: NostrEvent = { ...report, tags: [['e', POST_ID], ['p', OTHER]] };
    let current = first;
    const { result, rerender } = renderHook(() => useReportContext(current), { wrapper });
    threadState.event = null;
    rerender();
    expect(result.current.reportedUser.pubkey).toBe(AUTHOR);

    // Another report, whose post is found and has another author.
    const elsewhere = '5'.repeat(64);
    threadState.event = { ...post, id: elsewhere, pubkey: '6'.repeat(64) };
    current = { ...report, tags: [['e', elsewhere]] };
    rerender();
    expect(result.current.reportedUser.pubkey).toBe('6'.repeat(64));

    // Back to the first: its read still holds no post.
    threadState.event = null;
    current = first;
    rerender();
    expect(result.current.reportedUser.pubkey).toBe(AUTHOR);
  });

  it('does not carry one report\'s author over to a report on another post', () => {
    threadState.event = post;
    let current: NostrEvent = { ...report, tags: [['e', POST_ID], ['p', OTHER]] };
    const { result, rerender } = renderHook(() => useReportContext(current), { wrapper });
    expect(result.current.reportedUser.pubkey).toBe(AUTHOR);

    // The pane is not keyed per report: the next report reuses this hook.
    threadState.event = null;
    current = { ...report, tags: [['e', '5'.repeat(64)], ['p', OTHER]] };
    rerender();
    expect(result.current.reportedUser.pubkey).toBe(OTHER);
  });
});
