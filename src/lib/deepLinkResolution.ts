// ABOUTME: Pure helpers for resolving a Reports deep-link when the target may
// ABOUTME: no longer be on the relay. No React, no I/O — unit-testable.

export type DeepLinkStatus = 'idle' | 'resolving' | 'found' | 'gone' | 'unavailable';

// Classify a successful targeted relay lookup for a deep-link's report.
// Failed requests throw at the API boundary and are surfaced as 'unavailable'
// by the component's catch path.
export function classifyTargetedFetch(events: unknown[]): 'found' | 'gone' {
  return events.length > 0 ? 'found' : 'gone';
}

// Prefer reports whose resolved target (via the caller's getReportTarget) matches
// the deep-link target for display. This is not an existence gate: the relay's
// own #e/#p filter result is authoritative for found/gone.
export function reportsMatchingTarget<E>(
  events: E[],
  target: { type: string; value: string },
  getTarget: (event: E) => { type: string; value: string } | null
): E[] {
  return events.filter((e) => {
    const t = getTarget(e);
    return t !== null && t.type === target.type && t.value === target.value;
  });
}

// The moderation decisions recorded for a target. Every decision writer keys
// target_id on the bare pubkey/event id (ReportWatcher.logDecision, handleLogDecision,
// bulk-moderate — including age_review_case_created), so an exact match is complete.
// Generic so it preserves the caller's element type (e.g. ModerationDecision).
export function decisionsForTarget<T extends { target_id: string }>(
  allDecisions: T[] | undefined,
  targetValue: string
): T[] {
  if (!allDecisions) return [];
  return allDecisions.filter((d) => d.target_id === targetValue);
}
