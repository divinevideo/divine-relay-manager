import { describe, it, expect } from 'vitest';
import { AUTO_HIDE_ACTIONS } from './autohide';
import { isAutomatedDecision } from './automated-decision';
import {
  DURATION_ERROR,
  TIMER_DECISION_ACTIONS,
  checkSuspensionDuration,
  formatSuspensionEnd,
  isUnbanSuspensionChoice,
  suspensionEndsAt,
} from './suspension';

describe('checkSuspensionDuration', () => {
  it.each([[{ value: 1, unit: 'hours' }], [{ value: 365, unit: 'days' }], [{ value: 8760, unit: 'hours' }]])(
    'accepts %j', (d) => expect(checkSuspensionDuration(d)).toEqual({ ok: true, duration: d }));

  it.each([0, -1, 1.5, '3', NaN, Infinity].map(v => [{ value: v, unit: 'days' }])
    .concat([[{ value: 366, unit: 'days' }], [{ value: 8761, unit: 'hours' }], [{ value: 3, unit: 'weeks' }],
      [{ value: 3 }], [null], ['3 days']] as never[]))(
    'refuses %j', (d) => expect(checkSuspensionDuration(d)).toEqual({ ok: false, error: DURATION_ERROR }));
});

describe('suspensionEndsAt', () => {
  it('rounds the end up to the next whole minute', () => {
    expect(suspensionEndsAt({ value: 1, unit: 'hours' }, new Date('2026-11-20T10:00:30.500Z'))).toBe('2026-11-20T11:01:00.000Z');
    expect(suspensionEndsAt({ value: 2, unit: 'days' }, new Date('2026-11-20T10:00:00.000Z'))).toBe('2026-11-22T10:00:00.000Z');
  });
});

describe('formatSuspensionEnd', () => {
  it('formats in UTC whatever the local zone', () => {
    // root vitest pins TZ=America/Los_Angeles, where this instant is still 24 Nov
    expect(formatSuspensionEnd('2026-11-25T02:00:00.000Z')).toBe('Wed 25 Nov 2026, 02:00 UTC');
  });
});

describe('isUnbanSuspensionChoice', () => {
  it('accepts the three choices only', () => {
    for (const v of ['resume', 'end_now', 'open_ended']) expect(isUnbanSuspensionChoice(v)).toBe(true);
    for (const v of ['', 'RESUME', null, undefined, 1]) expect(isUnbanSuspensionChoice(v)).toBe(false);
  });
});

describe('timer decision actions', () => {
  it("treats the timer's rows as automated, and a person's unsuspend as human", () => {
    expect(isAutomatedDecision({ action: 'auto_unsuspend_user', moderator_pubkey: null })).toBe(true);
    expect(isAutomatedDecision({ action: 'cancel_suspension_timer', moderator_pubkey: null })).toBe(true);
    expect(isAutomatedDecision({ action: 'unsuspend_user', moderator_pubkey: null })).toBe(false);
    expect(isAutomatedDecision({ action: 'change_suspension_end', moderator_pubkey: null })).toBe(false);
  });

  it('are not auto-hide actions', () => {
    for (const a of TIMER_DECISION_ACTIONS) expect(AUTO_HIDE_ACTIONS).not.toContain(a);
  });
});
