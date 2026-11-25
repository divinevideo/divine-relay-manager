// ABOUTME: Restart catch-up for the report listener: windows of reports filed while it was disconnected.
// ABOUTME: Each unseen report found goes through the live handler once; windows persist and resume from a saved cursor.

import { canonicalHex64 } from '../../shared/hex-id';
import { findUnseenReportIds, type SignedReport } from './report-index';
import { RELAY_WALK_PAGE_TIMEOUT_MS, walkRelayEvents, type WalkStopReason } from './relay-walk';

/**
 * A span of report created_at seconds to read from the relay. `since` and
 * `until` come from the watcher's own clock (its heartbeat and the connect
 * time), never from report timestamps, which reporters set and can backdate
 * or future-date. `until` is the walk's inclusive cursor and moves down as
 * pages are handled. `handlerEnabled` is false for the gap after a deliberate
 * stop: those reports are indexed but get no auto-hide or age review.
 */
export interface CatchUpWindow {
  since: number;
  until: number;
  handlerEnabled: boolean;
}

export const CATCHUP_OVERLAP_SECONDS = 600;
// At or under the relay's maximum `limit` (see WalkOptions.pageSize).
export const CATCHUP_PAGE_SIZE = 500;
export const CATCHUP_MAX_PAGES = 40;
// Under the five-minute cron, so the cron can resume a failed window on its next run.
export const CATCHUP_MIN_ATTEMPT_INTERVAL_MS = 270_000;
export const CATCHUP_MAX_PENDING_WINDOWS = 8;
export const AUTO_ACTION_BURST_THRESHOLD = 10;

/** DO storage: the pending windows, oldest first. */
export const CATCHUP_WINDOWS_KEY = 'report-catchup-windows';
/** DO storage: unix ms of the last pass that read the relay. */
export const CATCHUP_LAST_ATTEMPT_KEY = 'report-catchup-last-attempt';
/** DO storage: StoppedPeriod[], each deliberate stop's (stopAt, startAt]. */
export const CATCHUP_STOPPED_PERIODS_KEY = 'report-catchup-stopped-periods';
export const CATCHUP_MAX_STOPPED_PERIODS = 8;

/**
 * A deliberate stop's stopped period, (after, until] in report created_at
 * seconds: after = the /stop time, until = the next start. Reports created in
 * it get no auto-hide or age review, whichever window finds them.
 */
export interface StoppedPeriod {
  after: number;
  until: number;
}

export function inStoppedPeriod(createdAt: number, periods: readonly StoppedPeriod[]): boolean {
  return periods.some(p => createdAt > p.after && createdAt <= p.until);
}

/**
 * Whether the handler runs for one report: its window must have it on and the
 * report must not fall in any stopped period. Decided per report, so a
 * handler-on window that folded over a stopped period (a reconnect before the
 * first heartbeat, or an older outage window) cannot run it there.
 */
export function reportHandlerEnabled(
  createdAt: number,
  window: CatchUpWindow,
  periods: readonly StoppedPeriod[],
): boolean {
  return window.handlerEnabled && !inStoppedPeriod(createdAt, periods);
}

/**
 * Drops periods that end before every pending window's since (no pending
 * window can find a report in them). With nothing pending the periods are
 * kept: until the heartbeat advances, a reconnect plans a window from the old
 * heartbeat that can cover a stopped period again.
 *
 * Over CATCHUP_MAX_STOPPED_PERIODS, the two oldest merge into their union
 * rather than one being dropped: a dropped period a pending window can still
 * reach would hand its reports the handler. The union also covers the time
 * between the two stops, which the watcher handled live, so it suppresses
 * only reports already seen (the seen check skips them anyway) or backdated
 * into that gap.
 */
export function pruneStoppedPeriods(
  periods: readonly StoppedPeriod[],
  pending: readonly CatchUpWindow[],
): StoppedPeriod[] {
  const earliest = pending.length === 0 ? -Infinity : Math.min(...pending.map(w => w.since));
  const kept = periods.filter(p => p.until >= earliest);
  while (kept.length > CATCHUP_MAX_STOPPED_PERIODS) {
    const [a, b] = kept.splice(0, 2);
    kept.unshift({ after: Math.min(a.after, b.after), until: Math.max(a.until, b.until) });
  }
  return kept;
}

export function addStoppedPeriod(
  periods: readonly StoppedPeriod[],
  period: StoppedPeriod,
  pending: readonly CatchUpWindow[],
): StoppedPeriod[] {
  return pruneStoppedPeriods([...periods, period], pending);
}

/**
 * The windows for one connect, oldest first. `stopAt` is the deliberate-stop
 * marker (unix seconds of the last /stop), when one is being consumed.
 *
 * Without a stop: one handler-on window from the last heartbeat (minus the
 * overlap) to now. After a stop: handler-on up to the stop and index-only for
 * the stopped period (stopAt, now]. Only the stopped period is exempt: an
 * outage that began before the stop keeps the live treatment for what was
 * filed before it. No outage needs no special case; the pre-stop slice was
 * seen live and the seen check filters it.
 */
export function planCatchUpWindow(
  lastAliveAt: number | undefined,
  nowSec: number,
  stopAt?: number,
): CatchUpWindow[] {
  // No heartbeat was ever recorded: this is the first connect, and everything
  // older is history the handler must not replay (it is not idempotent).
  if (lastAliveAt === undefined) return [];
  // `until` is the connect time and the relay filters on created_at, so a
  // future-dated report filed during the outage is outside these windows. It
  // is left to the later incremental and full sweeps.
  const since = lastAliveAt - CATCHUP_OVERLAP_SECONDS;
  if (stopAt === undefined) return [{ since, until: nowSec, handlerEnabled: true }];
  const windows: CatchUpWindow[] = [{ since, until: Math.min(stopAt, nowSec), handlerEnabled: true }];
  if (stopAt < nowSec) windows.push({ since: stopAt + 1, until: nowSec, handlerEnabled: false });
  return windows;
}

/**
 * Adds a window. One that overlaps pending windows with the same handler
 * setting folds into them (the union of their spans, at the first one's
 * place), so a flapping relay does not pile up near-identical windows that
 * every pass would walk again. A pending window's `until` is its remaining
 * cursor, so the union covers exactly what is still unwalked.
 *
 * Past the cap, the two oldest merge into one spanning both, as a backstop;
 * the merged window runs the handler only if both did, so a deliberate-stop
 * gap is never widened into handled time. `handlerDisabled` reports a merge
 * that took the handler away from a window that had it (its reports will be
 * indexed without auto-hide or age review), and `mergedWindows` names what
 * merged.
 */
export function addPendingWindow(
  pending: CatchUpWindow[],
  next: CatchUpWindow,
): { windows: CatchUpWindow[]; merged: boolean; handlerDisabled: boolean; mergedWindows: CatchUpWindow[] } {
  let incoming = next;
  let foldAt = -1;
  const windows: CatchUpWindow[] = [];
  for (const w of pending) {
    if (w.handlerEnabled === incoming.handlerEnabled && w.since <= incoming.until && incoming.since <= w.until) {
      incoming = { since: Math.min(w.since, incoming.since), until: Math.max(w.until, incoming.until), handlerEnabled: w.handlerEnabled };
      if (foldAt === -1) foldAt = windows.length;
    } else {
      windows.push(w);
    }
  }
  if (foldAt === -1) windows.push(incoming);
  else windows.splice(foldAt, 0, incoming);
  let merged = false;
  let handlerDisabled = false;
  const mergedWindows: CatchUpWindow[] = [];
  while (windows.length > CATCHUP_MAX_PENDING_WINDOWS) {
    const [a, b] = windows.splice(0, 2);
    const combined = {
      since: Math.min(a.since, b.since),
      until: Math.max(a.until, b.until),
      handlerEnabled: a.handlerEnabled && b.handlerEnabled,
    };
    if (a.handlerEnabled !== b.handlerEnabled) handlerDisabled = true;
    mergedWindows.push(combined);
    windows.unshift(combined);
    merged = true;
  }
  return { windows, merged, handlerDisabled, mergedWindows };
}

export interface CatchUpDeps {
  db: D1Database;
  relayUrl: string;
  storage: DurableObjectStorage;
  /** True the first time an id is claimed in this instance; the live path claims too. */
  claim(id: string): boolean;
  /** Resolves true when handling this report took an automated hide action. */
  handle(report: SignedReport, handlerEnabled: boolean): Promise<boolean | void>;
  /** False once the watcher is stopped: the pass halts at the next page boundary. */
  isRunning(): boolean;
  alert(text: string): Promise<void>;
  nowMs(): number;
}

export interface CatchUpSummary {
  ran: boolean;
  found: number;
  handled: number;
  /** Reports this pass took an automated hide action on (legacy hides and quarantine hide triggers). */
  autoHidden: number;
  complete: boolean;
}

const STEP_REASON_TEXT: Record<Exclude<WalkStopReason, 'page_cap'>, string> = {
  saturated_second: `a full page of ${CATCHUP_PAGE_SIZE} reports lies in that one second`,
  evidenced_cap: 'the relay returns fewer rows per page than that second holds',
  no_cursor: 'the relay returned a page with no usable timestamps',
};

/** Thrown from a page handler when the watcher stopped: no id on that page is claimed. */
class CatchUpStopped extends Error {}

async function alertQuietly(deps: CatchUpDeps, text: string): Promise<void> {
  try {
    await deps.alert(text);
  } catch (error) {
    console.error('[report-catchup] Alert failed:', error);
  }
}

const sameWindow = (a: CatchUpWindow, b: CatchUpWindow) =>
  a.since === b.since && a.until === b.until && a.handlerEnabled === b.handlerEnabled;

/**
 * Replaces `current` in the stored list with `next`, or removes it when `next`
 * is null. Re-reads the list each time: a connect can append (or merge) a
 * window while a pass runs. If `current` was merged away meanwhile, the merged
 * window covers its span and nothing is written.
 */
async function replaceWindow(
  storage: DurableObjectStorage,
  current: CatchUpWindow,
  next: CatchUpWindow | null,
): Promise<boolean> {
  const windows = (await storage.get<CatchUpWindow[]>(CATCHUP_WINDOWS_KEY)) ?? [];
  const index = windows.findIndex(w => sameWindow(w, current));
  if (index === -1) return false;
  if (next) windows[index] = next;
  else windows.splice(index, 1);
  await storage.put(CATCHUP_WINDOWS_KEY, windows);
  return true;
}

/**
 * One pass over the pending windows, oldest first. A window is dropped only
 * when its walk is complete. A failed page is never retried (the relay keeps
 * running an abandoned query): the window stays at the cursor saved after its
 * last handled page, and the pass stops. A window that cannot page past a
 * second steps one second down and keeps walking; one that uses up its page
 * budget is kept at its cursor and the pass moves on, so a stuck window cannot
 * hold later ones back. A stop halts the pass at the next page boundary,
 * before that page's ids are claimed.
 */
export async function runPendingCatchUp(deps: CatchUpDeps): Promise<CatchUpSummary> {
  const summary: CatchUpSummary = { ran: false, found: 0, handled: 0, autoHidden: 0, complete: false };
  const pending = (await deps.storage.get<CatchUpWindow[]>(CATCHUP_WINDOWS_KEY)) ?? [];
  if (pending.length === 0) return { ...summary, complete: true };

  const now = deps.nowMs();
  const lastAttempt = await deps.storage.get<number>(CATCHUP_LAST_ATTEMPT_KEY);
  if (lastAttempt !== undefined && now - lastAttempt < CATCHUP_MIN_ATTEMPT_INTERVAL_MS) return summary;
  // Stamped before the first page, so a pass that dies mid-walk still spaces the next one.
  await deps.storage.put(CATCHUP_LAST_ATTEMPT_KEY, now);
  summary.ran = true;
  const steps: string[] = [];

  // The stop guarantee (no auto-hide or age review for a report created while
  // the watcher was deliberately stopped) does not depend on window order. A
  // fold or cap merge can put a handler-on window that spans a stopped period
  // ahead of the handler-off one (a reconnect before the first heartbeat, or
  // an older outage window), and whichever window finds a report first is the
  // one that handles it. So the handler is decided per report: each stop's
  // (stopAt, startAt] is persisted when its marker is consumed, and
  // reportHandlerEnabled turns the handler off for any report created in one,
  // in any window. created_at is the reporter's claim, but it is also the only
  // time the relay filters on, so this matches how the windows split.
  //
  // What a halted pass (a stop, or a thrown page) relies on to leave nothing
  // handled twice and nothing unreachable: each walk is newest first and its
  // cursor is saved only after a whole page is handled, so a kept window's
  // unhandled part is exactly [since, until] as stored; and a thrown page
  // breaks the whole pass, so later windows stay untouched. Each window gets
  // the same page budget per pass, so one cannot starve the ones after it.
  let halted = false;
  for (const window of pending) {
    if (halted || !deps.isRunning()) break;
    let current = window;
    let pagesLeft = CATCHUP_MAX_PAGES;
    try {
      while (pagesLeft > 0) {
        const result = await walkRelayEvents<SignedReport>(
          {
            relayUrl: deps.relayUrl,
            filter: {},
            kind: 1984,
            since: current.since,
            until: current.until,
            pageSize: CATCHUP_PAGE_SIZE,
            maxPages: pagesLeft,
            pageTimeoutMs: RELAY_WALK_PAGE_TIMEOUT_MS,
          },
          async (events, nextUntil) => {
            if (!deps.isRunning()) throw new CatchUpStopped();
            summary.found += events.length;
            // Seen check first, then the claim, so a failed lookup leaves no id
            // claimed-but-unhandled in this instance. Exactly-once holds in
            // either order: the claim is taken synchronously right before
            // handle(), and the live path claims before it does anything. A
            // report the live path took meanwhile fails the claim here; one it
            // finished before the lookup is already in report_arrivals.
            const unseen = await findUnseenReportIds(deps.db, events.map(e => e.id));
            // Read per page: a connect during the pass can add a period.
            const periods = (await deps.storage.get<StoppedPeriod[]>(CATCHUP_STOPPED_PERIODS_KEY)) ?? [];
            for (const report of events) {
              const id = canonicalHex64(report.id) ?? report.id;
              if (!unseen.has(id) || !deps.claim(id)) continue;
              if (await deps.handle(report, reportHandlerEnabled(report.created_at, current, periods))) summary.autoHidden += 1;
              summary.handled += 1;
            }
            const next = { ...current, until: nextUntil };
            if (await replaceWindow(deps.storage, current, next)) current = next;
          },
        );
        pagesLeft -= result.pages;
        if (result.complete) {
          await replaceWindow(deps.storage, current, null);
          break;
        }
        if (!result.stopReason || result.stopReason === 'page_cap') {
          console.error(`[report-catchup] Window used its ${CATCHUP_MAX_PAGES}-page budget; kept at its saved cursor`, current);
          break;
        }
        // The walk cannot move its cursor below the second it ended on (for a
        // full page in one second, anyone can cause this: reporters set
        // created_at). Resuming there would re-read the same page forever, so
        // step one second down and keep walking within the budget. Reports
        // past the first page in that second are left to the later reconcile;
        // the alert at the end of the pass makes the skip visible.
        const second = current.until;
        const stepped = { ...current, until: second - 1 };
        steps.push(`second ${second} in window ${window.since}..${window.until} (${STEP_REASON_TEXT[result.stopReason]})`);
        // Merged away by a concurrent connect: the merged window covers it.
        if (!(await replaceWindow(deps.storage, current, stepped))) break;
        current = stepped;
      }
    } catch (error) {
      if (error instanceof CatchUpStopped) {
        console.log('[report-catchup] Watcher stopped; pass halted with the window at its saved cursor', current);
      } else {
        console.error('[report-catchup] Window page failed; kept at its saved cursor, not retried this pass', current, error);
      }
      halted = true;
    }
  }

  if (steps.length > 0) {
    await alertQuietly(
      deps,
      `Restart catch-up could not page past ${steps.length === 1 ? 'a second' : `${steps.length} seconds`} and stepped `
      + `one second down past each: ${steps.join('; ')}. Reports past the first page in each such second are left to `
      + 'the later reconcile.',
    );
  }

  const remaining = (await deps.storage.get<CatchUpWindow[]>(CATCHUP_WINDOWS_KEY)) ?? [];
  summary.complete = remaining.length === 0;
  const periods = (await deps.storage.get<StoppedPeriod[]>(CATCHUP_STOPPED_PERIODS_KEY)) ?? [];
  const keptPeriods = pruneStoppedPeriods(periods, remaining);
  if (keptPeriods.length !== periods.length) await deps.storage.put(CATCHUP_STOPPED_PERIODS_KEY, keptPeriods);
  if (summary.autoHidden > AUTO_ACTION_BURST_THRESHOLD) {
    await alertQuietly(
      deps,
      `Restart catch-up took automated hide actions on ${summary.autoHidden} reports in one pass `
      + `(alert threshold ${AUTO_ACTION_BURST_THRESHOLD}). Review the automated hides in the moderation log.`,
    );
  }
  return summary;
}
