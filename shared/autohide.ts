export const AUTO_HIDE_ACTION = {
  hidden: 'auto_hidden',
  pending: 'auto_hide_pending',
  skipped: 'auto_hide_skipped',
  failed: 'auto_hide_failed',
  unresolved: 'auto_hide_unresolved',
  restoreFailed: 'auto_hide_restore_failed',
  reversed: 'auto_hide_reversed',
  restored: 'auto_hide_restored',
  confirmed: 'auto_hide_confirmed',
} as const;

export const AUTO_HIDE_ACTIONS = [
  AUTO_HIDE_ACTION.hidden,
  AUTO_HIDE_ACTION.pending,
  AUTO_HIDE_ACTION.skipped,
  AUTO_HIDE_ACTION.failed,
  AUTO_HIDE_ACTION.unresolved,
  AUTO_HIDE_ACTION.restoreFailed,
  AUTO_HIDE_ACTION.reversed,
  AUTO_HIDE_ACTION.restored,
  AUTO_HIDE_ACTION.confirmed,
] as const;

export type AutoHideAction = typeof AUTO_HIDE_ACTIONS[number];

export const AUTO_HIDE_STATE_ACTIONS = [
  AUTO_HIDE_ACTION.hidden,
  AUTO_HIDE_ACTION.unresolved,
  AUTO_HIDE_ACTION.restoreFailed,
  AUTO_HIDE_ACTION.confirmed,
  AUTO_HIDE_ACTION.restored,
  AUTO_HIDE_ACTION.reversed,
] as const;

export function getLatestAutoHideState(actions: readonly string[]): string | undefined {
  const stateActions: readonly string[] = AUTO_HIDE_STATE_ACTIONS;
  return actions.find(action => stateActions.includes(action));
}

export const AUTO_HIDE_TIER_KINDS = ['immediate', 'threshold'] as const;
export type AutoHideTierKind = typeof AUTO_HIDE_TIER_KINDS[number];

export interface AutoHideTier {
  kind: AutoHideTierKind;
  name: string;
  categories: string[];
  threshold: number;
  requireTrustedClient: boolean;
}

export interface AutoHideConfig {
  enabled: boolean;
  trustedClients: string[];
  tiers: AutoHideTier[];
}

export function isImmediateAutoHideTier(tier: AutoHideTier): boolean {
  return tier.kind === 'immediate';
}

export function isThresholdAutoHideTier(tier: AutoHideTier): boolean {
  return tier.kind === 'threshold';
}

export interface AutoHideStateRowLike {
  target_type: string;
  target_id: string;
  action: string;
}

// Targets auto-hidden and still waiting for a human: the newest auto-hide state
// is hidden, unresolved, or a restore that failed. Rows must arrive newest
// first -- the order getAutoHideStates returns -- because getLatestAutoHideState
// takes the first state transition per target as authoritative.
//
// One definition for the worker, which keeps these targets in the queue
// payload, and the client, which splits them into the pending-review view. Two
// copies would let the badge and the list it filters disagree again.
export function pendingReviewTargetKeys(rows: readonly AutoHideStateRowLike[]): Set<string> {
  const actionsByTarget = new Map<string, string[]>();
  for (const row of rows) {
    const key = `${row.target_type}:${row.target_id}`;
    const actions = actionsByTarget.get(key);
    if (actions) actions.push(row.action);
    else actionsByTarget.set(key, [row.action]);
  }

  const pending = new Set<string>();
  for (const [key, actions] of actionsByTarget) {
    const latest = getLatestAutoHideState(actions);
    if (
      latest === AUTO_HIDE_ACTION.hidden
      || latest === AUTO_HIDE_ACTION.unresolved
      || latest === AUTO_HIDE_ACTION.restoreFailed
    ) {
      pending.add(key);
    }
  }
  return pending;
}
