// ABOUTME: Whether the queue counts a report as handled: by the dated rule (#324) when the
// ABOUTME: worker sends handling dates, by target membership when it predates them.

import { reportTargetKey } from '../../shared/report-target';
import {
  handlingByTarget,
  isHumanHandling,
  REOPENED_ACTION,
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

// The membership rule, as the queue applied it before #324. It now serves
// only a worker that sends no handling dates (queueResolution below), for the
// queue and, through the same QueueResolution, the sensitive switch.
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
  // Targets the decision log has a dated human row or a reopen for, keyed as
  // `handling` is. A relay ban on one of these is not undated: the log dates
  // it, so it counts only through `handling`.
  logged: ReadonlySet<string>;
}

export interface DatedReport extends ResolvableReport {
  id: string;
  created_at: number;
}

// A relay ban that the decision log has no dated row for, and no reopen
// (spec decision 4: "a ban the decision log has no row for ... until a dated
// human decision exists"). It keeps the target's reports handled, as it always
// did. Once the log dates the target, the ban counts only through the target's
// handling entry, so a Reopen, which takes the entry away, takes the ban's
// hiding away with it: Reopen never makes a report less visible.
function isUndatedBan(banned: boolean, key: string, ctx: HandlingContext): boolean {
  return banned && !ctx.logged.has(key);
}

// A report's standing, and for 'handled_before' the handling it came after,
// whose history the report pane lists. Read in the same pass as the status,
// so the pane and the queue row cannot disagree about it.
//
// For 'handled_before' it also says whose history `entry` is (`via`: the
// target's own, or the banned author's), and, when the account is relay-banned
// now, since when (`ban`, spec decisions 3 and 5): the queue labels and sorts
// those items lowest, and the pane names the ban.
export interface HandlingVerdict {
  status: ReportStatus;
  entry?: HandlingEntry;
  via?: 'own' | 'author';
  ban?: HandledBeforeBan;
}

// A relay ban on the account a handled-before report names: the account
// itself, or a post's author. `since` is the latest dated ban decision in
// that account's handling history; null when the log dates none.
export interface HandledBeforeBan {
  kind: 'account' | 'author';
  since: number | null;
}

// The decision rows that record an account ban. UserActions, UserManagement
// and DebugPanel log `ban_user`; `ban` is an older spelling. EventDetail and
// Labels ban without a decision row (EventDetail logs only its `unban_user`),
// and so do the relay call (`banpubkey`) and the moderate route's `ban_pubkey`.
const BAN_DECISION_ACTIONS: readonly string[] = ['ban_user', 'ban'];
const UNBAN_DECISION_ACTION = 'unban_user';

export function isBanDecision(action: string): boolean {
  return BAN_DECISION_ACTIONS.includes(action);
}

// History is newest first and undated last (shared/handling.ts), so the first
// ban is the latest dated one, or undated only when no ban is dated. An unban
// newer than it means the ban the relay lists now came later, by a path that
// writes no row (see BAN_DECISION_ACTIONS), so its date is unknown.
function latestBanAt(entry: HandlingEntry): number | null {
  const latest = entry.history.find(h => isBanDecision(h.action) || h.action === UNBAN_DECISION_ACTION);
  return latest && latest.action !== UNBAN_DECISION_ACTION ? latest.at : null;
}

// Spec decisions 3 and 5: a handled-before item on a banned account, or on a
// banned author's post, sorts below the other handled-before items.
export function sortsLowest(v: HandlingVerdict | undefined): boolean {
  return v?.status === 'handled_before' && v.ban !== undefined;
}

// What the report pane shows for a handled-before report: the history it
// came after, whose it is, and the ban it carries. Undefined otherwise.
export interface HandledBeforeView {
  history: HandlingEntry['history'];
  via: 'own' | 'author';
  ban?: HandledBeforeBan;
}

export function handledBeforeView(v: HandlingVerdict | undefined): HandledBeforeView | undefined {
  if (v?.status !== 'handled_before' || !v.entry) return undefined;
  return { history: v.entry.history, via: v.via ?? 'own', ...(v.ban ? { ban: v.ban } : {}) };
}

// The queue row's and the pane card's label for a handled-before ban. Dates
// as the pane's history card dates its entries.
export function handledBeforeBanText(ban: HandledBeforeBan): string {
  const who = ban.kind === 'account' ? 'Banned' : 'Author banned';
  return ban.since === null
    ? `${who}, date unknown`
    : `${who} since ${new Date(ban.since * 1000).toLocaleDateString()}`;
}

// One report against its target, by the dated rule (#324): handled only when a
// person handled the target after the report arrived.
//
// A post whose author is relay-banned is also compared with the author's
// handling (spec decision 3): the author's dated ban if the decision log has
// one, else an undated ban, which keeps it handled (decision 4). Either
// handling coming after the report answers it, the post's own or the
// author's: banning the account purges its posts, so a report filed before the
// ban was answered by it, whatever the post's own history says. An author ban
// the log dates but a reopen has since cancelled answers nothing.
//
// The entry a 'handled_before' verdict carries is the target's own when the
// report came after it, else the banned author's: the pane shows the history
// of the item the moderator opened whenever it has one that counts.
export function reportHandling(report: DatedReport, ctx: HandlingContext): HandlingVerdict {
  const time = reportTime(report, ctx.arrivals);
  const key = reportTargetKey(report.target);
  const entry = ctx.handling.get(key);
  const banned = report.target.type === 'pubkey'
    ? ctx.bannedPubkeys.has(report.target.value)
    : ctx.bannedEvents.has(report.target.value);
  const own: ReportStatus = entry
    ? reportStatus(time, entry)
    : isUndatedBan(banned, key, ctx) ? 'handled' : 'new';
  if (own === 'handled') return { status: own };
  // 'handled_before' on its own comes only from an entry.
  const ownVerdict = (): HandlingVerdict => {
    if (own !== 'handled_before' || !entry) return { status: own };
    const accountBanned = report.target.type === 'pubkey' && banned;
    return accountBanned
      ? { status: own, entry, via: 'own', ban: { kind: 'account', since: latestBanAt(entry) } }
      : { status: own, entry, via: 'own' };
  };

  // The author comes from a reporter-authored `p` tag, so only its side is
  // lowercased; see isConsolidatedReportResolved.
  const author = report.target.type === 'event' ? report.authorPubkey?.toLowerCase() : undefined;
  if (!author || !ctx.bannedPubkeys.has(author)) return ownVerdict();
  const authorKey = `pubkey:${author}`;
  const authorEntry = ctx.handling.get(authorKey);
  if (authorEntry) {
    const status = reportStatus(time, authorEntry);
    if (status !== 'handled_before') return { status };
    // The report came after the author's ban too: label it (decision 3).
    const ban: HandledBeforeBan = { kind: 'author', since: latestBanAt(authorEntry) };
    return own === 'handled_before'
      ? { status, entry, via: 'own', ban }
      : { status, entry: authorEntry, via: 'author', ban };
  }
  return isUndatedBan(true, authorKey, ctx) ? { status: 'handled' } : ownVerdict();
}

export function reportHandlingStatus(report: DatedReport, ctx: HandlingContext): ReportStatus {
  return reportHandling(report, ctx).status;
}

// A target's group of reports: handled before if any report is (a report no
// one has answered yet), handled if all are, otherwise new. A handled-before
// group carries the entry of its first report no one has answered.
export function consolidatedHandling(
  c: ResolvableReport & { reports: readonly { id: string; created_at: number }[] },
  ctx: HandlingContext,
): HandlingVerdict {
  let allHandled = c.reports.length > 0;
  for (const report of c.reports) {
    const v = reportHandling(
      { target: c.target, authorPubkey: c.authorPubkey, id: report.id, created_at: report.created_at },
      ctx,
    );
    if (v.status === 'handled_before') return v;
    if (v.status !== 'handled') allHandled = false;
  }
  return { status: allHandled ? 'handled' : 'new' };
}

export function consolidatedStatus(
  c: ResolvableReport & { reports: readonly { id: string; created_at: number }[] },
  ctx: HandlingContext,
): ReportStatus {
  return consolidatedHandling(c, ctx).status;
}

// The group's report that reached us last, by reportTime: its arrival, else
// its created_at. A reporter's clock can stamp an old report in the future, so
// the largest created_at (`latestReport`) is not always the newest. A group is
// handled before when any of its reports is, and the one that arrived last is
// then one of them, so opening it shows the pane what the row's tag is about.
// Ties keep `latestReport`.
export function newestReport<R extends { id: string; created_at: number }>(
  c: { reports: readonly R[]; latestReport: R },
  arrivals: ReadonlyMap<string, number>,
): R {
  let newest = c.latestReport;
  let newestTime = reportTime(newest, arrivals);
  for (const report of c.reports) {
    const time = reportTime(report, arrivals);
    if (time > newestTime) {
      newest = report;
      newestTime = time;
    }
  }
  return newest;
}

// The dated rule's reading of the decision log and the labels, apart from the
// arrivals and ban lists so the screen rebuilds it only when those two reads
// change, not on every feed or ban-list poll.
export interface DatedHandling {
  handling: Map<string, HandlingEntry>;
  logged: Set<string>;
}

// Null when a date the rule compares is missing: handling_rows from
// /api/resolution-state, or an `at` on any label target. A worker that
// predates #324 sends neither, and the queue then keeps the membership rule.
// TODO(#409): remove the membership fallback (null return here, the 'membership'
// rule in queueResolution) once no worker without handling_rows/label `at` can pair with this build.
export function datedHandling(
  handlingRows: readonly HandlingRow[] | undefined,
  labelTargets: readonly { type: 'event' | 'pubkey'; value: string; at?: number }[] | undefined,
): DatedHandling | null {
  const labels = labelTargets ?? [];
  const dated = labels.filter((label): label is HandlingLabel => typeof label.at === 'number');
  if (!handlingRows || dated.length !== labels.length) return null;

  // Same row classes handlingByTarget dates by: a reopen, or a person's
  // decision with a date. Keyed as stored, as handlingByTarget keys them.
  // Labels need no entry here: a labelled target is in `handling` unless a
  // reopen cancelled the label, and that reopen is logged.
  const logged = new Set<string>();
  for (const row of handlingRows) {
    if (row.target_type !== 'event' && row.target_type !== 'pubkey') continue;
    if (row.action === REOPENED_ACTION || (row.at !== null && isHumanHandling(row))) {
      logged.add(`${row.target_type}:${row.target_id}`);
    }
  }
  return { handling: handlingByTarget(handlingRows, dated), logged };
}

// Which rule the queue applies: 'dated' when datedHandling found every date it
// needs, else today's membership rule exactly, so a Pages build deployed ahead
// of its worker shows what it showed before. The membership rule never answers
// 'handled_before'.
export type QueueResolution =
  | { rule: 'dated'; ctx: HandlingContext }
  | { rule: 'membership'; resolvedTargets: ReadonlySet<string>; bannedPubkeys: ReadonlySet<string> };

export function queueResolution(args: {
  dated: DatedHandling | null;
  arrivals: ReadonlyMap<string, number>;
  bannedPubkeys: ReadonlySet<string>;
  bannedEvents: ReadonlySet<string>;
  // The membership rule's set (Reports.tsx resolvedTargets).
  resolvedTargets: ReadonlySet<string>;
}): QueueResolution {
  if (!args.dated) {
    return { rule: 'membership', resolvedTargets: args.resolvedTargets, bannedPubkeys: args.bannedPubkeys };
  }
  return {
    rule: 'dated',
    ctx: {
      handling: args.dated.handling,
      logged: args.dated.logged,
      arrivals: args.arrivals,
      bannedPubkeys: args.bannedPubkeys,
      bannedEvents: args.bannedEvents,
    },
  };
}

// The screen's entry points. The verdicts carry what the queue row and the
// pane show for a handled-before item; the membership rule never answers
// 'handled_before', so its verdicts are a bare status.
export function reportResolutionVerdict(report: DatedReport, resolution: QueueResolution): HandlingVerdict {
  if (resolution.rule === 'dated') return reportHandling(report, resolution.ctx);
  return {
    status: isConsolidatedReportResolved(report, resolution.resolvedTargets, resolution.bannedPubkeys)
      ? 'handled'
      : 'new',
  };
}

export function reportResolutionStatus(report: DatedReport, resolution: QueueResolution): ReportStatus {
  return reportResolutionVerdict(report, resolution).status;
}

export function groupResolutionVerdict(
  c: ResolvableReport & { reports: readonly { id: string; created_at: number }[] },
  resolution: QueueResolution,
): HandlingVerdict {
  if (resolution.rule === 'dated') return consolidatedHandling(c, resolution.ctx);
  return {
    status: isConsolidatedReportResolved(c, resolution.resolvedTargets, resolution.bannedPubkeys)
      ? 'handled'
      : 'new',
  };
}

export function groupResolutionStatus(
  c: ResolvableReport & { reports: readonly { id: string; created_at: number }[] },
  resolution: QueueResolution,
): ReportStatus {
  return groupResolutionVerdict(c, resolution).status;
}
