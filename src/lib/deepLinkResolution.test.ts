import { describe, expect, it } from 'vitest';
import { classifyTargetedFetch, decisionsForTarget, reportsMatchingTarget } from './deepLinkResolution';

describe('classifyTargetedFetch', () => {
  it('unavailable when the fetch failed', () => {
    expect(classifyTargetedFetch({ ok: false })).toBe('unavailable');
  });
  it('gone when the fetch succeeded but returned nothing', () => {
    expect(classifyTargetedFetch({ ok: true, events: [] })).toBe('gone');
  });
  it('found when the fetch returned at least one report', () => {
    expect(classifyTargetedFetch({ ok: true, events: [{}] })).toBe('found');
  });
});

describe('decisionsForTarget', () => {
  const decisions = [
    { target_id: 'PK', action: 'banned' },
    { target_id: 'PK', action: 'age_review_case_created' }, // written with the bare pubkey
    { target_id: 'OTHER', action: 'deleted' },
  ];
  it('matches every decision recorded against the bare target id', () => {
    expect(decisionsForTarget(decisions, 'PK').map((d) => d.action)).toEqual([
      'banned',
      'age_review_case_created',
    ]);
  });
  it('does not match a different target id', () => {
    expect(decisionsForTarget(decisions, 'PK').some((d) => d.target_id === 'OTHER')).toBe(false);
  });
  it('returns [] for undefined input', () => {
    expect(decisionsForTarget(undefined, 'PK')).toEqual([]);
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
