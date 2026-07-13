// ABOUTME: Tests ThreadModal's thread-tree builder incl. NIP-22 comment nesting (#164 B)

import { describe, it, expect } from 'vitest';
import type { NostrEvent } from '@nostrify/nostrify';
import { buildThreadTree } from './ThreadModal';

const PK = 'b'.repeat(64);
function ev(over: Partial<NostrEvent>): NostrEvent {
  return { id: 'x', pubkey: PK, kind: 1, content: '', tags: [], created_at: 1, sig: 'f'.repeat(128), ...over };
}

describe('buildThreadTree NIP-22', () => {
  it('nests a kind-1111 comment under its lowercase-e parent', () => {
    const root = ev({ id: 'root', kind: 34236, tags: [['d', 'vid1']] });
    const comment = ev({
      id: 'c1', kind: 1111,
      tags: [['A', `34236:${PK}:vid1`], ['e', 'root'], ['k', '34236']],
    });
    const tree = buildThreadTree([root, comment], 'root');
    expect(tree?.replies.map(r => r.event.id)).toContain('c1');
  });

  it('nests a NIP-22 reply-to-a-comment under that comment (lowercase e)', () => {
    const root = ev({ id: 'root', kind: 1 });
    const c1 = ev({ id: 'c1', kind: 1111, tags: [['E', 'root'], ['e', 'root'], ['k', '1']] });
    const c2 = ev({ id: 'c2', kind: 1111, tags: [['E', 'root'], ['e', 'c1'], ['k', '1111']] });
    const tree = buildThreadTree([root, c1, c2], 'root');
    const c1node = tree?.replies.find(r => r.event.id === 'c1');
    expect(c1node?.replies.map(r => r.event.id)).toContain('c2');
  });

  it('hangs a comment whose parent is not in the set directly under root', () => {
    const root = ev({ id: 'root', kind: 34236, tags: [['d', 'vid1']] });
    const orphan = ev({ id: 'o1', kind: 1111, tags: [['A', `34236:${PK}:vid1`], ['e', 'missing'], ['k', '34236']] });
    const tree = buildThreadTree([root, orphan], 'root');
    expect(tree?.replies.map(r => r.event.id)).toContain('o1');
  });

  it('nests a top-level comment on an addressable root by matching the root address', () => {
    const root = ev({ id: 'root', kind: 34236, tags: [['d', 'vid1']] });
    // Top-level comment: lowercase `a` parent == the root's address, no `e`
    const comment = ev({ id: 'c1', kind: 1111, tags: [['A', `34236:${PK}:vid1`], ['a', `34236:${PK}:vid1`], ['k', '34236']] });
    const tree = buildThreadTree([root, comment], 'root');
    expect(tree?.replies.map(r => r.event.id)).toContain('c1');
  });

  it('attaches a comment carrying both e and a to its parent exactly once', () => {
    const root = ev({ id: 'root', kind: 34236, tags: [['d', 'vid1']] });
    // Top-level comment on addressable content: NIP-22 lets it carry both a
    // lowercase `e` (root id) and `a` (root address) pointing at the same parent.
    const comment = ev({
      id: 'c1', kind: 1111,
      tags: [['E', 'root'], ['A', `34236:${PK}:vid1`], ['e', 'root'], ['a', `34236:${PK}:vid1`], ['k', '34236']],
    });
    const tree = buildThreadTree([root, comment], 'root');
    expect(tree?.replies.filter(r => r.event.id === 'c1')).toHaveLength(1);
  });

  it('attaches a comment whose e and a tags disagree only under its fetched e-parent', () => {
    const root = ev({ id: 'root', kind: 34236, tags: [['d', 'vid1']] });
    const c1 = ev({ id: 'c1', kind: 1111, tags: [['A', `34236:${PK}:vid1`], ['a', `34236:${PK}:vid1`], ['k', '34236']] });
    // Commenter-authored tags can disagree: `e` names c1 while `a` names the
    // root — a fetched id-parent is authoritative, so no double render
    const sneaky = ev({
      id: 'c2', kind: 1111,
      tags: [['A', `34236:${PK}:vid1`], ['e', 'c1'], ['a', `34236:${PK}:vid1`], ['k', '1111']],
    });
    const tree = buildThreadTree([root, c1, sneaky], 'root');
    expect(tree?.replies.map(r => r.event.id)).not.toContain('c2');
    const c1node = tree?.replies.find(r => r.event.id === 'c1');
    expect(c1node?.replies.map(r => r.event.id)).toEqual(['c2']);
  });

  it('still nests NIP-10 kind-1 replies (no regression)', () => {
    const root = ev({ id: 'root', kind: 1 });
    const reply = ev({ id: 'r1', kind: 1, tags: [['e', 'root', '', 'reply']] });
    const tree = buildThreadTree([root, reply], 'root');
    expect(tree?.replies.map(r => r.event.id)).toContain('r1');
  });
});
