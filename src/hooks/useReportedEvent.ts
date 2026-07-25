// ABOUTME: Fetches the reported event by id for the age-review case — normal relay
// ABOUTME: query first, then a getbannedevent fallback so a banned/removed reported
// ABOUTME: event still shows to moderators. Mirrors EventsList's direct-lookup path.
import { useQuery } from "@tanstack/react-query";
import type { NostrEvent } from "@nostrify/nostrify";
import { useNostr } from "@/hooks/useNostr";
import { useAdminApi, useApiUrl } from "@/hooks/useAdminApi";

export interface ReportedEventResult {
  event: NostrEvent;
  banned: boolean;
}

export function useReportedEvent(eventId: string | undefined) {
  const { nostr } = useNostr();
  const { callRelayRpc } = useAdminApi();
  // Environment id in the key: the QueryClient is a singleton while the relay
  // swaps per environment, so without it a repeat lookup could serve another
  // environment's result within the staleTime window (same caution as EventsList).
  const apiUrl = useApiUrl();

  return useQuery<ReportedEventResult | null>({
    queryKey: ["reported-event", apiUrl, eventId],
    queryFn: async ({ signal }) => {
      if (!eventId) return null;
      const timeoutSignal = AbortSignal.any([signal, AbortSignal.timeout(5000)]);
      // Relay-visible first.
      const events = await nostr.query([{ ids: [eventId] }], { signal: timeoutSignal });
      if (events[0]) return { event: events[0], banned: false };
      // Fallback: retrieve it via the management API if it was banned/removed.
      try {
        const banned = await callRelayRpc<NostrEvent>("getbannedevent", [eventId]);
        if (banned) return { event: banned, banned: true };
      } catch {
        // not banned, or the RPC failed — treat as not found
      }
      return null;
    },
    enabled: !!eventId,
    staleTime: 60_000,
  });
}
