// ABOUTME: Pure window logic for the listener's restart catch-up: planning a window and bounding the pending list.
// ABOUTME: The relay walk, claims and the live handler are exercised against real D1 in test/report-catchup.d1.test.ts.

import { describe, expect, it } from 'vitest';
import {
  CATCHUP_MAX_STOPPED_PERIODS,
  addStoppedPeriod,
  pruneStoppedPeriods,
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
    expect(planCatchUpWindow(undefined, 2_000_000, 1_999_990)).toEqual([]);
  });

  it('starts the window ten minutes before the last heartbeat, from the watcher clock', () => {
    // The window is built from watcher clocks and nothing else: the signature
    // takes no report data, so a future-dated report in the corpus (created_at
    // is the reporter's claim) cannot move `since` past a real gap.
    const lastAliveAt = 1_999_880;
    const now = 2_000_000;
    expect(CATCHUP_OVERLAP_SECONDS).toBe(600);
    expect(planCatchUpWindow(lastAliveAt, now)).toEqual([
      { since: lastAliveAt - 600, until: now, handlerEnabled: true },
    ]);
  });

  it('after a deliberate stop, keeps the handler up to the stop and indexes only the stopped period', () => {
    const lastAliveAt = 1_996_400;
    const stopAt = 1_999_000;
    const now = 2_000_000;
    // Whatever was missed before the stop (an outage) gets the live
    // treatment; only (stopAt, now] is index-only. With no outage, the
    // pre-stop slice was seen live and the seen check filters it.
    expect(planCatchUpWindow(lastAliveAt, now, stopAt)).toEqual([
      { since: lastAliveAt - 600, until: stopAt, handlerEnabled: true },
      { since: stopAt + 1, until: now, handlerEnabled: false },
    ]);
    // A stop in the current second leaves no stopped period to index.
    expect(planCatchUpWindow(lastAliveAt, now, now)).toEqual([
      { since: lastAliveAt - 600, until: now, handlerEnabled: true },
    ]);
  });
});

describe('addPendingWindow', () => {
  const w = (since: number, until: number, handlerEnabled = true): CatchUpWindow => ({ since, until, handlerEnabled });

  it('appends while there are at most eight windows', () => {
    const pending = [w(100, 200), w(300, 400)];
    const { windows, merged } = addPendingWindow(pending, w(500, 600, false));
    expect(merged).toBe(false);
    expect(windows).toEqual([w(100, 200), w(300, 400), w(500, 600, false)]);
    // The caller's list is not mutated.
    expect(pending).toHaveLength(2);
  });

  it('merges the two oldest windows past eight, keeping the handler off if either had it off', () => {
    expect(CATCHUP_MAX_PENDING_WINDOWS).toBe(8);
    const pending = [w(100, 200, true), w(150, 300, false), ...[3, 4, 5, 6, 7, 8].map(i => w(i * 1000, i * 1000 + 10))];
    const { windows, merged } = addPendingWindow(pending, w(9000, 9010));
    expect(merged).toBe(true);
    expect(windows).toHaveLength(8);
    expect(windows[0]).toEqual({ since: 100, until: 300, handlerEnabled: false });
    expect(windows.slice(1)).toEqual([...[3, 4, 5, 6, 7, 8].map(i => w(i * 1000, i * 1000 + 10)), w(9000, 9010)]);

    // Both on stays on; the merged window spans the earliest since to the latest until.
    const allOn = [w(500, 600), w(100, 700), ...[3, 4, 5, 6, 7, 8].map(i => w(i * 1000, i * 1000 + 10))];
    const result = addPendingWindow(allOn, w(9000, 9010));
    expect(result.windows[0]).toEqual({ since: 100, until: 700, handlerEnabled: true });
  });

  it('folds a new window into an overlapping pending one with the same handler', () => {
    expect(addPendingWindow([w(100, 300)], w(250, 400))).toMatchObject({ windows: [w(100, 400)], merged: false });
    // One new window can bridge two pending ones.
    expect(addPendingWindow([w(100, 200), w(300, 400)], w(150, 350)).windows).toEqual([w(100, 400)]);
    // Off folds into off.
    expect(addPendingWindow([w(100, 300, false)], w(250, 400, false)).windows).toEqual([w(100, 400, false)]);
  });

  it('keeps overlapping windows with a different handler, and windows that do not overlap, separate', () => {
    expect(addPendingWindow([w(100, 300, true)], w(250, 400, false)).windows).toEqual([w(100, 300, true), w(250, 400, false)]);
    expect(addPendingWindow([w(100, 200)], w(201, 300)).windows).toEqual([w(100, 200), w(201, 300)]);
  });

  it('says when a merge turns the handler off for a window that had it on', () => {
    const rest = [3, 4, 5, 6, 7, 8].map(i => w(i * 1000, i * 1000 + 10));
    expect(addPendingWindow([w(100, 200, true), w(300, 400, false), ...rest], w(9000, 9010)).handlerDisabled).toBe(true);
    expect(addPendingWindow([w(100, 200, false), w(300, 400, true), ...rest], w(9000, 9010)).handlerDisabled).toBe(true);
    expect(addPendingWindow([w(100, 200, true), w(300, 400, true), ...rest], w(9000, 9010)).handlerDisabled).toBe(false);
    expect(addPendingWindow([w(100, 200, false), w(300, 400, false), ...rest], w(9000, 9010)).handlerDisabled).toBe(false);
    expect(addPendingWindow([w(100, 200, true)], w(300, 400, false)).handlerDisabled).toBe(false);
  });
});

describe('stopped periods', () => {
  it('keeps every stopped-period report index-only after a reconnect folds a handler-on window ahead of the off one', () => {
    // The reviewer's sequence: stop at 10030 during an outage that began at the
    // 10000 heartbeat, start at 12000, socket drops and reconnects at 12020
    // before the first heartbeat stamp.
    const heartbeat = 10_000;
    const stopAt = 10_030;
    const startAt = 12_000;
    let windows = planCatchUpWindow(heartbeat, startAt, stopAt);
    expect(windows).toEqual([
      { since: 9_400, until: stopAt, handlerEnabled: true },
      { since: stopAt + 1, until: startAt, handlerEnabled: false },
    ]);
    const periods = addStoppedPeriod([], { after: stopAt, until: startAt }, windows);
    for (const w of planCatchUpWindow(heartbeat, 12_020)) windows = addPendingWindow(windows, w).windows;
    // The fold puts a handler-on window spanning the stopped period first.
    expect(windows).toEqual([
      { since: 9_400, until: 12_020, handlerEnabled: true },
      { since: stopAt + 1, until: startAt, handlerEnabled: false },
    ]);
    // Classified per report, so the window that finds it does not matter.
    for (const window of windows) {
      for (const createdAt of [stopAt + 1, 10_500, startAt]) {
        expect(reportHandlerEnabled(createdAt, window, periods)).toBe(false);
      }
    }
    // Filed before the stop (the outage) or after the start: live treatment.
    expect(reportHandlerEnabled(stopAt, windows[0], periods)).toBe(true);
    expect(reportHandlerEnabled(10_010, windows[0], periods)).toBe(true);
    expect(reportHandlerEnabled(startAt + 1, windows[0], periods)).toBe(true);
    // A handler-off window stays off for everything.
    expect(reportHandlerEnabled(stopAt, windows[1], periods)).toBe(false);
  });

  it('prunes a period once it ends before every pending window, and keeps at most eight', () => {
    const p = (after: number, until: number): StoppedPeriod => ({ after, until });
    const pending = [{ since: 5_000, until: 6_000, handlerEnabled: true }, { since: 7_000, until: 8_000, handlerEnabled: true }];
    expect(pruneStoppedPeriods([p(1_000, 4_999), p(4_000, 5_000), p(6_500, 6_800)], pending)).toEqual([p(4_000, 5_000), p(6_500, 6_800)]);
    // Nothing pending: kept, since a reconnect before the next heartbeat can
    // plan a window over them again.
    expect(pruneStoppedPeriods([p(1_000, 2_000)], [])).toEqual([p(1_000, 2_000)]);
    expect(CATCHUP_MAX_STOPPED_PERIODS).toBe(8);
    const many = Array.from({ length: 12 }, (_, i) => p(10_000 + i * 10, 10_005 + i * 10));
    const kept = addStoppedPeriod(many.slice(0, 11), many[11], [{ since: 0, until: 20_000, handlerEnabled: true }]);
    // Over the cap the oldest merge into their union rather than drop out.
    expect(kept).toEqual([p(many[0].after, many[4].until), ...many.slice(5)]);
  });

  it('keeps a report in the oldest of nine reachable periods index-only', () => {
    const p = (after: number, until: number): StoppedPeriod => ({ after, until });
    const pending = [{ since: 1_000, until: 20_000, handlerEnabled: true }];
    const nine = Array.from({ length: 9 }, (_, i) => p(2_000 + i * 1_000, 2_050 + i * 1_000));
    const kept = pruneStoppedPeriods(nine, pending);
    expect(kept).toHaveLength(CATCHUP_MAX_STOPPED_PERIODS);
    expect(reportHandlerEnabled(2_025, pending[0], kept)).toBe(false);
    // Every original period is still covered.
    for (const period of nine) expect(reportHandlerEnabled(period.until, pending[0], kept)).toBe(false);
  });
});
