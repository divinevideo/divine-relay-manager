import { describe, expect, it } from 'vitest';
import { buildReportsFilter, isUnconfirmedTargetedMiss } from './reports-filter';

describe('buildReportsFilter', () => {
  it('defaults to the bulk 200 window when no target param', () => {
    expect(buildReportsFilter(new URLSearchParams(''))).toEqual({ kinds: [1984], limit: 200 });
  });
  it('scopes to #e when an event param is present', () => {
    expect(buildReportsFilter(new URLSearchParams('event=abc'))).toEqual({ kinds: [1984], '#e': ['abc'] });
  });
  it('scopes to #p when a pubkey param is present', () => {
    expect(buildReportsFilter(new URLSearchParams('pubkey=def'))).toEqual({ kinds: [1984], '#p': ['def'] });
  });
  it('prefers event over pubkey when both are present', () => {
    expect(buildReportsFilter(new URLSearchParams('event=abc&pubkey=def'))).toEqual({ kinds: [1984], '#e': ['abc'] });
  });
});

describe('isUnconfirmedTargetedMiss', () => {
  it('true for a targeted empty result the relay never confirmed (timeout/close)', () => {
    expect(isUnconfirmedTargetedMiss(new URLSearchParams('event=abc'), { events: [], complete: false })).toBe(true);
    expect(isUnconfirmedTargetedMiss(new URLSearchParams('pubkey=def'), { events: [], complete: false })).toBe(true);
  });
  it('false when the relay confirmed the empty result via EOSE (a real "gone")', () => {
    expect(isUnconfirmedTargetedMiss(new URLSearchParams('event=abc'), { events: [], complete: true })).toBe(false);
  });
  it('false when the targeted lookup returned results', () => {
    expect(isUnconfirmedTargetedMiss(new URLSearchParams('event=abc'), { events: [{}], complete: false })).toBe(false);
  });
  it('false for a bulk request (no target param), even if unconfirmed and empty', () => {
    expect(isUnconfirmedTargetedMiss(new URLSearchParams(''), { events: [], complete: false })).toBe(false);
  });
});
