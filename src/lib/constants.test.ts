import { describe, expect, it } from 'vitest';

import { CATEGORY_LABELS, HIGH_PRIORITY_CATEGORIES, getReportCategory } from './constants';

describe('CATEGORY_LABELS', () => {
  it('maps the divine-mobile NIP-32 labels to existing display labels', () => {
    expect(CATEGORY_LABELS['NS-spam']).toBe('Spam');
    expect(CATEGORY_LABELS['NS-harassment']).toBe('Harassment');
    expect(CATEGORY_LABELS['NS-violence']).toBe('Violence');
    expect(CATEGORY_LABELS['NS-childSafety']).toBe('Child Safety');
    expect(CATEGORY_LABELS['NS-underageUser']).toBe('Under 16');
    expect(CATEGORY_LABELS['NS-sexualContent']).toBe('Sexual Content');
    expect(CATEGORY_LABELS['NS-copyright']).toBe('Copyright');
    expect(CATEGORY_LABELS['NS-falseInformation']).toBe('Misinformation');
    expect(CATEGORY_LABELS['NS-csam']).toBe('CSAM');
    expect(CATEGORY_LABELS['NS-aiGenerated']).toBe('AI Generated');
    expect(CATEGORY_LABELS['NS-other']).toBe('Other');
  });

  it('maps kebab-case aliases to the same display labels as camelCase', () => {
    expect(CATEGORY_LABELS['NS-child-safety']).toBe('Child Safety');
    expect(CATEGORY_LABELS['NS-underage-user']).toBe('Under 16');
    expect(CATEGORY_LABELS['NS-sexual-content']).toBe('Sexual Content');
    expect(CATEGORY_LABELS['NS-false-information']).toBe('Misinformation');
    expect(CATEGORY_LABELS['NS-ai-generated']).toBe('AI Generated');
  });

  it('maps non-prefixed child-safety aliases used across clients', () => {
    expect(CATEGORY_LABELS['childSafety']).toBe('Child Safety');
    expect(CATEGORY_LABELS['child-safety']).toBe('Child Safety');
    expect(CATEGORY_LABELS['underageUser']).toBe('Under 16');
    expect(CATEGORY_LABELS['underage-user']).toBe('Under 16');
  });
});

describe('HIGH_PRIORITY_CATEGORIES', () => {
  it('includes child-safety aliases for moderator-safety treatment', () => {
    expect(HIGH_PRIORITY_CATEGORIES).toContain('NS-childSafety');
    expect(HIGH_PRIORITY_CATEGORIES).toContain('NS-child-safety');
  });
});

describe('getReportCategory', () => {
  it('falls back to the l tag when a report tag is absent', () => {
    expect(getReportCategory({
      tags: [
        ['L', 'social.nos.ontology'],
        ['l', 'NS-violence', 'social.nos.ontology'],
      ],
    })).toBe('NS-violence');
  });

  it('prefers the report tag when both report and l tags are present', () => {
    expect(getReportCategory({
      tags: [
        ['report', 'spam'],
        ['L', 'social.nos.ontology'],
        ['l', 'NS-spam', 'social.nos.ontology'],
      ],
    })).toBe('spam');
  });
});
