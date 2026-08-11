// ABOUTME: Pins the user ban-status panel's three outcomes on a user report.
// ABOUTME: A check that could not answer must not render as "User is not banned".

import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { TooltipProvider } from '@/components/ui/tooltip';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ReportDetail } from './ReportDetail';
import type { NostrEvent } from '@nostrify/nostrify';

// This panel is the one place a user report states the relay's ban status as a
// sentence. It used to branch on `isUserBanned ? banned : checkedAt ? "not
// banned"`, so an inconclusive check — which now resolves null rather than the
// old fail-open true — fell into the negative branch and told the moderator
// "User is not banned. Checked: <time>" about a relay it never reached.

const REPORTED_PUBKEY = 'd'.repeat(64);
const MOD_PUBKEY = 'e'.repeat(64);
const CHECKED_AT = new Date('2026-08-10T12:00:00Z');

const status = vi.hoisted(() => ({
  value: {
    isUserBanned: null as boolean | null,
    isUserSuspended: false,
    isEventBanned: false,
    isEventGone: null as boolean | null,
    isLoading: false,
    isChecking: false,
    checkedAt: null as Date | null,
    recheck: vi.fn(),
  },
}));

vi.mock('react-router-dom', async (orig) => ({
  ...(await orig<typeof import('react-router-dom')>()),
  useNavigate: () => vi.fn(),
}));
vi.mock('@/hooks/useAdminApi', () => ({
  useAdminApi: () => ({
    deleteEvent: vi.fn(),
    allowEvent: vi.fn(),
    markAsReviewed: vi.fn(),
    logDecision: vi.fn(),
    deleteDecisions: vi.fn(),
  }),
}));
vi.mock('@/hooks/useToast', () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock('@/hooks/useCurrentUser', () => ({
  useCurrentUser: () => ({ user: { pubkey: MOD_PUBKEY }, getModeratorPubkey: async () => MOD_PUBKEY }),
}));
vi.mock('@/hooks/useAppContext', () => ({
  useAppContext: () => ({ config: { relayUrl: 'wss://relay.example' } }),
}));
vi.mock('@/hooks/useDecisionLog', () => ({
  useDecisionLog: () => ({
    hasDecisions: false,
    isPendingReview: false,
    isDeleted: false,
    isAutoHidden: false,
    isAutoHideRestored: false,
    decisions: [],
    latestDecision: null,
    refetch: vi.fn(),
  }),
}));
vi.mock('@/hooks/useModerationStatus', () => ({
  useModerationStatus: () => status.value,
}));
vi.mock('@/hooks/useBannedEvent', () => ({ useBannedEvent: () => ({ data: null, isLoading: false }) }));
vi.mock('@/hooks/useUserSummary', () => ({ useUserSummary: () => ({ data: null, isLoading: false }) }));
vi.mock('@/hooks/useMediaStatus', () => ({ useMediaStatus: () => ({}) }));

// A user report: no event target, which is the branch that renders this panel.
vi.mock('@/hooks/useReportContext', () => ({
  useReportContext: () => ({
    target: { type: 'pubkey', value: REPORTED_PUBKEY },
    thread: { event: undefined, ancestors: [], replies: [] },
    threadLoading: false,
    reportedUser: { profile: undefined, pubkey: REPORTED_PUBKEY, isFunnelcakeUser: false },
    userStats: undefined,
    reporter: { profile: undefined, pubkey: 'a'.repeat(64), reportCount: 0, isFunnelcakeUser: false },
    isLoading: false,
    error: null,
    relayHint: undefined,
    reportTags: REPORT.tags,
  }),
}));

vi.mock('@/components/ThreadContext', () => ({ ThreadContext: () => null }));
vi.mock('@/components/UserProfileCard', () => ({ UserProfileCard: () => null }));
vi.mock('@/components/AISummary', () => ({ AISummary: () => null }));
vi.mock('@/components/HiveAIReport', () => ({ HiveAIReport: () => null }));
vi.mock('@/components/AIDetectionReport', () => ({ AIDetectionReport: () => null }));
vi.mock('@/components/MediaPreview', () => ({ MediaPreview: () => null }));
vi.mock('@/components/ThreadModal', () => ({ ThreadModal: () => null }));
vi.mock('@/components/EventActions', () => ({ EventActions: () => null }));
vi.mock('@/components/UserActions', () => ({ UserActions: () => null }));
vi.mock('@/components/BulkDeleteByKind', () => ({ BulkDeleteByKind: () => null }));
vi.mock('@/components/ReporterCard', () => ({ ReporterInline: () => null }));
vi.mock('@/components/UserIdentifier', () => ({ UserIdentifier: () => null }));

const REPORT: NostrEvent = {
  id: 'f'.repeat(64),
  pubkey: 'a'.repeat(64),
  created_at: 1751000000,
  kind: 1984,
  tags: [['p', REPORTED_PUBKEY]],
  content: 'spam',
  sig: 'b'.repeat(128),
};

function renderDetail() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <TooltipProvider>
        <ReportDetail report={REPORT} />
      </TooltipProvider>
    </QueryClientProvider>,
  );
}

describe('ReportDetail user ban-status panel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    status.value = {
      isUserBanned: null,
      isUserSuspended: false,
      isEventBanned: false,
      isEventGone: null,
      isLoading: false,
      isChecking: false,
      checkedAt: CHECKED_AT,
      recheck: vi.fn(),
    };
  });

  it('says the user is banned when the check confirmed it', () => {
    status.value.isUserBanned = true;

    renderDetail();

    expect(screen.getByText('User is banned on the relay')).toBeInTheDocument();
  });

  it('says the user is not banned when the check completed and found nothing', () => {
    status.value.isUserBanned = false;

    renderDetail();

    expect(screen.getByText('User is not banned')).toBeInTheDocument();
  });

  it('says the status could not be checked when the check could not answer', () => {
    status.value.isUserBanned = null;

    renderDetail();

    expect(screen.getByText('Could not check ban status')).toBeInTheDocument();
    // The regression: null fell through to the negative branch and asserted a
    // ban list lookup that never happened.
    expect(screen.queryByText('User is not banned')).not.toBeInTheDocument();
  });
});
