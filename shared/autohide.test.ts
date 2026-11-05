import { describe, it, expect } from 'vitest';
import { AUTO_HIDE_ACTION, pendingReviewTargetKeys, pendingReviewTargetStates } from './autohide';

const row = (id: string, action: string) => ({ target_type: 'event', target_id: id, action });

describe('pendingReviewTargetKeys', () => {
  // Rows arrive newest first, which is the order getAutoHideStates returns.
  it('counts a target whose latest state is hidden, unresolved or restore-failed', () => {
    const keys = pendingReviewTargetKeys([
      row('a', AUTO_HIDE_ACTION.hidden),
      row('b', AUTO_HIDE_ACTION.unresolved),
      row('c', AUTO_HIDE_ACTION.restoreFailed),
    ]);
    expect([...keys].sort()).toEqual(['event:a', 'event:b', 'event:c']);
  });

  it('drops a target once a human confirmed or restored it, reading newest first', () => {
    const keys = pendingReviewTargetKeys([
      row('a', AUTO_HIDE_ACTION.confirmed), row('a', AUTO_HIDE_ACTION.hidden),
      row('b', AUTO_HIDE_ACTION.restored), row('b', AUTO_HIDE_ACTION.hidden),
    ]);
    expect(keys.size).toBe(0);
  });

  it('uses only the newest state when an older one would say pending', () => {
    const keys = pendingReviewTargetKeys([
      row('a', AUTO_HIDE_ACTION.reversed),
      row('a', AUTO_HIDE_ACTION.unresolved),
    ]);
    expect(keys.has('event:a')).toBe(false);
  });

  it('keys by target type as well as id', () => {
    const keys = pendingReviewTargetKeys([
      { target_type: 'pubkey', target_id: 'a', action: AUTO_HIDE_ACTION.hidden },
    ]);
    expect([...keys]).toEqual(['pubkey:a']);
  });
});

describe('pendingReviewTargetStates', () => {
  // The queue labels a target whose hide or restore may not have landed
  // differently from one that is hidden, so it needs the latest state, not just
  // that the target is pending.
  it("keeps each pending target's latest state, newest first", () => {
    const states = pendingReviewTargetStates([
      row('a', AUTO_HIDE_ACTION.unresolved), row('a', AUTO_HIDE_ACTION.hidden),
      row('b', AUTO_HIDE_ACTION.hidden),
      row('c', AUTO_HIDE_ACTION.confirmed), row('c', AUTO_HIDE_ACTION.hidden),
    ]);
    expect(Object.fromEntries(states)).toEqual({
      'event:a': AUTO_HIDE_ACTION.unresolved,
      'event:b': AUTO_HIDE_ACTION.hidden,
    });
  });
});
