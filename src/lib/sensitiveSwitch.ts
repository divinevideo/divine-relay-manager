// ABOUTME: Who sits behind the queue's sensitive pending-review switch, and how each is labelled.
// ABOUTME: Auto-hidden targets, plus targets with an unanswered CSAM-signal report that nothing has hidden.

import { AUTO_HIDE_ACTION, type AutoHideStateRowLike } from '../../shared/autohide';
import { reportTime } from '../../shared/handling';
import { hasCsamSignal } from './constants';
import {
  groupResolutionStatus,
  latestAutoHideAtByTarget,
  reportResolutionStatus,
  type QueueResolution,
} from './reportResolution';

// 'hidden-needs-check' is an auto-hidden target whose latest state is
// auto_hide_unresolved or auto_hide_restore_failed. The worker writes both only
// after the relay ban landed, so the content is hidden either way:
// - unresolved: it could not read whether a moderator's restore raced the ban.
// - restore failed: a moderator's restore raced the ban, and the worker's
//   attempt to undo the ban failed.
export type SwitchState = 'auto-hidden' | 'hidden-needs-check' | 'not-hidden';

// The auto-hide states that record a person's choice. A person confirms the
// hide or restores the content; the worker writes `auto_hide_reversed` when a
// person's restore raced its hide. ANY such row counts, not just the newest,
// because a person has looked at the target either way. Without this, a
// restored post (the restore writes only `auto_hide_restored`, which the
// resolved set does not include) would drop straight back behind the switch.
const HUMAN_AUTO_HIDE_ACTIONS: readonly string[] = [
  AUTO_HIDE_ACTION.confirmed,
  AUTO_HIDE_ACTION.restored,
  AUTO_HIDE_ACTION.reversed,
];

// Each target a person handled through auto-hide, keyed as stored, with the
// unix-seconds time of the latest such row (see latestAutoHideAtByTarget for
// undated rows and reopens).
//
// A person's auto-hide choice answers only the reports that reached us before
// it (#324): buildSwitchMembership compares each report with this time under
// the dated rule.
export function humanHandledAutoHideTargets(
  states: readonly AutoHideStateRowLike[],
  handlingRows: readonly { target_type: string; target_id: string; action: string; at: number | null }[] = [],
): Map<string, number | null> {
  return latestAutoHideAtByTarget(states, HUMAN_AUTO_HIDE_ACTIONS, handlingRows);
}

interface SwitchCandidate {
  target: { type: 'event' | 'pubkey'; value: string };
  authorPubkey?: string;
  reports: readonly { id: string; created_at: number; tags: string[][]; content?: string }[];
}

// Membership is computed from resolution state BEFORE the view's own Hide
// resolved setting applies: turning the switch on turns Hide resolved off, so
// a handled target has to be out of here already or it would sit behind the
// switch for good. While a resolution source is still loading, what the
// resolution reads is partial and a CSAM target stays in. That is the safe
// direction: it is kept out of the default view, not shown there.
//
// A target is here while a report no person has answered carries a CSAM
// signal. A CSAM-signal report that is 'handled_before' (a person handled the
// target, then the report came) is as unanswered as a new one, so it stays
// here rather than reaching the main list or the queue's handled-before
// section (#324). A CSAM-signal report a person did answer keeps nothing here:
// the target goes where the queue's own rule puts it, the handled-before
// section when a decision or label answered it and a later report has no
// signal. The feed drops answered reports, and a deep link's full read brings
// them back, so counting their signal would move the target with what is in
// hand.
//
// A person's auto-hide choice (humanHandled) answers a report too, but under
// the dated rule only one that reached us before it, by the same comparison
// as reportStatus: strictly before, so a report in the same second stays. Auto-
// hide rows are not handling to the queue (#332), so without this a post whose
// hide a person restored would leave here for good, and a CSAM-signal report
// that came after would land in the main list. A confirmed hide leaves the
// post banned, and the queue's own rule dates that ban by the confirm
// (reportResolution.ts withConfirmedBan), so a later report there is
// 'handled_before' and stays here too.
export function buildSwitchMembership(args: {
  consolidated: readonly SwitchCandidate[];
  // Auto-hidden targets pending review, keyed to their latest auto-hide state.
  pendingReview: ReadonlyMap<string, string>;
  // humanHandledAutoHideTargets: the latest human auto-hide time per target.
  humanHandled: ReadonlyMap<string, number | null>;
  // The queue's rule. Under the dated rule it is the queue's own: automated
  // decisions are not handling there (#332). Under the membership rule (a
  // worker without handling dates) its set must leave out the decisions only
  // the worker wrote (resolution-state's `automated`): those still count for
  // Hide resolved, but no person has looked at the target, so they do not take
  // it out of here.
  resolution: QueueResolution;
}): Map<string, SwitchState> {
  const membership = new Map<string, SwitchState>();
  // Every auto-hidden target, whether or not its reports are loaded.
  for (const [key, latestAction] of args.pendingReview) {
    membership.set(
      key,
      latestAction === AUTO_HIDE_ACTION.unresolved || latestAction === AUTO_HIDE_ACTION.restoreFailed
        ? 'hidden-needs-check'
        : 'auto-hidden',
    );
  }

  for (const c of args.consolidated) {
    const key = `${c.target.type}:${c.target.value}`;
    // Auto-hidden wins: a hidden target with a CSAM report is listed once.
    if (membership.has(key)) continue;
    if (!hasCsamSignal(unansweredReports(c, key, args.humanHandled, args.resolution))) continue;
    membership.set(key, 'not-hidden');
  }
  return membership;
}

// The candidate's reports that no person has answered.
function unansweredReports(
  c: SwitchCandidate,
  key: string,
  humanHandled: ReadonlyMap<string, number | null>,
  resolution: QueueResolution,
): SwitchCandidate['reports'] {
  // TODO(#409): the membership branch serves only a worker without handling
  // dates; it reads any human auto-hide row as answering every report, as the
  // switch did before #324.
  if (resolution.rule === 'membership') {
    const answered = humanHandled.has(key) || groupResolutionStatus(c, resolution) === 'handled';
    return answered ? [] : c.reports;
  }
  const autoHideAt = humanHandled.get(key);
  return c.reports.filter(report => {
    if (humanHandled.has(key)) {
      if (autoHideAt === null || autoHideAt === undefined) return false;
      if (autoHideAt > reportTime(report, resolution.ctx.arrivals)) return false;
    }
    return reportResolutionStatus(
      { target: c.target, authorPubkey: c.authorPubkey, id: report.id, created_at: report.created_at },
      resolution,
    ) !== 'handled';
  });
}

export const SWITCH_STATE_LABELS: Record<SwitchState, string> = {
  'auto-hidden': 'Hidden automatically',
  'hidden-needs-check': 'Hidden, needs a check',
  'not-hidden': 'Not hidden, needs review',
};
