// ABOUTME: Unit tests for statCountText, which renders a user-stat count only
// ABOUTME: when the relay read that produced it completed (#210).
import { describe, it, expect } from 'vitest';
import { statCountText, statCountAriaLabel } from './statDisplay';

describe('statCountText', () => {
  it('renders a completed count verbatim', () => {
    expect(statCountText(5, false)).toBe('5');
  });

  it('renders a completed zero as 0 (a verified absence)', () => {
    expect(statCountText(0, false)).toBe('0');
  });

  it('renders "?" for a zero from an incomplete read, never a confident 0', () => {
    expect(statCountText(0, true)).toBe('?');
  });

  it('renders "?" even for a non-zero partial count, which only understates', () => {
    expect(statCountText(5, true)).toBe('?');
  });

  it('treats an undefined count with no flag as 0 (loading, matching prior display)', () => {
    expect(statCountText(undefined, undefined)).toBe('0');
  });
});

describe('statCountAriaLabel', () => {
  it('has no override for a completed read (the visible count reads fine)', () => {
    expect(statCountAriaLabel('events', false)).toBeUndefined();
  });

  it('spells out an incomplete count so a screen reader does not read a bare "?"', () => {
    expect(statCountAriaLabel('events', true)).toBe(
      'events count unavailable, relay read did not complete',
    );
  });
});
