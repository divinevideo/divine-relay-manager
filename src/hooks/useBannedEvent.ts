// ABOUTME: Hook to fetch a banned event's content via getbannedevent management RPC
// ABOUTME: Used as fallback when normal relay queries return nothing for banned events

import { useQuery } from "@tanstack/react-query";
import { useAdminApi } from "@/hooks/useAdminApi";
import type { NostrEvent } from "@nostrify/nostrify";

/**
 * Fetch a banned event's content via the getbannedevent management RPC.
 * Only calls the API when enabled (i.e., when normal event lookup failed
 * and we suspect the event is banned).
 */
export function useBannedEvent(eventId: string | undefined, enabled: boolean) {
  const { callRelayRpc } = useAdminApi();

  return useQuery<NostrEvent | null>({
    queryKey: ['banned-event', eventId],
    queryFn: async () => {
      if (!eventId) return null;
      try {
        return await callRelayRpc<NostrEvent>('getbannedevent', [eventId]);
      } catch {
        return null;
      }
    },
    enabled: enabled && !!eventId,
    staleTime: 5 * 60 * 1000,
  });
}
