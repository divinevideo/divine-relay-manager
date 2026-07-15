// ABOUTME: Pure helpers for resolving a Reports deep-link when the target may
// ABOUTME: no longer be on the relay. No React, no I/O — unit-testable.

export type DeepLinkStatus = 'idle' | 'resolving' | 'found' | 'gone' | 'unavailable';

// Classify a targeted relay lookup for a deep-link's report. A failed request
// (timeout/502) is 'unavailable' — never treated as 'gone' — so a transient
// relay problem is not reported to a moderator as a deletion.
export function classifyTargetedFetch(
  outcome: { ok: boolean; events?: unknown[] }
): 'found' | 'gone' | 'unavailable' {
  if (!outcome.ok) return 'unavailable';
  return (outcome.events?.length ?? 0) > 0 ? 'found' : 'gone';
}

// The moderation decisions recorded for a target, matching both the raw id and
// the mobile "user_<pubkey>" form the report/decision pipeline sometimes uses.
// Generic so it preserves the caller's element type (e.g. ModerationDecision).
export function decisionsForTarget<T extends { target_id: string }>(
  allDecisions: T[] | undefined,
  targetValue: string
): T[] {
  if (!allDecisions) return [];
  return allDecisions.filter(
    (d) => d.target_id === targetValue || d.target_id === `user_${targetValue}`
  );
}
