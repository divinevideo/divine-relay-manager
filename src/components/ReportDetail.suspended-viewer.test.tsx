// ABOUTME: Pins report detail's placement of the suspended-content viewer: for a post a
// ABOUTME: suspension hides and for the reported account, with the report's media rule.

import { render } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { TooltipProvider } from '@/components/ui/tooltip';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactElement } from 'react';
import { ReportDetail } from './ReportDetail';
import type { NostrEvent } from '@nostrify/nostrify';
import type { ModerationStatus } from '@/hooks/useModerationStatus';
import { moderationStatusMock } from '@/test/moderationStatusMock';
import { SuspendedPostViewer } from '@/components/suspended/SuspendedContentPanel';

const REPORTED_PUBKEY = 'd'.repeat(64);
const MOD_PUBKEY = 'e'.repeat(64);
const CHECKED_AT = new Date('2026-08-10T12:00:00Z');

// Set in beforeEach; tests change single fields.
const status = vi.hoisted(() => ({ value: {} as ModerationStatus }));

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
const decisionFlags = vi.hoisted(() => ({ isDeleted: false, isAutoHidden: false, isPending: false, error: null as Error | null }));
vi.mock('@/hooks/useDecisionLog', () => ({
  useDecisionLog: () => ({
    hasDecisions: false,
    isPendingReview: false,
    isDeleted: decisionFlags.isDeleted,
    isAutoHidden: decisionFlags.isAutoHidden,
    isPending: decisionFlags.isPending,
    error: decisionFlags.error,
    isAutoHideRestored: false,
    decisions: [],
    latestDecision: null,
    refetch: vi.fn(),
  }),
}));
vi.mock('@/hooks/useModerationStatus', () => ({
  useModerationStatus: () => status.value,
}));
// The getbannedevent read. `data` is the banned post when the relay returned it.
const bannedEventRead = vi.hoisted(() => ({ value: { data: null as NostrEvent | null | undefined, isLoading: false } }));
vi.mock('@/hooks/useBannedEvent', () => ({ useBannedEvent: () => bannedEventRead.value }));
vi.mock('@/hooks/useUserSummary', () => ({ useUserSummary: () => ({ data: null, isLoading: false }) }));
vi.mock('@/hooks/useMediaStatus', () => ({ useMediaStatus: () => ({ results: [] }) }));

// A user report by default: no event target, which is the branch that renders
// the ban-status panel. Tests that need the thread panel switch to an event.
const reportTarget = vi.hoisted(() => ({
  value: { type: 'pubkey', value: 'd'.repeat(64) } as { type: string; value: string },
}));
vi.mock('@/hooks/useReportContext', () => ({
  useReportContext: () => ({
    target: reportTarget.value,
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

const threadContextProps = vi.hoisted(() => ({ last: null as Record<string, unknown> | null }));
vi.mock('@/components/ThreadContext', () => ({
  ThreadContext: (props: Record<string, unknown>) => {
    threadContextProps.last = props;
    return null;
  },
}));
const userCardProps = vi.hoisted(() => ({ last: null as Record<string, unknown> | null }));
vi.mock('@/components/UserProfileCard', () => ({
  UserProfileCard: (props: Record<string, unknown>) => {
    userCardProps.last = props;
    return null;
  },
}));
vi.mock('@/components/AISummary', () => ({ AISummary: () => null }));
vi.mock('@/components/HiveAIReport', () => ({ HiveAIReport: () => null }));
vi.mock('@/components/AIDetectionReport', () => ({ AIDetectionReport: () => null }));
vi.mock('@/components/MediaPreview', () => ({ MediaPreview: () => null }));
vi.mock('@/components/ThreadModal', () => ({ ThreadModal: () => null }));
const eventActionsProps = vi.hoisted(() => ({ last: null as Record<string, unknown> | null }));
vi.mock('@/components/EventActions', () => ({
  EventActions: (props: Record<string, unknown>) => {
    eventActionsProps.last = props;
    return null;
  },
}));
const userActionsProps = vi.hoisted(() => ({ last: null as Record<string, unknown> | null }));
vi.mock('@/components/UserActions', () => ({
  UserActions: (props: Record<string, unknown>) => {
    userActionsProps.last = props;
    return null;
  },
}));
const bulkDeleteProps = vi.hoisted(() => ({ last: null as Record<string, unknown> | null }));
vi.mock('@/components/BulkDeleteByKind', () => ({
  BulkDeleteByKind: (props: Record<string, unknown>) => {
    bulkDeleteProps.last = props;
    return null;
  },
}));
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

function renderDetail(allReportsForTarget?: NostrEvent[]) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <TooltipProvider>
        <ReportDetail report={REPORT} allReportsForTarget={allReportsForTarget} />
      </TooltipProvider>
    </QueryClientProvider>,
  );
}

const EVENT_ID = 'c'.repeat(64);
// An old-build CSAM report: NIP-56 'illegal' plus a Reason line.
const CSAM_REPORT: NostrEvent = {
  ...REPORT,
  tags: [['e', EVENT_ID, 'illegal'], ['p', REPORTED_PUBKEY, 'illegal'], ['client', 'diVine']],
  content: 'CONTENT REPORT - NIP-56\nReason: csam\nDetails: x\n',
};
const SPAM_REPORT: NostrEvent = { ...REPORT, tags: [['e', EVENT_ID, 'spam'], ['p', REPORTED_PUBKEY, 'spam']] };

function viewer(): ReactElement<{ eventId: string; surface: string; showMediaByDefault: boolean | null; expectedAuthor?: string; subject?: string }> | undefined {
  return threadContextProps.last?.suspendedViewer as never;
}

describe('ReportDetail suspended-content viewer placement', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    threadContextProps.last = null;
    userCardProps.last = null;
    bannedEventRead.value = { data: null, isLoading: false };
    decisionFlags.isDeleted = false;
    decisionFlags.isAutoHidden = false;
    decisionFlags.isPending = false;
    decisionFlags.error = null;
    reportTarget.value = { type: 'event', value: EVENT_ID };
    status.value = moderationStatusMock({ isEventGone: true, isUserSuspended: true, checkedAt: CHECKED_AT });
  });

  it('gives the thread panel the post viewer for a post the suspension hides', () => {
    renderDetail([SPAM_REPORT]);

    expect(viewer()?.type).toBe(SuspendedPostViewer);
    expect(viewer()?.props).toMatchObject({ eventId: EVENT_ID, surface: 'report' });
  });

  // The event id is the report's e tag; the post can be another account's.
  it('tells the post viewer which account the report names', () => {
    renderDetail([SPAM_REPORT]);

    expect(viewer()?.props).toMatchObject({ expectedAuthor: REPORTED_PUBKEY, subject: 'the reported account' });
  });

  // Matt, 2026-11-09: a confirmed suspension where a ban could not be checked
  // still offers the viewer; a ban shows as hidden for another reason.
  it('gives the post viewer when the suspension is confirmed but a ban is unknown', () => {
    status.value.isEventBanned = null;
    renderDetail([SPAM_REPORT]);

    expect(viewer()?.type).toBe(SuspendedPostViewer);
  });

  it('shows the post viewer media by default for a report that is not sensitive', () => {
    renderDetail([SPAM_REPORT]);

    expect(viewer()?.props.showMediaByDefault).toBe(true);
  });

  it('hides the post viewer media by default for a CSAM-signal report', () => {
    renderDetail([CSAM_REPORT]);

    expect(viewer()?.props.showMediaByDefault).toBe(false);
  });

  it('starts the post viewer media hidden while the reports are not known', () => {
    renderDetail(undefined);

    expect(viewer()?.props.showMediaByDefault).toBeNull();
  });

  it('gives no viewer when the account is not confirmed suspended', () => {
    status.value.isUserSuspended = null;
    renderDetail([SPAM_REPORT]);

    expect(viewer()).toBeUndefined();
  });

  it('gives no viewer when a ban explains the missing post', () => {
    status.value.isUserBanned = true;
    renderDetail([SPAM_REPORT]);

    expect(viewer()).toBeUndefined();
  });

  it('gives no viewer for a target id that is not 64 hex', () => {
    reportTarget.value = { type: 'event', value: 'not-an-id' };
    renderDetail([SPAM_REPORT]);

    expect(viewer()).toBeUndefined();
  });

  it('asks the user card for the account viewer on the report surface', () => {
    renderDetail([CSAM_REPORT]);

    expect(userCardProps.last?.suspendedViewerSurface).toBe('report');
    // The card applies its own hideMediaByDefault to the viewer.
    expect(userCardProps.last?.hideMediaByDefault).toBe(true);
  });
});
