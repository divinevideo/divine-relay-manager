// ABOUTME: Fetches complete thread context for a Nostr event
// ABOUTME: Tries REST → local WebSocket → external relay hint, with fetch status tracking

import { useNostr } from "@nostrify/react";
import { useQuery } from "@tanstack/react-query";
import type { NostrEvent } from "@nostrify/nostrify";
import { NRelay1 } from "@nostrify/nostrify";
import { fetchFunnelcakeEvent } from "@/lib/funnelcakeApi";

export type FetchSource = 'rest' | 'local-relay' | 'external-relay' | 'banned-fallback';

export interface ThreadResult {
  ancestors: NostrEvent[];  // ordered from root to parent
  event: NostrEvent | null;
  replies: NostrEvent[];
  repostedEvent: NostrEvent | null;
  isRepost: boolean;
  /** Where the main event was fetched from, or null if not found */
  fetchSource: FetchSource | null;
  /** If event wasn't found, the relay hint from the report (if any) */
  triedExternalRelay?: string;
}

// Kind 6 = repost of kind 1, Kind 16 = generic repost
const REPOST_KINDS = [6, 16];

/**
 * One-shot fetch from an external relay via WebSocket.
 * Opens a connection, sends one REQ, waits for EVENT or EOSE, then closes.
 * Short timeout since external relays may be slow or unreachable.
 */
async function fetchFromExternalRelay(
  relayUrl: string,
  eventId: string,
): Promise<NostrEvent | null> {
  const relay = new NRelay1(relayUrl);
  try {
    const timeout = AbortSignal.timeout(5000);
    const events = await relay.query(
      [{ ids: [eventId], limit: 1 }],
      { signal: timeout },
    );
    return events[0] || null;
  } catch {
    return null;
  } finally {
    relay.close();
  }
}

export function useThread(
  eventId: string | undefined,
  depth: number = 3,
  apiUrl?: string,
  relayHint?: string,
) {
  const { nostr } = useNostr();

  return useQuery<ThreadResult>({
    queryKey: ['thread', eventId, depth, apiUrl, relayHint],
    queryFn: async ({ signal }) => {
      if (!eventId) {
        return { ancestors: [], event: null, replies: [], repostedEvent: null, isRepost: false, fetchSource: null };
      }

      const timeout = AbortSignal.timeout(8000);
      const combinedSignal = AbortSignal.any([signal, timeout]);

      // Fetch the main event: REST → local WebSocket → external relay hint
      let event: NostrEvent | undefined;
      let fetchSource: FetchSource | null = null;

      // 1. Try REST (fastest)
      if (apiUrl) {
        const restEvent = await fetchFunnelcakeEvent(apiUrl, eventId);
        if (restEvent) {
          event = restEvent;
          fetchSource = 'rest';
        }
      }

      // 2. Try local relay via WebSocket
      if (!event) {
        const [wsEvent] = await nostr.query(
          [{ ids: [eventId], limit: 1 }],
          { signal: combinedSignal }
        );
        if (wsEvent) {
          event = wsEvent;
          fetchSource = 'local-relay';
        }
      }

      // 3. Try external relay hint (if provided and event still not found)
      if (!event && relayHint) {
        const externalEvent = await fetchFromExternalRelay(relayHint, eventId);
        if (externalEvent) {
          event = externalEvent;
          fetchSource = 'external-relay';
        }
      }

      if (!event) {
        return {
          ancestors: [], event: null, replies: [], repostedEvent: null, isRepost: false,
          fetchSource: null,
          triedExternalRelay: relayHint,
        };
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
            // Try external relay for repost original too
            if (!repostedEvent && relayHint) {
              repostedEvent = await fetchFromExternalRelay(relayHint, originalEventTag[1]);
            }
          }
        }
      }

      // Collect ancestor IDs from NIP-10 tags upfront
      const ancestorIds: string[] = [];
      const rootTag = event.tags.find(t => t[0] === 'e' && t[3] === 'root');
      const replyTag = event.tags.find(t => t[0] === 'e' && t[3] === 'reply');

      if (rootTag) ancestorIds.push(rootTag[1]);
      if (replyTag && replyTag[1] !== rootTag?.[1]) ancestorIds.push(replyTag[1]);

      // Fallback for events without NIP-10 markers: use positional e-tags
      if (ancestorIds.length === 0) {
        const eTags = event.tags.filter(t => t[0] === 'e');
        if (eTags.length > 0) {
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

      // Fetch ancestors: REST → local WS → external relay for any still missing
      let ancestorEvents: NostrEvent[] = [];
      const idsToFetch = ancestorIds.slice(0, depth);

      if (apiUrl && idsToFetch.length > 0) {
        const restResults = await Promise.all(
          idsToFetch.map(id => fetchFunnelcakeEvent(apiUrl, id))
        );
        ancestorEvents = restResults.filter((e): e is NostrEvent => e !== null);
      }

      if (ancestorEvents.length < idsToFetch.length) {
        const missingIds = idsToFetch.filter(id => !ancestorEvents.find(e => e.id === id));
        if (missingIds.length > 0) {
          const wsAncestors = await nostr.query(
            [{ ids: missingIds, limit: missingIds.length }],
            { signal: combinedSignal }
          );
          ancestorEvents = [...ancestorEvents, ...wsAncestors];
        }
      }

      // Try external relay for any ancestors still missing
      if (ancestorEvents.length < idsToFetch.length && relayHint) {
        const stillMissing = idsToFetch.filter(id => !ancestorEvents.find(e => e.id === id));
        const externalResults = await Promise.all(
          stillMissing.map(id => fetchFromExternalRelay(relayHint, id))
        );
        ancestorEvents = [...ancestorEvents, ...externalResults.filter((e): e is NostrEvent => e !== null)];
      }

      // Replies stay on WebSocket for now (Phase 2)
      const replies = await nostr.query(
        [{ kinds: [1], '#e': [eventId], limit: 20 }],
        { signal: combinedSignal }
      );

      // Order ancestors: root first, then reply
      const ancestorMap = new Map(ancestorEvents.map(e => [e.id, e]));
      const ancestors = idsToFetch
        .map(id => ancestorMap.get(id))
        .filter((e): e is NostrEvent => e !== undefined);

      return { ancestors, event, replies, repostedEvent, isRepost, fetchSource };
    },
    enabled: !!eventId,
    staleTime: 60_000,
  });
}
