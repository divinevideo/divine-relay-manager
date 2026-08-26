import { describe, it, expect } from 'vitest';
import {
  AGE_REVIEW_STATES,
  TERMINAL_STATES,
  ACTIVE_AGE_REVIEW_STATES,
  statesForTab,
  listStateParam,
  foldByState,
} from './age-review';

describe('ACTIVE_AGE_REVIEW_STATES', () => {
  it('is exactly the non-terminal states', () => {
    const terminal = new Set<string>(TERMINAL_STATES);
    expect(ACTIVE_AGE_REVIEW_STATES).toEqual(AGE_REVIEW_STATES.filter((s) => !terminal.has(s)));
    // and never overlaps the closed set
    expect(ACTIVE_AGE_REVIEW_STATES.some((s) => terminal.has(s))).toBe(false);
  });

  it('partitions AGE_REVIEW_STATES together with TERMINAL_STATES', () => {
    // Every state is either active or closed, and none is both — the invariant
    // that lets the Active and Closed views' counts sum to the All total.
    expect([...ACTIVE_AGE_REVIEW_STATES, ...TERMINAL_STATES].sort())
      .toEqual([...AGE_REVIEW_STATES].sort());
  });
});

describe('statesForTab', () => {
  it('spans the non-terminal states for Active', () => {
    expect(statesForTab('active')).toEqual(ACTIVE_AGE_REVIEW_STATES);
  });

  it('spans the terminal states for Closed', () => {
    expect(statesForTab('closed')).toEqual(TERMINAL_STATES);
  });

  it('spans every state for All', () => {
    expect(statesForTab('all')).toEqual(AGE_REVIEW_STATES);
  });
});

describe('listStateParam', () => {
  it('sends the view itself for Active and Closed with no chip', () => {
    // These are server-accepted filters, so the view is the param.
    expect(listStateParam('active', null)).toBe('active');
    expect(listStateParam('closed', null)).toBe('closed');
  });

  it('sends no param for All with no chip', () => {
    expect(listStateParam('all', null)).toBeUndefined();
  });

  it('lets a chip override the view with an exact state', () => {
    // Drilling into "Pending Parent" inside Active must query that one state,
    // not the whole non-terminal set.
    expect(listStateParam('active', 'restricted_pending_parental_consent'))
      .toBe('restricted_pending_parental_consent');
    expect(listStateParam('all', 'cleared')).toBe('cleared');
  });
});

describe('foldByState', () => {
  it('folds grouped rows into a per-state count map', () => {
    expect(foldByState([
      { state: 'open_reported', n: 5 },
      { state: 'under_moderator_review', n: 4 },
      { state: 'cleared', n: 135 },
    ])).toEqual({ open_reported: 5, under_moderator_review: 4, cleared: 135 });
  });

  it('coerces string counts and is empty for no rows', () => {
    expect(foldByState([{ state: 'cleared', n: '7' as unknown as number }])).toEqual({ cleared: 7 });
    expect(foldByState([])).toEqual({});
  });
});
