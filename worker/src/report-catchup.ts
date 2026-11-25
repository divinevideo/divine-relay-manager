// ABOUTME: Restart catch-up for the report listener: windows of reports filed while it was disconnected.
// ABOUTME: Each unseen report found goes through the live handler once; windows persist and resume from a saved cursor.

import { canonicalHex64 } from '../../shared/hex-id';
import { findUnseenReportIds, readMeta, type SignedReport } from './report-index';
import { RELAY_WALK_PAGE_TIMEOUT_MS, walkRelayEvents, type WalkStopReason } from './relay-walk';

/**
 * A span of report created_at seconds to read from the relay. `since` and
 * `until` come from the watcher's own clock (its heartbeat and the connect
 * time), never from report timestamps, which reporters set and can backdate
 * or future-date. `until` is the walk's inclusive cursor and moves down as
 * pages are handled. Whether a report found in it gets auto-hide and age
 * review is decided per report by the stopped periods (reportHandlerEnabled).
 */
export interface CatchUpWindow {
  since: number;
  until: number;
}

export const CATCHUP_OVERLAP_SECONDS = 600;
// Windows reach this far past the connect time: a report filed at the end of
// an outage by a client whose clock runs fast is dated after the connect. The
// relay returns no report dated after its own clock (funnelcake adds
// created_at <= now() to every REQ), so at the connect this margin reads
// empty. That is why a pass keeps the part of a window the relay could not
// show yet (CATCHUP_RELAY_CLOCK_ALLOWANCE_SECONDS) and a later pass walks it
// again. A report in the margin that arrived live is claimed and has an
// arrival, so the seen check skips it.
export const CATCHUP_CLOCK_MARGIN_SECONDS = 120;
// How far the relay's clock may run behind the watcher's. A pass treats a
// window's created_at seconds later than (its own clock minus this) as not yet
// visible, and keeps them pending instead of finishing the window.
export const CATCHUP_RELAY_CLOCK_ALLOWANCE_SECONDS = 5;
// At or under the relay's maximum `limit` (see WalkOptions.pageSize).
export const CATCHUP_PAGE_SIZE = 500;
export const CATCHUP_MAX_PAGES = 40;
// After a failed pass: under the five-minute cron, so the cron can resume a
// failed window on its next run.
export const CATCHUP_MIN_ATTEMPT_INTERVAL_MS = 270_000;
// After a pass with no failed page: a floor, so a reconnect storm (each
// connect adds a window and asks for a pass while the heartbeat is frozen)
// cannot drive a pass per connect. The pass re-walks windows added while it
// ran, so a connect during a pass does not wait for the cron.
export const CATCHUP_SUCCESS_INTERVAL_MS = 30_000;
export const CATCHUP_MAX_PENDING_WINDOWS = 8;
export const AUTO_ACTION_BURST_THRESHOLD = 10;

/** DO storage: the pending windows, oldest first. */
export const CATCHUP_WINDOWS_KEY = 'report-catchup-windows';
/** DO storage: unix ms of the last pass that read the relay (its start). */
export const CATCHUP_LAST_ATTEMPT_KEY = 'report-catchup-last-attempt';
/** DO storage: unix ms at which the last pass with no failed page ended. */
export const CATCHUP_LAST_OK_KEY = 'report-catchup-last-ok';
/** DO storage: StoppedPeriod[], each consumed deliberate stop's period (see stopPeriodFor). */
export const CATCHUP_STOPPED_PERIODS_KEY = 'report-catchup-stopped-periods';
export const CATCHUP_MAX_STOPPED_PERIODS = 8;

/**
 * A deliberate stop's stopped period, (after, until] in report created_at
 * seconds (see stopPeriodFor). Reports created in one get no auto-hide or age
 * review, whichever window finds them.
 */
export interface StoppedPeriod {
  after: number;
  until: number;
}

export function inStoppedPeriod(createdAt: number, periods: readonly StoppedPeriod[]): boolean {
  return periods.some(p => createdAt > p.after && createdAt <= p.until);
}

/**
 * Whether the handler (auto-hide and age review) runs for one report found by
 * catch-up: only if it falls in no stopped period. Decided per report, so it
 * does not matter which window finds it, or how windows folded or merged.
 */
export function reportHandlerEnabled(createdAt: number, periods: readonly StoppedPeriod[]): boolean {
  return !inStoppedPeriod(createdAt, periods);
}

/**
 * The stopped period of one deliberate stop: `(after, until]` in whole-second
 * Nostr `created_at` timestamps, covering from the `/stop` second itself
 * (`after = Math.min(stopAt, end) - 1`, so `created_at >= stopAt` matches
 * `createdAt > p.after`) to `/start` plus the clock margin after `/start`.
 * With no recorded start (its write failed, or the watcher is still stopped),
 * `nowSec` stands in for it: the connect time when a connect consumes the
 * stop, or now for a reader before that.
 *
 * The margin: the relay rejects a report dated more than its drift limit
 * (60 s by default) past its own clock, so a report filed during the stop is
 * dated at most that far past the /start. Anything filed after the connect
 * arrives live and is skipped as seen, so a report only catch-up finds in the
 * margin was filed before the connect: during the stop by a fast clock, or in
 * the first two minutes after a start whose connect was late or missed it.
 * Both are index-only. Anchored at the /start, not the connect, so a late
 * connect adds no index-only time after it.
 */
export function stopPeriodFor(stopAt: number, startedAt: number | undefined, nowSec: number): StoppedPeriod {
  const end = Math.min(startedAt ?? nowSec, nowSec);
  return { after: Math.min(stopAt, end) - 1, until: end + CATCHUP_CLOCK_MARGIN_SECONDS };
}

/**
 * The earliest created_at a window planned from now on can start at: the next
 * connect's window starts at its heartbeat minus the overlap, and the
 * heartbeat only moves forward. With no heartbeat yet, the first one will be
 * stamped no earlier than now. Pass -Infinity when the heartbeat could not be
 * read. Callers take the minimum with the adult replay's reach too (see
 * CatchUpDeps.otherReachFloor).
 */
export function stoppedPeriodReachFloor(lastAliveAt: number | undefined, nowSec: number): number {
  return (lastAliveAt ?? nowSec) - CATCHUP_OVERLAP_SECONDS;
}

/**
 * Drops periods no window can still reach: those that end before every
 * pending window's since and before `reachFloor` (stoppedPeriodReachFloor),
 * where any window planned later starts.
 *
 * Over CATCHUP_MAX_STOPPED_PERIODS, the two oldest merge into their union
 * rather than one being dropped: a dropped period a window can still reach
 * would hand its reports the handler. The union also covers the time between
 * the two stops, which the watcher handled live, so it suppresses only reports
 * already seen (the seen check skips them anyway) or backdated into that gap.
 * It is the last resort: with a known heartbeat, periods older than the floor
 * are dropped first, so it takes more than eight stops within reach at once.
 * `onMerge` is told each union, so the caller can alert (see
 * stoppedPeriodMergeAlertText).
 */
export function pruneStoppedPeriods(
  periods: readonly StoppedPeriod[],
  pending: readonly CatchUpWindow[],
  reachFloor: number,
  onMerge?: (merged: StoppedPeriod) => void,
): StoppedPeriod[] {
  const earliest = Math.min(reachFloor, ...pending.map(w => w.since));
  const kept = periods.filter(p => p.until >= earliest).sort((a, b) => a.after - b.after);
  while (kept.length > CATCHUP_MAX_STOPPED_PERIODS) {
    const [a, b] = kept.splice(0, 2);
    const merged = { after: Math.min(a.after, b.after), until: Math.max(a.until, b.until) };
    kept.unshift(merged);
    onMerge?.(merged);
  }
  return kept;
}

/** The alert for a cap merge of stopped periods (pruneStoppedPeriods). */
export function stoppedPeriodMergeAlertText(merged: StoppedPeriod): string {
  return `More than ${CATCHUP_MAX_STOPPED_PERIODS} stopped periods are within reach; the two oldest were merged into `
    + `${merged.after}..${merged.until}, which may cover time the listener was running. Reports catch-up finds there `
    + 'get no auto-hide or age review. Check why the watcher was stopped so often.';
}

/**
 * Adds a period, joined with any it overlaps or touches: (a, b] and (b, c]
 * cover exactly the reports (a, c] does, so this never widens what is
 * index-only, and a stop's period and its margin count as one. An empty
 * period adds nothing.
 */
export function addStoppedPeriod(
  periods: readonly StoppedPeriod[],
  period: StoppedPeriod,
  pending: readonly CatchUpWindow[],
  reachFloor: number,
  onMerge?: (merged: StoppedPeriod) => void,
): StoppedPeriod[] {
  if (period.until <= period.after) return pruneStoppedPeriods(periods, pending, reachFloor, onMerge);
  let joined = period;
  const rest: StoppedPeriod[] = [];
  for (const p of periods) {
    if (p.after <= joined.until && joined.after <= p.until) {
      joined = { after: Math.min(p.after, joined.after), until: Math.max(p.until, joined.until) };
    } else {
      rest.push(p);
    }
  }
  return pruneStoppedPeriods([...rest, joined], pending, reachFloor, onMerge);
}

/**
 * The window for one connect: from the last heartbeat (minus the overlap) to
 * the clock margin past now. After a deliberate stop it is the same window;
 * the stop is saved as a stopped period instead, which turns the handler off
 * per report (reportHandlerEnabled). So a merge at the pending cap never takes
 * auto-hide or age review away from an outage. An outage that began before the
 * stop keeps the live treatment for what was filed before it.
 */
export function planCatchUpWindow(
  lastAliveAt: number | undefined,
  nowSec: number,
): CatchUpWindow[] {
  // No heartbeat was ever recorded: this is the first connect, and everything
  // older is history the handler must not replay (it is not idempotent).
  if (lastAliveAt === undefined) return [];
  // The relay filters on created_at and the window ends a clock margin past
  // the connect, so a report dated further ahead (future-dated, filed during
  // the outage) is outside it. It is left to the later incremental and full
  // sweeps. The margin itself is found only once the relay's clock passes it
  // (see CATCHUP_CLOCK_MARGIN_SECONDS).
  return [{ since: lastAliveAt - CATCHUP_OVERLAP_SECONDS, until: nowSec + CATCHUP_CLOCK_MARGIN_SECONDS }];
}

/**
 * Adds a window. One that overlaps pending windows folds into them (the union
 * of their spans, at the first one's place), so a flapping relay does not pile
 * up near-identical windows that every pass would walk again. A pending
 * window's `until` is its remaining cursor, so the union covers exactly what
 * is still unwalked. Past the cap, the two oldest merge into one spanning
 * both, as a backstop (capPendingWindows).
 */
export function addPendingWindow(
  pending: CatchUpWindow[],
  next: CatchUpWindow,
): { windows: CatchUpWindow[]; merged: boolean } {
  let incoming = next;
  let foldAt = -1;
  const windows: CatchUpWindow[] = [];
  for (const w of pending) {
    if (w.since <= incoming.until && incoming.since <= w.until) {
      incoming = { since: Math.min(w.since, incoming.since), until: Math.max(w.until, incoming.until) };
      if (foldAt === -1) foldAt = windows.length;
    } else {
      windows.push(w);
    }
  }
  if (foldAt === -1) windows.push(incoming);
  else windows.splice(foldAt, 0, incoming);
  return capPendingWindows(windows);
}

/**
 * Merges the two oldest windows into one spanning both while there are more
 * than CATCHUP_MAX_PENDING_WINDOWS. The merged window re-reads the gap between
 * them, which the seen check makes harmless; the handler is decided per
 * report, so a merge cannot change what any report gets.
 */
function capPendingWindows(windows: CatchUpWindow[]): { windows: CatchUpWindow[]; merged: boolean } {
  let merged = false;
  while (windows.length > CATCHUP_MAX_PENDING_WINDOWS) {
    const [a, b] = windows.splice(0, 2);
    windows.unshift({ since: Math.min(a.since, b.since), until: Math.max(a.until, b.until) });
    merged = true;
  }
  return { windows, merged };
}

export interface CatchUpDeps {
  db: D1Database;
  relayUrl: string;
  storage: DurableObjectStorage;
  /** True the first time an id is claimed in this instance; the live path claims too. */
  claim(id: string): boolean;
  /** Resolves true when handling this report took an automated hide action. */
  handle(report: SignedReport, handlerEnabled: boolean): Promise<boolean | void>;
  /**
   * The stopped periods as they stand: the saved ones and a stop no connect
   * has consumed yet. Read before each report is claimed, so a stop and start
   * during the pass are honoured.
   */
  stoppedPeriods(): Promise<StoppedPeriod[]>;
  /**
   * The earliest created_at another reader of the stopped periods (the adult
   * report replay) can still reach at `nowSec` (the pass's clock), or Infinity
   * when none can. Pruning keeps every period from there on.
   */
  otherReachFloor(nowSec: number): Promise<number>;
  /** False once the watcher is stopped: the pass halts before the next report it would claim. */
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

/** Thrown from a page handler when the watcher stopped: no further id is claimed, and the page's cursor is not saved. */
class CatchUpStopped extends Error {}

async function alertQuietly(deps: CatchUpDeps, text: string): Promise<void> {
  try {
    await deps.alert(text);
  } catch (error) {
    console.error('[report-catchup] Alert failed:', error);
  }
}

const sameWindow = (a: CatchUpWindow, b: CatchUpWindow) => a.since === b.since && a.until === b.until;

/**
 * Replaces `current` in the stored list with `next` (in its place, in order),
 * or removes it when `next` is empty. Re-reads the list each time: a connect
 * can append (or merge) a window while a pass runs. Returns 'missing' when
 * `current` was merged away meanwhile (the merged window covers its span) and
 * nothing is written, and 'full' when the replacement would take the list
 * past CATCHUP_MAX_PENDING_WINDOWS: nothing is written, so `current` stays as
 * stored and still covers everything `next` would have.
 *
 * In a transaction: the pass and a connect's plan both read-modify-write this
 * list. Only storage calls lie between the get and the put, so the input gate
 * already holds other events off; the transaction makes that explicit and
 * does not depend on it.
 */
async function replaceWindow(
  storage: DurableObjectStorage,
  current: CatchUpWindow,
  next: readonly CatchUpWindow[],
): Promise<'saved' | 'missing' | 'full'> {
  return storage.transaction(async (tx) => {
    const windows = (await tx.get<CatchUpWindow[]>(CATCHUP_WINDOWS_KEY)) ?? [];
    const index = windows.findIndex(w => sameWindow(w, current));
    if (index === -1) return 'missing';
    // Only a split grows the list; a plain cursor save or a removal never does.
    if (next.length > 1 && windows.length - 1 + next.length > CATCHUP_MAX_PENDING_WINDOWS) return 'full';
    windows.splice(index, 1, ...next);
    await tx.put(CATCHUP_WINDOWS_KEY, windows);
    return 'saved';
  });
}

const windowKey = (w: CatchUpWindow) => `${w.since}:${w.until}`;

/**
 * One pass over the pending windows, oldest first. A window is dropped only
 * when its walk is complete. A failed page is never retried (the relay keeps
 * running an abandoned query): the window stays at the cursor saved after its
 * last handled page, and the pass stops. A window that cannot page past a
 * second steps one second down and keeps walking; one that uses up its page
 * budget is kept at its cursor and the pass moves on, so a stuck window cannot
 * hold later ones back. A stop halts the pass before the next report it
 * would claim, without saving that page's cursor, so the next pass reads the
 * page again and the seen check skips what was handled. Windows a connect
 * added while the pass ran are walked once more before it returns.
 *
 * A window that reaches past what the relay can show yet (later than this
 * pass's clock minus CATCHUP_RELAY_CLOCK_ALLOWANCE_SECONDS) is walked, but
 * that part of it is kept pending however the walk ends, and a later pass
 * walks it again. Nothing else is read twice, except when the pending list is
 * full: then a window's cursor is not saved below that part (splitting it off
 * would need a ninth window), and a walk cut short starts over.
 */
export async function runPendingCatchUp(deps: CatchUpDeps): Promise<CatchUpSummary> {
  const summary: CatchUpSummary = { ran: false, found: 0, handled: 0, autoHidden: 0, complete: false };
  const pending = (await deps.storage.get<CatchUpWindow[]>(CATCHUP_WINDOWS_KEY)) ?? [];
  if (pending.length === 0) return { ...summary, complete: true };

  const now = deps.nowMs();
  const lastAttempt = await deps.storage.get<number>(CATCHUP_LAST_ATTEMPT_KEY);
  if (lastAttempt !== undefined) {
    // The last pass finished without a failed page only if it recorded so
    // after it started; otherwise it failed, or died mid-walk.
    const lastOk = await deps.storage.get<number>(CATCHUP_LAST_OK_KEY);
    const held = lastOk !== undefined && lastOk >= lastAttempt
      ? now - lastOk < CATCHUP_SUCCESS_INTERVAL_MS
      : now - lastAttempt < CATCHUP_MIN_ATTEMPT_INTERVAL_MS;
    if (held) return summary;
  }
  // Stamped before the first page, so a pass that dies mid-walk counts as
  // failed and spaces the next one by the full interval.
  await deps.storage.put(CATCHUP_LAST_ATTEMPT_KEY, now);
  summary.ran = true;
  const steps: string[] = [];
  // Windows as this pass left them, to tell them from windows a connect added.
  const ours = new Set<string>(pending.map(windowKey));
  let failed = false;
  let stopped = false;

  const save = async (current: CatchUpWindow, next: readonly CatchUpWindow[]) => {
    const result = await replaceWindow(deps.storage, current, next);
    if (result === 'saved') for (const w of next) ours.add(windowKey(w));
    return result;
  };

  // The stop guarantee (no auto-hide or age review for a report created while
  // the watcher was deliberately stopped) does not depend on windows: a fold
  // or cap merge can put any window over a stopped period. So the handler is
  // decided per report against the stopped periods (deps.stoppedPeriods),
  // read before each claim. created_at is the reporter's claim, but it is
  // also the only time the relay filters on.
  //
  // What a halted pass (a stop, or a thrown page) relies on to leave nothing
  // handled twice and nothing unreachable: each walk is newest first and its
  // cursor is saved only after a whole page is handled, so a kept window's
  // unhandled part is exactly [since, until] as stored; and a thrown page
  // breaks the whole pass, so later windows stay untouched. Each window gets
  // the same page budget per pass, so one cannot starve the ones after it.
  const walkWindows = async (windows: readonly CatchUpWindow[]): Promise<void> => {
    for (const window of windows) {
      if (failed || stopped) return;
      if (!deps.isRunning()) { stopped = true; return; }
      // `stored` is this window as it now stands in storage; `cursor` is where
      // the walk is. They differ only while the pending list is full (below).
      let stored: CatchUpWindow | null = window;
      let cursor = window.until;
      let pagesLeft = CATCHUP_MAX_PAGES;
      // The relay returns no report dated after its own clock, so this part
      // of the window reads empty or partial now. It stays pending, as its own
      // window, however the walk ends: once the cursor has moved below it, or
      // the walk is done.
      const horizon = Math.floor(deps.nowMs() / 1000) - CATCHUP_RELAY_CLOCK_ALLOWANCE_SECONDS;
      let unseenTail: CatchUpWindow | null = window.until > horizon
        ? { since: Math.max(window.since, horizon + 1), until: window.until }
        : null;
      // Saves the walk's progress: `nextUntil` is the new cursor, null when the
      // walk is done. The unseen tail joins the first save that no longer
      // stores the window's end. If that would take the pending list past the
      // cap, nothing is saved and the stored window keeps covering everything.
      // False once the window was merged away by a concurrent connect (the
      // merged window covers it, and nothing more is saved for it).
      const advance = async (nextUntil: number | null): Promise<boolean> => {
        if (stored === null) return false;
        const next = nextUntil === null ? null : { since: window.since, until: nextUntil };
        const replacement = next ? [next] : [];
        const keepTail = unseenTail !== null && (next === null || next.until < unseenTail.until);
        if (keepTail && unseenTail) replacement.push(unseenTail);
        const result = await save(stored, replacement);
        if (result === 'missing') { stored = null; return false; }
        if (result === 'saved') {
          stored = next;
          if (keepTail) unseenTail = null;
        }
        return true;
      };
      try {
        while (pagesLeft > 0) {
          const result = await walkRelayEvents<SignedReport>(
            {
              relayUrl: deps.relayUrl,
              filter: {},
              kind: 1984,
              since: window.since,
              until: cursor,
              pageSize: CATCHUP_PAGE_SIZE,
              maxPages: pagesLeft,
              pageTimeoutMs: RELAY_WALK_PAGE_TIMEOUT_MS,
            },
            async (events, nextUntil) => {
              if (!deps.isRunning()) throw new CatchUpStopped();
              summary.found += events.length;
              // Seen check first, then the claim, so a failed lookup leaves no id
              // claimed-but-unhandled in this instance. Exactly-once holds in
              // either order: the claim is taken right before handle(), and the
              // live path claims before it does anything. A report the live
              // path took meanwhile fails the claim here; one it finished
              // before the lookup is already in report_arrivals.
              const unseen = await findUnseenReportIds(deps.db, events.map(e => e.id));
              for (const report of events) {
                const id = canonicalHex64(report.id) ?? report.id;
                if (!unseen.has(id)) continue;
                // Per report, not only per page: each handling awaits D1 and
                // the relay, so a stop (or a stop and a start) can land
                // mid-page. Nothing claimed after a stop runs, and the periods
                // are read as they stand now, before the claim so a failed read
                // strands no claim.
                if (!deps.isRunning()) throw new CatchUpStopped();
                const periods = await deps.stoppedPeriods();
                if (!deps.claim(id)) continue;
                if (await deps.handle(report, reportHandlerEnabled(report.created_at, periods))) summary.autoHidden += 1;
                summary.handled += 1;
              }
              cursor = nextUntil;
              await advance(nextUntil);
            },
          );
          pagesLeft -= result.pages;
          if (result.complete) {
            await advance(null);
            break;
          }
          if (!result.stopReason || result.stopReason === 'page_cap') {
            console.error(`[report-catchup] Window used its ${CATCHUP_MAX_PAGES}-page budget; kept at its saved cursor`, stored);
            break;
          }
          // The walk cannot move its cursor below the second it ended on (for a
          // full page in one second, anyone can cause this: reporters set
          // created_at). Resuming there would re-read the same page forever, so
          // step one second down and keep walking within the budget. Reports
          // past the first page in that second are left to the later reconcile;
          // the alert at the end of the pass makes the skip visible.
          const second = cursor;
          // A second the relay may not show in full yet lies in the unseen
          // tail, which a later pass walks again: that pass, once the second
          // is visible, raises the alert, so it is raised once.
          if (second <= horizon) {
            steps.push(`second ${second} in window ${window.since}..${window.until} (${STEP_REASON_TEXT[result.stopReason]})`);
          }
          // The step leaves nothing of the window: drop it rather than store an
          // inverted window and spend a query on it.
          if (second - 1 < window.since) {
            await advance(null);
            break;
          }
          // Merged away by a concurrent connect: the merged window covers it.
          if (!(await advance(second - 1))) break;
          cursor = second - 1;
        }
      } catch (error) {
        if (error instanceof CatchUpStopped) {
          stopped = true;
          console.log('[report-catchup] Watcher stopped; pass halted with the window at its saved cursor', stored);
        } else {
          failed = true;
          console.error('[report-catchup] Window page failed; kept at its saved cursor, not retried this pass', stored, error);
        }
      }
    }
  };

  await walkWindows(pending);
  // A connect that added a window during the pass found the pass in flight,
  // so nothing else will walk it before the next cron. Walk those once more
  // now: sequential, after the pass, never a retry of a failed page (a failure
  // or a stop ends here).
  if (!failed && !stopped) {
    const stored = (await deps.storage.get<CatchUpWindow[]>(CATCHUP_WINDOWS_KEY)) ?? [];
    const added = stored.filter(w => !ours.has(windowKey(w)));
    if (added.length > 0) await walkWindows(added);
  }
  // A pass halted by /stop deliberately counts as a success for the floor, so a
  // stop/start loop cannot bypass the relay throttle; the cron resumes it.
  if (!failed) await deps.storage.put(CATCHUP_LAST_OK_KEY, deps.nowMs());

  if (steps.length > 0) {
    await alertQuietly(
      deps,
      `Restart catch-up could not page past ${steps.length === 1 ? 'a second' : `${steps.length} seconds`} and stepped `
      + `one second down past each: ${steps.join('; ')}. Reports past the first page in each such second are left to `
      + 'the later reconcile.',
    );
  }

  // Read before the transaction (D1 is not storage), and only when there is a
  // period to prune. A floor that cannot be read prunes nothing but what the
  // cap merges, and so does a period a connect adds after this check.
  let reachFloor = -Infinity;
  if (((await deps.storage.get<StoppedPeriod[]>(CATCHUP_STOPPED_PERIODS_KEY)) ?? []).length > 0) {
    try {
      const nowSec = Math.floor(deps.nowMs() / 1000);
      reachFloor = Math.min(
        stoppedPeriodReachFloor((await readMeta(deps.db)).watcher_last_alive_at, nowSec),
        await deps.otherReachFloor(nowSec),
      );
    } catch (error) {
      console.error('[report-catchup] Heartbeat or replay cursor read failed; stopped periods kept', error);
    }
  }
  // In a transaction, like every other read-modify-write of these keys: a
  // connect can add a period between this read and this write.
  summary.complete = await deps.storage.transaction(async (tx) => {
    const remaining = (await tx.get<CatchUpWindow[]>(CATCHUP_WINDOWS_KEY)) ?? [];
    const periods = (await tx.get<StoppedPeriod[]>(CATCHUP_STOPPED_PERIODS_KEY)) ?? [];
    // No merge alert here: every writer of the list (a connect's plan, a /stop)
    // already caps it and alerts, so this prune only drops.
    const keptPeriods = pruneStoppedPeriods(periods, remaining, reachFloor);
    if (keptPeriods.length !== periods.length) await tx.put(CATCHUP_STOPPED_PERIODS_KEY, keptPeriods);
    return remaining.length === 0;
  });
  if (summary.autoHidden > AUTO_ACTION_BURST_THRESHOLD) {
    await alertQuietly(
      deps,
      `Restart catch-up took automated hide actions on ${summary.autoHidden} reports in one pass `
      + `(alert threshold ${AUTO_ACTION_BURST_THRESHOLD}). Review the automated hides in the moderation log.`,
    );
  }
  return summary;
}
