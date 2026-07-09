// ABOUTME: Tests NIP-18 repost parsing edge cases (empty/malformed/non-event JSON)

import { describe, it, expect } from 'vitest';
import { getRepostTargetId, isRepostKind, parseRepostedEvent } from './nip18';

describe('isRepostKind', () => {
  it('matches kinds 6 and 16 only', () => {
    expect(isRepostKind(6)).toBe(true);
    expect(isRepostKind(16)).toBe(true);
    expect(isRepostKind(1)).toBe(false);
    expect(isRepostKind(1111)).toBe(false);
  });
});

describe('getRepostTargetId', () => {
  it('returns the first e-tag value, or undefined when absent', () => {
    expect(getRepostTargetId([['p', 'x'], ['e', 'abc'], ['e', 'def']])).toBe('abc');
    expect(getRepostTargetId([['p', 'x']])).toBeUndefined();
    expect(getRepostTargetId([])).toBeUndefined();
  });
});

describe('parseRepostedEvent', () => {
  it('extracts content, tags, and pubkey from a serialized event', () => {
    const inner = { content: 'hello', tags: [['e', 'abc']], pubkey: 'f'.repeat(64), kind: 34236 };
    expect(parseRepostedEvent(JSON.stringify(inner))).toEqual({
      content: 'hello',
      tags: [['e', 'abc']],
      pubkey: 'f'.repeat(64),
    });
  });

  it('returns null for empty or malformed content', () => {
    expect(parseRepostedEvent('')).toBeNull();
    expect(parseRepostedEvent('not json')).toBeNull();
    expect(parseRepostedEvent('null')).toBeNull();
    expect(parseRepostedEvent('42')).toBeNull();
    expect(parseRepostedEvent('"string"')).toBeNull();
  });

  it('returns null when inner content is missing or not a string', () => {
    expect(parseRepostedEvent(JSON.stringify({ tags: [] }))).toBeNull();
    expect(parseRepostedEvent(JSON.stringify({ content: 42 }))).toBeNull();
  });

  it('defaults tags/pubkey when absent or wrong-typed', () => {
    expect(parseRepostedEvent(JSON.stringify({ content: 'x', tags: 'nope', pubkey: 5 }))).toEqual({
      content: 'x',
      tags: [],
      pubkey: '',
    });
  });

  it('drops non-array elements inside tags', () => {
    expect(
      parseRepostedEvent(JSON.stringify({ content: 'x', tags: [['e', 'abc'], 'rogue', 42] }))
    ).toEqual({ content: 'x', tags: [['e', 'abc']], pubkey: '' });
  });

  it('drops tags containing non-string members (would crash media preview)', () => {
    expect(
      parseRepostedEvent(JSON.stringify({ content: 'x', tags: [['imeta', 42], ['e', 'abc'], [null]] }))
    ).toEqual({ content: 'x', tags: [['e', 'abc']], pubkey: '' });
  });
});
