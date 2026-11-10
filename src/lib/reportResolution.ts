// ABOUTME: Whether the queue counts a report as handled: by the dated rule (#324) when the
// ABOUTME: worker sends handling dates, by target membership when it predates them.

import { reportTargetKey } from '../../shared/report-target';
import {
  handlingByTarget,
  reportStatus,
  reportTime,
  type HandlingEntry,
  type HandlingLabel,
  type HandlingRow,
  type ReportStatus,
} from '../../shared/handling';

export interface ResolvableReport {
  target: { type: 'event' | 'pubkey'; value: string };
  // The reported author (the report's `p` tag), when present. Optional because an
  // `e`-tagged report need not carry one: NIP-56's own blob-report example is
  // `x` + `e` + `server` with no `p` at all, and the caller also leaves this
  // undefined when a group's reports disagree about the author.
  authorPubkey?: string;
}

// The membership rule, as the queue applied it before #324. It still serves
// two callers: the sensitive switch (sensitiveSwitch.ts), and the queue against
// a worker that sends no handling dates (queueResolution below).
//
// A consolidated report is resolved when its exact target key is already in
// `resolvedTargets`, OR — for an EVENT-scoped report — when its author pubkey is
// in the relay's banned-pubkey set.
//
// The event->author cross-resolution exists for one specific gap: "Ban User"
// (`banpubkey`) purges the account's events without registering each one in
// `listbannedevents`, so the event's own target key never appears in
// `resolvedTargets` and the report would linger even though the account is gone.
// Bulk "Delete All Content" does NOT need this — it `banevent`s each event, which
// resolves them through the normal `event:<id>` path.
//
// Keying on `bannedPubkeys` (not the decision log) is deliberate: suspension lives
// on a separate list, so a reversible holding action never cross-resolves.
export function isConsolidatedReportResolved(
  report: ResolvableReport,
  resolvedTargets: ReadonlySet<string>,
  bannedPubkeys: ReadonlySet<string>,
): boolean {
  if (resolvedTargets.has(reportTargetKey(report.target))) return true;
  // Only the report's side is lowercased. authorPubkey comes from a
  // reporter-authored `p` tag; consolidateReports lowercases it, and this is a
  // backstop for any other caller. The relay's side is kept
  // as written on purpose (Reports.tsx `bannedPubkeySet`): funnelcake stores what
  // `banpubkey` was handed but matches bans exactly, so an uppercase entry never
  // banned the lowercase account, and the reports on its posts still need a
  // person. Lowercasing the set would let such a ban clear them.
  if (
    report.target.type === 'event' &&
    report.authorPubkey &&
    bannedPubkeys.has(report.authorPubkey.toLowerCase())
  ) {
    return true;
  }
  return false;
}

// What the dated rule reads. `handling` is handlingByTarget over the worker's
// handling_rows and the dated label targets, keyed as stored. `arrivals` are
// the feed's first-seen times by report id. The ban lists are the relay's, as
// written: the relay matches a ban exactly (see isConsolidatedReportResolved).
export interface HandlingContext {
  handling: ReadonlyMap<string, HandlingEntry>;
  arrivals: ReadonlyMap<string, number>;
  bannedPubkeys: ReadonlySet<string>;
  bannedEvents: ReadonlySet<string>;
}

export interface DatedReport extends ResolvableReport {
  id: string;
  created_at: number;
}

// A relay ban has no date. With no dated handling on the target, it keeps the
// target's reports handled, as it always did (spec decision 4).
function isRelayBanned(target: ResolvableReport['target'], ctx: HandlingContext): boolean {
  return target.type === 'pubkey'
    ? ctx.bannedPubkeys.has(target.value)
    : ctx.bannedEvents.has(target.value);
}

// One report against its target, by the dated rule (#324): handled only when a
// person handled the target after the report arrived.
//
// A post whose author is relay-banned is also compared with the author's
// handling (spec decision 3): the author's dated ban if the decision log has
// one, else the undated ban, which keeps it handled (decision 4). Either
// handling coming after the report answers it, the post's own or the
// author's: banning the account purges its posts, so a report filed before the
// ban was answered by it, whatever the post's own history says.
export function reportHandlingStatus(report: DatedReport, ctx: HandlingContext): ReportStatus {
  const time = reportTime(report, ctx.arrivals);
  const entry = ctx.handling.get(reportTargetKey(report.target));
  const own: ReportStatus = entry
    ? reportStatus(time, entry)
    : isRelayBanned(report.target, ctx) ? 'handled' : 'new';
  if (own === 'handled') return own;

  // The author comes from a reporter-authored `p` tag, so only its side is
  // lowercased; see isConsolidatedReportResolved.
  const author = report.target.type === 'event' ? report.authorPubkey?.toLowerCase() : undefined;
  if (!author || !ctx.bannedPubkeys.has(author)) return own;
  const authorEntry = ctx.handling.get(`pubkey:${author}`);
  return authorEntry ? reportStatus(time, authorEntry) : 'handled';
}

// A target's group of reports: handled before if any report is (a report no
// one has answered yet), handled if all are, otherwise new.
export function consolidatedStatus(
  c: ResolvableReport & { reports: readonly { id: string; created_at: number }[] },
  ctx: HandlingContext,
): ReportStatus {
  let allHandled = c.reports.length > 0;
  for (const report of c.reports) {
    const status = reportHandlingStatus(
      { target: c.target, authorPubkey: c.authorPubkey, id: report.id, created_at: report.created_at },
      ctx,
    );
    if (status === 'handled_before') return status;
    if (status !== 'handled') allHandled = false;
  }
  return allHandled ? 'handled' : 'new';
}

// Which rule the queue applies. 'dated' needs every date the rule compares:
// handling_rows from /api/resolution-state and an `at` on every label target.
// A worker that predates #324 sends neither, and then the queue keeps today's
// membership rule exactly, so a Pages build deployed ahead of its worker
// shows what it showed before. The membership rule never answers
// 'handled_before'.
export type QueueResolution =
  | { rule: 'dated'; ctx: HandlingContext }
  | { rule: 'membership'; resolvedTargets: ReadonlySet<string>; bannedPubkeys: ReadonlySet<string> };

export function queueResolution(args: {
  handlingRows: readonly HandlingRow[] | undefined;
  labelTargets: readonly { type: 'event' | 'pubkey'; value: string; at?: number }[] | undefined;
  arrivals: ReadonlyMap<string, number>;
  bannedPubkeys: ReadonlySet<string>;
  bannedEvents: ReadonlySet<string>;
  // The membership rule's set (Reports.tsx resolvedTargets).
  resolvedTargets: ReadonlySet<string>;
}): QueueResolution {
  const labels = args.labelTargets ?? [];
  const dated = labels.filter((label): label is HandlingLabel => typeof label.at === 'number');
  if (!args.handlingRows || dated.length !== labels.length) {
    return { rule: 'membership', resolvedTargets: args.resolvedTargets, bannedPubkeys: args.bannedPubkeys };
  }
  return {
    rule: 'dated',
    ctx: {
      handling: handlingByTarget(args.handlingRows, dated),
      arrivals: args.arrivals,
      bannedPubkeys: args.bannedPubkeys,
      bannedEvents: args.bannedEvents,
    },
  };
}

export function reportResolutionStatus(report: DatedReport, resolution: QueueResolution): ReportStatus {
  if (resolution.rule === 'dated') return reportHandlingStatus(report, resolution.ctx);
  return isConsolidatedReportResolved(report, resolution.resolvedTargets, resolution.bannedPubkeys)
    ? 'handled'
    : 'new';
}

export function groupResolutionStatus(
  c: ResolvableReport & { reports: readonly { id: string; created_at: number }[] },
  resolution: QueueResolution,
): ReportStatus {
  if (resolution.rule === 'dated') return consolidatedStatus(c, resolution.ctx);
  return isConsolidatedReportResolved(c, resolution.resolvedTargets, resolution.bannedPubkeys)
    ? 'handled'
    : 'new';
}
