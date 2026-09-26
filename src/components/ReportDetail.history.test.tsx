// ABOUTME: Pins how the report pane states an account history it could not read whole:
// ABOUTME: a cut-short report list is a floor ("N+"), and a failed read withholds the AI summary.

import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { TooltipProvider } from '@/components/ui/tooltip';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ReportDetail } from './ReportDetail';
import type { NostrEvent } from '@nostrify/nostrify';

const TARGET_EVENT = 'c'.repeat(64);
const REPORTED_PUBKEY = 'd'.repeat(64);
const MOD_PUBKEY = 'e'.repeat(64);

// Mutable per test: which half of the account history failed to read, and
// what the summary hook would otherwise hand back.
const history = vi.hoisted(() => ({
  userStats: undefined as { reportsIncomplete: boolean; labelsIncomplete: boolean } | undefined,
  summary: { data: null as { summary: string; riskLevel: 'low' } | null, isLoading: false, error: null as Error | null },
}));

vi.mock('react-router-dom', async (orig) => ({
  ...(await orig<typeof import('react-router-dom')>()),
  useNavigate: () => vi.fn(),
}));
vi.mock('@/hooks/useAdminApi', () => ({
  useAdminApi: () => ({
    deleteEvent: vi.fn(),
    restoreEvent: vi.fn(),
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
  useModerationStatus: () => ({ isUserBanned: false, isEventGone: false, recheck: vi.fn() }),
}));
vi.mock('@/hooks/useBannedEvent', () => ({ useBannedEvent: () => ({ data: null, isLoading: false }) }));
vi.mock('@/hooks/useUserSummary', () => ({ useUserSummary: () => history.summary }));
vi.mock('@/hooks/useMediaStatus', () => ({ useMediaStatus: () => ({}) }));

// An event report whose content loaded, the branch that renders the AI summary.
const TARGET_EVENT_OBJ: NostrEvent = {
  id: TARGET_EVENT,
  pubkey: REPORTED_PUBKEY,
  created_at: 1751000100,
  kind: 1,
  tags: [],
  content: 'reported content',
  sig: 'c'.repeat(128),
};
vi.mock('@/hooks/useReportContext', () => ({
  useReportContext: () => ({
    target: { type: 'event', value: TARGET_EVENT },
    thread: { event: TARGET_EVENT_OBJ, ancestors: [], replies: [] },
    threadLoading: false,
    reportedUser: { profile: undefined, pubkey: REPORTED_PUBKEY, isFunnelcakeUser: false },
    userStats: history.userStats,
    reporter: { profile: undefined, pubkey: 'a'.repeat(64), reportCount: 0, isFunnelcakeUser: false },
    isLoading: false,
    error: null,
    relayHint: undefined,
    reportTags: REPORT.tags,
  }),
}));

// AISummary stays real: its rendered state is what these tests read.
vi.mock('@/components/ThreadContext', () => ({ ThreadContext: () => null }));
vi.mock('@/components/UserProfileCard', () => ({ UserProfileCard: () => null }));
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
  tags: [['e', TARGET_EVENT], ['p', REPORTED_PUBKEY]],
  content: 'spam',
  sig: 'b'.repeat(128),
};

function renderDetail(props: { allReportsForTarget?: NostrEvent[]; allReportsForTargetTruncated?: boolean } = {}) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <TooltipProvider>
        <ReportDetail report={REPORT} {...props} />
      </TooltipProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  history.userStats = { reportsIncomplete: false, labelsIncomplete: false };
  history.summary = { data: null, isLoading: false, error: null };
});

describe('ReportDetail report-count header', () => {
  // One report is enough: the floor mark must also force the plural, since
  // "1+" means one or more.
  it('marks the count as a floor when the target lookup was cut short', () => {
    renderDetail({ allReportsForTarget: [REPORT], allReportsForTargetTruncated: true });

    expect(screen.getByText('Why This Was Reported (1+ reports)')).toBeInTheDocument();
  });

  it('states the count plainly when the lookup read everything', () => {
    renderDetail({ allReportsForTarget: [REPORT], allReportsForTargetTruncated: false });

    expect(screen.getByText('Why This Was Reported (1 report)')).toBeInTheDocument();
  });
});

describe('ReportDetail AI summary with an unreadable account history', () => {
  // A summary built from a history the read could not finish would describe
  // an account with fewer reports than it has. Say so instead.
  it('withholds a summary when the report history could not be read', () => {
    history.userStats = { reportsIncomplete: true, labelsIncomplete: false };
    history.summary = { data: { summary: 'No concerning history.', riskLevel: 'low' }, isLoading: false, error: null };

    renderDetail();

    expect(screen.getByText('AI summary unavailable')).toBeInTheDocument();
    expect(screen.queryByText('No concerning history.')).not.toBeInTheDocument();
  });

  it('shows unavailable rather than loading when the label history could not be read', () => {
    history.userStats = { reportsIncomplete: false, labelsIncomplete: true };
    history.summary = { data: null, isLoading: true, error: null };

    renderDetail();

    expect(screen.getByText('AI summary unavailable')).toBeInTheDocument();
    expect(screen.queryByText('Generating summary...')).not.toBeInTheDocument();
  });
});
