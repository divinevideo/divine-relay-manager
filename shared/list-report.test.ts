import { describe, it, expect } from 'vitest';
import { getReportedList, LIST_KIND } from './list-report';

// Full-length 64-char hex pubkey, never truncated.
const AUTHOR = 'a'.repeat(64);

describe('getReportedList', () => {
  it('reads a video list coordinate from the report', () => {
    expect(getReportedList({ tags: [['e', 'e'.repeat(64)], ['a', `30005:${AUTHOR}:faves`]] }))
      .toEqual({ kind: LIST_KIND.videos, pubkey: AUTHOR, d: 'faves' });
  });

  it('reads a people list coordinate from the report', () => {
    expect(getReportedList({ tags: [['a', `30000:${AUTHOR}:crew`]] }))
      .toEqual({ kind: LIST_KIND.people, pubkey: AUTHOR, d: 'crew' });
  });

  it('keeps colons that belong to the d tag', () => {
    expect(getReportedList({ tags: [['a', `30005:${AUTHOR}:a:b:c`]] })?.d).toBe('a:b:c');
  });

  it('ignores a coordinate for a kind that is not a list', () => {
    expect(getReportedList({ tags: [['a', `34236:${AUTHOR}:clip`]] })).toBeNull();
  });

  it('ignores a coordinate whose pubkey is not 64 lowercase hex', () => {
    expect(getReportedList({ tags: [['a', `30005:${'A'.repeat(64)}:faves`]] })).toBeNull();
    expect(getReportedList({ tags: [['a', `30005:${'a'.repeat(63)}:faves`]] })).toBeNull();
  });

  it('ignores a coordinate with no d separator', () => {
    expect(getReportedList({ tags: [['a', `30005:${AUTHOR}`]] })).toBeNull();
  });

  it('finds the list coordinate among other a tags', () => {
    expect(getReportedList({
      tags: [['a', `34236:${AUTHOR}:clip`], ['a', `30000:${AUTHOR}:crew`]],
    })?.kind).toBe(LIST_KIND.people);
  });

  it('is null when the report carries no a tag', () => {
    expect(getReportedList({ tags: [['e', 'e'.repeat(64)], ['p', AUTHOR]] })).toBeNull();
  });
});
