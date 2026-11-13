// ABOUTME: Who sits behind the queue's sensitive pending-review switch, and how each is labelled.
// ABOUTME: Auto-hidden targets, plus unhandled CSAM-signal targets that nothing has hidden.

import { AUTO_HIDE_ACTION, type AutoHideStateRowLike } from '../../shared/autohide';
import { REOPENED_ACTION, reportTime } from '../../shared/handling';
import { hasCsamSignal } from './constants';
import { groupResolutionStatus, reportResolutionStatus, type QueueResolution } from './reportResolution';

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
// unix-seconds time of the latest such row. null: no row has a date, either
// because it predates timestamps (an undated row predates every dated one, as
// in handlingByTarget) or because a worker from before #324 sends no `at`.
// TODO(#409): reading an absent `at` as null serves only a worker from before
// #324; once none can be live, an absent `at` is malformed like any other.
//
// A person's auto-hide choice answers only the reports that reached us before
// it (#324): buildSwitchMembership compares each report with this time under
// the dated rule. So, as there, a reopen cancels the rows before it. Pass the
// decision log's handling rows to apply that; without them (a worker from
// before #324, whose Reopen deleted rows instead) nothing is cancelled.
export function humanHandledAutoHideTargets(
  states: readonly AutoHideStateRowLike[],
  handlingRows: readonly { target_type: string; target_id: string; action: string; at: number | null }[] = [],
): Map<string, number | null> {
  const reopened = new Map<string, number | null>();
  for (const row of handlingRows) {
    if (row.action !== REOPENED_ACTION) continue;
    const key = `${row.target_type}:${row.target_id}`;
    const prev = reopened.get(key);
    // An undated reopen still cancels every undated row; any dated one wins.
    reopened.set(key, row.at === null ? (prev ?? null) : Math.max(prev ?? -Infinity, row.at));
  }

  const handled = new Map<string, number | null>();
  for (const row of states) {
    if (!HUMAN_AUTO_HIDE_ACTIONS.includes(row.action)) continue;
    // A malformed date is skipped, as parseHandlingRows skips a human row's:
    // read as undated it would answer every report and take a CSAM-signal
    // target out of here. Dropping handling keeps a target in, never out.
    if (row.at !== undefined && row.at !== null && !(typeof row.at === 'number' && Number.isFinite(row.at))) continue;
    const key = `${row.target_type}:${row.target_id}`;
    const at = typeof row.at === 'number' ? row.at : null;
    if (reopened.has(key)) {
      // Only a dated row after the latest dated reopen survives it.
      const reopenedAt = reopened.get(key) ?? -Infinity;
      if (at === null || at <= reopenedAt) continue;
    }
    const prev = handled.get(key);
    handled.set(key, at === null ? (prev ?? null) : Math.max(prev ?? -Infinity, at));
  }
  return handled;
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
// A CSAM-signal target leaves only when every report on it is 'handled'. One
// that is 'handled_before' (a person handled it, then a report came) is as
// unanswered as a new one, so it stays here rather than reaching the main
// list or the queue's handled-before section (#324).
//
// A person's auto-hide choice (humanHandled) answers a report too, but under
// the dated rule only one that reached us before it, by the same comparison
// as reportStatus: strictly before, so a report in the same second stays. Auto-
// hide rows are not handling to the queue (#332), so without this a target
// whose hide a person confirmed would leave here for good, and a CSAM-signal
// report that came after would land in the main list.
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
    if (!hasCsamSignal(c.reports)) continue;
    if (isAnswered(c, key, args.humanHandled, args.resolution)) continue;
    membership.set(key, 'not-hidden');
  }
  return membership;
}

function isAnswered(
  c: SwitchCandidate,
  key: string,
  humanHandled: ReadonlyMap<string, number | null>,
  resolution: QueueResolution,
): boolean {
  // TODO(#409): the membership branch serves only a worker without handling
  // dates; it reads any human auto-hide row as answering every report, as the
  // switch did before #324.
  if (resolution.rule === 'membership') {
    return humanHandled.has(key) || groupResolutionStatus(c, resolution) === 'handled';
  }
  // A candidate here has at least one report: its CSAM signal comes from one.
  const autoHideAt = humanHandled.get(key);
  return c.reports.every(report => {
    if (humanHandled.has(key)) {
      if (autoHideAt === null || autoHideAt === undefined) return true;
      if (autoHideAt > reportTime(report, resolution.ctx.arrivals)) return true;
    }
    return reportResolutionStatus(
      { target: c.target, authorPubkey: c.authorPubkey, id: report.id, created_at: report.created_at },
      resolution,
    ) === 'handled';
  });
}

export const SWITCH_STATE_LABELS: Record<SwitchState, string> = {
  'auto-hidden': 'Hidden automatically',
  'hidden-needs-check': 'Hidden, needs a check',
  'not-hidden': 'Not hidden, needs review',
};
