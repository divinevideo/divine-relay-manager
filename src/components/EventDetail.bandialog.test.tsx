// ABOUTME: Pins the ban dialog's report-count sentence to the same source as
// ABOUTME: the stats row above it, so a destructive-action surface never shows two counts.

import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';
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

// The related-reports read is capped at 50 per filter. Returning exactly 50
// here means a bare `relatedReports.length` in the dialog would read "50",
// while the account's true history (userStats) is 80 -- the contradiction I2
// exists to remove.
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

vi.mock('@/hooks/useModerationStatus', () => ({
  useModerationStatus: () => ({
    isUserBanned: false,
    isUserSuspended: false,
    isEventBanned: false,
    isEventGone: false,
    isLoading: false,
    isChecking: false,
    checkedAt: null,
    recheck: vi.fn(),
  }),
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

describe('EventDetail ban dialog report count', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    userStatsData.reportCount = 80;
    userStatsData.reportsTruncated = false;
  });

  it('matches the stats row above it instead of the capped related-reports read', async () => {
    renderDetail();
    const dialog = await openBanDialog();

    // The stats row reads the account's full report history.
    expect(within(dialog).getByText('80 reports')).toBeInTheDocument();

    // The sentence below it must read the same number, not the 50-item
    // related-reports fixture.
    expect(within(dialog).getByText('This user has 80 reports against them')).toBeInTheDocument();
    expect(within(dialog).queryByText(/This user has 50 reports/)).not.toBeInTheDocument();
  });

  it('marks a report count that stopped early as a floor, in the dialog sentence too', async () => {
    userStatsData.reportCount = 991;
    userStatsData.reportsTruncated = true;

    renderDetail();
    const dialog = await openBanDialog();

    expect(within(dialog).getByText('991+ reports')).toBeInTheDocument();
    expect(within(dialog).getByText('This user has 991+ reports against them')).toBeInTheDocument();
  });

  it('hides the sentence when the account has no reports', async () => {
    userStatsData.reportCount = 0;
    userStatsData.reportsTruncated = false;

    renderDetail();
    const dialog = await openBanDialog();

    expect(within(dialog).getByText('0 reports')).toBeInTheDocument();
    expect(within(dialog).queryByText(/This user has/)).not.toBeInTheDocument();
  });
});
