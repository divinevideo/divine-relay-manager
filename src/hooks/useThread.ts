// ABOUTME: Fetches complete thread context for a Nostr event
// ABOUTME: Tries Funnelcake REST API first for speed, falls back to WebSocket

import { useNostr } from "@nostrify/react";
import { useQuery } from "@tanstack/react-query";
import type { NostrEvent } from "@nostrify/nostrify";
import { fetchFunnelcakeEvent } from "@/lib/funnelcakeApi";

interface ThreadResult {
  ancestors: NostrEvent[];  // ordered from root to parent
  event: NostrEvent | null;
  replies: NostrEvent[];
  repostedEvent: NostrEvent | null;  // Original event if this is a repost
  isRepost: boolean;
}

// Kind 6 = repost of kind 1, Kind 16 = generic repost
const REPOST_KINDS = [6, 16];

export function useThread(eventId: string | undefined, depth: number = 3, apiUrl?: string) {
  const { nostr } = useNostr();

  return useQuery<ThreadResult>({
    queryKey: ['thread', eventId, depth, apiUrl],
    queryFn: async ({ signal }) => {
      if (!eventId) {
        return { ancestors: [], event: null, replies: [], repostedEvent: null, isRepost: false };
      }

      const timeout = AbortSignal.timeout(8000);
      const combinedSignal = AbortSignal.any([signal, timeout]);

      // Fetch the main event -- try REST first for speed, fall back to WebSocket
      let event: NostrEvent | undefined;
      if (apiUrl) {
        const restEvent = await fetchFunnelcakeEvent(apiUrl, eventId);
        if (restEvent) event = restEvent;
      }
      if (!event) {
        const [wsEvent] = await nostr.query(
          [{ ids: [eventId], limit: 1 }],
          { signal: combinedSignal }
        );
        event = wsEvent;
      }

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
            if (apiUrl) {
              repostedEvent = await fetchFunnelcakeEvent(apiUrl, originalEventTag[1]) || null;
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

      // NIP-22 kind 1111 comments may use uppercase E tags to reference parents
      if (ancestorIds.length === 0) {
        const upperETags = event.tags.filter(t => t[0] === 'E');
        if (upperETags.length > 0) {
          ancestorIds.push(upperETags[0][1]);
        }
      }

      // Fetch ancestors -- try REST in parallel, fall back to WebSocket batch
      let ancestorEvents: NostrEvent[] = [];
      if (apiUrl && ancestorIds.length > 0) {
        const restResults = await Promise.all(
          ancestorIds.slice(0, depth).map(id => fetchFunnelcakeEvent(apiUrl, id))
        );
        ancestorEvents = restResults.filter((e): e is NostrEvent => e !== null);
      }
      // Fall back to WebSocket if REST didn't return all ancestors
      if (ancestorEvents.length < ancestorIds.slice(0, depth).length) {
        const missingIds = ancestorIds.slice(0, depth).filter(
          id => !ancestorEvents.find(e => e.id === id)
        );
        if (missingIds.length > 0) {
          const wsAncestors = await nostr.query(
            [{ ids: missingIds, limit: missingIds.length }],
            { signal: combinedSignal }
          );
          ancestorEvents = [...ancestorEvents, ...wsAncestors];
        }
      }

      // Replies stay on WebSocket for now (Phase 2)
      const replies = await nostr.query(
        [{ kinds: [1], '#e': [eventId], limit: 20 }],
        { signal: combinedSignal }
      );

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
