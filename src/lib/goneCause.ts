// ABOUTME: Why a reported post the relay won't return is gone, from what was actually answered.
// ABOUTME: One derivation, so report detail's badge, its tooltip and its thread panel give the same reason.

import { GONE_NO_CAUSE_LINE, goneCauseUnknownLine, suspendedBadgeLabel, suspendedMissingPostLine } from '@/lib/suspendedContent';
import { SWITCH_STATE_LABELS } from '@/lib/sensitiveSwitch';

/** A cause the badge states itself, in the order it is ranked. */
export type ExplainedBy = 'delete' | 'auto-hide' | 'ban' | 'event-ban';

/**
 * How the badge reads: a removal the badge states (red, ShieldX), a post
 * withheld for a suspension, or a cause nobody has established (outline,
 * AlertTriangle): one that has not answered yet, or none found at all.
 */
export type GoneTone = 'removal' | 'withheld' | 'unknown';

export type GoneCause =
  /** The live check found the post, or has not said it is gone. */
  | { kind: 'not-gone' }
  /** Gone for a reason the badge states itself. */
  | { kind: 'explained'; by: ExplainedBy; line: string; badge: string; tone: GoneTone }
  /** The relay withholds the post because the account is suspended. */
  | { kind: 'suspended'; stale: boolean; line: string; badge: string; tone: GoneTone }
  /** A status that would explain it has not answered. The post may still exist. */
  | { kind: 'unknown'; line: string; badge: string; tone: GoneTone }
  /** Everything answered and nothing explains it. Not a deletion either. */
  | { kind: 'none-found'; line: string; badge: string; tone: GoneTone };

export interface GoneCauseInput {
  /** useModerationStatus's isEventGone */
  eventGone: boolean | null;
  /** D1 decision log: a delete is recorded */
  recordedDelete: boolean;
  /** D1 decision log: an auto-hide is in force */
  autoHidden: boolean;
  /**
   * The decision log has not been read: 'checking' while its read is out,
   * 'failed' when it errored. A delete or auto-hide it did read still counts.
   */
  decisionsUnread: 'checking' | 'failed' | null;
  userBanned: boolean | null;
  /** useModerationStatus's isUserBannedStale: the ban is last known, not confirmed. */
  userBannedStale: boolean;
  eventBanned: boolean | null;
  /** useModerationStatus's isEventBannedStale: the event ban is last known, not confirmed. */
  eventBannedStale: boolean;
  suspended: boolean | null;
  suspendedStale: boolean;
  /**
   * Per status, whether its read is still out (as opposed to failed). From
   * useModerationStatus's isUserSuspensionChecking, isUserBanChecking (which the
   * thread panel's ban line also follows) and isEventBanChecking.
   */
  checking: { suspension: boolean; accountBan: boolean; eventBan: boolean };
}

const EXPLAINED_BADGE: Record<ExplainedBy, string> = {
  delete: 'Removed by Moderation',
  // Worded as the queue row and header badge word a plain one.
  'auto-hide': SWITCH_STATE_LABELS['auto-hidden'],
  ban: 'User Banned',
  'event-ban': 'Event Banned',
};

// The thread panel's line for each: "deleted" only for a recorded delete. An
// auto-hide and an event ban hide the post; an account ban removed it. The
// auto-hide line claims no provenance: ReportWatcher auto-hides on AI
// classification, user reports and reporter thresholds alike.
const EXPLAINED_LINE: Record<ExplainedBy, string> = {
  delete: 'Event has been deleted from the relay',
  'auto-hide': 'Hidden automatically',
  ban: 'The account is banned; its posts were removed as part of the ban',
  'event-ban': "The event is in the relay's ban list",
};

export function deriveGoneCause(input: GoneCauseInput): GoneCause {
  const {
    eventGone, recordedDelete, autoHidden, decisionsUnread,
    userBanned, userBannedStale, eventBanned, eventBannedStale,
    suspended, suspendedStale, checking,
  } = input;
  if (eventGone !== true) return { kind: 'not-gone' };

  // Only a confirmed ban explains the post. One kept from a list that could not
  // be refreshed may have been lifted, so its status is unknown. The same holds
  // for the banned-events list, which also keeps a positive after a failure.
  const confirmedBan = userBanned === true && !userBannedStale;
  const confirmedEventBan = eventBanned === true && !eventBannedStale;
  const accountBanUnknown = userBanned === null || (userBanned === true && userBannedStale);
  const eventBanUnknown = eventBanned === null || (eventBanned === true && eventBannedStale);

  const by: ExplainedBy | null = recordedDelete ? 'delete'
    : autoHidden ? 'auto-hide'
    : confirmedBan ? 'ban'
    : confirmedEventBan ? 'event-ban'
    : null;
  if (by) return { kind: 'explained', by, line: EXPLAINED_LINE[by], badge: EXPLAINED_BADGE[by], tone: 'removal' };

  if (suspended === true && userBanned === false && eventBanned === false && decisionsUnread === null) {
    return {
      kind: 'suspended',
      stale: suspendedStale,
      line: suspendedMissingPostLine(suspendedStale),
      badge: suspendedBadgeLabel(suspendedStale),
      tone: 'withheld',
    };
  }

  if (suspended === null || accountBanUnknown || eventBanUnknown || decisionsUnread !== null) {
    const state = (isChecking: boolean) => (isChecking ? 'checking' as const : 'failed' as const);
    return {
      kind: 'unknown',
      line: goneCauseUnknownLine({
        suspended,
        suspendedStale,
        suspension: suspended === null ? state(checking.suspension) : null,
        accountBan: accountBanUnknown ? { state: state(checking.accountBan), stale: userBanned === true } : null,
        eventBan: eventBanUnknown ? { state: state(checking.eventBan), stale: eventBanned === true } : null,
        decisions: decisionsUnread,
      }),
      // The headline is the strongest thing actually known: a suspension the
      // list confirmed, then a ban or event ban carried over as last known.
      badge: suspended === true ? suspendedBadgeLabel(suspendedStale)
        : userBanned === true ? 'Banned (last known)'
        : eventBanned === true ? 'Event Banned (last known)'
        : 'Not Found on Relay',
      tone: 'unknown',
    };
  }

  // Not a removal either: funnelcake withholds things none of these lists
  // report, so the badge reads like the thread panel's neutral line.
  return { kind: 'none-found', line: GONE_NO_CAUSE_LINE, badge: 'Not Found on Relay', tone: 'unknown' };
}
