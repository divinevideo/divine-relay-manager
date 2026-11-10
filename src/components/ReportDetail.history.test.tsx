// ABOUTME: Pins how the report pane states an account history it could not read whole:
// ABOUTME: a cut-short report list is a floor ("N+"), a failed read withholds the AI summary,
// ABOUTME: and a report on an item handled before lists that item's dated handling (#324).

import { render, screen, within } from '@testing-library/react';
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
  target: { type: 'event', value: 'c'.repeat(64) } as { type: 'event' | 'pubkey'; value: string },
  userStats: undefined as { reportsIncomplete: boolean; labelsIncomplete: boolean } | undefined,
  summary: { data: null as { summary: string; riskLevel: 'low' } | null, isLoading: false, error: null as Error | null },
}));

// The account-type label has its own tests; here it would need the account-status query.
vi.mock('@/components/AccountTypeBadge', () => ({ AccountTypeLabel: () => null }));
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
  useCurrentUser: () => ({ user: { pubkey: MOD_PUBKEY }, getModeratorToken: () => 'moderator-login-token' }),
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
vi.mock('@/hooks/useMediaStatus', () => ({ useMediaStatus: () => ({ results: [] }) }));

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
    target: history.target,
    thread: { event: TARGET_EVENT_OBJ, ancestors: [], replies: [] },
    threadLoading: false,
    reportedUser: { profile: undefined, pubkey: REPORTED_PUBKEY, isFunnelcakeUser: false },
    userStats: history.userStats,
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

function renderDetail(props: {
  allReportsForTarget?: NostrEvent[];
  allReportsForTargetTruncated?: boolean;
  handledBeforeHistory?: { action: string; at: number | null }[];
} = {}) {
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
  history.target = { type: 'event', value: TARGET_EVENT };
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

describe('ReportDetail overflow line under the report list', () => {
  const reports = (n: number): NostrEvent[] =>
    Array.from({ length: n }, (_, i) => ({ ...REPORT, id: (i + 1).toString(16).padStart(64, '0') }));

  it('says "report" for exactly one more, on a read that finished', () => {
    renderDetail({ allReportsForTarget: reports(6), allReportsForTargetTruncated: false });

    expect(screen.getByText('+1 more report')).toBeInTheDocument();
  });

  it('says "reports" for several more, on a read that finished', () => {
    renderDetail({ allReportsForTarget: reports(7), allReportsForTargetTruncated: false });

    expect(screen.getByText('+2 more reports')).toBeInTheDocument();
  });

  it('puts the floor mark on the count, and stays plural, on a read that stopped early', () => {
    renderDetail({ allReportsForTarget: reports(6), allReportsForTargetTruncated: true });

    expect(screen.getByText('1+ more reports')).toBeInTheDocument();
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

// #324: a report that came after its target was handled shows that handling,
// dated, so the moderator sees what was decided before and when.
describe('ReportDetail history for a report on an item handled before', () => {
  const day = (at: number) => new Date(at * 1000).toLocaleDateString();
  const HISTORY = [
    { action: 'reopened', at: 1751500000 },
    { action: 'unban_user', at: 1751400000 },
    { action: 'resolution_label', at: 1751300000 },
    { action: 'ban_user', at: null },
  ];
  const PROMPT = "This account was handled before. Does this report, with the account's current state, change the call?";

  it('titles the card Handled before and lists every entry with its date', () => {
    renderDetail({ handledBeforeHistory: HISTORY });

    const card = screen.getByText('Handled before').closest('.rounded-lg') as HTMLElement;
    expect(card).not.toBeNull();
    const rows = within(card).getAllByTestId('handled-before-entry');
    expect(rows.map(r => r.textContent)).toEqual([
      `reopened${day(1751500000)}`,
      `unban user${day(1751400000)}`,
      `resolution label${day(1751300000)}`,
      'ban userdate unknown',
    ]);
    // A post is not an account: no account prompt.
    expect(screen.queryByText(PROMPT)).not.toBeInTheDocument();
  });

  it('asks for a fresh look at an account', () => {
    history.target = { type: 'pubkey', value: REPORTED_PUBKEY };
    renderDetail({ handledBeforeHistory: HISTORY });

    expect(screen.getByText('Handled before')).toBeInTheDocument();
    expect(screen.getByText(PROMPT)).toBeInTheDocument();
  });

  it('shows no such card for any other report', () => {
    history.target = { type: 'pubkey', value: REPORTED_PUBKEY };
    renderDetail();

    expect(screen.queryByText('Handled before')).not.toBeInTheDocument();
    expect(screen.queryByText(PROMPT)).not.toBeInTheDocument();
  });
});
