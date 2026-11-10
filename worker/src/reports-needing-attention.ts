// ABOUTME: Selects the reports a moderator still needs to see, at any age.
// ABOUTME: The worker's half of resolution: decisions and labels. Bans stay client-side.

import { getReportTarget, reportTargetKey } from '../../shared/report-target';
import { relayPageFetcher } from './relay-profile';
import { pageByUntil } from '../../shared/relay-pager';
import { pendingReviewTargetKeys } from '../../shared/autohide';
import {
  handlingByTarget, reportStatus, reportTime, REOPENED_ACTION, type HandlingEntry, type ReportStatus,
} from '../../shared/handling';
import { getAutoHideStates, getHandlingRows, getResolvedTargets } from './resolution-state';
import { readResolutionLabelTargets } from './resolution-labels';
import { readReportArrivals } from './report-arrivals';
import { REPORT_KIND, REPORTS_MAX_PAGES, REPORTS_PAGE_SIZE } from './reports-filter';

export interface RelayReport {
  id: string;
  created_at: number;
  tags: string[][];
}

// The targets the worker can call resolved, split by who resolved them. The
// feed and resolved history read only `automated` from this now; whether a
// report is handled is the dated rule in shared/handling.ts (#324).
//
// `resolved`: handled -- any resolution label, and any event or pubkey decision
// getResolvedTargets returns without the `automated` flag, so one a person made.
// Auto-hide actions are never here (getResolvedTargets leaves them out): auto-
// hidden content is waiting FOR review, not handled.
//
// `automated`: resolved only by decisions the worker wrote itself (today
// age_review_case_created), with no label either. No person has looked at
// these, so they are not handled: the needs-attention read keeps them, where
// the sensitive switch can take a CSAM-signal one, and resolved history leaves
// them out. The queue's Hide resolved still counts them as resolved (#332).
//
// Other target types (media) never match a report, which is why the client's
// resolvedTargets ignores them too.
export function resolvedKeysFrom(
  decisions: readonly { target_type: string; target_id: string; automated?: true }[],
  labels: readonly { type: string; value: string }[],
): { resolved: Set<string>; automated: Set<string> } {
  const resolved = new Set<string>();
  const automated = new Set<string>();
  // Keyed as stored, not lowercased as getReportTarget keys a report: the
  // pane's history and Reopen read records exactly, so one in another
  // spelling leaves its report in front of a person.
  for (const label of labels) resolved.add(`${label.type}:${label.value}`);
  for (const decision of decisions) {
    if (decision.target_type === 'pubkey' || decision.target_type === 'event') {
      const key = `${decision.target_type}:${decision.target_id}`;
      if (decision.automated) automated.add(key);
      else resolved.add(key);
    }
  }
  // A label takes a target out of here, as it takes it out of the switch.
  for (const key of resolved) automated.delete(key);
  return { resolved, automated };
}

// The complement invariant selectReportsNeedingAttention and
// getResolvedReportsPage both rest on: a report is in resolved history -- a
// person handled its target after it arrived, and the target is not still
// pending review -- or it needs attention, never both, never neither.
// Extracted so the two endpoints cannot drift apart.
export function isResolvedForReview(
  status: ReportStatus,
  key: string,
  pendingReview: ReadonlySet<string>,
): boolean {
  return status === 'handled' && !pendingReview.has(key);
}

// A report's standing against its target's handling, by arrival time when the
// watcher saw it arrive and by created_at otherwise. `key` is
// reportTargetKey(getReportTarget(report)), and the handling map is keyed as
// stored, exactly as the old resolved set was (PR #365).
function statusOf(
  report: RelayReport,
  key: string,
  handling: ReadonlyMap<string, HandlingEntry>,
  arrivals: ReadonlyMap<string, number>,
): ReportStatus {
  return reportStatus(reportTime(report, arrivals), handling.get(key));
}

// Needing attention = not handled OR pending review. The union is load-bearing:
// a target can be both handled and pending review, and dropping it would leave
// the pending-review view with a badge and no rows.
//
// A report is handled only when a person handled its target after the report
// arrived (shared/handling.ts). A newer one is 'handled_before': it is kept, and
// its target is listed in handledBefore so the queue can mark it and keep it
// below never-handled work (#324).
//
// Resolution here covers decisions and labels only. Targets resolved by a relay
// ban are returned and filtered client-side, which keeps each ban list's own
// failure handling in the queue (#221).
//
// A target only automation touched has no handling, so its reports are kept.
// automatedTargets lists the kept ones that are, for the client's Hide resolved.
//
// counts.targets, counts.resolved and counts.handled_before are counts of
// distinct TARGETS, never of report events. counts.resolved is the targets
// whose reports were all dropped; a target with one kept report counts in
// targets instead. A report naming no usable target is kept, as the client
// keeps it, and counted in none. An automation-only target counts in targets,
// not resolved.
export function selectReportsNeedingAttention<T extends RelayReport>(
  reports: readonly T[],
  handling: ReadonlyMap<string, HandlingEntry>,
  pendingReview: ReadonlySet<string>,
  automated: ReadonlySet<string> = new Set(),
  arrivals: ReadonlyMap<string, number> = new Map(),
): {
  events: T[];
  counts: { targets: number; resolved: number; handled_before: number };
  automatedTargets: string[];
  handledBefore: string[];
} {
  const events: T[] = [];
  const keptTargets = new Set<string>();
  const droppedTargets = new Set<string>();
  const handledBefore = new Set<string>();

  for (const report of reports) {
    const target = getReportTarget(report);
    if (!target) {
      events.push(report);
      continue;
    }
    const key = reportTargetKey(target);
    const status = statusOf(report, key, handling, arrivals);
    if (isResolvedForReview(status, key, pendingReview)) {
      droppedTargets.add(key);
      continue;
    }
    events.push(report);
    keptTargets.add(key);
    if (status === 'handled_before') handledBefore.add(key);
  }

  let resolved = 0;
  for (const key of droppedTargets) if (!keptTargets.has(key)) resolved += 1;

  return {
    events,
    counts: { targets: keptTargets.size, resolved, handled_before: handledBefore.size },
    automatedTargets: [...keptTargets].filter(key => automated.has(key)),
    handledBefore: [...handledBefore],
  };
}

// The brigading watch (spec decision 6): handled-before targets counted by the
// action that last handled them -- the newest history entry that is not a
// reopen -- so a run of items coming back after "no violation" calls shows up
// in the logs. Keys sorted, so log lines compare across builds.
export function handledBeforeByLastAction(
  handledBefore: readonly string[],
  handling: ReadonlyMap<string, HandlingEntry>,
): Record<string, number> {
  const counts = new Map<string, number>();
  for (const key of handledBefore) {
    const action = handling.get(key)?.history.find(entry => entry.action !== REOPENED_ACTION)?.action;
    if (action === undefined) continue;
    counts.set(action, (counts.get(action) ?? 0) + 1);
  }
  return Object.fromEntries([...counts].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

export interface ResolutionKeys {
  // When a person last handled each target, and the history behind it: the
  // dated rule's input (#324). Keyed `${type}:${id}` as stored.
  handling: Map<string, HandlingEntry>;
  // Resolved only by decisions the worker wrote itself. See resolvedKeysFrom.
  automated: Set<string>;
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

// Everything the worker knows about which targets are handled: decisions and
// auto-hide states from D1, resolution labels from the relay. The worker's own
// automated decisions come back apart, in `automated`.
// getAutoHideStates returns newest first, which pendingReviewTargetKeys needs.
//
// The handling map comes from the same handlingByTarget the screen runs over
// /api/resolution-state's handling_rows and the label targets, so the feed and
// the queue date every target alike.
export async function readResolutionKeys(
  db: D1Database,
  relayUrl: string,
  labelsPaging?: PagingOptions,
): Promise<ResolutionKeys> {
  const [decisions, autoHideStates, labels, handlingRows] = await Promise.all([
    getResolvedTargets(db),
    getAutoHideStates(db),
    readResolutionLabelTargets(relayUrl, labelsPaging),
    getHandlingRows(db),
  ]);
  const { automated } = resolvedKeysFrom(decisions, labels.targets);
  return {
    handling: handlingByTarget(handlingRows, labels.targets),
    automated,
    pendingReview: pendingReviewTargetKeys(autoHideStates),
    labelsTruncated: labels.truncated,
  };
}

// First-seen times for the reports in hand, and only those: a lookup bounded by
// the page, never a read of the whole table. A report with no row compares by
// its created_at (reportTime).
//
// A failed read falls back to created_at for every report rather than failing
// the request. That is the rule as it stood before arrivals were recorded, and
// the spec's fallback for any report with no row; blocking the queue on it
// would cost more than a comparison by the reporter's clock.
async function readArrivalsFor(db: D1Database, reports: readonly RelayReport[]): Promise<Map<string, number>> {
  const ids = reports.map(report => report?.id).filter((id): id is string => typeof id === 'string');
  try {
    return await readReportArrivals(db, ids);
  } catch (error) {
    console.error('Read report arrivals error, comparing by created_at:', error);
    return new Map();
  }
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
    // Arrivals need the report ids, so they follow the report walk, alongside
    // the resolution reads rather than after them.
    const [{ reports, arrivals }, keys] = await Promise.all([
      pageByUntil<RelayReport>(
        relayPageFetcher<RelayReport>(relayUrl, { kinds: [REPORT_KIND] }, reportsPageSize),
        { pageSize: reportsPageSize, maxPages: reportsMaxPages },
      ).then(async paged => ({ reports: paged, arrivals: await readArrivalsFor(db, paged.events) })),
      readResolutionKeys(db, relayUrl, opts?.labelsPaging),
    ]);
    const { events, counts, automatedTargets, handledBefore } = selectReportsNeedingAttention(
      reports.events, keys.handling, keys.pendingReview, keys.automated, arrivals,
    );
    // One line per build, counts only: no target or report ids.
    console.log(
      `[needs-attention] handled before: ${handledBefore.length} targets, by last handling ${
        JSON.stringify(handledBeforeByLastAction(handledBefore, keys.handling))}`,
    );
    const reportArrivals: Record<string, number> = {};
    for (const event of events) {
      const seenAt = arrivals.get(event.id);
      if (seenAt !== undefined) reportArrivals[event.id] = seenAt;
    }
    return {
      status: 200,
      body: {
        success: true,
        events,
        // counts.handled_before is new beside targets and resolved (#324).
        counts,
        // Keys ("pubkey:<hex>", "event:<hex>") of the returned targets that only
        // the worker's own decisions resolved. Kept for the sensitive switch;
        // the queue's Hide resolved still hides them (#332).
        automated_targets: automatedTargets,
        // Keys of the returned targets a person handled before some of their
        // reports arrived (#324). Those reports are returned; older ones are not.
        handled_before: handledBefore,
        // First-seen unix seconds by report id, for the returned events the
        // watcher saw arrive. Absent: compare by created_at.
        report_arrivals: reportArrivals,
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

export const RESOLVED_PAGE_DEFAULT = 200;
export const RESOLVED_PAGE_MAX = 500;

// GET /api/reports/resolved?cursor=<unix seconds>&limit=<n>. One page of
// resolved history, fetched only when a moderator asks for it.
//
// Reads one relay page of `limit` reports ending at `cursor` (`until`,
// inclusive), and returns the ones the worker resolved: a person's decision or
// a label on the target after the report arrived, and the target not pending
// review -- the exact complement of the needs-attention filter. A report newer
// than its target's handling is not here (#324). Targets resolved only by a ban
// are not here either; they arrive in the needs-attention payload and the
// client filters them. Nor are
// targets only the worker's own decisions resolved: no person has handled
// them, and the needs-attention payload carries them instead.
//
// Cursor, not offset: offsets drift as new reports arrive. Because `until` is
// inclusive, the next page repeats the boundary second, and the client
// de-duplicates by event id. If one second fills a whole page, the cursor cannot
// advance; this steps one second back and says so in `skipped_within_second`
// rather than looping forever or pretending nothing was skipped.
export async function getResolvedReportsPage(
  params: URLSearchParams,
  db: D1Database | undefined,
  relayUrl: string,
  // Test-only: lets a fixture shrink the label walk to exercise
  // resolution_truncated without a large corpus. The route never passes this.
  labelsPaging?: PagingOptions,
): Promise<{ status: number; body: Record<string, unknown> }> {
  if (!db) return failure(503, 'Database not configured');

  const cursorParam = params.get('cursor');
  if (cursorParam !== null && !/^\d+$/.test(cursorParam)) {
    return failure(400, 'cursor must be a unix timestamp in seconds');
  }
  const cursor = cursorParam === null ? undefined : Number(cursorParam);
  const requested = Number.parseInt(params.get('limit') ?? '', 10);
  const limit = Number.isFinite(requested) && requested > 0
    ? Math.min(requested, RESOLVED_PAGE_MAX)
    : RESOLVED_PAGE_DEFAULT;

  try {
    const [{ page, arrivals }, keys] = await Promise.all([
      relayPageFetcher<RelayReport>(relayUrl, { kinds: [REPORT_KIND] }, limit)(cursor)
        .then(async fetched => ({ page: fetched, arrivals: await readArrivalsFor(db, fetched) })),
      readResolutionKeys(db, relayUrl, labelsPaging),
    ]);

    const events = page.filter(report => {
      const target = getReportTarget(report);
      if (!target) return false;
      const key = reportTargetKey(target);
      return isResolvedForReview(statusOf(report, key, keys.handling, arrivals), key, keys.pendingReview);
    });

    // Only a whole, non-negative second anchors a cursor: it is sent back
    // as `cursor=<n>` and the whole-seconds check above would reject
    // anything else, ending the walk on an error instead of `done`.
    let oldest = Infinity;
    for (const report of page) {
      const createdAt = report?.created_at;
      if (typeof createdAt === 'number' && Number.isInteger(createdAt) && createdAt >= 0 && createdAt < oldest) {
        oldest = createdAt;
      }
    }

    // A short page is the relay saying there is nothing older.
    const exhausted = page.length < limit;
    let nextCursor: number | null = null;
    let skippedWithinSecond = false;
    let done = exhausted;
    if (!exhausted && oldest !== Infinity) {
      if (cursor !== undefined && oldest === cursor) {
        skippedWithinSecond = true;
        if (oldest === 0) {
          // Nothing is older than second 0: there is no cursor left to step
          // to, but the overflow this second held really was skipped.
          nextCursor = null;
          done = true;
        } else {
          nextCursor = oldest - 1;
        }
      } else {
        nextCursor = oldest;
      }
    }

    return {
      status: 200,
      body: {
        success: true,
        events,
        next_cursor: nextCursor,
        // Only true when the relay ran out, or second 0 leaves nothing older
        // to step to. A full page with no usable created_at leaves no cursor
        // AND is not the end; the screen must say history could not be
        // followed further, not that it ended.
        done,
        skipped_within_second: skippedWithinSecond,
        // The label walk stopped early: a label-resolved target beyond its
        // cap is missing from this page's resolved set.
        resolution_truncated: keys.labelsTruncated,
      },
    };
  } catch (error) {
    console.error('Get resolved reports page error:', error);
    return failure(502, error);
  }
}
