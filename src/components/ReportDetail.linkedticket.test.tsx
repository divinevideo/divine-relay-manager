// ABOUTME: Pins WHICH lookup ReportDetail asks for, not just that the helper is right.
// ABOUTME: An event report must never send the author, or the panel lists other videos.
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { TooltipProvider } from '@/components/ui/tooltip';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ReportDetail } from './ReportDetail';
import type { NostrEvent } from '@nostrify/nostrify';

const AUTHOR = 'd'.repeat(64);
const EVENT = '7'.repeat(64);
const MOD = 'e'.repeat(64);

const ctx = vi.hoisted(() => ({ target: { type: 'event', value: '7'.repeat(64) } as { type: string; value: string } }));
const getLinkedTickets = vi.hoisted(() => vi.fn(async () => []));

vi.mock('react-router-dom', async (orig) => ({
  ...(await orig<typeof import('react-router-dom')>()), useNavigate: () => vi.fn(),
}));
vi.mock('@/hooks/useAdminApi', () => ({
  useAdminApi: () => ({
    deleteEvent: vi.fn(), restoreEvent: vi.fn(), markAsReviewed: vi.fn(),
    logDecision: vi.fn(), deleteDecisions: vi.fn(),
    getLinkedTickets, closeTicket: vi.fn(),
  }),
}));
vi.mock('@/hooks/useToast', () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock('@/hooks/useCurrentUser', () => ({
  useCurrentUser: () => ({ user: { pubkey: MOD }, getModeratorPubkey: async () => MOD }),
}));
vi.mock('@/hooks/useAppContext', () => ({ useAppContext: () => ({ config: { relayUrl: 'wss://relay.example' } }) }));
vi.mock('@/hooks/useDecisionLog', () => ({
  useDecisionLog: () => ({ hasDecisions: false, isPendingReview: false, isDeleted: false,
    isAutoHidden: false, isAutoHideRestored: false, decisions: [], latestDecision: null, refetch: vi.fn() }),
}));
vi.mock('@/hooks/useModerationStatus', () => ({
  useModerationStatus: () => ({ isUserBanned: false, isUserSuspended: false, isEventBanned: false,
    isEventGone: false, isLoading: false, isChecking: false, checkedAt: null, recheck: vi.fn() }),
}));
vi.mock('@/hooks/useBannedEvent', () => ({ useBannedEvent: () => ({ data: null, isLoading: false }) }));
vi.mock('@/hooks/useUserSummary', () => ({ useUserSummary: () => ({ data: null, isLoading: false }) }));
vi.mock('@/hooks/useMediaStatus', () => ({ useMediaStatus: () => ({}) }));
vi.mock('@/hooks/useReportContext', () => ({
  useReportContext: () => ({
    target: ctx.target,
    thread: { event: undefined, ancestors: [], replies: [] },
    threadLoading: false,
    reportedUser: { profile: undefined, pubkey: AUTHOR, isFunnelcakeUser: false },
    userStats: undefined,
    reporter: { profile: undefined, pubkey: 'a'.repeat(64), reportCount: 0, isFunnelcakeUser: false },
    isLoading: false, error: null, relayHint: undefined, reportTags: [],
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
  id: 'f'.repeat(64), pubkey: 'a'.repeat(64), created_at: 1751000000, kind: 1984,
  tags: [['e', EVENT, 'spam'], ['p', AUTHOR]], content: 'spam', sig: 'b'.repeat(128),
};

function renderDetail() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}><TooltipProvider>
      <ReportDetail report={REPORT} />
    </TooltipProvider></QueryClientProvider>,
  );
}

// linkedTicketTarget is unit-tested, but nothing asserted ReportDetail actually
// calls it. Restoring the pre-fix two lines here -- event id from the target, author
// from `reportedPubkey` unconditionally -- leaves the whole suite green while the
// panel is back to listing tickets filed about the author's OTHER posts, with the
// Close button on whichever is open. These three cases fail on that revert.
describe('ReportDetail -> LinkedTicketPanel wiring', () => {
  beforeEach(() => { getLinkedTickets.mockClear(); });

  it('an EVENT-scoped report looks up only the event', async () => {
    ctx.target = { type: 'event', value: EVENT };
    renderDetail();
    expect(await screen.findByText(/Linked ticket/i)).toBeInTheDocument();
    expect(getLinkedTickets).toHaveBeenCalledWith({ eventId: EVENT, pubkey: undefined });
  });

  it('a PUBKEY-scoped report looks up the author', async () => {
    ctx.target = { type: 'pubkey', value: AUTHOR };
    renderDetail();
    expect(await screen.findByText(/Linked ticket/i)).toBeInTheDocument();
    expect(getLinkedTickets).toHaveBeenCalledWith({ eventId: undefined, pubkey: AUTHOR });
  });

  it('no valid target hides the heading entirely', () => {
    ctx.target = null as unknown as { type: string; value: string };
    renderDetail();
    expect(screen.queryByText(/Linked ticket/i)).not.toBeInTheDocument();
    expect(getLinkedTickets).not.toHaveBeenCalled();
  });
});
