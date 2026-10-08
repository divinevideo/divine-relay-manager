// ABOUTME: Pins how a report against a Divine list reads to a moderator: the
// ABOUTME: heading names the list type and a card shows its title and description.

import { render, screen, within } from '@testing-library/react';
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
// The decision log the reported list's id returns. Empty by default.
const decisionRows = vi.hoisted(() => ({
  value: [] as { id: number; action: string; reason: string | null; created_at: string }[],
  handling: false,
}));
vi.mock('@/hooks/useDecisionLog', () => ({
  useDecisionLog: () => ({
    hasDecisions: decisionRows.value.length > 0,
    hasHandlingDecisions: decisionRows.handling,
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

describe('ReportDetail for a reported list', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    status.value = moderationStatusMock({ isUserBanned: false, isEventGone: false });
    decisionRows.value = [];
    decisionRows.handling = false;
  });

  describe('after its auto-hide was skipped', () => {
    beforeEach(() => {
      decisionRows.value = [{
        id: 1,
        action: 'auto_hide_skipped',
        reason: 'NS-harassment: list report, human review',
        created_at: '2026-10-08T12:00:00Z',
      }];
      decisionRows.handling = false;
    });

    it('does not present the report as already handled', () => {
      renderDetail();

      expect(screen.queryByText(/Already Handled/)).not.toBeInTheDocument();
      expect(screen.queryByText(/Last action:/)).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Reopen' })).not.toBeInTheDocument();
    });

    it('still shows the skip in the decision history', () => {
      renderDetail();

      expect(screen.getByText(/Decision History/)).toBeInTheDocument();
      expect(screen.getByText('auto hide skipped')).toBeInTheDocument();
    });
  });

  it('names the list type in the reported-content heading', () => {
    renderDetail();

    expect(screen.getByText('Reported Video List')).toBeInTheDocument();
  });

  it("shows the list's title and description", () => {
    renderDetail();

    // The raw tags also list the title, so look inside the list card itself.
    const card = within(screen.getByRole('region', { name: 'Reported list' }));
    expect(card.getByText('Best skate clips')).toBeInTheDocument();
    expect(card.getByText('Only the good ones')).toBeInTheDocument();
  });
});
