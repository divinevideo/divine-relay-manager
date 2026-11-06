// ABOUTME: Fetches complete thread context for a Nostr event
// ABOUTME: Tries REST → local WebSocket → external relay hint, with fetch status tracking

import { useNostr } from "@nostrify/react";
import { useQuery } from "@tanstack/react-query";
import type { NostrEvent } from "@nostrify/nostrify";
import { NRelay1 } from "@nostrify/nostrify";
import { fetchFunnelcakeEvent } from "@/lib/funnelcakeApi";
import { isEventWithId, isRepostKind, verifiedRepostedEvent } from "@/lib/nip18";
import { buildThreadReplyFilters } from "@/lib/threadFilters";
import { isListKind } from "../../shared/list-report";

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
      const isRepost = isRepostKind(event.kind);

      if (isRepost) {
        const originalEventTag = event.tags.find(t => t[0] === 'e');
        if (originalEventTag) {
          // The media buttons act on the original's files, so the original counts
          // only when it is the event the e tag names, with a valid signature
          // (#337). The embedded copy is the reposter's writing, and a fetched
          // event is checked too, since the external relay hint is the
          // reporter's.
          const targetId = originalEventTag[1];
          const checked = (candidate: NostrEvent | null | undefined) =>
            (candidate && isEventWithId(candidate, targetId) ? { ...candidate, id: candidate.id.toLowerCase() } : null);
          repostedEvent = verifiedRepostedEvent(event);

          if (!repostedEvent) {
            if (apiUrl) {
              repostedEvent = checked(await fetchFunnelcakeEvent(apiUrl, targetId));
            }
            if (!repostedEvent) {
              const [fetchedOriginal] = await nostr.query(
                [{ ids: [targetId], limit: 1 }],
                { signal: combinedSignal }
              );
              repostedEvent = checked(fetchedOriginal);
            }
            // Try external relay for repost original too
            if (!repostedEvent && relayHint) {
              repostedEvent = checked(await fetchFromExternalRelay(relayHint, targetId));
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

      // Fallback for events without NIP-10 markers: use positional e-tags.
      // Not for a list: its e tags are its items, never a parent post.
      if (ancestorIds.length === 0 && !isListKind(event.kind)) {
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

      // A repost is not a reply, however its tags are marked: its e or E tag is
      // what it reposts, read above only once it checks out. Fetching it here as
      // a parent would bring back an original that did not, shown with the
      // author it claims.
      if (isRepost) ancestorIds.length = 0;

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

      // Replies stay on WebSocket for now (Phase 2). Includes NIP-10 kind-1
      // replies AND NIP-22 kind-1111 comments (scoped by root E/A tag) — Divine
      // comments are kind 1111, so kinds:[1] alone showed none (#164 B). A
      // single multi-filter REQ lets the relay union + dedupe.
      const replies = await nostr.query(
        buildThreadReplyFilters(event, 20),
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
