// ABOUTME: The report pane does not call a target handled when its only decision is
// ABOUTME: one the worker made by itself, so it agrees with the sensitive switch.

import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { TooltipProvider } from '@/components/ui/tooltip';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ReportDetail } from './ReportDetail';
import type { NostrEvent } from '@nostrify/nostrify';
import type { ModerationDecision } from '@/lib/adminApi';
import { moderationStatusMock } from '@/test/moderationStatusMock';

const REPORTED_PUBKEY = 'd'.repeat(64);
const MOD_PUBKEY = 'e'.repeat(64);

// What GET /api/decisions/<id> answers for each target, newest first. The real
// useDecisionLog reads it, so the pane is driven by the rows, not a canned flag.
const decisionsByTarget = vi.hoisted(() => ({ value: {} as Record<string, ModerationDecision[]> }));
// The report's target, when a test needs a post instead of the account.
const reportTarget = vi.hoisted(() => ({ value: null as { type: 'event' | 'pubkey'; value: string } | null }));

vi.mock('react-router-dom', async (orig) => ({
  ...(await orig<typeof import('react-router-dom')>()),
  useNavigate: () => vi.fn(),
}));
vi.mock('@/hooks/useAdminApi', () => ({
  useAdminApi: () => ({
    getDecisions: async (targetId: string) => decisionsByTarget.value[targetId] ?? [],
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
vi.mock('@/hooks/useModerationStatus', () => ({
  useModerationStatus: () => moderationStatusMock({ isUserBanned: false, isEventGone: false }),
}));
vi.mock('@/hooks/useBannedEvent', () => ({ useBannedEvent: () => ({ data: null, isLoading: false }) }));
vi.mock('@/hooks/useUserSummary', () => ({ useUserSummary: () => ({ data: null, isLoading: false }) }));
vi.mock('@/hooks/useMediaStatus', () => ({ useMediaStatus: () => ({}) }));
vi.mock('@/hooks/useReportContext', () => ({
  useReportContext: () => ({
    target: reportTarget.value ?? { type: 'pubkey', value: REPORTED_PUBKEY },
    thread: { event: undefined, ancestors: [], replies: [] },
    threadLoading: false,
    reportedUser: { profile: undefined, pubkey: REPORTED_PUBKEY, isFunnelcakeUser: false },
    userStats: undefined,
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

// A profile CSAM report, the kind the sensitive switch keeps for review.
const REPORT: NostrEvent = {
  id: 'f'.repeat(64),
  pubkey: 'a'.repeat(64),
  created_at: 1751000000,
  kind: 1984,
  tags: [['p', REPORTED_PUBKEY, 'illegal'], ['L', 'social.nos.ontology'], ['l', 'NS-csam', 'social.nos.ontology']],
  content: '',
  sig: 'b'.repeat(128),
};

// The row ReportWatcher logs when it opens an age-review case by itself.
const AGE_REVIEW_CASE_ROW: ModerationDecision = {
  id: 2,
  target_type: 'pubkey',
  target_id: REPORTED_PUBKEY,
  action: 'age_review_case_created',
  reason: 'Under-16 report: age review case created (default band: age_13_15)',
  moderator_pubkey: 'auto',
  report_id: '9'.repeat(64),
  created_at: '2026-10-20 12:00:00',
};
const REVIEWED_ROW: ModerationDecision = {
  id: 1,
  target_type: 'pubkey',
  target_id: REPORTED_PUBKEY,
  action: 'reviewed',
  moderator_pubkey: MOD_PUBKEY,
  created_at: '2026-10-19 12:00:00',
};

// A CSAM report on a post, and the row ReportWatcher logs when the relay
// refuses to hide that post: the post is still up.
const EVENT_ID = 'c'.repeat(64);
const EVENT_REPORT: NostrEvent = {
  ...REPORT,
  id: '8'.repeat(64),
  tags: [['e', EVENT_ID, 'illegal'], ['p', REPORTED_PUBKEY], ['L', 'social.nos.ontology'], ['l', 'NS-csam', 'social.nos.ontology']],
};
const AUTO_HIDE_FAILED_ROW: ModerationDecision = {
  id: 3,
  target_type: 'event',
  target_id: EVENT_ID,
  action: 'auto_hide_failed',
  reason: 'Auto-hide failed',
  moderator_pubkey: 'auto',
  report_id: EVENT_REPORT.id,
  created_at: '2026-10-21 12:00:00',
};

function renderDetail(report: NostrEvent = REPORT) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <TooltipProvider>
        <ReportDetail report={report} />
      </TooltipProvider>
    </QueryClientProvider>,
  );
}

describe('ReportDetail on a target the worker has decided on', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    decisionsByTarget.value = {};
    reportTarget.value = null;
  });

  it('lists the decision without calling the target handled when it is the only one', async () => {
    decisionsByTarget.value = { [REPORTED_PUBKEY]: [AGE_REVIEW_CASE_ROW] };

    renderDetail();

    const heading = await screen.findByText('Decision History (1 action)');
    expect(screen.queryByText(/Already Handled/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Last action:/)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Reopen' })).not.toBeInTheDocument();
    // Green reads as "all clear", which only a handling decision earns.
    expect(heading).not.toHaveClass('text-green-700');
    expect(heading.closest('[class*="bg-green-50"]')).toBeNull();
  });

  it("calls it handled, and names the person's decision, once a person has decided", async () => {
    decisionsByTarget.value = { [REPORTED_PUBKEY]: [AGE_REVIEW_CASE_ROW, REVIEWED_ROW] };

    renderDetail();

    const heading = await screen.findByText('Already Handled (2 actions)');
    expect(screen.getByText(/Last action: reviewed/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Reopen' })).toBeInTheDocument();
    expect(heading).toHaveClass('text-green-700');
    expect(heading.closest('[class*="bg-green-50"]')).not.toBeNull();
  });

  it('does not call a post handled when its only auto-hide failed', async () => {
    reportTarget.value = { type: 'event', value: EVENT_ID };
    decisionsByTarget.value = { [EVENT_ID]: [AUTO_HIDE_FAILED_ROW] };

    renderDetail(EVENT_REPORT);

    const heading = await screen.findByText('Decision History (1 action)');
    expect(screen.queryByText(/Already Handled/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Last action:/)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Reopen' })).not.toBeInTheDocument();
    expect(heading).not.toHaveClass('text-green-700');
  });
});
