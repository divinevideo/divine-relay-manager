import { describe, expect, it } from 'vitest';

import { CATEGORY_LABELS, getCategoryLabel, getReportCategory, hasCsamSignal, getReportTargetIds, isHex64 } from './constants';

describe('CATEGORY_LABELS', () => {
  it('maps the divine-mobile NIP-32 labels to existing display labels', () => {
    expect(CATEGORY_LABELS['NS-spam']).toBe('Spam');
    expect(CATEGORY_LABELS['NS-harassment']).toBe('Harassment');
    expect(CATEGORY_LABELS['NS-violence']).toBe('Violence');
    expect(CATEGORY_LABELS['NS-sexualContent']).toBe('Sexual Content');
    expect(CATEGORY_LABELS['NS-copyright']).toBe('Copyright');
    expect(CATEGORY_LABELS['NS-falseInformation']).toBe('Misinformation');
    expect(CATEGORY_LABELS['NS-csam']).toBe('CSAM');
    expect(CATEGORY_LABELS['NS-aiGenerated']).toBe('AI Generated');
    expect(CATEGORY_LABELS['NS-other']).toBe('Other');
  });

  it('maps kebab-case aliases to the same display labels as camelCase', () => {
    expect(CATEGORY_LABELS['NS-sexual-content']).toBe('Sexual Content');
    expect(CATEGORY_LABELS['NS-false-information']).toBe('Misinformation');
    expect(CATEGORY_LABELS['NS-ai-generated']).toBe('AI Generated');
  });
});

// Labels come from the map's own keys only, so inherited object keys render
// as plain text.
describe('getCategoryLabel', () => {
  it.each(['__proto__', 'constructor', 'toString', 'hasOwnProperty', 'valueOf'])('returns %s unchanged', v => {
    expect(getCategoryLabel(v)).toBe(v);
  });

  it('returns the display label for a known category', () => {
    expect(getCategoryLabel('csam')).toBe('CSAM');
  });

  it('returns an unknown category unchanged', () => {
    expect(getCategoryLabel('made_up')).toBe('made_up');
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

  it('reads the NIP-56 report type from the e or p tag', () => {
    expect(getReportCategory({ tags: [['p', 'd'.repeat(64), 'spam']] })).toBe('spam');
    expect(getReportCategory({ tags: [['e', 'c'.repeat(64), 'illegal'], ['p', 'd'.repeat(64), 'spam']] })).toBe('illegal');
  });
});

describe('hasCsamSignal', () => {
  const oldBuild = {
    tags: [['e', 'c'.repeat(64), 'illegal'], ['p', 'd'.repeat(64), 'illegal']],
    content: 'CONTENT REPORT - NIP-56\nReason: csam\n',
  };
  const plainIllegal = { tags: [['p', 'd'.repeat(64), 'illegal']], content: 'bad' };

  it('is true for an old-build report whose Reason line says csam', () => {
    expect(hasCsamSignal([oldBuild])).toBe(true);
  });

  it('is true when any one report in the set carries the signal', () => {
    expect(hasCsamSignal([plainIllegal, oldBuild])).toBe(true);
  });

  it('is false for a bare illegal report and for an empty set', () => {
    expect(hasCsamSignal([plainIllegal])).toBe(false);
    expect(hasCsamSignal([])).toBe(false);
  });
});

describe('isHex64', () => {
  it('accepts lowercase, uppercase, and mixed-case 64-char hex', () => {
    expect(isHex64('a'.repeat(64))).toBe(true);
    expect(isHex64('F'.repeat(64))).toBe(true);
    expect(isHex64('aB3'.repeat(21) + 'c')).toBe(true);
  });

  it('rejects wrong lengths, non-hex characters, and non-strings', () => {
    expect(isHex64('a'.repeat(63))).toBe(false);
    expect(isHex64('a'.repeat(65))).toBe(false);
    expect(isHex64('g'.repeat(64))).toBe(false);
    expect(isHex64('')).toBe(false);
    expect(isHex64(undefined)).toBe(false);
    expect(isHex64(42)).toBe(false);
    expect(isHex64(null)).toBe(false);
  });
});

describe('getReportTargetIds', () => {
  it('extracts the first e and p tag values', () => {
    expect(getReportTargetIds({
      tags: [
        ['e', 'c'.repeat(64), 'spam'],
        ['e', 'f'.repeat(64)],
        ['p', 'd'.repeat(64), 'spam'],
      ],
    })).toEqual({ eventId: 'c'.repeat(64), pubkey: 'd'.repeat(64) });
  });

  it('returns undefined fields for missing or valueless tags', () => {
    expect(getReportTargetIds({ tags: [] })).toEqual({ eventId: undefined, pubkey: undefined });
    expect(getReportTargetIds({ tags: [['e'], ['p']] })).toEqual({ eventId: undefined, pubkey: undefined });
  });

  it('skips valueless or junk-valued tags so they do not mask later valid ones', () => {
    expect(getReportTargetIds({
      tags: [['e'], ['e', 'c'.repeat(64)], ['p'], ['p', 'd'.repeat(64)]],
    })).toEqual({ eventId: 'c'.repeat(64), pubkey: 'd'.repeat(64) });

    expect(getReportTargetIds({
      tags: [['e', ''], ['e', 'c'.repeat(64)], ['p', 'junk'], ['p', 'd'.repeat(64)]],
    })).toEqual({ eventId: 'c'.repeat(64), pubkey: 'd'.repeat(64) });
  });

  it('returns undefined when no tag value is a well-formed 64-hex id', () => {
    expect(getReportTargetIds({ tags: [['e', 'junk'], ['p', 'a'.repeat(63)]] }))
      .toEqual({ eventId: undefined, pubkey: undefined });
  });

  it('tolerates non-array tags — the crash fallback must never crash itself', () => {
    expect(getReportTargetIds({ tags: null as unknown as string[][] }))
      .toEqual({ eventId: undefined, pubkey: undefined });
    expect(getReportTargetIds({} as { tags: string[][] }))
      .toEqual({ eventId: undefined, pubkey: undefined });
  });
});
