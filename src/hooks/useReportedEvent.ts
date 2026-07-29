// ABOUTME: Resolves the content a kind-1984 report is about, for the age-review
// ABOUTME: case pane. `report_id` is the REPORT's id, not the content's, so this
// ABOUTME: is a two-hop lookup: fetch the report, read its target from the tags,
// ABOUTME: then fetch that event (with a getbannedevent fallback when banned).
import { useQuery } from "@tanstack/react-query";
import type { NostrEvent } from "@nostrify/nostrify";
import { useNostr } from "@/hooks/useNostr";
import { useAdminApi, useApiUrl } from "@/hooks/useAdminApi";
import { useAppContext } from "@/hooks/useAppContext";
import { getReportTargetIds } from "@/lib/constants";
import { assertRelayReadCompleted, isDefinitiveRpcNegative } from "@/lib/relayRead";

/**
 * Every outcome is named, so the UI never has to infer a reason from a bare
 * null. `target_missing` means we asked and the event is genuinely not
 * retrievable; a read that failed throws instead and surfaces as a query error.
 */
export type ReportedEventResult =
  | { status: "found"; event: NostrEvent; banned: boolean }
  | { status: "account_level" }
  | { status: "target_missing"; targetEventId: string }
  | { status: "report_missing" };

const READ_TIMEOUT_MS = 5000;

export function useReportedEvent(reportId: string | undefined) {
  const { nostr } = useNostr();
  const { callRelayRpc } = useAdminApi();
  // Both the relay and the management API change with the environment, and the
  // QueryClient is a singleton, so both belong in the key or a repeat lookup
  // could serve another environment's result inside the staleTime window.
  const apiUrl = useApiUrl();
  const { config } = useAppContext();
  const relayUrl = config.relayUrl;

  return useQuery<ReportedEventResult>({
    queryKey: ["reported-event", apiUrl, relayUrl, reportId],
    queryFn: async ({ signal }) => {
      const timeout = AbortSignal.timeout(READ_TIMEOUT_MS);
      const combined = AbortSignal.any([signal, timeout]);

      // Hop 1: the kind-1984 report itself. `report_id` is written from the
      // report event's own id (ReportWatcher), not from what it reports on.
      const reports = await nostr.query([{ ids: [reportId!] }], { signal: combined });
      assertRelayReadCompleted(timeout, signal);
      const report = reports[0];
      if (!report) return { status: "report_missing" };

      // Hop 2: what the report points at. Under-16 cases are filed against the
      // account (a `p` tag and no `e` tag), so there is no single post to show.
      const { eventId } = getReportTargetIds(report);
      if (!eventId) return { status: "account_level" };

      const events = await nostr.query([{ ids: [eventId] }], { signal: combined });
      assertRelayReadCompleted(timeout, signal);
      if (events[0]) return { status: "found", event: events[0], banned: false };

      // Not publicly readable. It may be banned, which admins can still fetch.
      try {
        const banned = await callRelayRpc<NostrEvent>("getbannedevent", [eventId]);
        if (banned) return { status: "found", event: banned, banned: true };
      } catch (e) {
        // Only "the relay says it is not banned" is a real negative. Transport,
        // auth, and unknown failures propagate, so the pane shows an error
        // rather than asserting the content was deleted.
        if (!isDefinitiveRpcNegative(e)) throw e;
      }

      return { status: "target_missing", targetEventId: eventId };
    },
    enabled: !!reportId,
    staleTime: 60_000,
  });
}
