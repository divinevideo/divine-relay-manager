// ABOUTME: Fetches complete thread context for a Nostr event
// ABOUTME: Traverses reply tags to build thread ancestry and fetch full conversation

import { useNostr } from "@nostrify/react";
import { useQuery } from "@tanstack/react-query";
import type { NostrEvent } from "@nostrify/nostrify";

interface ThreadResult {
  ancestors: NostrEvent[];  // ordered from root to parent
  event: NostrEvent | null;
  replies: NostrEvent[];
}

export function useThread(eventId: string | undefined, depth: number = 3) {
  const { nostr } = useNostr();

  return useQuery<ThreadResult>({
    queryKey: ['thread', eventId, depth],
    queryFn: async ({ signal }) => {
      if (!eventId) {
        return { ancestors: [], event: null, replies: [] };
      }

      const timeout = AbortSignal.timeout(5000);
      const combinedSignal = AbortSignal.any([signal, timeout]);

      // Fetch the main event
      const [event] = await nostr.query(
        [{ ids: [eventId], limit: 1 }],
        { signal: combinedSignal }
      );

      if (!event) {
        return { ancestors: [], event: null, replies: [] };
      }

      // Find ancestors by following reply tags
      const ancestors: NostrEvent[] = [];
      let currentEvent = event;

      for (let i = 0; i < depth; i++) {
        const replyTag = currentEvent.tags.find(
          t => t[0] === 'e' && (t[3] === 'reply' || t[3] === 'root' || !t[3])
        );

        if (!replyTag) break;

        const [parentEvent] = await nostr.query(
          [{ ids: [replyTag[1]], limit: 1 }],
          { signal: combinedSignal }
        );

        if (parentEvent) {
          ancestors.unshift(parentEvent);
          currentEvent = parentEvent;
        } else {
          break;
        }
      }

      // Fetch replies to the event
      const replies = await nostr.query(
        [{ kinds: [1], '#e': [eventId], limit: 20 }],
        { signal: combinedSignal }
      );

      return { ancestors, event, replies };
    },
    enabled: !!eventId,
  });
}
