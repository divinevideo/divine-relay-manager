// ABOUTME: Pins EventDetail's two "N events" counts (author card and ban dialog) to
// ABOUTME: say unavailable, hidden by a suspension, or a floor, never a confident number.

import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NostrEvent } from '@nostrify/nostrify';
import { EventDetail } from './EventDetail';
import type { ModerationStatus } from '@/hooks/useModerationStatus';
import { moderationStatusMock } from '@/test/moderationStatusMock';
import { RECENT_AUTHORED_LIMIT } from '@/lib/constants';
import { markRestored, RESTORE_SETTLE_MS } from '@/lib/userStatsCache';

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

// The related-reports read is capped at 50 per filter. Returning exactly 50
// here means a bare `relatedReports.length` in the dialog would read "50",
// while the account's true history (userStats) is 80 -- the contradiction these
// tests exist to prevent.
function relatedReportEvents(count: number, pTagValue: string): NostrEvent[] {
  return Array.from({ length: count }, (_, i) => ({
    id: i.toString(16).padStart(64, '0'),
    pubkey: 'f'.repeat(64),
    created_at: 1_751_000_000 + i,
    kind: 1984,
    tags: [['p', pTagValue]],
    content: '',
    sig: 'a'.repeat(128),
  }));
}

vi.mock('@/hooks/useNostr', () => ({
  useNostr: () => ({
    nostr: {
      query: vi.fn().mockImplementation((filters: Array<{ '#p'?: string[]; '#e'?: string[] }>) => {
        const f = filters[0];
        if (f?.['#p']) return Promise.resolve(relatedReportEvents(50, REPORTED_PUBKEY));
        return Promise.resolve([]);
      }),
    },
  }),
}));

vi.mock('@/hooks/useAuthor', () => ({ useAuthor: () => ({ data: undefined, isLoading: false }) }));

const userStatsData = vi.hoisted(() => ({
  postCount: 12,
  reportCount: 80,
  labelCount: 0,
  recentPosts: [],
  existingLabels: [],
  previousReports: [],
  authoredContentIncomplete: false,
  labelsIncomplete: false,
  reportsIncomplete: false,
  reportsTruncated: false,
  labelsTruncated: false,
  relayIncomplete: false,
}));
vi.mock('@/hooks/useUserStats', () => ({
  useUserStats: () => ({ data: userStatsData, isLoading: false }),
}));

vi.mock('@/hooks/useAgeReviewGuardRedirect', () => ({
  useAgeReviewGuardRedirect: () => ({ redirectIfGuarded: () => false }),
}));

const status = vi.hoisted(() => ({ value: {} as ModerationStatus }));
vi.mock('@/hooks/useModerationStatus', () => ({
  useModerationStatus: () => status.value,
}));

vi.mock('@/components/HiveAIReport', () => ({ HiveAIReport: () => null }));
vi.mock('@/components/AIDetectionReport', () => ({ AIDetectionReport: () => null }));
vi.mock('@/components/SceneClassification', () => ({ SceneClassification: () => null }));
vi.mock('@/components/TranscriptAnalysis', () => ({ TranscriptAnalysis: () => null }));
vi.mock('@/components/ReporterCard', () => ({ ReporterList: () => null }));
vi.mock('@/components/MediaPreview', () => ({ MediaPreview: () => null }));
vi.mock('@/components/UserIdentifier', () => ({ UserIdentifier: () => null }));

const EVENT: NostrEvent = {
  id: 'c'.repeat(64),
  pubkey: REPORTED_PUBKEY,
  created_at: 1751000000,
  kind: 1,
  tags: [],
  content: 'reported content',
  sig: 'c'.repeat(128),
};

function renderDetail() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <EventDetail event={EVENT} />
    </QueryClientProvider>,
  );
}

async function openBanDialog() {
  const trigger = await screen.findByRole('button', { name: /^Ban User$/ });
  await act(async () => {
    fireEvent.click(trigger);
  });
  return screen.findByRole('alertdialog');
}

// Each test runs once against the author card (dialog closed, so its row is the
// only one) and once against the ban dialog's row.
const SITES = [
  { site: 'author card', scope: async () => document.body as HTMLElement },
  { site: 'ban dialog', scope: async () => openBanDialog() },
];

describe.each(SITES)('EventDetail events count in the $site', ({ scope }) => {
  beforeEach(() => {
    vi.clearAllMocks();
    userStatsData.postCount = 12;
    userStatsData.authoredContentIncomplete = false;
    status.value = moderationStatusMock();
  });

  it('prints a completed read as its count', async () => {
    renderDetail();
    expect(within(await scope()).getByText('12 events')).toBeInTheDocument();
  });

  it('does not print a failed authored-content read as zero', async () => {
    userStatsData.postCount = 0;
    userStatsData.authoredContentIncomplete = true;

    renderDetail();
    const area = await scope();

    expect(within(area).getByText('events unavailable')).toBeInTheDocument();
    expect(within(area).queryByText('0 events')).not.toBeInTheDocument();
  });

  it("says a suspended account's empty read is the suspension, not an empty account", async () => {
    userStatsData.postCount = 0;
    status.value.isUserSuspended = true;

    renderDetail();
    const area = await scope();

    expect(within(area).getByText('events hidden (account suspended)')).toBeInTheDocument();
    expect(within(area).queryByText('0 events')).not.toBeInTheDocument();
  });

  it('marks a suspension carried over from a list that could not be refreshed', async () => {
    userStatsData.postCount = 0;
    status.value.isUserSuspended = true;
    status.value.isUserSuspendedStale = true;

    renderDetail();

    expect(within(await scope()).getByText('events hidden (last known: suspended)')).toBeInTheDocument();
  });

  it("does not print an empty read as a confident zero when the suspension couldn't be checked", async () => {
    userStatsData.postCount = 0;
    status.value.isUserSuspended = null;

    renderDetail();
    const area = await scope();

    expect(within(area).getByText("0 events (couldn't check suspension)")).toBeInTheDocument();
    expect(within(area).queryByText('0 events')).not.toBeInTheDocument();
  });

  it('says it could not check the suspension when only the ban status is still loading', async () => {
    userStatsData.postCount = 0;
    status.value.isUserSuspended = null;
    status.value.isAccountStatusLoading = true;
    status.value.isUserSuspensionChecking = false;

    renderDetail();

    expect(within(await scope()).getByText("0 events (couldn't check suspension)")).toBeInTheDocument();
  });

  it('says the suspension is still being checked behind an empty read', async () => {
    userStatsData.postCount = 0;
    status.value.isUserSuspended = null;
    status.value.isUserSuspensionChecking = true;

    renderDetail();

    expect(within(await scope()).getByText('0 events (checking suspension)')).toBeInTheDocument();
  });

  it('qualifies an empty read just after this tab unsuspended the account', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      userStatsData.postCount = 0;
      await act(async () => { await markRestored(new QueryClient(), REPORTED_PUBKEY, undefined); });

      renderDetail();

      expect(within(await scope()).getByText('0 events (just restored; posts can take a few minutes to reappear)')).toBeInTheDocument();
      // End the window so it cannot reach the next test.
      await act(async () => { await vi.advanceTimersByTimeAsync(RESTORE_SETTLE_MS + 1); });
    } finally {
      vi.useRealTimers();
    }
  });

  it('marks a count that reached the read limit as a floor', async () => {
    userStatsData.postCount = RECENT_AUTHORED_LIMIT;

    renderDetail();

    expect(within(await scope()).getByText(`${RECENT_AUTHORED_LIMIT}+ events`)).toBeInTheDocument();
  });
});
