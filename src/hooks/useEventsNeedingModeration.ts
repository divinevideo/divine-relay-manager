// ABOUTME: Shared read of the relay's listeventsneedingmoderation recent-events window.
// ABOUTME: That NIP-86 method sorts the events table, so repeat reads are explicit.

import { useQuery } from "@tanstack/react-query";
import { useAdminApi } from "@/hooks/useAdminApi";

export interface EventNeedingModeration {
  id: string;
  reason?: string;
}

export function useEventsNeedingModeration(relayUrl: string | undefined) {
  const { callRelayRpc } = useAdminApi();
  return useQuery({
    queryKey: ['events-needing-moderation', relayUrl],
    queryFn: () => callRelayRpc<EventNeedingModeration[]>('listeventsneedingmoderation'),
    // The first visit starts one read. After it settles, only an explicit
    // refetch should scan again, even if another screen invalidates the cache.
    enabled: query => !!relayUrl && query.state.status === 'pending',
    retry: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    refetchInterval: false,
  });
}
