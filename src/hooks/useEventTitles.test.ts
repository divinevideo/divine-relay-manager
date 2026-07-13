// ABOUTME: Tests the pure resolved-map builder behind useEventTitles (#164 A)

import { describe, it, expect } from 'vitest';
import type { NostrEvent } from '@nostrify/nostrify';
import { buildResolvedMap } from './useEventTitles';

const PK = 'b'.repeat(64);
const ID = 'c'.repeat(64);

function ev(over: Partial<NostrEvent>): NostrEvent {
  return { id: 'a'.repeat(64), pubkey: PK, kind: 1, content: '', tags: [], created_at: 1, sig: 'f'.repeat(128), ...over };
}

describe('buildResolvedMap', () => {
  it('resolves an id target to the fetched event title + kind', () => {
    const map = buildResolvedMap([ID], [ev({ id: ID, kind: 34236, tags: [['title', 'Puppies']] })]);
    const r = map.get(ID)!;
    expect(r.title).toBe('Puppies');
    expect(r.kind).toBe(34236);
    expect(r.encoded.startsWith('nevent1')).toBe(true);
  });

  it('resolves an address target by matching kind+pubkey+d', () => {
    const coord = `34236:${PK}:vid1`;
    const map = buildResolvedMap([coord], [ev({ kind: 34236, tags: [['d', 'vid1'], ['title', 'My Video']] })]);
    const r = map.get(coord)!;
    expect(r.title).toBe('My Video');
    expect(r.encoded.startsWith('naddr1')).toBe(true);
  });

  it('degrades unresolved id target to a short-id title, still encoded/linkable', () => {
    const map = buildResolvedMap([ID], []);
    const r = map.get(ID)!;
    expect(r.title).toContain(ID.slice(0, 8));
    expect(r.encoded.startsWith('nevent1')).toBe(true);
  });

  it('degrades unresolved address target to the coordinate, still encoded', () => {
    const coord = `34236:${PK}:vid1`;
    const map = buildResolvedMap([coord], []);
    const r = map.get(coord)!;
    expect(r.title).toBe(coord);
    expect(r.encoded.startsWith('naddr1')).toBe(true);
  });

  it('omits malformed targets entirely', () => {
    const map = buildResolvedMap(['garbage'], []);
    expect(map.has('garbage')).toBe(false);
  });

  it('resolves targets with uppercase hex via the case-normalized form', () => {
    const upperId = ID.toUpperCase();
    const idMap = buildResolvedMap([upperId], [ev({ id: ID, kind: 34236, tags: [['title', 'Puppies']] })]);
    expect(idMap.get(upperId)?.title).toBe('Puppies');

    const upperCoord = `34236:${PK.toUpperCase()}:vid1`;
    const addrMap = buildResolvedMap([upperCoord], [ev({ kind: 34236, tags: [['d', 'vid1'], ['title', 'My Video']] })]);
    expect(addrMap.get(upperCoord)?.title).toBe('My Video');
  });
});
