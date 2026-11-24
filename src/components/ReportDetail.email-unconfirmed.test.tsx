// ABOUTME: Pins that report detail shows the "Email not confirmed" chip for the reported user
// ABOUTME: and for each reporter, from the real account-status query, and only where it applies.

import { render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { TooltipProvider } from '@/components/ui/tooltip';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ReportDetail } from './ReportDetail';
import type { NostrEvent } from '@nostrify/nostrify';

const TARGET_EVENT = 'c'.repeat(64);
const REPORTED_PUBKEY = 'd'.repeat(64);
const MOD_PUBKEY = 'e'.repeat(64);

const REPORTER = 'a'.repeat(64);
const OTHER_REPORTER = '8'.repeat(64);
const getAccountStatus = vi.hoisted(() => vi.fn());
const unconfirmed = vi.hoisted(() => ({ pubkeys: new Set<string>() }));

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
    getAccountStatus,
  }),
  useApiUrl: () => 'https://api.test',
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
    refetch: vi.fn(),
  }),
}));
vi.mock('@/hooks/useModerationStatus', () => ({
  useModerationStatus: () => ({ isUserBanned: false, isEventGone: false, recheck: vi.fn() }),
}));
vi.mock('@/hooks/useBannedEvent', () => ({ useBannedEvent: () => ({ data: null, isLoading: false }) }));
vi.mock('@/hooks/useUserSummary', () => ({ useUserSummary: () => ({ data: null, isLoading: false, error: null }) }));
vi.mock('@/hooks/useMediaStatus', () => ({ useMediaStatus: () => ({ results: [] }) }));

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
  pubkey: REPORTER,
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
  pubkey: OTHER_REPORTER,
  created_at: 1750999000,
  tags: [['e', TARGET_EVENT], ['p', REPORTED_PUBKEY], ['client', 'Row App']],
  content: 'also spam',
};

function renderDetail(allReportsForTarget: NostrEvent[] | undefined) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <TooltipProvider>
        <ReportDetail report={REPORT} allReportsForTarget={allReportsForTarget} />
      </TooltipProvider>
    </QueryClientProvider>,
  );
}

const CHIP = 'Email not confirmed';

describe('ReportDetail email-not-confirmed chip', () => {
  beforeEach(() => {
    unconfirmed.pubkeys = new Set();
    getAccountStatus.mockReset();
    getAccountStatus.mockImplementation(async (pubkey: string) => ({
      success: true,
      status: 'active',
      ...(unconfirmed.pubkeys.has(pubkey) ? { email_unconfirmed: true } : {}),
    }));
  });

  it('shows it in the reported user panel, and nowhere else when only that account is unconfirmed', async () => {
    unconfirmed.pubkeys.add(REPORTED_PUBKEY);
    renderDetail([REPORT, OTHER_REPORT]);
    const panel = screen.getByText('Reported User').nextElementSibling as HTMLElement;
    expect(await within(panel).findByText(CHIP)).toBeInTheDocument();
    expect(screen.getAllByText(CHIP)).toHaveLength(1);
  });

  it('shows it on a reporter in "Why This Was Reported", only for the unconfirmed reporter', async () => {
    unconfirmed.pubkeys.add(OTHER_REPORTER);
    renderDetail([REPORT, OTHER_REPORT]);
    const reasons = screen.getByText(/^Why This Was Reported/).closest('.border-red-200') as HTMLElement;
    expect(await within(reasons).findByText(CHIP)).toBeInTheDocument();
    expect(within(reasons).getAllByText(CHIP)).toHaveLength(1);
    expect(screen.getAllByText(CHIP)).toHaveLength(1);
  });

  it('shows it on the reporter of the single-report card when there is no group list', async () => {
    unconfirmed.pubkeys.add(REPORTER);
    renderDetail(undefined);
    expect(await screen.findByText(CHIP)).toBeInTheDocument();
    expect(screen.getAllByText(CHIP)).toHaveLength(1);
  });

  it('shows no chip when no account is flagged', async () => {
    renderDetail([REPORT, OTHER_REPORT]);
    await waitFor(() => expect(getAccountStatus).toHaveBeenCalledWith(REPORTED_PUBKEY));
    // Reported user plus two reporters: all three lookups have settled.
    expect((await screen.findAllByText('Keycast active')).length).toBe(3);
    expect(screen.queryByText(CHIP)).not.toBeInTheDocument();
  });
});
