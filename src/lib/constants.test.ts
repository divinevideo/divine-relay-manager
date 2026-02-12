// ABOUTME: Tests for shared moderation constants and utility functions
// ABOUTME: Covers getCategoryLabel, getReportCategory, getDivineProfileUrl

import { describe, it, expect } from 'vitest';
import {
  CATEGORY_LABELS,
  HIGH_PRIORITY_CATEGORIES,
  RESOLUTION_STATUSES,
  getCategoryLabel,
  getReportCategory,
  getDivineProfileUrl,
  DIVINE_PROFILE_URL,
} from './constants';

describe('getCategoryLabel', () => {
  it('should return label for known category key', () => {
    expect(getCategoryLabel('sexual_minors')).toBe('CSAM');
    expect(getCategoryLabel('spam')).toBe('Spam');
    expect(getCategoryLabel('terrorism_extremism')).toBe('Terrorism');
  });

  it('should return label for case-variant keys', () => {
    // Both 'spam' and 'Spam' map to 'Spam'
    expect(getCategoryLabel('spam')).toBe('Spam');
    expect(getCategoryLabel('Spam')).toBe('Spam');
    expect(getCategoryLabel('impersonation')).toBe('Impersonation');
    expect(getCategoryLabel('Impersonation')).toBe('Impersonation');
  });

  it('should return label for alias keys (multiple keys → same label)', () => {
    // CSAM aliases
    expect(getCategoryLabel('sexual_minors')).toBe('CSAM');
    expect(getCategoryLabel('csam')).toBe('CSAM');
    expect(getCategoryLabel('NS-csam')).toBe('CSAM');

    // AI Generated aliases
    expect(getCategoryLabel('aiGenerated')).toBe('AI Generated');
    expect(getCategoryLabel('ai-generated')).toBe('AI Generated');
    expect(getCategoryLabel('NS-ai-generated')).toBe('AI Generated');
  });

  it('should return the raw key as fallback for unknown categories', () => {
    expect(getCategoryLabel('unknown_category')).toBe('unknown_category');
    expect(getCategoryLabel('')).toBe('');
    expect(getCategoryLabel('some-new-category')).toBe('some-new-category');
  });
});

describe('getReportCategory', () => {
  it('should extract category from report tag', () => {
    const event = {
      tags: [
        ['e', 'abc123'],
        ['report', 'spam'],
        ['p', 'pubkey123'],
      ],
    };
    expect(getReportCategory(event)).toBe('spam');
  });

  it('should fall back to l tag when no report tag', () => {
    const event = {
      tags: [
        ['e', 'abc123'],
        ['l', 'harassment'],
        ['p', 'pubkey123'],
      ],
    };
    expect(getReportCategory(event)).toBe('harassment');
  });

  it('should prefer report tag over l tag', () => {
    const event = {
      tags: [
        ['report', 'csam'],
        ['l', 'harassment'],
      ],
    };
    expect(getReportCategory(event)).toBe('csam');
  });

  it('should return "other" when no report or l tag', () => {
    const event = {
      tags: [
        ['e', 'abc123'],
        ['p', 'pubkey123'],
      ],
    };
    expect(getReportCategory(event)).toBe('other');
  });

  it('should return "other" for empty tags', () => {
    const event = { tags: [] as string[][] };
    expect(getReportCategory(event)).toBe('other');
  });

  it('should return "other" when report tag has no value', () => {
    const event = {
      tags: [['report']],
    };
    expect(getReportCategory(event)).toBe('other');
  });

  it('should return "other" when l tag has no value', () => {
    const event = {
      tags: [['l']],
    };
    expect(getReportCategory(event)).toBe('other');
  });

  it('should handle report tag with empty string value', () => {
    const event = {
      tags: [['report', '']],
    };
    // Empty string is falsy, should fall through
    expect(getReportCategory(event)).toBe('other');
  });
});

describe('getDivineProfileUrl', () => {
  it('should build profile URL from npub', () => {
    const npub = 'npub1abc123';
    expect(getDivineProfileUrl(npub)).toBe(`${DIVINE_PROFILE_URL}/${npub}`);
  });

  it('should handle hex pubkey format', () => {
    const hex = '7e7e9c42a91bfef19fa929e5fda1b72e0ebc1a4c1141673e2794234d86addf4e';
    expect(getDivineProfileUrl(hex)).toBe(`${DIVINE_PROFILE_URL}/${hex}`);
  });
});

describe('CATEGORY_LABELS', () => {
  it('should have entries for all HIGH_PRIORITY_CATEGORIES', () => {
    for (const cat of HIGH_PRIORITY_CATEGORIES) {
      expect(CATEGORY_LABELS[cat]).toBeDefined();
    }
  });

  it('should map all CSAM variants to "CSAM"', () => {
    const csamKeys = ['sexual_minors', 'csam', 'NS-csam'];
    for (const key of csamKeys) {
      expect(CATEGORY_LABELS[key]).toBe('CSAM');
    }
  });
});

describe('RESOLUTION_STATUSES', () => {
  it('should contain expected statuses', () => {
    expect(RESOLUTION_STATUSES).toContain('reviewed');
    expect(RESOLUTION_STATUSES).toContain('dismissed');
    expect(RESOLUTION_STATUSES).toContain('no-action');
    expect(RESOLUTION_STATUSES).toContain('false-positive');
  });

  it('should have exactly 4 statuses', () => {
    expect(RESOLUTION_STATUSES).toHaveLength(4);
  });
});
