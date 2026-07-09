// ABOUTME: Tests NIP-10 reply + NIP-22 comment filter construction for a thread

import { describe, it, expect } from 'vitest';
import { buildThreadReplyFilters, eventAddress } from './threadFilters';

const ID = 'a'.repeat(64);
const PK = 'b'.repeat(64);
const base = { id: ID, pubkey: PK, tags: [] as string[][] };

describe('eventAddress', () => {
  it('builds a kind:pubkey:d-tag coordinate for addressable video kinds', () => {
    expect(eventAddress({ kind: 34236, pubkey: PK, tags: [['d', 'my-vid']] }))
      .toBe(`34236:${PK}:my-vid`);
  });

  it('uses an empty d-tag segment when the d tag is absent', () => {
    expect(eventAddress({ kind: 34235, pubkey: PK, tags: [] })).toBe(`34235:${PK}:`);
  });

  it('returns undefined for regular (non-addressable) kinds', () => {
    expect(eventAddress({ kind: 22, pubkey: PK, tags: [] })).toBeUndefined();
    expect(eventAddress({ kind: 1, pubkey: PK, tags: [] })).toBeUndefined();
    expect(eventAddress({ kind: 1111, pubkey: PK, tags: [] })).toBeUndefined();
  });
});

describe('buildThreadReplyFilters', () => {
  it('fetches NIP-10 kind-1 replies (lowercase e) and NIP-22 kind-1111 comments (root E)', () => {
    const filters = buildThreadReplyFilters({ ...base, kind: 22 });
    expect(filters).toContainEqual({ kinds: [1], '#e': [ID], limit: 100 });
    expect(filters).toContainEqual({ kinds: [1111], '#E': [ID], limit: 100 });
  });

  it('does not add an address filter for regular-kind events', () => {
    const filters = buildThreadReplyFilters({ ...base, kind: 22 });
    expect(filters.some(f => '#A' in f)).toBe(false);
    expect(filters).toHaveLength(2);
  });

  it('adds an #A address filter for addressable videos — their comments scope by address', () => {
    const filters = buildThreadReplyFilters({ ...base, kind: 34236, tags: [['d', 'vid1']] });
    expect(filters).toContainEqual({ kinds: [1111], '#A': [`34236:${PK}:vid1`], limit: 100 });
    expect(filters).toHaveLength(3);
  });

  it('honors a custom limit across every filter', () => {
    const filters = buildThreadReplyFilters({ ...base, kind: 34236, tags: [['d', 'v']] }, 20);
    expect(filters.every(f => f.limit === 20)).toBe(true);
  });
});
