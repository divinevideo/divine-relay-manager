export const AUTO_HIDE_ACTION = {
  hidden: 'auto_hidden',
  pending: 'auto_hide_pending',
  skipped: 'auto_hide_skipped',
  failed: 'auto_hide_failed',
} as const;

export const AUTO_HIDE_ACTIONS = [
  AUTO_HIDE_ACTION.hidden,
  AUTO_HIDE_ACTION.pending,
  AUTO_HIDE_ACTION.skipped,
  AUTO_HIDE_ACTION.failed,
] as const;

export type AutoHideAction = typeof AUTO_HIDE_ACTIONS[number];

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
