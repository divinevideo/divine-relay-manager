// @vitest-environment node
// ABOUTME: Tests NIP-18 repost parsing edge cases (empty/malformed/non-event JSON)
// Node, not jsdom, so the signature checks below run nostr-tools for real.

import { describe, it, expect } from 'vitest';
import { getRepostTargetId, isRepostKind, parseRepostedEvent, describeRepostTarget, getRepostTargetCoordinate, parseRepostForDisplay, isEventWithId, checkedEventWithId, verifiedRepostedEvent } from './nip18';
import { SIGNED_NOTE, SIGNED_VIDEO } from '@/test/signedEvents';
import { verifyEvent } from 'nostr-tools';

// A repost's embedded copy is written by the reposter. The media buttons act on
// its files, so it counts only when it is the event the repost names (#337).
describe('verifiedRepostedEvent', () => {
  const original = SIGNED_VIDEO;
  const repostOf = (content: string, target = original.id) => ({
    content,
    tags: [['e', target], ['p', original.pubkey]],
  });

  it('returns the copy when it is the signed event the e tag names', () => {
    expect(verifiedRepostedEvent(repostOf(JSON.stringify(original)))).toEqual(original);
  });

  it('refuses a copy whose files were changed after signing', () => {
    const forged = { ...original, tags: [['imeta', 'url https://media.divine.video/' + 'b'.repeat(64), 'm video/mp4']] };
    expect(verifiedRepostedEvent(repostOf(JSON.stringify(forged)))).toBeNull();
  });

  it('refuses a correctly signed event that is not the one the e tag names', () => {
    expect(verifiedRepostedEvent(repostOf(JSON.stringify(SIGNED_NOTE)))).toBeNull();
  });

  it('refuses a copy with no signature, and content that is not an event', () => {
    const { sig: _sig, ...unsigned } = original;
    expect(verifiedRepostedEvent(repostOf(JSON.stringify(unsigned)))).toBeNull();
    expect(verifiedRepostedEvent(repostOf('not json'))).toBeNull();
    expect(verifiedRepostedEvent(repostOf(JSON.stringify([original])))).toBeNull();
  });

  it('refuses a copy when the repost names no event', () => {
    expect(verifiedRepostedEvent({ content: JSON.stringify(original), tags: [['p', original.pubkey]] })).toBeNull();
  });
});

describe('isEventWithId', () => {
  const event = SIGNED_NOTE;

  it('refuses an event whose fields and id are intact but whose signature is not', () => {
    // The id is the hash of the fields, so only the signature says who wrote it.
    const forgedSig = { ...SIGNED_VIDEO, sig: SIGNED_NOTE.sig };
    expect(isEventWithId(forgedSig, SIGNED_VIDEO.id)).toBe(false);
    expect(verifiedRepostedEvent({ content: JSON.stringify(forgedSig), tags: [['e', SIGNED_VIDEO.id]] })).toBeNull();
  });

  it('refuses a copy of an event it already verified, once its files are changed', () => {
    // nostr-tools marks an event it verified and trusts that mark next time, and
    // a spread copies the mark. The check must not let a changed copy ride on it.
    const verified = { ...SIGNED_VIDEO };
    expect(isEventWithId(verified, SIGNED_VIDEO.id)).toBe(true);
    expect(verifyEvent(verified)).toBe(true);
    const changed = { ...verified, tags: [['imeta', `url https://media.divine.video/${'e'.repeat(64)}`, 'm video/mp4']] };

    expect(isEventWithId(changed, SIGNED_VIDEO.id)).toBe(false);
  });

  it('accepts a signed event whose id is in upper case, from either side', () => {
    expect(isEventWithId({ ...event, id: event.id.toUpperCase() }, event.id)).toBe(true);
    expect(isEventWithId(event, event.id.toUpperCase())).toBe(true);
  });

  it('accepts a signed event with the expected id, and nothing else', () => {
    expect(isEventWithId(event, event.id)).toBe(true);
    expect(isEventWithId(event, 'f'.repeat(64))).toBe(false);
    expect(isEventWithId({ ...event, content: 'changed' }, event.id)).toBe(false);
    expect(isEventWithId(null, event.id)).toBe(false);
    expect(isEventWithId({ ...event, tags: 'not tags' }, event.id)).toBe(false);
  });
});

// The one place a candidate original is checked and normalized: both an embedded
// copy and a fetched event go through it before anything reads their files.
describe('checkedEventWithId', () => {
  it('returns the event, with its id in lower case, when it is the signed event the id names', () => {
    const upper = { ...SIGNED_VIDEO, id: SIGNED_VIDEO.id.toUpperCase() };
    expect(checkedEventWithId(upper, SIGNED_VIDEO.id)).toEqual(SIGNED_VIDEO);
    expect(checkedEventWithId(SIGNED_VIDEO, SIGNED_VIDEO.id.toUpperCase())).toEqual(SIGNED_VIDEO);
  });

  it('returns null for an event with its files changed, another event, or something that is not one', () => {
    const forged = { ...SIGNED_VIDEO, tags: [['imeta', 'url https://media.divine.video/' + 'b'.repeat(64), 'm video/mp4']] };
    expect(checkedEventWithId(forged, SIGNED_VIDEO.id)).toBeNull();
    expect(checkedEventWithId(SIGNED_NOTE, SIGNED_VIDEO.id)).toBeNull();
    expect(checkedEventWithId(null, SIGNED_VIDEO.id)).toBeNull();
    expect(checkedEventWithId('not an event', SIGNED_VIDEO.id)).toBeNull();
  });
});

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

describe('getRepostTargetCoordinate', () => {
  const PK = 'b'.repeat(64);

  it('returns a well-formed a-tag coordinate (addressable repost, NIP-18)', () => {
    expect(getRepostTargetCoordinate([['a', `34236:${PK}:my-video`]])).toBe(`34236:${PK}:my-video`);
    expect(getRepostTargetCoordinate([['a', `34235:${PK}:`]])).toBe(`34235:${PK}:`);
  });

  it('rejects malformed coordinates (reporter/reposter-authored tags)', () => {
    expect(getRepostTargetCoordinate([])).toBeUndefined();
    expect(getRepostTargetCoordinate([['a', 'garbage']])).toBeUndefined();
    expect(getRepostTargetCoordinate([['a', `notakind:${PK}:d`]])).toBeUndefined();
    expect(getRepostTargetCoordinate([['a', '34236:shortpubkey:d']])).toBeUndefined();
  });
});

describe('describeRepostTarget', () => {
  const ID = 'c'.repeat(64);
  const PK = 'b'.repeat(64);

  it('prefers the e-tag event id, falls back to the a-tag coordinate', () => {
    expect(describeRepostTarget([['e', ID], ['a', `34236:${PK}:d`]])).toBe(`event ${ID}`);
    expect(describeRepostTarget([['a', `34236:${PK}:d`]])).toBe(`34236:${PK}:d`);
    expect(describeRepostTarget([])).toBeUndefined();
  });
});

describe('parseRepostForDisplay', () => {
  const PK = 'b'.repeat(64);

  it('passes non-repost content through unchanged (no kind-based suppression)', () => {
    expect(parseRepostForDisplay({ kind: 1, content: 'hello', tags: [] }).displayContent).toBe('hello');
  });

  it('shows the inner text of a parsed repost', () => {
    const r = parseRepostForDisplay({
      kind: 16,
      content: JSON.stringify({ content: 'inner note', pubkey: PK }),
      tags: [['e', 'c'.repeat(64)]],
    });
    expect(r.displayContent).toBe('inner note');
  });

  it('never hides readable text a reposter tries to disguise with a kind claim', () => {
    // Every kind signal on a repost (k tag, inner JSON kind) is authored by
    // the account under review. None may blank its own readable text.
    const viaKTag = parseRepostForDisplay({
      kind: 16,
      content: 'FREE GIVEAWAY click my profile',
      tags: [['k', '1064'], ['e', 'c'.repeat(64)]],
    });
    expect(viaKTag.displayContent).toBe('FREE GIVEAWAY click my profile');

    const viaInnerKind = parseRepostForDisplay({
      kind: 16,
      content: JSON.stringify({ content: 'FREE GIVEAWAY', kind: 1064 }),
      tags: [['e', 'c'.repeat(64)]],
    });
    expect(viaInnerKind.displayContent).toBe('FREE GIVEAWAY');
  });

  it('shows plain-text and JSON-array out-of-spec content, but not a raw object envelope', () => {
    // Plain text renders as evidence.
    expect(parseRepostForDisplay({ kind: 6, content: 'plain text spam', tags: [] }).displayContent)
      .toBe('plain text spam');

    // A JSON array carrying readable text is not an event envelope — show it.
    const arr = parseRepostForDisplay({ kind: 16, content: JSON.stringify(['visit scam.link']), tags: [] });
    expect(arr.displayContent).toBe(JSON.stringify(['visit scam.link']));

    // A serialized-event *object* (not a valid inner event) must not render as
    // a raw JSON blob or reach the AI — show the target label instead.
    const objEnvelope = parseRepostForDisplay({
      kind: 16,
      content: JSON.stringify({ content: 42, pubkey: 'x' }),
      tags: [['e', 'c'.repeat(64)]],
    });
    expect(objEnvelope.displayContent).toBe('');
    expect(objEnvelope.targetDescription).toBe(`event ${'c'.repeat(64)}`);
  });

  it('describes the a-tag coordinate for empty-content addressable reposts', () => {
    const addressable = parseRepostForDisplay({
      kind: 16,
      content: '',
      tags: [['k', '34236'], ['a', `34236:${PK}:my-video`]],
    });
    expect(addressable.displayContent).toBe('');
    expect(addressable.targetDescription).toBe(`34236:${PK}:my-video`);
  });
});

describe('describeRepostTarget hostile-tag hardening', () => {
  it('ignores e-tag values that are not 64-hex event ids (NIP-18 MUST)', () => {
    const junk = 'x'.repeat(20000);
    expect(describeRepostTarget([['e', junk]])).toBeUndefined();
    expect(describeRepostTarget([['e', junk], ['a', `34236:${'b'.repeat(64)}:d`]]))
      .toBe(`34236:${'b'.repeat(64)}:d`);
  });
});

describe('getRepostTargetCoordinate segment count', () => {
  it('rejects 2-segment kind:pubkey values (documented shape is kind:pubkey:d-tag)', () => {
    expect(getRepostTargetCoordinate([['a', `34236:${'b'.repeat(64)}`]])).toBeUndefined();
  });
});
