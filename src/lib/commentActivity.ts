// ABOUTME: NIP-22 comment target extraction + spray-activity summary — the
// ABOUTME: logic behind "what is this comment on" and "N comments across M videos"

import type { NostrEvent } from "@nostrify/nostrify";

/**
 * The root scope a kind-1111 comment is attached to: its `E` (root event id)
 * or, for addressable content, its `A` (root address coordinate). This is
 * "what the comment is on". Returns undefined for non-comments or comments
 * with no root scope.
 */
export function getCommentTarget(event: Pick<NostrEvent, 'kind' | 'tags'>): string | undefined {
  if (event.kind !== 1111) return undefined;
  const rootE = event.tags.find(t => t[0] === 'E')?.[1];
  if (rootE) return rootE;
  return event.tags.find(t => t[0] === 'A')?.[1];
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
