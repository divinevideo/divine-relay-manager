// ABOUTME: Pins report detail's suspended branch for a post the relay won't return,
// ABOUTME: and the suspension handed to the user card and thread panel.

import { act, fireEvent, render, screen } from '@testing-library/react';
import type { UserActionChange } from '@/components/UserActions';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { TooltipProvider } from '@/components/ui/tooltip';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ReportDetail } from './ReportDetail';
import type { NostrEvent } from '@nostrify/nostrify';
import type { ModerationStatus } from '@/hooks/useModerationStatus';
import { moderationStatusMock } from '@/test/moderationStatusMock';

// The live check that marks a post "gone" is a public REQ, and the relay hides
// a suspended account's posts from it. Report detail used to fall through to
// "Not Found on Relay" (and the thread panel to "deleted") for exactly the
// posts it could not show because of a suspension.

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
  useCurrentUser: () => ({ user: { pubkey: MOD_PUBKEY }, getModeratorPubkey: async () => MOD_PUBKEY }),
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

function renderDetail(qc = new QueryClient({
  defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
})) {
  return render(
    <QueryClientProvider client={qc}>
      <TooltipProvider>
        <ReportDetail report={REPORT} />
      </TooltipProvider>
    </QueryClientProvider>,
  );
}

const EVENT_ID = 'c'.repeat(64);

async function removedBadgeTooltip(label: string) {
  const badge = screen.getAllByText(label).find(el => el.classList.contains('cursor-help'));
  expect(badge).toBeDefined();
  fireEvent.focus(badge!);
  return (await screen.findByRole('tooltip')).textContent;
}

describe('ReportDetail post hidden by a suspension', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    threadContextProps.last = null;
    userCardProps.last = null;
    eventActionsProps.last = null;
    bannedEventRead.value = { data: null, isLoading: false };
    decisionFlags.isDeleted = false;
    decisionFlags.isAutoHidden = false;
    decisionFlags.isPending = false;
    decisionFlags.error = null;
    reportTarget.value = { type: 'event', value: EVENT_ID };
    // The post came back gone, the account is suspended, and nothing else
    // explains it.
    status.value = moderationStatusMock({
      isEventGone: true,
      isUserSuspended: true,
      checkedAt: CHECKED_AT,
    });
  });

  it('badges the post as hidden by the suspension, not as not found', async () => {
    renderDetail();

    expect(screen.queryByText('Not Found on Relay')).not.toBeInTheDocument();
    const tip = await removedBadgeTooltip('Account Suspended');
    expect(tip).toMatch(/may still exist/);
  });

  it('marks a suspension carried over from a list that could not be refreshed', async () => {
    status.value.isUserSuspendedStale = true;

    renderDetail();

    const tip = await removedBadgeTooltip('Suspended (last known)');
    expect(tip).toMatch(/Last known: the reported account is suspended/);
  });

  it('tells the thread panel the suspension explains the missing post', () => {
    status.value.isUserSuspendedStale = true;

    renderDetail();

    expect((threadContextProps.last?.goneCause as { kind: string } | undefined)?.kind).toBe('suspended');
    expect((threadContextProps.last?.goneCause as { stale?: boolean } | undefined)?.stale).toBe(true);
  });

  it('keeps "Not Found on Relay" when the account is not confirmed suspended', () => {
    status.value.isUserSuspended = null;

    renderDetail();

    expect(screen.getByText('Not Found on Relay')).toBeInTheDocument();
    expect((threadContextProps.last?.goneCause as { kind: string } | undefined)?.kind).not.toBe('suspended');
  });

  it('does not tell the thread panel a suspension hides a post the relay still has', () => {
    status.value.isEventGone = false;

    renderDetail();

    expect((threadContextProps.last?.goneCause as { kind: string } | undefined)?.kind).not.toBe('suspended');
  });

  // Causes the badge already ranks ahead of a suspension. The thread panel must
  // give the same reason the badge does.
  it('lets a moderation delete outrank the suspension', () => {
    decisionFlags.isDeleted = true;

    renderDetail();

    expect(screen.getByText('Removed by Moderation')).toBeInTheDocument();
    expect((threadContextProps.last?.goneCause as { kind: string } | undefined)?.kind).not.toBe('suspended');
  });

  it('tells the thread panel an auto-hidden post was hidden, not deleted', () => {
    decisionFlags.isAutoHidden = true;

    renderDetail();

    expect((threadContextProps.last?.goneCause as { line?: string } | undefined)?.line).toBe('Hidden automatically');
  });

  // Not "by AI classification": ReportWatcher also auto-hides on user reports.
  it('does not attribute an auto-hide to AI classification in the tooltip', async () => {
    decisionFlags.isAutoHidden = true;

    renderDetail();

    const tip = await removedBadgeTooltip('Hidden automatically');
    expect(tip).toBe('Hidden automatically');
  });

  it('lets an auto-hide outrank the suspension', () => {
    decisionFlags.isAutoHidden = true;

    renderDetail();

    expect(screen.queryByText('Account Suspended')).not.toBeInTheDocument();
    expect((threadContextProps.last?.goneCause as { kind: string } | undefined)?.kind).not.toBe('suspended');
  });

  it('lets a ban outrank the suspension', () => {
    status.value.isUserBanned = true;

    renderDetail();

    expect(screen.queryByText('Account Suspended')).not.toBeInTheDocument();
    expect((threadContextProps.last?.goneCause as { kind: string } | undefined)?.kind).not.toBe('suspended');
  });

  it('lets an event ban outrank the suspension', () => {
    status.value.isEventBanned = true;

    renderDetail();

    expect(screen.getByText('Event Banned')).toBeInTheDocument();
    expect((threadContextProps.last?.goneCause as { kind: string } | undefined)?.kind).not.toBe('suspended');
  });

  // A suspension explains the missing post only when both bans are confirmed
  // absent. Otherwise one of them might, and nothing confirms which.
  it('does not credit the suspension while the account ban is unknown', () => {
    status.value.isUserBanned = null;

    renderDetail();

    // Still headlined as suspended (confirmed), but styled as an unknown cause.
    expect(removedBadge('Account Suspended').querySelector('.lucide-triangle-alert, .lucide-alert-triangle')).not.toBeNull();
    expect((threadContextProps.last?.goneCause as { kind: string } | undefined)?.kind).not.toBe('suspended');
    expect((threadContextProps.last?.goneCause as { kind: string } | undefined)?.kind).toBe('unknown');
  });

  it('does not credit the suspension while the event ban is unknown', () => {
    status.value.isEventBanned = null;

    renderDetail();

    expect(removedBadge('Account Suspended').querySelector('.lucide-triangle-alert, .lucide-alert-triangle')).not.toBeNull();
    expect((threadContextProps.last?.goneCause as { kind: string } | undefined)?.kind).not.toBe('suspended');
    expect((threadContextProps.last?.goneCause as { kind: string } | undefined)?.kind).toBe('unknown');
  });

  it('says the cause is unknown, not that the post was removed, when the suspension could not be checked', async () => {
    status.value.isUserSuspended = null;

    renderDetail();

    expect((threadContextProps.last?.goneCause as { kind: string } | undefined)?.kind).toBe('unknown');
    expect((threadContextProps.last?.goneCause as { line?: string } | undefined)?.line).toMatch(/Couldn't check/);
    const tip = await removedBadgeTooltip('Not Found on Relay');
    expect(tip).toMatch(/Couldn't check whether the account is suspended\. That would hide it/);
    expect(tip).not.toMatch(/self-deleted/);
  });

  it('says the cause is still being checked while the suspended list is being read', async () => {
    status.value.isUserSuspended = null;
    status.value.isUserSuspensionChecking = true;

    renderDetail();

    expect((threadContextProps.last?.goneCause as { line?: string } | undefined)?.line).toMatch(/Still checking/);
    const tip = await removedBadgeTooltip('Not Found on Relay');
    expect(tip).toMatch(/Still checking whether the account is suspended\. That would hide it/);
  });

  it('keeps the plain not-found explanation when every status is known and none explains it', async () => {
    status.value.isUserSuspended = false;

    renderDetail();

    expect((threadContextProps.last?.goneCause as { kind: string } | undefined)?.kind).not.toBe('unknown');
    const tip = await removedBadgeTooltip('Not Found on Relay');
    expect(tip).toBe('Not returned by the relay. It may have been self-deleted, held for review, or never stored here.');
  });

  it('lets a recorded delete outrank an unknown cause', () => {
    status.value.isUserSuspended = null;
    decisionFlags.isDeleted = true;

    renderDetail();

    expect((threadContextProps.last?.goneCause as { kind: string } | undefined)?.kind).not.toBe('unknown');
  });

  it('lets an auto-hide outrank an unknown cause', () => {
    status.value.isUserSuspended = null;
    decisionFlags.isAutoHidden = true;

    renderDetail();

    expect((threadContextProps.last?.goneCause as { kind: string } | undefined)?.kind).not.toBe('unknown');
  });

  // Red and ShieldX read as a removal. A withheld post and an unknown cause are
  // not removals, so they are styled like "Banned (last known)".
  function removedBadge(label: string) {
    const badge = screen.getAllByText(label).find(el => el.classList.contains('cursor-help'));
    expect(badge).toBeDefined();
    return badge!;
  }

  it('does not style a post hidden by a suspension as a removal', () => {
    renderDetail();

    const badge = removedBadge('Account Suspended');
    expect(badge.className).not.toMatch(/bg-destructive/);
    expect(badge.querySelector('.lucide-eye-off')).not.toBeNull();
    expect(badge.querySelector('.lucide-shield-x')).toBeNull();
  });

  it('does not style a post whose cause is unknown as a removal', () => {
    status.value.isUserSuspended = null;

    renderDetail();

    const badge = removedBadge('Not Found on Relay');
    expect(badge.className).not.toMatch(/bg-destructive/);
    expect(badge.querySelector('.lucide-shield-x')).toBeNull();
  });

  // Every status answered and none explains it: not a known removal either,
  // matching the thread panel's neutral line.
  it('does not style a post nothing explains as a removal', () => {
    status.value.isUserSuspended = false;

    renderDetail();

    const badge = removedBadge('Not Found on Relay');
    expect(badge.className).not.toMatch(/bg-destructive/);
    expect(badge.querySelector('.lucide-triangle-alert, .lucide-alert-triangle')).not.toBeNull();
  });

  it('keeps the removal styling for a cause the badge states itself', () => {
    decisionFlags.isDeleted = true;

    renderDetail();

    const badge = removedBadge('Removed by Moderation');
    expect(badge.className).toMatch(/bg-destructive/);
    expect(badge.querySelector('.lucide-shield-x')).not.toBeNull();
  });

  it('does not let a stale ban outrank a confirmed suspension', () => {
    status.value.isUserBanned = true;
    status.value.isUserBannedStale = true;

    renderDetail();

    expect((threadContextProps.last?.goneCause as { kind: string } | undefined)?.kind).toBe('unknown');
    // A confirmed suspension is the headline; the kept ban is named in the
    // tooltip as last known. Styled as unknown, not as a removal.
    const badge = removedBadge('Account Suspended');
    expect(badge.className).not.toMatch(/bg-destructive/);
  });

  it('says still checking while the decision log is loading', () => {
    decisionFlags.isPending = true;

    renderDetail();

    expect((threadContextProps.last?.goneCause as { line?: string } | undefined)?.line)
      .toMatch(/Still checking whether a moderator also removed it/);
  });

  it('calls the cause unknown when the decision log could not be read', () => {
    decisionFlags.error = new Error('worker unreachable');

    renderDetail();

    expect((threadContextProps.last?.goneCause as { line?: string } | undefined)?.line)
      .toMatch(/Couldn't check whether a moderator also removed it/);
  });

  it('does not let a stale event ban explain the post', () => {
    status.value.isEventBanned = true;
    status.value.isEventBannedStale = true;

    renderDetail();

    expect((threadContextProps.last?.goneCause as { kind: string } | undefined)?.kind).toBe('unknown');
  });

  // A kept (stale) account ban must not outrank a confirmed event ban: only a
  // confirmed account ban does.
  it('explains a post removed with a confirmed ban, in the badge and its tooltip', async () => {
    status.value.isUserBanned = true;

    renderDetail();

    expect(await removedBadgeTooltip('User Banned')).toBe('The account is banned; its posts were removed as part of the ban');
  });

  it('names a confirmed event ban over a stale account ban, in the badge and its tooltip', async () => {
    status.value.isUserBanned = true;
    status.value.isUserBannedStale = true;
    status.value.isEventBanned = true;

    renderDetail();

    const tip = await removedBadgeTooltip('Event Banned');
    expect(tip).toBe("The event is in the relay's ban list");
    expect((threadContextProps.last?.goneCause as { kind: string } | undefined)?.kind).toBe('explained');
  });

  it('lets a confirmed ban outrank an unknown suspension', () => {
    status.value.isUserSuspended = null;
    status.value.isUserBanned = true;

    renderDetail();

    expect((threadContextProps.last?.goneCause as { kind: string } | undefined)?.kind).not.toBe('unknown');
  });

  it('lets a confirmed event ban outrank an unknown suspension', () => {
    status.value.isUserSuspended = null;
    status.value.isEventBanned = true;

    renderDetail();

    expect((threadContextProps.last?.goneCause as { kind: string } | undefined)?.kind).not.toBe('unknown');
  });

  it('does not call a post the relay still has a cause-unknown removal', () => {
    status.value.isUserSuspended = null;
    status.value.isEventGone = false;

    renderDetail();

    expect((threadContextProps.last?.goneCause as { kind: string } | undefined)?.kind).not.toBe('unknown');
  });

  // EventActions reads isEventBanned as "the post is banned": it offers Restore
  // ("reverses the ban") and hides Ban and Delete. A suspension banned nothing.
  it('does not tell the post actions a post hidden by a suspension is banned', () => {
    renderDetail();

    expect(eventActionsProps.last?.isEventBanned).toBe(false);
  });

  it('still tells the post actions a post the relay ban list holds is banned', () => {
    status.value.isUserSuspended = false;
    status.value.isEventBanned = true;

    renderDetail();

    expect(eventActionsProps.last?.isEventBanned).toBe(true);
  });

  // The cause is unknown only because the decision log failed, but the event
  // ban list confirmed the post is not banned: no "Restore Event / reverses
  // the ban", and Ban and Delete stay.
  it('does not tell the post actions a post is banned when the event ban is confirmed absent and the cause is unknown', () => {
    decisionFlags.error = new Error('worker unreachable');

    renderDetail();

    expect((threadContextProps.last?.goneCause as { kind: string } | undefined)?.kind).toBe('unknown');
    expect(eventActionsProps.last?.isEventBanned).toBe(false);
  });

  // Every status answered, the event ban among them, and none explains it.
  it('does not tell the post actions a post is banned when the event ban is confirmed absent', () => {
    status.value.isUserSuspended = false;

    renderDetail();

    expect(eventActionsProps.last?.isEventBanned).toBe(false);
  });

  // EventActions' `null`: nobody has said whether the post is banned, so it
  // keeps Ban and Delete and leaves out Restore. A missing post used to be
  // passed as banned whenever the banned-events list had not answered (#371).
  describe('post actions while the event ban is unconfirmed', () => {
    beforeEach(() => {
      status.value.isUserSuspended = false;
      status.value.isEventBanned = null;
    });

    it('calls the ban status unknown, not banned, when the banned-events list could not be read', () => {
      renderDetail();

      expect(eventActionsProps.last?.isEventBanned).toBe(null);
      expect(eventActionsProps.last?.statusPending).toBe(false);
    });

    it('says the ban status is still being checked while the banned-events list is being read', () => {
      status.value.isEventBanChecking = true;

      renderDetail();

      expect(eventActionsProps.last?.isEventBanned).toBe(null);
      expect(eventActionsProps.last?.statusPending).toBe(true);
    });

    it('says the ban status is still being checked while the live check runs', () => {
      status.value.isEventGone = null;
      status.value.isChecking = true;

      renderDetail();

      expect(eventActionsProps.last?.isEventBanned).toBe(null);
      expect(eventActionsProps.last?.statusPending).toBe(true);
    });

    // A ban kept from a list whose refresh failed may have been lifted.
    it('does not treat a kept event ban as confirmed', () => {
      status.value.isEventBanned = true;
      status.value.isEventBannedStale = true;

      renderDetail();

      expect(eventActionsProps.last?.isEventBanned).toBe(null);
    });

    // The live check that found the post can be older than the ban the list
    // last confirmed, so it does not settle a kept ban.
    it('does not let a live check that found the post override a kept event ban', () => {
      status.value.isEventBanned = true;
      status.value.isEventBannedStale = true;
      status.value.isEventGone = false;

      renderDetail();

      expect(eventActionsProps.last?.isEventBanned).toBe(null);
    });

    // Funnelcake's getbannedevent also answers for a post under an active
    // moderation hold, which is not in its ban table and which Restore (an
    // unban) does not lift. So the post it returns is shown, but it is not
    // evidence of a ban.
    it('does not treat a post the getbannedevent read returned as banned', () => {
      bannedEventRead.value = { data: { ...REPORT, id: EVENT_ID, kind: 1 }, isLoading: false };

      renderDetail();

      expect(eventActionsProps.last?.isEventBanned).toBe(null);
    });

    // The live check's "found it" is kept from when it ran, so a ban made since
    // (with the list's refresh then failing) would be missed.
    it('does not settle the ban status from a live check that found the post', () => {
      status.value.isEventGone = false;

      renderDetail();

      expect(eventActionsProps.last?.isEventBanned).toBe(null);
    });
  });

  // The verb follows the banned-events list's own read (isEventBanChecking).
  it('says the event ban is still being checked while its list is being read', async () => {
    status.value.isUserSuspended = false;
    status.value.isEventBanned = null;
    status.value.isEventBanChecking = true;

    renderDetail();

    expect(await removedBadgeTooltip('Not Found on Relay')).toMatch(/Still checking whether the event is banned/);
  });

  // After an Unsuspend the card must re-read, or it keeps the cached "hidden"
  // or "0 events" for useUserStats' 2 minute staleTime. The key is the hook's
  // own shape, relay URL included (useUserStats.test pins that side).
  const STATS_KEY = ['user-stats', 'wss://relay.example', REPORTED_PUBKEY];

  async function completeAction(change: UserActionChange) {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    qc.setQueryData(STATS_KEY, { postCount: 0 });
    renderDetail(qc);
    const onActionComplete = userActionsProps.last?.onActionComplete as (c?: UserActionChange) => void;
    await act(async () => { onActionComplete(change); });
    return qc;
  }

  it("marks the reported account's cached stats stale after a content action", async () => {
    const qc = await completeAction({ accountStatusChanged: false });

    expect(qc.getQueryState(STATS_KEY)?.isInvalidated).toBe(true);
  });

  it("hands the account's suspension to the user card", () => {
    status.value.isUserSuspendedStale = true;

    renderDetail();

    expect(userCardProps.last?.isSuspended).toBe(true);
    expect(userCardProps.last?.isSuspendedStale).toBe(true);
  });

  // Only a read of the suspended list in flight: the ban list or the live
  // check still being out does not make an unknown suspension "being checked".
  it('does not tell the user card the suspension is being checked when only the ban status is', () => {
    status.value.isUserSuspended = null;
    status.value.isAccountStatusLoading = true;
    status.value.isUserSuspensionChecking = false;

    renderDetail();

    expect(userCardProps.last?.isSuspensionChecking).toBe(false);
  });

  it('tells the user card when the suspension is still being checked', () => {
    status.value.isUserSuspended = null;
    status.value.isUserSuspensionChecking = true;

    renderDetail();

    expect(userCardProps.last?.isSuspended).toBe(null);
    expect(userCardProps.last?.isSuspensionChecking).toBe(true);
  });
});
