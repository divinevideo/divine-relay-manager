// ABOUTME: Pins that the report pane gives Related Reports the reported account and the open
// ABOUTME: report's target, so the card reads the right account and leaves the open report out.

import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { TooltipProvider } from '@/components/ui/tooltip';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ReportDetail } from './ReportDetail';
import type { NostrEvent } from '@nostrify/nostrify';
import type { ModerationStatus } from '@/hooks/useModerationStatus';
import { moderationStatusMock } from '@/test/moderationStatusMock';

const REPORTED_PUBKEY = 'd'.repeat(64);
const MOD_PUBKEY = 'e'.repeat(64);
const LIST_EVENT_ID = 'c'.repeat(64);
const LIST_EVENT = vi.hoisted(() => ({
  value: {
    id: 'c'.repeat(64),
    pubkey: 'd'.repeat(64),
    created_at: 1751000000,
    kind: 30005,
    tags: [['d', 'faves'], ['title', 'Best skate clips'], ['description', 'Only the good ones']],
    content: '',
    sig: 'b'.repeat(128),
  } as NostrEvent,
}));

// Set in beforeEach; tests change single fields.
const status = vi.hoisted(() => ({ value: {} as ModerationStatus }));

vi.mock('react-router-dom', async (orig) => ({
  ...(await orig<typeof import('react-router-dom')>()),
  useNavigate: () => vi.fn(),
}));
const fetchReportsByTarget = vi.hoisted(() => vi.fn());
vi.mock('@/hooks/useAdminApi', () => ({
  useAdminApi: () => ({
    deleteEvent: vi.fn(),
    restoreEvent: vi.fn(),
    markAsReviewed: vi.fn(),
    logDecision: vi.fn(),
    deleteDecisions: vi.fn(),
    fetchReportsByTarget,
  }),
}));
vi.mock('@/hooks/useToast', () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock('@/hooks/useCurrentUser', () => ({
  useCurrentUser: () => ({ user: { pubkey: MOD_PUBKEY }, getModeratorPubkey: async () => MOD_PUBKEY }),
}));
vi.mock('@/hooks/useAppContext', () => ({
  useAppContext: () => ({ config: { relayUrl: 'wss://relay.example', apiUrl: 'https://api.example' } }),
}));
// The decision log the reported list's id returns. Empty by default.
const decisionRows = vi.hoisted(() => ({
  value: [] as { id: number; action: string; reason: string | null; created_at: string }[],
  handling: false,
}));
vi.mock('@/hooks/useDecisionLog', () => ({
  useDecisionLog: () => ({
    hasDecisions: decisionRows.value.length > 0,
    hasHandlingDecisions: decisionRows.handling,
    latestHandlingDecision: decisionRows.handling
      ? decisionRows.value.find(row => !row.action.startsWith('auto_hide_'))
      : undefined,
    isPendingReview: false,
    isDeleted: false,
    isAutoHidden: false,
    isAutoHideRestored: false,
    decisions: decisionRows.value,
    latestDecision: decisionRows.value[0] ?? null,
    refetch: vi.fn(),
  }),
}));
vi.mock('@/hooks/useModerationStatus', () => ({
  useModerationStatus: () => status.value,
}));
vi.mock('@/hooks/useBannedEvent', () => ({ useBannedEvent: () => ({ data: null, isLoading: false }) }));
vi.mock('@/hooks/useUserSummary', () => ({ useUserSummary: () => ({ data: null, isLoading: false }) }));
vi.mock('@/hooks/useMediaStatus', () => ({ useMediaStatus: () => ({}) }));

const reportTarget = vi.hoisted(() => ({
  value: { type: 'event', value: 'c'.repeat(64) } as { type: string; value: string },
}));
vi.mock('@/hooks/useReportContext', () => ({
  useReportContext: () => ({
    target: reportTarget.value,
    thread: { event: LIST_EVENT.value, ancestors: [], replies: [] },
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
  tags: [['e', LIST_EVENT_ID], ['p', REPORTED_PUBKEY], ['a', `30005:${REPORTED_PUBKEY}:faves`]],
  content: 'harassment',
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

describe('ReportDetail Related Reports wiring', () => {
  beforeEach(() => {
    fetchReportsByTarget.mockReset();
    status.value = moderationStatusMock({ isUserBanned: false, isEventGone: false });
    decisionRows.value = [];
    decisionRows.handling = false;
  });

  it("reads the reported account's reports and leaves the open report's target out", async () => {
    const other: NostrEvent = {
      ...REPORT,
      id: '9'.repeat(64),
      tags: [['e', '8'.repeat(64)], ['p', REPORTED_PUBKEY]],
    };
    fetchReportsByTarget.mockResolvedValue({ events: [REPORT, other], truncated: false });

    renderDetail();

    expect(await screen.findByText(/Related Reports \(1 more on this account\)/)).toBeInTheDocument();
    expect(fetchReportsByTarget).toHaveBeenCalledWith({ pubkey: REPORTED_PUBKEY });
  });
});
