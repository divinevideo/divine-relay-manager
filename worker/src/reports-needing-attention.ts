// ABOUTME: Selects the reports whose target still needs a moderator, at any age.
// ABOUTME: The worker's half of resolution: decisions and labels. Bans stay client-side.

import { getReportTarget, reportTargetKey } from '../../shared/report-target';
import { queryRelay } from './relay-profile';
import { pageByUntil } from '../../shared/relay-pager';
import { pendingReviewTargetKeys } from '../../shared/autohide';
import { getAutoHideStates, getResolvedTargets } from './resolution-state';
import { LABEL_PAGE_SIZE, pageResolutionLabels, type ResolutionLabelEvent } from './resolution-labels';
import { REPORT_KIND, REPORTS_MAX_PAGES, REPORTS_PAGE_SIZE } from './reports-filter';

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

// One page of a relay filter, cursored by `until`. The filter's `limit` is the
// `pageSize` the caller hands the pager, so the two cannot drift. Throws on an
// unconfirmed read (#186): a timed-out page must never be folded in as "nothing
// older", which would hand the queue a short list.
export function relayPageFetcher<T>(relayUrl: string, base: Record<string, unknown>, pageSize: number) {
  return async (until: number | undefined): Promise<T[]> => {
    const filter: Record<string, unknown> = { ...base, limit: pageSize };
    if (until !== undefined) filter.until = until;
    const result = await queryRelay(filter, relayUrl);
    if (!result.success) throw new Error(result.error || 'Relay query failed');
    return (result.events || []) as unknown as T[];
  };
}

export interface ResolutionKeys {
  resolved: Set<string>;
  pendingReview: Set<string>;
  labelsTruncated: boolean;
}

// Page size and page cap for a walked relay read. Optional so a caller can
// shrink both to exercise truncation against a small fixture; the route never
// passes this, so its behaviour is unchanged.
export interface PagingOptions {
  pageSize?: number;
  maxPages?: number;
}

// Everything the worker knows about which targets are handled: human decisions
// and auto-hide states from D1, resolution labels from the relay.
// getAutoHideStates returns newest first, which pendingReviewTargetKeys needs.
export async function readResolutionKeys(
  db: D1Database,
  relayUrl: string,
  labelsPaging?: PagingOptions,
): Promise<ResolutionKeys> {
  const labelsPageSize = labelsPaging?.pageSize ?? LABEL_PAGE_SIZE;
  const [decisions, autoHideStates, labels] = await Promise.all([
    getResolvedTargets(db),
    getAutoHideStates(db),
    pageResolutionLabels(
      relayPageFetcher<ResolutionLabelEvent>(relayUrl, { kinds: [1985], '#L': ['moderation/resolution'] }, labelsPageSize),
      { pageSize: labelsPageSize, maxPages: labelsPaging?.maxPages },
    ),
  ]);
  return {
    resolved: resolvedKeysFrom(decisions, labels.targets),
    pendingReview: pendingReviewTargetKeys(autoHideStates),
    labelsTruncated: labels.truncated,
  };
}

function failure(status: number, error: unknown) {
  return { status, body: { success: false, error: error instanceof Error ? error.message : String(error) } };
}

// GET /api/reports?needs_attention=1. Every report whose target still needs a
// moderator, at any age. Any failed source fails the request: resolution sets
// are subtractive, so a silent empty makes the queue bigger and wrong rather
// than smaller and safe (#221).
export async function getReportsNeedingAttention(
  db: D1Database | undefined,
  relayUrl: string,
  opts?: { reportsPaging?: PagingOptions; labelsPaging?: PagingOptions },
): Promise<{ status: number; body: Record<string, unknown> }> {
  if (!db) return failure(503, 'Database not configured');
  const reportsPageSize = opts?.reportsPaging?.pageSize ?? REPORTS_PAGE_SIZE;
  const reportsMaxPages = opts?.reportsPaging?.maxPages ?? REPORTS_MAX_PAGES;
  try {
    const [reports, keys] = await Promise.all([
      pageByUntil<RelayReport>(
        relayPageFetcher<RelayReport>(relayUrl, { kinds: [REPORT_KIND] }, reportsPageSize),
        { pageSize: reportsPageSize, maxPages: reportsMaxPages },
      ),
      readResolutionKeys(db, relayUrl, opts?.labelsPaging),
    ]);
    const { events, counts } = selectReportsNeedingAttention(reports.events, keys.resolved, keys.pendingReview);
    return {
      status: 200,
      body: {
        success: true,
        events,
        counts,
        // The report walk stopped early: reports may be missing.
        truncated: reports.truncated,
        // The label walk stopped early: some handled targets may appear.
        resolution_truncated: keys.labelsTruncated,
        oldest_covered: reports.oldestCovered,
      },
    };
  } catch (error) {
    console.error('Get reports needing attention error:', error);
    return failure(502, error);
  }
}

// GET /api/reports?event= / ?pubkey=. Every report for one target, never
// filtered: these lookups find reports for targets the queue has dropped,
// including resolved ones. Paged, because a 200 cap here was the same silent
// truncation as everywhere else -- an account with more reports had its
// history quietly cut.
export async function getReportsForTarget(
  filter: Record<string, unknown>,
  relayUrl: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  try {
    const paged = await pageByUntil<RelayReport>(
      relayPageFetcher<RelayReport>(relayUrl, filter, REPORTS_PAGE_SIZE),
      { pageSize: REPORTS_PAGE_SIZE, maxPages: REPORTS_MAX_PAGES },
    );
    return { status: 200, body: { success: true, events: paged.events, truncated: paged.truncated } };
  } catch (error) {
    console.error('Get reports for target error:', error);
    return failure(502, error);
  }
}
