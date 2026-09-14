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

