// ABOUTME: Shared read of the relay's listeventsneedingmoderation recent-events window.
// ABOUTME: That NIP-86 method sorts the whole events table, so it is cached long and never polled.

import { useQuery } from "@tanstack/react-query";
import { useAdminApi } from "@/hooks/useAdminApi";

export interface EventNeedingModeration {
  id: string;
  reason?: string;
}

// The relay returns the newest 100 non-banned events here; it records no approvals,
// so this is a "recent events" window, not a true pending queue.

// The relay answers this with a full scan of events_local (sorted by created_at
// for the newest 100), so every call is expensive. Ten minutes keeps a tab
// remount from re-running it; moderators who need it fresher use an explicit
// refetch. Window focus and polling are off for the same reason.
export const EVENTS_NEEDING_MODERATION_STALE_MS = 10 * 60 * 1000;

export function eventsNeedingModerationKey(relayUrl: string | undefined) {
  return ['events-needing-moderation', relayUrl] as const;
}

export function useEventsNeedingModeration(relayUrl: string | undefined) {
  const { callRelayRpc } = useAdminApi();
  return useQuery({
    queryKey: eventsNeedingModerationKey(relayUrl),
    queryFn: () => callRelayRpc<EventNeedingModeration[]>('listeventsneedingmoderation'),
    enabled: !!relayUrl,
    staleTime: EVENTS_NEEDING_MODERATION_STALE_MS,
    // A failed full scan is not retried, and a reconnect does not rerun it.
    retry: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    refetchInterval: false,
  });
}
