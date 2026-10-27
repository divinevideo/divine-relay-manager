// ABOUTME: Pins that EventDetail hides media by default when a related report is an old-build
// ABOUTME: CSAM report, and keeps it hidden until a complete read of its reports finds none.

import { act, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NostrEvent } from '@nostrify/nostrify';
import { EventDetail } from './EventDetail';

const REPORTED_PUBKEY = 'd'.repeat(64);
const MOD_PUBKEY = 'e'.repeat(64);

const api = vi.hoisted(() => ({
  banPubkey: vi.fn(),
  deleteEvent: vi.fn(),
  unbanPubkey: vi.fn(),
  restoreEvent: vi.fn(),
  verifyPubkeyBanned: vi.fn(),
  verifyPubkeyUnbanned: vi.fn(),
  verifyEventDeleted: vi.fn(),
  logDecision: vi.fn(),
}));

vi.mock('@/hooks/useAdminApi', () => ({ useAdminApi: () => api }));
vi.mock('@/hooks/useToast', () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock('@/hooks/useCurrentUser', () => ({
  useCurrentUser: () => ({
    user: { pubkey: MOD_PUBKEY },
    getModeratorPubkey: async () => MOD_PUBKEY,
  }),
}));
const reports = vi.hoisted(() => ({ value: [] as unknown[] }));
type RelayAnswer = (filters: Record<string, unknown>[], opts: { signal: AbortSignal }) => Promise<unknown[]>;
// How the relay answers each related-reports read. Unset, every read finishes
// at once with reports.value.
const relay = vi.hoisted(() => ({ answer: null as RelayAnswer | null }));
vi.mock('@/hooks/useNostr', () => ({
  useNostr: () => ({
    nostr: {
      query: vi.fn((filters: Record<string, unknown>[], opts: { signal: AbortSignal }) =>
        relay.answer ? relay.answer(filters, opts) : Promise.resolve(reports.value)),
    },
  }),
}));
vi.mock('@/hooks/useAuthor', () => ({ useAuthor: () => ({ data: undefined, isLoading: false }) }));
vi.mock('@/hooks/useUserStats', () => ({ useUserStats: () => ({ data: undefined, isLoading: false }) }));
vi.mock('@/hooks/useAgeReviewGuardRedirect', () => ({
  useAgeReviewGuardRedirect: () => ({ redirectIfGuarded: () => false }),
}));

const modStatus = vi.hoisted(() => ({
  isUserBanned: true as boolean | null,
  isUserBannedStale: false,
  isEventGone: false as boolean | null,
  isChecking: false,
  isUserBanChecking: false,
  isAccountStatusLoading: false,
  recheck: vi.fn(),
}));
vi.mock('@/hooks/useModerationStatus', async () => {
  const { moderationStatusMock } = await import('@/test/moderationStatusMock');
  return { useModerationStatus: () => moderationStatusMock({ ...modStatus }) };
});

vi.mock('@/components/HiveAIReport', () => ({ HiveAIReport: () => null }));
vi.mock('@/components/AIDetectionReport', () => ({ AIDetectionReport: () => null }));
vi.mock('@/components/SceneClassification', () => ({ SceneClassification: () => null }));
vi.mock('@/components/TranscriptAnalysis', () => ({ TranscriptAnalysis: () => null }));
vi.mock('@/components/ReporterCard', () => ({ ReporterList: () => null }));
// Stand-in that exposes showByDefault, so no media is ever loaded or fetched.
// 'null' is hidden because the reports are not known yet; 'false' is hidden
// because they are sensitive.
vi.mock('@/components/MediaPreview', () => ({
  MediaPreview: ({ showByDefault }: { showByDefault?: boolean | null }) => (
    <div data-testid="media" data-show={String(showByDefault)} />
  ),
}));
vi.mock('@/components/UserIdentifier', () => ({ UserIdentifier: () => null }));

const EVENT: NostrEvent = {
  id: 'c'.repeat(64),
  pubkey: REPORTED_PUBKEY,
  created_at: 1751000000,
  kind: 1,
  tags: [],
  content: 'clip https://example.invalid/clip.mp4',
  sig: 'c'.repeat(128),
};

function makeReport(tags: string[][], content: string): NostrEvent {
  return { id: 'f'.repeat(64), pubkey: 'a'.repeat(64), created_at: 1751000100, kind: 1984, tags, content, sig: 'b'.repeat(128) };
}
const OLD_BUILD = makeReport(
  [['e', EVENT.id, 'illegal'], ['p', REPORTED_PUBKEY, 'illegal'], ['client', 'diVine']],
  'CONTENT REPORT - NIP-56\nReason: csam\nDetails: x\n',
);
const PLAIN_ILLEGAL = makeReport([['e', EVENT.id, 'illegal'], ['p', REPORTED_PUBKEY, 'illegal']], 'bad');
const SPAM = makeReport([['e', EVENT.id, 'spam'], ['p', REPORTED_PUBKEY, 'spam']], 'buy now');

// The app's relay pool (NPool) resolves a query with whatever had arrived when
// its signal aborts, its own timeout included; it never rejects. This stands in
// for a read the relay never finishes.
function answerOnAbort(signal: AbortSignal, events: unknown[] = []): Promise<unknown[]> {
  return new Promise((resolve) => {
    if (signal.aborted) resolve(events);
    else signal.addEventListener('abort', () => resolve(events), { once: true });
  });
}

function renderDetail() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const view = render(
    <QueryClientProvider client={queryClient}>
      <EventDetail event={EVENT} />
    </QueryClientProvider>,
  );
  return { ...view, queryClient };
}

beforeEach(() => {
  vi.clearAllMocks();
  relay.answer = null;
  modStatus.isUserBanned = false;
  modStatus.isUserBannedStale = false;
  modStatus.isEventGone = false;
});

describe('EventDetail media gating by related reports', () => {

  it('hides media by default when a related report is an old-build CSAM report', async () => {
    reports.value = [OLD_BUILD];
    renderDetail();
    await screen.findByText('1 Related Report');
    await waitFor(() => expect(screen.getByTestId('media').dataset.show).toBe('false'));
  });

  it('keeps media shown for a bare illegal report (control)', async () => {
    reports.value = [PLAIN_ILLEGAL];
    renderDetail();
    await screen.findByText('1 Related Report');
    expect(screen.getByTestId('media').dataset.show).toBe('true');
  });
});

describe('EventDetail media before its reports are known', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  // Runs the reads' 3 s timeout, then the timer the query library uses to hand
  // the settled result to React.
  async function letReadsTimeOut() {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
      await vi.runOnlyPendingTimersAsync();
    });
  }

  it('starts with media hidden while the reports read is still out', () => {
    relay.answer = () => new Promise(() => {});
    renderDetail();
    // Checked straight after the first commit, not in waitFor: a browser starts
    // loading whatever media that commit mounts.
    expect(screen.getByTestId('media').dataset.show).toBe('null');
  });

  it('keeps media hidden when every reports read times out with nothing', async () => {
    vi.useFakeTimers();
    relay.answer = (_filters, { signal }) => answerOnAbort(signal);
    const { queryClient } = renderDetail();
    expect(queryClient.isFetching()).toBe(1);

    await letReadsTimeOut();

    expect(queryClient.isFetching()).toBe(0);
    expect(screen.getByTestId('media').dataset.show).toBe('null');
  });

  it('lists what a timed-out read found, and keeps media hidden', async () => {
    vi.useFakeTimers();
    // The read for the event finishes with a spam report; the read for the
    // account never does.
    relay.answer = (filters, { signal }) =>
      filters[0]['#e'] ? Promise.resolve([SPAM]) : answerOnAbort(signal);
    renderDetail();

    await letReadsTimeOut();

    expect(screen.getByText('1 Related Report')).toBeInTheDocument();
    expect(screen.getByTestId('media').dataset.show).toBe('null');
  });

  it('shows media once every read has finished and found only spam', async () => {
    reports.value = [SPAM];
    renderDetail();
    await screen.findByText('1 Related Report');
    expect(screen.getByTestId('media').dataset.show).toBe('true');
  });
});
