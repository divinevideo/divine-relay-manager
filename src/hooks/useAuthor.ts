// ABOUTME: Fetches author profile metadata for a pubkey
// ABOUTME: Tries Funnelcake REST API first for speed, falls back to WebSocket kind 0 query

import { type NostrEvent, type NostrMetadata, NSchema as n } from '@nostrify/nostrify';
import { useNostr } from '@nostrify/react';
import { useQuery } from '@tanstack/react-query';
import { fetchFunnelcakeUser } from '@/lib/funnelcakeApi';

export function useAuthor(pubkey: string | undefined, apiUrl?: string) {
  const { nostr } = useNostr();

  return useQuery<{ event?: NostrEvent; metadata?: NostrMetadata }>({
    queryKey: ['author', pubkey ?? '', apiUrl],
    queryFn: async ({ signal }) => {
      if (!pubkey) {
        return {};
      }

      // Try REST first for speed
      if (apiUrl) {
        const restResult = await fetchFunnelcakeUser(apiUrl, pubkey);
        if (restResult) {
          return { event: undefined, metadata: restResult.metadata as NostrMetadata };
        }
      }

      // Fall back to WebSocket
      const [event] = await nostr.query(
        [{ kinds: [0], authors: [pubkey!], limit: 1 }],
        { signal: AbortSignal.any([signal, AbortSignal.timeout(3000)]) },
      );

      if (!event) {
        throw new Error('No event found');
      }

      try {
        const metadata = n.json().pipe(n.metadata()).parse(event.content);
        return { metadata, event };
      } catch {
        return { event };
      }
    },
    retry: 1,
    staleTime: 5 * 60_000,
  });
}
