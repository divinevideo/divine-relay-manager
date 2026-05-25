import { describe, expect, it } from 'vitest';

import {
  CHILD_SAFETY_CATEGORIES,
  UNDERAGE_CATEGORIES,
  isChildSafetyCategory,
  isUnderageCategory,
} from '../../shared/categories';

describe('shared/categories', () => {
  it.each([...UNDERAGE_CATEGORIES])('treats %s as an underage category', (alias) => {
    expect(isUnderageCategory(alias)).toBe(true);
  });

  it.each([...CHILD_SAFETY_CATEGORIES])('treats %s as a child-safety category', (alias) => {
    expect(isChildSafetyCategory(alias)).toBe(true);
  });

  it('does not treat unrelated categories as underage', () => {
    expect(isUnderageCategory('NS-spam')).toBe(false);
    expect(isUnderageCategory('sexual_minors')).toBe(false);
  });
});
