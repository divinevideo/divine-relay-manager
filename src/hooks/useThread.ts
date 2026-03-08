// ABOUTME: Fetches complete thread context for a Nostr event
// ABOUTME: Traverses reply tags to build thread ancestry and fetch full conversation

import { useNostr } from "@nostrify/react";
import { useQuery } from "@tanstack/react-query";
import type { NostrEvent } from "@nostrify/nostrify";

interface ThreadResult {
  ancestors: NostrEvent[];  // ordered from root to parent
  event: NostrEvent | null;
  replies: NostrEvent[];
  repostedEvent: NostrEvent | null;  // Original event if this is a repost
  isRepost: boolean;
}

// Kind 6 = repost of kind 1, Kind 16 = generic repost
const REPOST_KINDS = [6, 16];

export function useThread(eventId: string | undefined, depth: number = 3) {
  const { nostr } = useNostr();

  return useQuery<ThreadResult>({
    queryKey: ['thread', eventId, depth],
    queryFn: async ({ signal }) => {
      if (!eventId) {
        return { ancestors: [], event: null, replies: [], repostedEvent: null, isRepost: false };
      }

      const timeout = AbortSignal.timeout(8000);
      const combinedSignal = AbortSignal.any([signal, timeout]);

      // Fetch the main event
      const [event] = await nostr.query(
        [{ ids: [eventId], limit: 1 }],
        { signal: combinedSignal }
      );

      if (!event) {
        return { ancestors: [], event: null, replies: [], repostedEvent: null, isRepost: false };
      }

      // Check if this is a repost and fetch the original
      let repostedEvent: NostrEvent | null = null;
      const isRepost = REPOST_KINDS.includes(event.kind);

      if (isRepost) {
        const originalEventTag = event.tags.find(t => t[0] === 'e');
        if (originalEventTag) {
          if (event.content) {
            try {
              const parsed = JSON.parse(event.content);
              if (parsed && parsed.id && parsed.pubkey && parsed.kind !== undefined) {
                repostedEvent = parsed as NostrEvent;
              }
            } catch {
              // Content is not JSON, fetch the event
            }
          }

          if (!repostedEvent) {
            const [fetchedOriginal] = await nostr.query(
              [{ ids: [originalEventTag[1]], limit: 1 }],
              { signal: combinedSignal }
            );
            repostedEvent = fetchedOriginal || null;
          }
        }
      }

      // Collect ancestor IDs from NIP-10 tags upfront.
      // NIP-10 events may have a 'root' tag and a 'reply' tag — both point to
      // ancestors we can fetch in a single batch instead of chasing one at a time.
      const ancestorIds: string[] = [];
      const rootTag = event.tags.find(t => t[0] === 'e' && t[3] === 'root');
      const replyTag = event.tags.find(t => t[0] === 'e' && t[3] === 'reply');

      if (rootTag) ancestorIds.push(rootTag[1]);
      if (replyTag && replyTag[1] !== rootTag?.[1]) ancestorIds.push(replyTag[1]);

      // Fallback for events without NIP-10 markers: use positional e-tags
      if (ancestorIds.length === 0) {
        const eTags = event.tags.filter(t => t[0] === 'e');
        if (eTags.length > 0) {
          // First e-tag is conventionally the root/parent
          ancestorIds.push(eTags[0][1]);
        }
      }

      // Fetch ancestors and replies in parallel
      const [ancestorEvents, replies] = await Promise.all([
        ancestorIds.length > 0
          ? nostr.query(
              [{ ids: ancestorIds.slice(0, depth), limit: depth }],
              { signal: combinedSignal }
            )
          : Promise.resolve([]),
        nostr.query(
          [{ kinds: [1], '#e': [eventId], limit: 20 }],
          { signal: combinedSignal }
        ),
      ]);

      // Order ancestors: root first, then reply (match the order we collected IDs)
      const ancestorMap = new Map(ancestorEvents.map(e => [e.id, e]));
      const ancestors = ancestorIds
        .slice(0, depth)
        .map(id => ancestorMap.get(id))
        .filter((e): e is NostrEvent => e !== undefined);

      return { ancestors, event, replies, repostedEvent, isRepost };
    },
    enabled: !!eventId,
    staleTime: 60_000, // Cache thread data for 1 minute when switching between reports
  });
}
