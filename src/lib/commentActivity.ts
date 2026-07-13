// ABOUTME: NIP-22 comment target extraction + spray-activity summary — the
// ABOUTME: logic behind "what is this comment on" and "N comments across M videos"

import type { NostrEvent } from "@nostrify/nostrify";
import { isVideoKind } from "@/lib/kindNames";
import { parseCommentTarget } from "@/lib/eventTitles";

/**
 * Canonical form for a commenter-authored root value: parseable ids and
 * coordinates get their hex lowercased (either shape, whichever tag it was
 * smuggled through); unparseable values pass through raw and are rejected
 * downstream by every parseCommentTarget consumer.
 */
function canonicalizeTarget(raw: string): string {
  const parsed = parseCommentTarget(raw);
  if (!parsed) return raw;
  return parsed.kind === 'id'
    ? parsed.id
    : `${parsed.addressKind}:${parsed.pubkey}:${parsed.identifier}`;
}

/**
 * The root scope a kind-1111 comment is attached to: its `E` (root event id)
 * or, for addressable content, its `A` (root address coordinate). This is
 * "what the comment is on". Returns undefined for non-comments or comments
 * with no root scope. External-identity roots (`I` tag: URLs, podcasts,
 * geohashes) are intentionally not resolved — Divine's content is E/A video,
 * and there is no in-tool event view to link them to.
 *
 * Values are canonicalized at this single source, so the spray count, the
 * batched title map, and row-link lookups all compare targets consistently.
 */
export function getCommentTarget(event: Pick<NostrEvent, 'kind' | 'tags'>): string | undefined {
  if (event.kind !== 1111) return undefined;
  const rootE = event.tags.find(t => t[0] === 'E')?.[1];
  if (rootE) return canonicalizeTarget(rootE);
  const rootA = event.tags.find(t => t[0] === 'A')?.[1];
  return rootA ? canonicalizeTarget(rootA) : undefined;
}

export interface CommentActivitySummary {
  /** Number of kind-1111 comments in the set. */
  commentCount: number;
  /** Distinct root targets those comments are spread across. */
  distinctTargets: number;
  /** Largest count of distinct targets that received byte-identical comment
   * text — >= 2 means the same comment was sprayed across multiple targets. */
  repeatedAcrossTargets: number;
}

/**
 * Summarize a user's comment activity for the at-a-glance spray signal (#164 A):
 * distinguishes "8 comments across 7 videos" (spray) from "8 comments on 1
 * video" (conversation). Non-comment events are ignored.
 */
export function summarizeCommentActivity(events: NostrEvent[]): CommentActivitySummary {
  const comments = events.filter(e => e.kind === 1111);
  const targets = new Set<string>();
  const targetsByContent = new Map<string, Set<string>>();

  for (const c of comments) {
    const target = getCommentTarget(c);
    if (target) targets.add(target);

    const text = c.content.trim();
    if (text && target) {
      const set = targetsByContent.get(text) ?? new Set<string>();
      set.add(target);
      targetsByContent.set(text, set);
    }
  }

  let repeatedAcrossTargets = 0;
  for (const set of targetsByContent.values()) {
    repeatedAcrossTargets = Math.max(repeatedAcrossTargets, set.size);
  }

  return { commentCount: comments.length, distinctTargets: targets.size, repeatedAcrossTargets };
}

/**
 * The at-a-glance spray line for a card: "8 comments across 7 videos" vs
 * "8 comments on 1 video". Noun is "video" only when every comment's root-kind
 * (K tag) is a video kind, else "post". Returns null when there are no comments.
 */
export function formatCommentActivity(events: NostrEvent[]): string | null {
  const comments = events.filter(e => e.kind === 1111);
  if (comments.length === 0) return null;

  const { commentCount, distinctTargets, repeatedAcrossTargets } = summarizeCommentActivity(comments);

  const rootKinds = comments
    .map(c => c.tags.find(t => t[0] === 'K')?.[1])
    .filter((k): k is string => !!k)
    .map(Number)
    .filter(k => !Number.isNaN(k));
  const allVideo = rootKinds.length > 0 && rootKinds.every(isVideoKind);
  const noun = allVideo ? 'video' : 'post';

  const c = `${commentCount} comment${commentCount === 1 ? '' : 's'}`;
  // A comment with no resolvable root scope contributes no target — fall back to
  // the bare count rather than an "across 0 posts" nonsense line.
  if (distinctTargets === 0) return c;
  const where = distinctTargets === 1
    ? `on 1 ${noun}`
    : `across ${distinctTargets} ${noun}s`;
  const spray = repeatedAcrossTargets >= 2 ? ` (same comment on ${repeatedAcrossTargets})` : '';
  return `${c} ${where}${spray}`;
}
