// ABOUTME: Pins the user ban-status panel's three outcomes on a user report.
// ABOUTME: A check that could not answer must not render as "User is not banned".

import { fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { TooltipProvider } from '@/components/ui/tooltip';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ReportDetail } from './ReportDetail';
import type { NostrEvent } from '@nostrify/nostrify';
import type { ModerationStatus } from '@/hooks/useModerationStatus';
import { moderationStatusMock } from '@/test/moderationStatusMock';

// This panel is the one place a user report states the relay's ban status as a
// sentence. It used to branch on `isUserBanned ? banned : checkedAt ? "not
// banned"`, so an inconclusive check — which now resolves null rather than the
// old fail-open true — fell into the negative branch and told the moderator
// "User is not banned. Checked: <time>" about a relay it never reached.

const REPORTED_PUBKEY = 'd'.repeat(64);
const MOD_PUBKEY = 'e'.repeat(64);
const CHECKED_AT = new Date('2026-08-10T12:00:00Z');

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
    reporter: { profile: undefined, pubkey: 'a'.repeat(64), reportCount: 0, isFunnelcakeUser: false },
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
vi.mock('@/components/UserProfileCard', () => ({ UserProfileCard: () => null }));
vi.mock('@/components/AISummary', () => ({ AISummary: () => null }));
vi.mock('@/components/HiveAIReport', () => ({ HiveAIReport: () => null }));
vi.mock('@/components/AIDetectionReport', () => ({ AIDetectionReport: () => null }));
vi.mock('@/components/MediaPreview', () => ({ MediaPreview: () => null }));
vi.mock('@/components/ThreadModal', () => ({ ThreadModal: () => null }));
vi.mock('@/components/EventActions', () => ({ EventActions: () => null }));
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
    // Otherwise a render that never reached UserActions would read the previous
    // test's props and pass.
    userActionsProps.last = null;
    threadContextProps.last = null;
    bulkDeleteProps.last = null;
    reportTarget.value = { type: 'pubkey', value: REPORTED_PUBKEY };
    status.value = moderationStatusMock({ isUserBanned: null, isEventGone: null, checkedAt: CHECKED_AT });
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

  // While the status is still being determined, "could not check" would state
  // an outcome that has not happened yet. That holds through the live check
  // and through the list re-reads after it, which can still settle the ban.

  it('says the ban status is being checked, not that it could not be, while the check runs', () => {
    status.value.isUserBanned = null;
    status.value.isChecking = true;
    status.value.isAccountStatusLoading = true;

    renderDetail();

    expect(screen.getByText('Checking ban status...')).toBeInTheDocument();
    expect(screen.queryByText('Could not check ban status')).not.toBeInTheDocument();
  });

  it('keeps saying the ban status is being checked while the lists re-read after the check', () => {
    status.value.isUserBanned = null;
    status.value.isChecking = false;
    status.value.isAccountStatusLoading = true;

    renderDetail();

    expect(screen.getByText('Checking ban status...')).toBeInTheDocument();
    expect(screen.queryByText('Could not check ban status')).not.toBeInTheDocument();
  });

  // Every action in the pane reports back through one handler. Only an action
  // that changed the account's ban or suspension makes the status on screen
  // pre-action; a content action leaves it as it was.

  it('runs the check after an action when an account action completes', () => {
    renderDetail();
    const onActionComplete = userActionsProps.last?.onActionComplete as (change?: { accountStatusChanged: boolean }) => void;

    onActionComplete({ accountStatusChanged: true });

    expect(status.value.recheckAfterAction).toHaveBeenCalledTimes(1);
    expect(status.value.recheck).not.toHaveBeenCalled();
  });

  it('runs a plain check, re-reading the account lists, when a content action completes', () => {
    const invalidate = vi.spyOn(QueryClient.prototype, 'invalidateQueries');
    try {
      renderDetail();
      const onComplete = bulkDeleteProps.last?.onComplete as () => void;

      onComplete();

      expect(status.value.recheck).toHaveBeenCalledTimes(1);
      expect(status.value.recheckAfterAction).not.toHaveBeenCalled();
      expect(invalidate).toHaveBeenCalledWith({ queryKey: ['banned-pubkeys'] });
      expect(invalidate).toHaveBeenCalledWith({ queryKey: ['suspended-pubkeys'] });
    } finally {
      invalidate.mockRestore();
    }
  });

  it('runs a plain check when a bulk content action from UserActions completes', () => {
    renderDetail();
    const onActionComplete = userActionsProps.last?.onActionComplete as (change?: { accountStatusChanged: boolean }) => void;

    onActionComplete({ accountStatusChanged: false });

    expect(status.value.recheck).toHaveBeenCalledTimes(1);
    expect(status.value.recheckAfterAction).not.toHaveBeenCalled();
  });

  // A failed suspended-list read used to arrive at UserActions as `false`:
  // ReportDetail passed `?? undefined`, and a default parameter turns undefined
  // into false. An account whose status was never confirmed was handed over
  // identically to one confirmed clean. Asserting on the prop rather than on
  // rendered text because this file stubs UserActions out; the note itself is
  // covered in UserActions.test.tsx.
  it('hands an unconfirmed suspend status to UserActions as null, not false', () => {
    status.value.isUserSuspended = null;

    renderDetail();

    expect(userActionsProps.last?.isSuspended).toBeNull();
    expect(userActionsProps.last?.isSuspended).not.toBe(false);
  });

  it('hands a confirmed negative through as false', () => {
    status.value.isUserSuspended = false;

    renderDetail();

    expect(userActionsProps.last?.isSuspended).toBe(false);
  });

  it('tells UserActions when the account status lists are still loading', () => {
    status.value.isUserSuspended = null;
    status.value.isAccountStatusLoading = true;

    renderDetail();

    expect(userActionsProps.last?.statusPending).toBe(true);
  });

  it('tells UserActions the account lists have settled, whatever else is loading', () => {
    // isLoading also waits on banned-events, which is not an account status.
    status.value.isUserSuspended = null;
    status.value.isLoading = true;
    status.value.isAccountStatusLoading = false;

    renderDetail();

    expect(userActionsProps.last?.statusPending).toBe(false);
  });

  it('hands an unconfirmed ban status to UserActions as null, not false', () => {
    status.value.isUserBanned = null;

    renderDetail();

    expect(userActionsProps.last?.isBanned).toBeNull();
    expect(userActionsProps.last?.isBanned).not.toBe(false);
  });

  it('does not present a kept ban as confirmed when the latest check failed', () => {
    status.value.isUserBanned = true;
    status.value.isUserBannedStale = true;

    renderDetail();

    expect(screen.getByText(/Last known: banned/)).toBeInTheDocument();
    expect(screen.queryByText('User is banned on the relay')).not.toBeInTheDocument();
  });

  // Right after an Unban the pre-Unban list is behind the check's mark, so the
  // ban is kept and stale while the check after it runs. "Could not confirm"
  // then states an outcome that has not happened yet.
  it('says a kept ban is being checked, not that the check failed, while the check runs', () => {
    status.value.isUserBanned = true;
    status.value.isUserBannedStale = true;
    status.value.isAccountStatusLoading = true;
    status.value.isUserBanChecking = true;

    renderDetail();

    expect(screen.getByText('Last known: banned. Checking now.')).toBeInTheDocument();
    expect(screen.queryByText(/could not confirm/)).not.toBeInTheDocument();
    expect(screen.queryByText('User is banned on the relay')).not.toBeInTheDocument();
  });

  it('says the check could not confirm a kept ban once nothing is loading', () => {
    status.value.isUserBanned = true;
    status.value.isUserBannedStale = true;
    status.value.isAccountStatusLoading = false;

    renderDetail();

    expect(screen.getByText('Last known: banned. The latest check could not confirm it.')).toBeInTheDocument();
    expect(screen.queryByText(/Checking now/)).not.toBeInTheDocument();
  });

  // The ban's re-read has failed and only the suspended list is still out.
  // Nothing on its way can settle the ban, so the check has failed to confirm
  // it, even though the account status as a whole is still loading.
  it('says the check could not confirm a kept ban while only the suspension is still loading', () => {
    status.value.isUserBanned = true;
    status.value.isUserBannedStale = true;
    status.value.isAccountStatusLoading = true;
    status.value.isUserBanChecking = false;

    renderDetail();

    expect(screen.getByText('Last known: banned. The latest check could not confirm it.')).toBeInTheDocument();
    expect(screen.queryByText(/Checking now/)).not.toBeInTheDocument();
  });

  it('tells the thread panel when the ban is still being checked', () => {
    reportTarget.value = { type: 'event', value: 'e'.repeat(64) };
    status.value.isUserBanned = true;
    status.value.isUserBannedStale = true;
    status.value.isAccountStatusLoading = true;
    status.value.isUserBanChecking = true;

    renderDetail();

    expect(threadContextProps.last?.isUserBanChecking).toBe(true);
  });

  it('does not tell the thread panel the ban is being checked while only the suspension is loading', () => {
    reportTarget.value = { type: 'event', value: 'e'.repeat(64) };
    status.value.isUserBanned = true;
    status.value.isUserBannedStale = true;
    status.value.isAccountStatusLoading = true;
    status.value.isUserBanChecking = false;

    renderDetail();

    expect(threadContextProps.last?.isUserBanChecking).toBe(false);
  });

  it('tells UserActions when either kept status is stale', () => {
    status.value.isUserSuspended = true;
    status.value.isUserSuspendedStale = true;

    renderDetail();

    expect(userActionsProps.last?.statusStale).toBe(true);
  });

  it('tells UserActions nothing is stale when both statuses are current', () => {
    status.value.isUserBanned = false;

    renderDetail();

    expect(userActionsProps.last?.statusStale).toBe(false);
  });

  // A kept ban has to read as kept everywhere the pane states it, or the header
  // contradicts the panel beside it.
  it('does not badge a kept ban as a confirmed one in the header', () => {
    status.value.isUserBanned = true;
    status.value.isUserBannedStale = true;

    renderDetail();

    expect(screen.queryAllByText('User Banned')).toHaveLength(0);
    expect(screen.getAllByText('Banned (last known)').length).toBeGreaterThan(0);
  });

  it('does not label a removed event as removed by a confirmed ban when the ban is kept', () => {
    status.value.isUserBanned = true;
    status.value.isUserBannedStale = true;
    status.value.isEventGone = true;

    renderDetail();

    expect(screen.queryAllByText('User Banned')).toHaveLength(0);
  });

  it('tells the thread panel when the ban it shows is kept', () => {
    // The thread panel is where an EVENT report states the author's ban -- the
    // usual path for a banned author, since a ban purges their posts.
    reportTarget.value = { type: 'event', value: 'e'.repeat(64) };
    status.value.isUserBanned = true;
    status.value.isUserBannedStale = true;

    renderDetail();

    expect(threadContextProps.last?.isUserBannedStale).toBe(true);
  });

  it('tells UserActions a status is stale when only the ban is kept', () => {
    status.value.isUserBanned = true;
    status.value.isUserBannedStale = true;

    renderDetail();

    expect(userActionsProps.last?.statusStale).toBe(true);
  });

  it('labels a removed post as removed by a kept ban, in the badge and its tooltip', async () => {
    status.value.isUserBanned = true;
    status.value.isUserBannedStale = true;
    status.value.isEventGone = true;

    renderDetail();

    // One in the header, one on the removed-post badge.
    const labels = screen.getAllByText('Banned (last known)');
    expect(labels).toHaveLength(2);

    const removedBadge = labels.find(el => el.classList.contains('cursor-help'));
    expect(removedBadge).toBeDefined();
    fireEvent.focus(removedBadge!);
    const tip = await screen.findByRole('tooltip');
    expect(tip.textContent).toMatch(/could not confirm the ban/i);
    expect(tip.textContent).not.toMatch(/event removed as part of ban/i);
    expect(tip.textContent).not.toMatch(/checking/i);
  });

  it('says the kept ban behind a removed post is being checked while the check runs', async () => {
    status.value.isUserBanned = true;
    status.value.isUserBannedStale = true;
    status.value.isEventGone = true;
    status.value.isAccountStatusLoading = true;
    status.value.isUserBanChecking = true;

    renderDetail();

    const removedBadge = screen.getAllByText('Banned (last known)').find(el => el.classList.contains('cursor-help'));
    expect(removedBadge).toBeDefined();
    fireEvent.focus(removedBadge!);
    const tip = await screen.findByRole('tooltip');
    expect(tip.textContent).toMatch(/checking the ban now/i);
    expect(tip.textContent).not.toMatch(/could not confirm/i);
  });

  it('says the check could not confirm the kept ban behind a removed post while only the suspension is loading', async () => {
    status.value.isUserBanned = true;
    status.value.isUserBannedStale = true;
    status.value.isEventGone = true;
    status.value.isAccountStatusLoading = true;
    status.value.isUserBanChecking = false;

    renderDetail();

    const removedBadge = screen.getAllByText('Banned (last known)').find(el => el.classList.contains('cursor-help'));
    expect(removedBadge).toBeDefined();
    fireEvent.focus(removedBadge!);
    const tip = await screen.findByRole('tooltip');
    expect(tip.textContent).toMatch(/could not confirm the ban/i);
    expect(tip.textContent).not.toMatch(/checking/i);
  });
});
