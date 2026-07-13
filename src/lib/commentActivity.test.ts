// ABOUTME: Tests NIP-22 comment target extraction and spray-activity summary

import { describe, it, expect } from 'vitest';
import type { NostrEvent } from '@nostrify/nostrify';
import { getCommentTarget, summarizeCommentActivity, formatCommentActivity } from './commentActivity';

const PK = 'a'.repeat(64);
const VID = (b: string) => b.repeat(64);
const ADDR = `34236:${PK}:vid1`;

function comment(content: string, rootTags: string[][], idByte = '9'): NostrEvent {
  return { id: idByte.repeat(64), pubkey: PK, kind: 1111, tags: rootTags, content, created_at: 1, sig: 'f'.repeat(128) };
}

describe('getCommentTarget', () => {
  it('returns the root E event id for a comment', () => {
    expect(getCommentTarget(comment('x', [['E', VID('c')]]))).toBe(VID('c'));
  });

  it('returns the root A address when there is no E tag (addressable video)', () => {
    expect(getCommentTarget(comment('x', [['A', ADDR]]))).toBe(ADDR);
  });

  it('prefers E over A when both are present', () => {
    expect(getCommentTarget(comment('x', [['E', VID('c')], ['A', ADDR]]))).toBe(VID('c'));
  });

  it('returns undefined for non-comment kinds and comments without a root scope', () => {
    expect(getCommentTarget({ ...comment('x', []), kind: 1 })).toBeUndefined();
    expect(getCommentTarget(comment('x', []))).toBeUndefined();
  });

  it('case-normalizes commenter-authored hex so equal targets compare equal', () => {
    expect(getCommentTarget(comment('x', [['E', VID('c').toUpperCase()]]))).toBe(VID('c'));
    expect(getCommentTarget(comment('x', [['A', `34236:${PK.toUpperCase()}:vid1`]]))).toBe(ADDR);
    // Values smuggled through the wrong tag (out-of-spec) still normalize to
    // the same canonical form: a bare id via A, a coordinate via E
    expect(getCommentTarget(comment('x', [['A', VID('c').toUpperCase()]]))).toBe(VID('c'));
    expect(getCommentTarget(comment('x', [['E', `34236:${PK.toUpperCase()}:vid1`]]))).toBe(ADDR);
    // ...so a video tagged with mixed-case hex counts as one target, not two
    const s = summarizeCommentActivity([
      comment('a', [['E', VID('c')]], '1'),
      comment('b', [['E', VID('c').toUpperCase()]], '2'),
    ]);
    expect(s.distinctTargets).toBe(1);
  });
});

describe('summarizeCommentActivity', () => {
  it('counts comments and distinct targets, ignoring non-comment events', () => {
    const events: NostrEvent[] = [
      comment('gm', [['E', VID('1')]], '1'),
      comment('gm', [['E', VID('2')]], '2'),
      comment('nice', [['E', VID('2')]], '3'),
      { ...comment('a post', []), kind: 1, id: '4'.repeat(64) },
    ];
    const s = summarizeCommentActivity(events);
    expect(s.commentCount).toBe(3);
    expect(s.distinctTargets).toBe(2);
  });

  it('detects the same text sprayed across multiple distinct targets', () => {
    const events: NostrEvent[] = [
      comment('FREE GIVEAWAY', [['E', VID('1')]], '1'),
      comment('FREE GIVEAWAY', [['E', VID('2')]], '2'),
      comment('FREE GIVEAWAY', [['E', VID('3')]], '3'),
    ];
    expect(summarizeCommentActivity(events).repeatedAcrossTargets).toBe(3);
  });

  it('does not treat repeated text on ONE target as spray', () => {
    const events: NostrEvent[] = [
      comment('lol', [['E', VID('1')]], '1'),
      comment('lol', [['E', VID('1')]], '2'),
    ];
    const s = summarizeCommentActivity(events);
    expect(s.distinctTargets).toBe(1);
    expect(s.repeatedAcrossTargets).toBe(1);
  });
});

describe('formatCommentActivity', () => {
  it('returns null when there are no comments', () => {
    expect(formatCommentActivity([])).toBeNull();
  });

  it('reads "on 1 video" for comments concentrated on one video target', () => {
    const events = [
      comment('a', [['E', VID('1')], ['K', '34236']], '1'),
      comment('b', [['E', VID('1')], ['K', '34236']], '2'),
    ];
    expect(formatCommentActivity(events)).toBe('2 comments on 1 video');
  });

  it('reads "across M videos" for a spread, with a spray note for repeated text', () => {
    const events = [
      comment('same', [['E', VID('1')], ['K', '34236']], '1'),
      comment('same', [['E', VID('2')], ['K', '34236']], '2'),
      comment('same', [['E', VID('3')], ['K', '34236']], '3'),
    ];
    expect(formatCommentActivity(events)).toBe('3 comments across 3 videos (same comment on 3)');
  });

  it('uses "post" when the root kinds are not all video', () => {
    const events = [
      comment('a', [['E', VID('1')], ['K', '1']], '1'),
      comment('b', [['E', VID('2')], ['K', '34236']], '2'),
    ];
    expect(formatCommentActivity(events)).toBe('2 comments across 2 posts');
  });

  it('falls back to a bare count when comments have no resolvable target', () => {
    expect(formatCommentActivity([comment('orphan', [], '1')])).toBe('1 comment');
  });
});
