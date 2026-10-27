import { describe, it, expect } from 'vitest';
import { classifyReport, ageReviewCategory, reportCategory } from './report-classification';

const P = 'b'.repeat(64);
const E = 'c'.repeat(64);

describe('classifyReport', () => {
  it('routes a current Divine profile report', () => {
    expect(classifyReport({
      tags: [
        ['p', P, 'illegal'],
        ['L', 'social.nos.ontology'],
        ['l', 'NS-csam', 'social.nos.ontology'],
        ['t', 'user-report'],
        ['client', 'Divine'],
      ],
      content: '',
    })).toEqual({ category: 'NS-csam', csamSignal: true });
  });

  it('routes an old-build report by its Reason line', () => {
    expect(classifyReport({
      tags: [['e', E, 'illegal'], ['p', P, 'illegal'], ['client', 'diVine']],
      content: 'CONTENT REPORT - NIP-56\nReason: csam\nDetails: x\n',
    })).toEqual({ category: 'illegal', csamSignal: true });
  });

  it('routes a Reason line the free-text terms would miss', () => {
    expect(classifyReport({
      tags: [['e', E, 'illegal']],
      content: 'CONTENT REPORT - NIP-56\nReason: sexual_minors\n',
    }).csamSignal).toBe(true);
  });

  it('keeps a bare illegal report from another app out', () => {
    expect(classifyReport({
      tags: [['e', E, 'illegal'], ['p', P]],
      content: 'bad stuff',
    })).toEqual({ category: 'illegal', csamSignal: false });
  });

  it('routes on free text', () => {
    const tags = [['e', E, 'illegal'], ['p', P]];
    expect(classifyReport({ tags, content: 'this account posts child pornography' }).csamSignal).toBe(true);
    expect(classifyReport({ tags, content: 'Child Sexual Abuse material' }).csamSignal).toBe(true);
  });

  it('does not match csam inside another word', () => {
    expect(classifyReport({ tags: [['e', E, 'illegal']], content: 'csamuel' }).csamSignal).toBe(false);
  });

  it.each([
    'child-porn',
    'childporn',
    'child  porn',
    'child porn',
    'child\nsexual abuse material',
    'Child_Sexual_Abuse',
    'child-sexual-abuse',
  ])('routes free text %j', content => {
    expect(classifyReport({ tags: [['e', E, 'illegal']], content }).csamSignal).toBe(true);
  });

  it.each(['csamuel', 'children playing', 'child safety', 'grandchildporn'])('does not route free text %j', content => {
    expect(classifyReport({ tags: [['e', E, 'illegal']], content }).csamSignal).toBe(false);
  });

  it('classifies content of widely spaced "child" words in linear time', () => {
    const start = performance.now();
    classifyReport({ tags: [['e', E, 'illegal']], content: ('child' + ' '.repeat(2000)).repeat(32) });
    expect(performance.now() - start).toBeLessThan(200);
  });

  it('routes a CSAM label in another namespace', () => {
    expect(classifyReport({ tags: [['p', P], ['l', 'csam', 'MOD']] }).csamSignal).toBe(true);
  });

  it('routes a CSAM report tag value', () => {
    expect(classifyReport({ tags: [['p', P], ['report', 'sexual_minors']] }).csamSignal).toBe(true);
  });

  it('leaves child safety out of routing', () => {
    expect(classifyReport({
      tags: [['p', P], ['l', 'NS-childSafety', 'social.nos.ontology']],
    })).toEqual({ category: 'NS-childSafety', csamSignal: false });
  });

  it('prefers a high-priority Divine label over an earlier one', () => {
    expect(classifyReport({
      tags: [
        ['p', P],
        ['l', 'NS-spam', 'social.nos.ontology'],
        ['l', 'NS-csam', 'social.nos.ontology'],
      ],
    }).category).toBe('NS-csam');
  });

  it('folds case on labels and the Reason line', () => {
    expect(classifyReport({ tags: [['p', P], ['l', 'CSAM', 'MOD']] }).csamSignal).toBe(true);
    expect(classifyReport({ tags: [['p', P]], content: 'Reason: CSAM' }).csamSignal).toBe(true);
  });

  it('reads a Reason line ending in CRLF', () => {
    // sexual_minors, so the free-text terms cannot be what matched.
    expect(classifyReport({
      tags: [['e', E, 'illegal']],
      content: 'CONTENT REPORT - NIP-56\r\nReason: sexual_minors\r\nDetails: x\r\n',
    }).csamSignal).toBe(true);
  });

  it('rejects a Reason line whose value only starts with a CSAM category', () => {
    expect(classifyReport({ tags: [['e', E, 'illegal']], content: 'Reason: sexual_minorsx\n' }).csamSignal).toBe(false);
    expect(classifyReport({ tags: [['e', E, 'illegal']], content: 'Reason: childSafety\n' }).csamSignal).toBe(false);
  });

  it('classifies content made of many newlines in linear time', () => {
    const start = performance.now();
    classifyReport({ tags: [['e', E, 'illegal']], content: '\n'.repeat(100_000) });
    expect(performance.now() - start).toBeLessThan(200);
  });

  it('tolerates malformed input', () => {
    const other = { category: 'other', csamSignal: false };
    expect(classifyReport({ tags: [['l'], ['p']] })).toEqual(other);
    expect(classifyReport({})).toEqual(other);
    expect(classifyReport({ tags: 'nope', content: 42 })).toEqual(other);
    expect(classifyReport({ tags: [null, 'x', ['l', 'NS-spam', 'social.nos.ontology']] }).category).toBe('NS-spam');
  });

  it('lets a report tag beat labels', () => {
    expect(classifyReport({
      tags: [['l', 'NS-spam', 'social.nos.ontology'], ['report', 'harassment'], ['p', P, 'spam']],
    }).category).toBe('harassment');
  });

  it('uses a non-Divine label when no Divine label exists', () => {
    expect(classifyReport({ tags: [['p', P, 'spam'], ['l', 'csam', 'MOD']] }).category).toBe('csam');
  });

  it('skips empty-valued report and label tags', () => {
    expect(classifyReport({
      tags: [['report', ''], ['l', '', 'social.nos.ontology'], ['l', 'x', 'MOD'], ['p', P, 'spam']],
    }).category).toBe('x');
    expect(classifyReport({ tags: [['report', ''], ['l', '', 'social.nos.ontology'], ['p', P, 'spam']] }).category).toBe('spam');
  });

  // Only the first report tag counts, as in age review: an empty one falls
  // back to the labels, not to a later report tag.
  it('lets an empty first report tag fall back to labels', () => {
    const tags = [
      ['report', ''],
      ['report', 'spam'],
      ['L', 'social.nos.ontology'],
      ['l', 'NS-childSafety', 'social.nos.ontology'],
      ['p', P],
    ];
    expect(classifyReport({ tags }).category).toBe('NS-childSafety');
    expect(ageReviewCategory({ tags })).toBe('NS-childSafety');
  });

  it('falls back to the NIP-56 type on a p tag', () => {
    expect(classifyReport({ tags: [['p', P, 'spam']] }).category).toBe('spam');
  });

  it('skips a malformed NIP-56 type that is not a string', () => {
    const tags = [['e', P, 42], ['p', P, 'spam']] as unknown as string[][];
    expect(classifyReport({ tags }).category).toBe('spam');
    const pTags = [['p', P, 42]] as unknown as string[][];
    expect(classifyReport({ tags: pTags }).category).toBe('other');
  });

  it('skips an empty NIP-56 type', () => {
    expect(classifyReport({ tags: [['e', P, ''], ['p', P, 'spam']] }).category).toBe('spam');
    expect(classifyReport({ tags: [['p', P, '']] }).category).toBe('other');
  });

  // NIP-01 puts a relay hint third on an e or p tag, where NIP-56 puts the type.
  it('skips a relay hint where the NIP-56 type goes', () => {
    expect(classifyReport({ tags: [['e', E, 'wss://relay.example.com'], ['p', P]] }).category).toBe('other');
    expect(classifyReport({ tags: [['p', P, 'ws://relay.example.com']] }).category).toBe('other');
    expect(classifyReport({ tags: [['e', E, 'WSS://relay.example.com'], ['p', P, 'spam']] }).category).toBe('spam');
  });

  it('reads profanity as a NIP-56 type', () => {
    expect(classifyReport({ tags: [['e', E, 'profanity'], ['p', P, 'profanity']] }).category).toBe('profanity');
  });
});

describe('reportCategory', () => {
  // The content carries a CSAM signal, which must not change the category.
  it.each([
    { name: 'a relay hint on e', tags: [['e', E, 'wss://relay.example.com'], ['p', P]], category: 'other' },
    { name: 'a relay hint on p', tags: [['p', P, 'ws://relay.example.com']], category: 'other' },
    { name: 'an upper-case relay hint', tags: [['e', E, 'WSS://relay.example.com'], ['p', P, 'spam']], category: 'spam' },
    { name: 'a profanity type', tags: [['e', E, 'profanity'], ['p', P, 'profanity']], category: 'profanity' },
    {
      name: 'an empty first report tag',
      tags: [
        ['report', ''],
        ['report', 'spam'],
        ['L', 'social.nos.ontology'],
        ['l', 'NS-childSafety', 'social.nos.ontology'],
        ['p', P],
      ],
      category: 'NS-childSafety',
    },
  ])('matches classifyReport for $name', ({ tags, category }) => {
    const event = { tags, content: 'CONTENT REPORT - NIP-56\nReason: csam\n' };
    expect(reportCategory(event)).toBe(category);
    expect(classifyReport(event).category).toBe(category);
  });
});

describe('ageReviewCategory', () => {
  it('takes the first Divine label, in the worker order', () => {
    expect(ageReviewCategory({
      tags: [
        ['l', 'NS-csam', 'social.nos.ontology'],
        ['l', 'NS-underageUser', 'social.nos.ontology'],
      ],
    })).toBe('NS-csam');
  });

  it('does not prefer a high-priority Divine label the way classifyReport does', () => {
    expect(ageReviewCategory({
      tags: [
        ['l', 'NS-spam', 'social.nos.ontology'],
        ['l', 'NS-csam', 'social.nos.ontology'],
      ],
    })).toBe('NS-spam');
  });

  it('follows the worker precedence step by step', () => {
    const rep = ['report', 'r'];
    const nos = ['l', 'n', 'social.nos.ontology'];
    const mod = ['l', 'm', 'MOD'];
    const e = ['e', E, 'et'];
    const p = ['p', P, 'pt'];
    expect(ageReviewCategory({ tags: [nos, mod, e, p, rep] })).toBe('r');
    expect(ageReviewCategory({ tags: [mod, nos, e, p] })).toBe('n');
    expect(ageReviewCategory({ tags: [e, p, mod] })).toBe('m');
    expect(ageReviewCategory({ tags: [p, e] })).toBe('et');
  });

  it('falls back to the p tag type', () => {
    expect(ageReviewCategory({ tags: [['p', P, 'other']] })).toBe('other');
  });

  it('is unknown when nothing names a category', () => {
    expect(ageReviewCategory({ tags: [] })).toBe('unknown');
  });
});
