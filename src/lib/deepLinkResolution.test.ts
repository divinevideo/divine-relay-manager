import { describe, expect, it } from 'vitest';
import { classifyTargetedFetch, reportsMatchingTarget } from './deepLinkResolution';

describe('classifyTargetedFetch', () => {
  it('gone when the successful fetch returned nothing', () => {
    expect(classifyTargetedFetch([])).toBe('gone');
  });
  it('found when the successful fetch returned at least one report', () => {
    expect(classifyTargetedFetch([{}])).toBe('found');
  });
});

describe('reportsMatchingTarget', () => {
  type E = { id: string; t: { type: string; value: string } | null };
  const getTarget = (e: E) => e.t;
  const events: E[] = [
    { id: 'a', t: { type: 'event', value: 'E1' } },
    { id: 'b', t: { type: 'pubkey', value: 'P1' } },
    { id: 'c', t: null },
    { id: 'd', t: { type: 'pubkey', value: 'P1' } },
  ];
  it('keeps only events whose resolved target matches type and value', () => {
    expect(reportsMatchingTarget(events, { type: 'pubkey', value: 'P1' }, getTarget).map((e) => e.id)).toEqual([
      'b',
      'd',
    ]);
  });
  it('drops events whose resolved target is null or differs (event-typed report does not satisfy a pubkey target)', () => {
    expect(reportsMatchingTarget(events, { type: 'event', value: 'E1' }, getTarget).map((e) => e.id)).toEqual(['a']);
  });
});
