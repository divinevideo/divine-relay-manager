// ABOUTME: Pins where report detail names the app a report says it was filed from:
// ABOUTME: the header for the selected report, and each entry under "Why This Was Reported" (#132).

import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { TooltipProvider } from '@/components/ui/tooltip';
import { describe, expect, it, vi } from 'vitest';
import { ReportDetail } from './ReportDetail';
import type { NostrEvent } from '@nostrify/nostrify';

const TARGET_EVENT = 'c'.repeat(64);
const REPORTED_PUBKEY = 'd'.repeat(64);
const MOD_PUBKEY = 'e'.repeat(64);


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
vi.mock('@/hooks/useUserSummary', () => ({ useUserSummary: () => ({ data: null, isLoading: false, error: null }) }));
vi.mock('@/hooks/useMediaStatus', () => ({ useMediaStatus: () => ({}) }));

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
    userStats: { reportsIncomplete: false, labelsIncomplete: false },
    reporter: { profile: undefined, pubkey: 'a'.repeat(64), isFunnelcakeUser: false },
    isLoading: false,
    error: null,
    relayHint: undefined,
    reportTags: REPORT.tags,
  }),
}));

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
  tags: [['e', TARGET_EVENT], ['p', REPORTED_PUBKEY], ['client', 'Header App']],
  content: 'spam',
  sig: 'b'.repeat(128),
};

// A second report on the same target, filed from a different app.
const OTHER_REPORT: NostrEvent = {
  ...REPORT,
  id: '9'.repeat(64),
  pubkey: '8'.repeat(64),
  created_at: 1750999000,
  tags: [['e', TARGET_EVENT], ['p', REPORTED_PUBKEY], ['client', 'Row App']],
  content: 'also spam',
};

function renderDetail(allReportsForTarget: NostrEvent[]) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <TooltipProvider>
        <ReportDetail report={REPORT} allReportsForTarget={allReportsForTarget} />
      </TooltipProvider>
    </QueryClientProvider>,
  );
}

describe('ReportDetail reporting app', () => {
  it("names the selected report's app in the header beside the report time", () => {
    renderDetail([REPORT, OTHER_REPORT]);
    const header = screen.getByText(/^Reported:/).parentElement!;
    expect(header).toHaveTextContent('Filed via Header App');
    expect(header).not.toHaveTextContent('Row App');
  });

  it('names each report\'s app on its entry under "Why This Was Reported"', () => {
    renderDetail([REPORT, OTHER_REPORT]);
    const reasons = screen.getByText(/^Why This Was Reported/).closest('.border-red-200')!;
    expect(reasons).toHaveTextContent('Filed via Header App');
    expect(reasons).toHaveTextContent('Filed via Row App');
  });

  it('says no app is named for a report without a client tag', () => {
    const unnamed = { ...OTHER_REPORT, tags: [['e', TARGET_EVENT], ['p', REPORTED_PUBKEY]] };
    renderDetail([REPORT, unnamed]);
    const reasons = screen.getByText(/^Why This Was Reported/).closest('.border-red-200')!;
    expect(reasons).toHaveTextContent('No app named');
  });
});
