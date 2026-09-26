// ABOUTME: Combines the report feeds the queue draws from into one list, once per report.
// ABOUTME: The needs-attention feed, loaded resolved history and deep-linked reports can overlap.

import type { NostrEvent } from '@nostrify/nostrify';

// The same report can arrive from two feeds: a reopen moves a target back into
// the needs-attention feed while a cached history page still lists it, and a
// deep link can find a report the feed also holds. Listing it twice would show
// a duplicate row and double the target's report count. Newest first, the
// order every feed already arrives in.
export function mergeReportFeeds(...feeds: ReadonlyArray<readonly NostrEvent[] | undefined>): NostrEvent[] {
  const seen = new Set<string>();
  const merged: NostrEvent[] = [];
  for (const feed of feeds) {
    for (const event of feed ?? []) {
      if (seen.has(event.id)) continue;
      seen.add(event.id);
      merged.push(event);
    }
  }
  return merged.sort((a, b) => b.created_at - a.created_at);
}
