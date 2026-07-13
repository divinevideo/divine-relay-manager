// ABOUTME: Pure NIP-22/NIP-10 thread-tree builder for the Full Thread modal —
// ABOUTME: nests comments under their immediate parent (e/a), orphans under root

import type { NostrEvent } from "@nostrify/nostrify";
import { eventAddress } from "@/lib/threadFilters";
import { parseCommentTarget } from "@/lib/eventTitles";
import { isHex64 } from "@/lib/constants";

export interface ThreadNode {
  event: NostrEvent;
  replies: ThreadNode[];
  depth: number;
}

export function buildThreadTree(events: NostrEvent[], rootId: string): ThreadNode | null {
  const eventMap = new Map<string, NostrEvent>();
  events.forEach(e => eventMap.set(e.id, e));

  const root = eventMap.get(rootId);
  if (!root) return null;

  const rootAddress = eventAddress(root);
  const idSet = new Set(events.map(e => e.id));

  // A NIP-22 comment's immediate parent: lowercase `e` (event id) or `a`
  // (address). Both are commenter-authored, so hex is case-normalized to
  // match relay-canonical lowercase (same rationale as parseCommentTarget);
  // unparseable values pass through and degrade to the orphan path.
  function commentParent(e: NostrEvent): { id?: string; address?: string } {
    const rawId = e.tags.find(t => t[0] === 'e')?.[1];
    const rawAddress = e.tags.find(t => t[0] === 'a')?.[1];
    const parsedAddress = rawAddress ? parseCommentTarget(rawAddress) : null;
    return {
      id: rawId && isHex64(rawId) ? rawId.toLowerCase() : rawId,
      address: parsedAddress?.kind === 'address'
        ? `${parsedAddress.addressKind}:${parsedAddress.pubkey}:${parsedAddress.identifier}`
        : rawAddress,
    };
  }

  function isChildOf(e: NostrEvent, parent: NostrEvent, parentAddress: string | undefined): boolean {
    if (e.kind === 1111) {
      const { id, address } = commentParent(e);
      // A fetched id-parent is authoritative — tags are commenter-authored, so
      // an `e` and `a` that disagree (e→X, a→root) must not attach twice.
      if (id && idSet.has(id)) return id === parent.id;
      if (address && parentAddress && address === parentAddress) return true;
      // Orphan (immediate parent not fetched): attach to root only, so it still shows.
      const parentPresent = !!address && rootAddress === address;
      return parent.id === rootId && !parentPresent;
    }
    // NIP-10 kind-1 reply markers (existing behavior)
    const replyTag = e.tags.find(t => t[0] === 'e' && (t[3] === 'reply' || !t[3]));
    return !!replyTag && replyTag[1] === parent.id;
  }

  function buildNode(event: NostrEvent, depth: number): ThreadNode {
    const parentAddress = eventAddress(event);
    const replies = events
      .filter(e => e.id !== event.id && isChildOf(e, event, parentAddress))
      .map(e => buildNode(e, depth + 1))
      .sort((a, b) => a.event.created_at - b.event.created_at);

    return { event, replies, depth };
  }

  return buildNode(root, 0);
}
