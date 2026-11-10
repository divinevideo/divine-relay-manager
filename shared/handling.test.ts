import { describe, it, expect } from 'vitest';
import { AUTO_HIDE_ACTIONS } from './autohide';
import {
  REOPENED_ACTION,
  handlingByTarget,
  isHumanHandling,
  reportStatus,
  reportTime,
  type HandlingRow,
} from './handling';

const MODERATOR = '7e'.repeat(32);
const TARGET = 'a1'.repeat(32);
const KEY = `event:${TARGET}`;

function row(action: string, at: number | null, extra: Partial<HandlingRow> = {}): HandlingRow {
  return { target_type: 'event', target_id: TARGET, action, moderator_pubkey: MODERATOR, at, ...extra };
}

describe('isHumanHandling', () => {
  it('is true for a moderator decision, including a reversal with no moderator', () => {
    expect(isHumanHandling({ action: 'ban_pubkey', moderator_pubkey: MODERATOR })).toBe(true);
    expect(isHumanHandling({ action: 'unban_pubkey', moderator_pubkey: null })).toBe(true);
  });

  it.each([...AUTO_HIDE_ACTIONS])('is false for the auto-hide action %s', action => {
    expect(isHumanHandling({ action, moderator_pubkey: MODERATOR })).toBe(false);
    expect(isHumanHandling({ action, moderator_pubkey: 'auto' })).toBe(false);
  });

  it('is false for an automated row and for a reopen', () => {
    expect(isHumanHandling({ action: 'age_review_case_created', moderator_pubkey: 'auto' })).toBe(false);
    expect(isHumanHandling({ action: REOPENED_ACTION })).toBe(false);
  });
});

describe('handlingByTarget', () => {
  it('takes the newest of a decision and a label', () => {
    const map = handlingByTarget([row('ban_event', 100)], [{ type: 'event', value: TARGET, at: 150 }]);
    expect(map.get(KEY)?.handledAt).toBe(150);
  });

  it('ignores auto-hide and automated rows', () => {
    const map = handlingByTarget(
      [row('ban_event', 100), row('auto_hidden', 300), row('age_review_case_created', 300, { moderator_pubkey: 'auto' })],
      [],
    );
    expect(map.get(KEY)?.handledAt).toBe(100);
    expect(map.get(KEY)?.history.map(h => h.action)).toEqual(['ban_event']);
  });

  it('omits a target that only automatic entries touched', () => {
    expect(handlingByTarget([row('auto_hidden', 300)], []).has(KEY)).toBe(false);
  });

  it('omits a target a reopen came after', () => {
    expect(handlingByTarget([row('ban_event', 100), row(REOPENED_ACTION, 200)], []).has(KEY)).toBe(false);
  });

  it('omits a target whose label is older than its reopen', () => {
    const map = handlingByTarget([row(REOPENED_ACTION, 200)], [{ type: 'event', value: TARGET, at: 150 }]);
    expect(map.has(KEY)).toBe(false);
  });

  it('counts handling after a reopen', () => {
    const map = handlingByTarget([row('ban_event', 100), row(REOPENED_ACTION, 200), row('ban_event', 250)], []);
    expect(map.get(KEY)?.handledAt).toBe(250);
  });

  it('marks an undated human row handled for good', () => {
    expect(handlingByTarget([row('ban_event', null)], []).get(KEY)).toEqual({
      handledAt: null,
      history: [{ action: 'ban_event', at: null }],
    });
  });

  it('lets a later dated row win over an undated one', () => {
    const map = handlingByTarget([row('ban_event', null), row('ban_event', 120)], []);
    expect(map.get(KEY)?.handledAt).toBe(120);
  });

  it('lets a reopen supersede an undated row', () => {
    expect(handlingByTarget([row('ban_event', null), row(REOPENED_ACTION, 200)], []).has(KEY)).toBe(false);
  });

  it('ignores media rows', () => {
    const map = handlingByTarget([row('ban_media', 100, { target_type: 'media' })], []);
    expect(map.size).toBe(0);
  });

  it('keys targets exactly as stored', () => {
    const upper = 'A1'.repeat(32);
    const map = handlingByTarget([row('ban_event', 100, { target_id: upper })], []);
    expect(map.has(`event:${upper}`)).toBe(true);
    expect(map.has(KEY)).toBe(false);
  });

  it('keeps a label on a pubkey separate from an event with the same value', () => {
    const map = handlingByTarget([], [{ type: 'pubkey', value: TARGET, at: 10 }]);
    expect(map.get(`pubkey:${TARGET}`)?.handledAt).toBe(10);
    expect(map.has(KEY)).toBe(false);
  });

  it('lists history newest first with labels and reopens, undated last', () => {
    const map = handlingByTarget(
      [row('ban_event', 100), row(REOPENED_ACTION, 200), row('unban_event', 250), row('ban_event', null)],
      [{ type: 'event', value: TARGET, at: 150 }],
    );
    expect(map.get(KEY)?.history).toEqual([
      { action: 'unban_event', at: 250 },
      { action: REOPENED_ACTION, at: 200 },
      { action: 'resolution_label', at: 150 },
      { action: 'ban_event', at: 100 },
      { action: 'ban_event', at: null },
    ]);
  });
});

describe('reportTime', () => {
  it('prefers the arrival time over created_at', () => {
    expect(reportTime({ id: 'r1', created_at: 100 }, new Map([['r1', 500]]))).toBe(500);
  });

  it('falls back to created_at', () => {
    expect(reportTime({ id: 'r1', created_at: 100 }, new Map())).toBe(100);
  });
});

describe('reportStatus', () => {
  it('is new with no entry', () => {
    expect(reportStatus(50, undefined)).toBe('new');
  });

  it('is handled when handling is undated', () => {
    expect(reportStatus(50, { handledAt: null, history: [] })).toBe('handled');
  });

  it('is handled when handled after the report arrived', () => {
    expect(reportStatus(99, { handledAt: 100, history: [] })).toBe('handled');
  });

  it('treats the same second as new, so handling is never presumed to cover it', () => {
    expect(reportStatus(100, { handledAt: 100, history: [] })).toBe('handled_before');
  });

  it('is handled_before when the report arrived after handling', () => {
    expect(reportStatus(101, { handledAt: 100, history: [] })).toBe('handled_before');
  });
});
