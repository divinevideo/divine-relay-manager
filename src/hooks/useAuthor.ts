// ABOUTME: Fetches author profile metadata for a pubkey
// ABOUTME: Tries Funnelcake REST API first for speed, falls back to WebSocket kind 0 query

import { type NostrEvent, type NostrMetadata, NSchema as n } from '@nostrify/nostrify';
import { useNostr } from '@nostrify/react';
import { useQuery } from '@tanstack/react-query';
import { fetchFunnelcakeUser } from '@/lib/funnelcakeApi';

export function useAuthor(pubkey: string | undefined, apiUrl?: string) {
  const { nostr } = useNostr();

  return useQuery<{ event?: NostrEvent; metadata?: NostrMetadata; isFunnelcakeUser: boolean }>({
    queryKey: ['author', pubkey ?? ''],
    queryFn: async ({ signal }) => {
      if (!pubkey) {
        return { isFunnelcakeUser: false };
      }

      // Try REST first for speed
      if (apiUrl) {
        const restResult = await fetchFunnelcakeUser(apiUrl, pubkey);
        if (restResult) {
          return { event: undefined, metadata: restResult.metadata as NostrMetadata, isFunnelcakeUser: true };
        }
      }

      // Fall back to WebSocket
      const [event] = await nostr.query(
        [{ kinds: [0], authors: [pubkey!], limit: 1 }],
        { signal: AbortSignal.any([signal, AbortSignal.timeout(5000)]) },
      );

      if (!event) {
        // No kind 0 metadata event — user exists but hasn't published a profile.
        // Return empty rather than throwing, to avoid error states in profile cards.
        return { isFunnelcakeUser: false };
      }

      try {
        const metadata = n.json().pipe(n.metadata()).parse(event.content);
        return { metadata, event, isFunnelcakeUser: false };
      } catch {
        return { event, isFunnelcakeUser: false };
      }
    },
    retry: 1, // Most failures are missing profiles, not transient errors
    staleTime: 5 * 60_000, // Cache author profiles for 5 minutes
  });
}
