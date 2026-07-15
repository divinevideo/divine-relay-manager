import { describe, expect, it } from 'vitest';
import { classifyTargetedFetch, decisionsForTarget } from './deepLinkResolution';

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
    { target_id: 'user_PK', action: 'age_review_case_created' },
    { target_id: 'OTHER', action: 'deleted' },
  ];
  it('matches both raw and user_-prefixed target ids', () => {
    expect(decisionsForTarget(decisions, 'PK').map((d) => d.action)).toEqual([
      'banned',
      'age_review_case_created',
    ]);
  });
  it('returns [] for undefined input', () => {
    expect(decisionsForTarget(undefined, 'PK')).toEqual([]);
  });
});
