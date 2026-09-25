// ABOUTME: Selects the reports whose target still needs a moderator, at any age.
// ABOUTME: The worker's half of resolution: decisions and labels. Bans stay client-side.

import { getReportTarget, reportTargetKey } from '../../shared/report-target';

export interface RelayReport {
  id: string;
  created_at: number;
  tags: string[][];
}

// The targets the worker can call resolved: any resolution label, and any human
// decision on an event or pubkey. Auto-hide actions are already excluded by
// getResolvedTargets -- auto-hidden content is waiting FOR review, not handled.
// Other target types (media) never match a report, which is why the client's
// resolvedTargets ignores them too.
export function resolvedKeysFrom(
  decisions: readonly { target_type: string; target_id: string }[],
  labels: readonly { type: string; value: string }[],
): Set<string> {
  const keys = new Set<string>();
  for (const label of labels) keys.add(`${label.type}:${label.value}`);
  for (const decision of decisions) {
    if (decision.target_type === 'pubkey' || decision.target_type === 'event') {
      keys.add(`${decision.target_type}:${decision.target_id}`);
    }
  }
  return keys;
}

// Needing attention = unresolved OR pending review. The union is load-bearing:
// a target can be both resolved and pending review, and dropping it would leave
// the pending-review view with a badge and no rows.
//
// Resolution here covers decisions and labels only. Targets resolved by a relay
// ban are returned and filtered client-side, which keeps each ban list's own
// failure handling in the queue (#221).
//
// counts.targets and counts.resolved are both counts of distinct TARGETS, never
// of report events. A report naming no usable target is kept, as the client
// keeps it, and counted in neither.
export function selectReportsNeedingAttention<T extends RelayReport>(
  reports: readonly T[],
  resolved: ReadonlySet<string>,
  pendingReview: ReadonlySet<string>,
): { events: T[]; counts: { targets: number; resolved: number } } {
  const events: T[] = [];
  const keptTargets = new Set<string>();
  const resolvedTargets = new Set<string>();

  for (const report of reports) {
    const target = getReportTarget(report);
    if (!target) {
      events.push(report);
      continue;
    }
    const key = reportTargetKey(target);
    if (resolved.has(key) && !pendingReview.has(key)) {
      resolvedTargets.add(key);
      continue;
    }
    events.push(report);
    keptTargets.add(key);
  }

  return { events, counts: { targets: keptTargets.size, resolved: resolvedTargets.size } };
}
