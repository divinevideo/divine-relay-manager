// ABOUTME: Who sits behind the queue's sensitive pending-review switch, and how each is labelled.
// ABOUTME: Auto-hidden targets, plus unhandled CSAM-signal targets that nothing has hidden.

import { AUTO_HIDE_ACTION, type AutoHideStateRowLike } from '../../shared/autohide';
import { hasCsamSignal } from './constants';
import { isConsolidatedReportResolved } from './reportResolution';

// 'hide-unconfirmed' is an auto-hidden target whose latest state is
// auto_hide_unresolved or auto_hide_restore_failed: the hide (or a restore)
// may not have landed, so it must not be labelled as hidden.
export type SwitchState = 'auto-hidden' | 'hide-unconfirmed' | 'not-hidden';

// Auto-hide states only a person writes: confirming the hide, restoring the
// content, or reversing the hide. ANY such row counts, not just the newest,
// because a person has looked at the target either way. Without this, a
// restored post (the restore writes only `auto_hide_restored`, which the
// resolved set does not include) would drop straight back behind the switch.
const HUMAN_AUTO_HIDE_ACTIONS: readonly string[] = [
  AUTO_HIDE_ACTION.confirmed,
  AUTO_HIDE_ACTION.restored,
  AUTO_HIDE_ACTION.reversed,
];

export function humanHandledAutoHideTargets(states: readonly AutoHideStateRowLike[]): Set<string> {
  const handled = new Set<string>();
  for (const row of states) {
    if (HUMAN_AUTO_HIDE_ACTIONS.includes(row.action)) {
      handled.add(`${row.target_type}:${row.target_id}`);
    }
  }
  return handled;
}

interface SwitchCandidate {
  target: { type: 'event' | 'pubkey'; value: string };
  authorPubkey?: string;
  reports: readonly { tags: string[][]; content?: string }[];
}

// Membership is computed from resolution state BEFORE the view's own Hide
// resolved setting applies: turning the switch on turns Hide resolved off, so
// a resolved target has to be out of here already or it would sit behind the
// switch for good. While a resolution source is still loading, resolvedTargets
// is partial and a CSAM target stays in. That is the safe direction: it is
// kept out of the default view, not shown there.
export function buildSwitchMembership(args: {
  consolidated: readonly SwitchCandidate[];
  // Auto-hidden targets pending review, keyed to their latest auto-hide state.
  pendingReview: ReadonlyMap<string, string>;
  humanHandled: ReadonlySet<string>;
  resolvedTargets: Set<string>;
  bannedPubkeys: Set<string>;
}): Map<string, SwitchState> {
  const membership = new Map<string, SwitchState>();
  // Every auto-hidden target, whether or not its reports are loaded.
  for (const [key, latestAction] of args.pendingReview) {
    membership.set(
      key,
      latestAction === AUTO_HIDE_ACTION.unresolved || latestAction === AUTO_HIDE_ACTION.restoreFailed
        ? 'hide-unconfirmed'
        : 'auto-hidden',
    );
  }

  for (const c of args.consolidated) {
    const key = `${c.target.type}:${c.target.value}`;
    // Auto-hidden wins: a hidden target with a CSAM report is listed once.
    if (membership.has(key)) continue;
    if (!hasCsamSignal(c.reports)) continue;
    if (args.humanHandled.has(key)) continue;
    if (isConsolidatedReportResolved(c, args.resolvedTargets, args.bannedPubkeys)) continue;
    membership.set(key, 'not-hidden');
  }
  return membership;
}

export const SWITCH_STATE_LABELS: Record<SwitchState, string> = {
  'auto-hidden': 'Hidden automatically',
  'hide-unconfirmed': 'Hide not confirmed',
  'not-hidden': 'Not hidden, needs review',
};
