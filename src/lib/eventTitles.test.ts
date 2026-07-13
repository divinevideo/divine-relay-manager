// ABOUTME: Tests pure target parsing/encoding/title-extraction for comment parents (#164 A)

import { describe, it, expect } from 'vitest';
import { nip19 } from 'nostr-tools';
import {
  parseCommentTarget,
  encodeTarget,
  extractEventTitle,
  buildTitleFilters,
} from './eventTitles';

const PK = 'b'.repeat(64);
const ID = 'c'.repeat(64);

describe('parseCommentTarget', () => {
  it('parses a 64-hex event id', () => {
    expect(parseCommentTarget(ID)).toEqual({ kind: 'id', id: ID });
  });

  it('parses a kind:pubkey:d address coordinate', () => {
    expect(parseCommentTarget(`34236:${PK}:my-video`)).toEqual({
      kind: 'address', addressKind: 34236, pubkey: PK, identifier: 'my-video',
    });
  });

  it('parses an addressable coordinate with an empty d-tag', () => {
    expect(parseCommentTarget(`34235:${PK}:`)).toEqual({
      kind: 'address', addressKind: 34235, pubkey: PK, identifier: '',
    });
  });

  it('rejects malformed targets (untrusted commenter tags)', () => {
    expect(parseCommentTarget('')).toBeNull();
    expect(parseCommentTarget('garbage')).toBeNull();
    expect(parseCommentTarget(`notakind:${PK}:d`)).toBeNull();
    expect(parseCommentTarget('34236:shortpubkey:d')).toBeNull();
    expect(parseCommentTarget(`34236:${PK}`)).toBeNull(); // 2-segment, no d
  });

  it('normalizes uppercase hex in commenter-authored targets to canonical lowercase', () => {
    // Relay ids/pubkeys are lowercase hex; an uppercase tag value must still
    // match in filters instead of silently degrading the title
    expect(parseCommentTarget(ID.toUpperCase())).toEqual({ kind: 'id', id: ID });
    expect(parseCommentTarget(`34236:${PK.toUpperCase()}:vid1`)).toEqual({
      kind: 'address', addressKind: 34236, pubkey: PK, identifier: 'vid1',
    });
    // d-tags are case-sensitive — never normalized
    expect(parseCommentTarget(`34236:${PK}:VId1`)).toMatchObject({ identifier: 'VId1' });
  });
});

describe('encodeTarget', () => {
  it('encodes an id target as nevent', () => {
    const encoded = encodeTarget({ kind: 'id', id: ID });
    const decoded = nip19.decode(encoded);
    expect(decoded.type).toBe('nevent');
  });

  it('encodes an address target as naddr round-trip', () => {
    const encoded = encodeTarget({ kind: 'address', addressKind: 34236, pubkey: PK, identifier: 'my-video' });
    const decoded = nip19.decode(encoded);
    expect(decoded.type).toBe('naddr');
    expect(decoded.data).toMatchObject({ kind: 34236, pubkey: PK, identifier: 'my-video' });
  });
});

describe('extractEventTitle', () => {
  it('prefers the title tag', () => {
    expect(extractEventTitle({ kind: 34236, content: 'body', tags: [['title', 'Cute Puppies']] }))
      .toBe('Cute Puppies');
  });

  it('falls back to a trimmed content snippet when there is no title tag', () => {
    expect(extractEventTitle({ kind: 1, content: '  hello world  ', tags: [] })).toBe('hello world');
  });

  it('truncates a long content snippet to 60 chars with an ellipsis', () => {
    const long = 'x'.repeat(100);
    const out = extractEventTitle({ kind: 1, content: long, tags: [] });
    expect(out).toBe('x'.repeat(60) + '…');
  });

  it('returns empty string when there is neither title nor content', () => {
    expect(extractEventTitle({ kind: 34236, content: '', tags: [] })).toBe('');
  });
});

describe('buildTitleFilters', () => {
  it('groups id targets into one ids filter and each address into its own filter', () => {
    const filters = buildTitleFilters([ID, `34236:${PK}:my-video`]);
    expect(filters).toContainEqual({ ids: [ID] });
    expect(filters).toContainEqual({ kinds: [34236], authors: [PK], '#d': ['my-video'], limit: 1 });
  });

  it('drops malformed targets and returns [] when nothing is valid', () => {
    expect(buildTitleFilters(['garbage', ''])).toEqual([]);
  });
});
