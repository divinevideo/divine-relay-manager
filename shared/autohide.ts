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

// Targets auto-hidden and still waiting for a human, each keyed to its latest
// auto-hide state: hidden, unresolved, or a restore that failed. Rows must
// arrive newest first -- the order getAutoHideStates returns -- because
// getLatestAutoHideState takes the first state transition per target as
// authoritative. The state is kept because the queue labels a target whose hide
// or restore may not have landed differently from one that is hidden.
//
// The worker uses the keys to keep these targets in the needs-attention
// payload, and the queue uses the whole map to split them into the pending-
// review view. One definition, so the badge and the list it labels cannot
// disagree about which targets are waiting.
export function pendingReviewTargetStates(rows: readonly AutoHideStateRowLike[]): Map<string, string> {
  const actionsByTarget = new Map<string, string[]>();
  for (const row of rows) {
    const key = `${row.target_type}:${row.target_id}`;
    const actions = actionsByTarget.get(key);
    if (actions) actions.push(row.action);
    else actionsByTarget.set(key, [row.action]);
  }

  const pending = new Map<string, string>();
  for (const [key, actions] of actionsByTarget) {
    const latest = getLatestAutoHideState(actions);
    if (
      latest === AUTO_HIDE_ACTION.hidden
      || latest === AUTO_HIDE_ACTION.unresolved
      || latest === AUTO_HIDE_ACTION.restoreFailed
    ) {
      pending.set(key, latest);
    }
  }
  return pending;
}

export function pendingReviewTargetKeys(rows: readonly AutoHideStateRowLike[]): Set<string> {
  return new Set(pendingReviewTargetStates(rows).keys());
}
