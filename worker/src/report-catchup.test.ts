// ABOUTME: Pure window logic for the listener's restart catch-up: planning a window and bounding the pending list.
// ABOUTME: The relay walk, claims and the live handler are exercised against real D1 in test/report-catchup.d1.test.ts.

import { describe, expect, it } from 'vitest';
import {
  CATCHUP_CLOCK_MARGIN_SECONDS,
  CATCHUP_MAX_STOPPED_PERIODS,
  addStoppedPeriod,
  pruneStoppedPeriods,
  stopPeriodFor,
  stoppedPeriodReachFloor,
  reportHandlerEnabled,
  type StoppedPeriod,
  CATCHUP_MAX_PENDING_WINDOWS,
  CATCHUP_OVERLAP_SECONDS,
  addPendingWindow,
  planCatchUpWindow,
  type CatchUpWindow,
} from './report-catchup';

describe('planCatchUpWindow', () => {
  it('plans no window when no heartbeat was ever recorded', () => {
    expect(planCatchUpWindow(undefined, 2_000_000)).toEqual([]);
  });

  it('starts the window ten minutes before the last heartbeat, from the watcher clock', () => {
    // The window is built from watcher clocks and nothing else: the signature
    // takes no report data, so a future-dated report in the corpus (created_at
    // is the reporter's claim) cannot move `since` past a real gap.
    const lastAliveAt = 1_999_880;
    const now = 2_000_000;
    expect(CATCHUP_OVERLAP_SECONDS).toBe(600);
    expect(planCatchUpWindow(lastAliveAt, now)).toEqual([{ since: lastAliveAt - 600, until: now + 120 }]);
  });

  it('reaches two minutes past the connect time, for a report from a client whose clock runs fast', () => {
    expect(CATCHUP_CLOCK_MARGIN_SECONDS).toBe(120);
    const [window] = planCatchUpWindow(1_999_880, 2_000_000);
    // Filed at 1_999_999 by a client 90 s fast: dated after the connect.
    expect(window.until).toBeGreaterThanOrEqual(2_000_089);
  });
});

describe('addPendingWindow', () => {
  const w = (since: number, until: number): CatchUpWindow => ({ since, until });

  it('appends while there are at most eight windows', () => {
    const pending = [w(100, 200), w(300, 400)];
    const { windows, merged } = addPendingWindow(pending, w(500, 600));
    expect(merged).toBe(false);
    expect(windows).toEqual([w(100, 200), w(300, 400), w(500, 600)]);
    // The caller's list is not mutated.
    expect(pending).toHaveLength(2);
  });

  it('merges the two oldest windows past eight into one spanning both', () => {
    expect(CATCHUP_MAX_PENDING_WINDOWS).toBe(8);
    const rest = [3, 4, 5, 6, 7, 8].map(i => w(i * 1000, i * 1000 + 10));
    const { windows, merged } = addPendingWindow([w(500, 600), w(100, 700), ...rest], w(9000, 9010));
    expect(merged).toBe(true);
    expect(windows).toEqual([w(100, 700), ...rest, w(9000, 9010)]);
  });

  it('folds a new window into an overlapping pending one', () => {
    expect(addPendingWindow([w(100, 300)], w(250, 400))).toEqual({ windows: [w(100, 400)], merged: false });
    // One new window can bridge two pending ones.
    expect(addPendingWindow([w(100, 200), w(300, 400)], w(150, 350)).windows).toEqual([w(100, 400)]);
    // Windows that do not overlap stay separate.
    expect(addPendingWindow([w(100, 200)], w(201, 300)).windows).toEqual([w(100, 200), w(201, 300)]);
  });
});

describe('planCatchUpWindow after a deliberate stop', () => {
  it('plans the same window as an outage: the stopped periods decide per report', () => {
    const lastAliveAt = 1_996_400;
    const now = 2_000_000;
    // Takes no stop time at all: a stop changes the periods, not the window.
    expect(planCatchUpWindow(lastAliveAt, now)).toEqual([{ since: lastAliveAt - 600, until: now + 120 }]);
  });
});

describe('stopPeriodFor', () => {
  it('runs from the stop second itself to the clock margin after the /start, however late the connect', () => {
    // Started at 1_500, connected an hour later: nothing after 1_620 is index-only.
    expect(stopPeriodFor(1_000, 1_500, 5_100)).toEqual({ after: 999, until: 1_620 });
    // No recorded start: anchored at the connect (or now, for a reader before it).
    expect(stopPeriodFor(1_000, undefined, 1_300)).toEqual({ after: 999, until: 1_420 });
    // A start that reads later than the connect is clamped to it.
    expect(stopPeriodFor(1_000, 1_600, 1_550)).toEqual({ after: 999, until: 1_670 });
    // Stop and start in the same second still leave the margin and cover that second.
    expect(stopPeriodFor(1_500, 1_500, 1_500)).toEqual({ after: 1_499, until: 1_620 });

    const period = stopPeriodFor(1_000, 1_500, 5_100);
    expect(reportHandlerEnabled(1_000, [period])).toBe(false);
    expect(reportHandlerEnabled(999, [period])).toBe(true);
    expect(reportHandlerEnabled(1_500, [stopPeriodFor(1_500, 1_500, 1_500)])).toBe(false);
  });
});

describe('stopped periods', () => {
  it('keeps every stopped-period report index-only, whichever window finds it', () => {
    // Stop at 10030 during an outage that began at the 10000 heartbeat, start
    // at 12000, socket drops and reconnects at 12020 before the first stamp.
    const heartbeat = 10_000;
    const stopAt = 10_030;
    const startAt = 12_000;
    let windows = planCatchUpWindow(heartbeat, startAt);
    const periods = addStoppedPeriod([], { after: stopAt, until: startAt }, windows, heartbeat - 600);
    for (const w of planCatchUpWindow(heartbeat, 12_020)) windows = addPendingWindow(windows, w).windows;
    expect(windows).toEqual([{ since: 9_400, until: 12_140 }]);
    for (const createdAt of [stopAt + 1, 10_500, startAt]) {
      expect(reportHandlerEnabled(createdAt, periods)).toBe(false);
    }
    // Filed before the stop (the outage) or after the start: live treatment.
    expect(reportHandlerEnabled(stopAt, periods)).toBe(true);
    expect(reportHandlerEnabled(10_010, periods)).toBe(true);
    expect(reportHandlerEnabled(startAt + 1, periods)).toBe(true);
  });

  it('prunes a period once it ends before every pending window, and keeps at most eight', () => {
    const p = (after: number, until: number): StoppedPeriod => ({ after, until });
    const pending = [{ since: 5_000, until: 6_000 }, { since: 7_000, until: 8_000 }];
    // The heartbeat floor is later than the pending windows here.
    expect(pruneStoppedPeriods([p(1_000, 4_999), p(4_000, 5_000), p(6_500, 6_800)], pending, 9_000)).toEqual([p(4_000, 5_000), p(6_500, 6_800)]);
    // Nothing pending: kept while the next window, from the heartbeat, can
    // still reach them.
    expect(pruneStoppedPeriods([p(1_000, 2_000)], [], 1_500)).toEqual([p(1_000, 2_000)]);
    expect(CATCHUP_MAX_STOPPED_PERIODS).toBe(8);
    const many = Array.from({ length: 12 }, (_, i) => p(10_000 + i * 10, 10_005 + i * 10));
    const kept = addStoppedPeriod(many.slice(0, 11), many[11], [{ since: 0, until: 20_000 }], 9_000);
    // Over the cap the oldest merge into their union rather than drop out.
    expect(kept).toEqual([p(many[0].after, many[4].until), ...many.slice(5)]);
  });

  it('keeps a report in the oldest of nine reachable periods index-only', () => {
    const p = (after: number, until: number): StoppedPeriod => ({ after, until });
    const pending = [{ since: 1_000, until: 20_000 }];
    const nine = Array.from({ length: 9 }, (_, i) => p(2_000 + i * 1_000, 2_050 + i * 1_000));
    const kept = pruneStoppedPeriods(nine, pending, 1_500);
    expect(kept).toHaveLength(CATCHUP_MAX_STOPPED_PERIODS);
    expect(reportHandlerEnabled(2_025, kept)).toBe(false);
    // Every original period is still covered.
    for (const period of nine) expect(reportHandlerEnabled(period.until, kept)).toBe(false);
  });

  it('drops periods nothing can reach once the heartbeat has moved past them, and never merges across running time', () => {
    const p = (after: number, until: number): StoppedPeriod => ({ after, until });
    const heartbeat = 2_000_000;
    const floor = heartbeat - CATCHUP_OVERLAP_SECONDS;
    // Nine stops, each consumed long ago; nothing is pending. No window can
    // reach them again: the next one starts at the heartbeat minus the overlap.
    const old = Array.from({ length: 9 }, (_, i) => p(1_000_000 + i * 100_000, 1_000_100 + i * 100_000));
    expect(pruneStoppedPeriods(old, [], floor)).toEqual([]);
    // A tenth stop is kept on its own: no union of two old stops spanning the
    // days the watcher ran between them.
    const recent = p(heartbeat - 100, heartbeat + 50);
    expect(addStoppedPeriod(old.slice(0, 8), recent, [], floor)).toEqual([recent]);
    // A period the next window can still reach is kept, at the floor exactly.
    expect(pruneStoppedPeriods([p(floor - 50, floor), p(floor - 50, floor - 1)], [], floor)).toEqual([p(floor - 50, floor)]);
    // A pending window older than the floor keeps what it can reach.
    const pending = [{ since: 1_500_000, until: 1_600_000 }];
    expect(pruneStoppedPeriods(old, pending, floor)).toEqual(old.filter(x => x.until >= 1_500_000));
    // A heartbeat that could not be read prunes nothing; the cap still holds.
    expect(pruneStoppedPeriods(old, [], -Infinity)).toHaveLength(CATCHUP_MAX_STOPPED_PERIODS);
  });

  it('joins a period to one it touches or overlaps, which covers exactly the same reports', () => {
    const p = (after: number, until: number): StoppedPeriod => ({ after, until });
    expect(addStoppedPeriod([p(100, 200)], p(200, 320), [], -Infinity)).toEqual([p(100, 320)]);
    expect(addStoppedPeriod([p(100, 200)], p(150, 180), [], -Infinity)).toEqual([p(100, 200)]);
    // 201 is not in either, so these stay apart.
    expect(addStoppedPeriod([p(100, 200)], p(201, 320), [], -Infinity)).toEqual([p(100, 200), p(201, 320)]);
    // An empty period adds nothing.
    expect(addStoppedPeriod([p(100, 200)], p(500, 500), [], -Infinity)).toEqual([p(100, 200)]);
  });

  it('reaches back from a frozen heartbeat, not from the clock', () => {
    // An outage froze the heartbeat 3000 s ago: the next connect's window
    // starts 600 s before it, so periods back to there stay reachable.
    expect(stoppedPeriodReachFloor(1_997_000, 2_000_000)).toBe(1_996_400);
    // No heartbeat yet: the first one is stamped no earlier than now.
    expect(stoppedPeriodReachFloor(undefined, 2_000_000)).toBe(1_999_400);
  });

  it('merges the two oldest by stop time at the cap, whatever order the list is in', () => {
    const p = (after: number, until: number): StoppedPeriod => ({ after, until });
    // A joined period is appended to the end of the list (addStoppedPeriod).
    const unsorted = [p(500, 510), p(600, 610), p(700, 710), p(800, 810), p(900, 910), p(1_000, 1_010), p(1_100, 1_110), p(200, 210), p(100, 110)];
    expect(pruneStoppedPeriods(unsorted, [], -Infinity)).toEqual([
      p(100, 210), p(500, 510), p(600, 610), p(700, 710), p(800, 810), p(900, 910), p(1_000, 1_010), p(1_100, 1_110),
    ]);
  });
});
