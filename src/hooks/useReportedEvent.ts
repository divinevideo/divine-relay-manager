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
import { queryStrict, isDefinitiveRpcNegative } from "@/lib/relayRead";

/**
 * Every outcome is named, so the UI never has to infer a reason from a bare
 * null. A read that failed throws instead of returning one of these, so a
 * "missing" answer here always means we asked and got a real answer.
 */
export type ReportedEventResult =
  | { status: "found"; event: NostrEvent; banned: boolean }
  | { status: "account_level" }
  | { status: "target_missing"; targetEventId: string }
  | { status: "report_missing" }
  /** The report points at an event authored by someone other than this case's subject. */
  | { status: "target_foreign"; targetEventId: string; authorPubkey: string };

// Per hop, not shared: a single budget across both hops meant a healthy but slow
// relay got roughly half the time the pre-two-hop lookup had.
const HOP_TIMEOUT_MS = 5000;

const REPORT_KIND = 1984;

export function useReportedEvent(reportId: string | undefined, casePubkey?: string) {
  const { nostr } = useNostr();
  const { callRelayRpc } = useAdminApi();
  // Both the relay and the management API change with the environment, and the
  // QueryClient is a singleton, so both belong in the key or a repeat lookup
  // could serve another environment's result inside the staleTime window.
  const apiUrl = useApiUrl();
  const { config } = useAppContext();
  const relayUrl = config.relayUrl;

  return useQuery<ReportedEventResult>({
    queryKey: ["reported-event", apiUrl, relayUrl, reportId, casePubkey],
    queryFn: async ({ signal }) => {
      // Hop 1: the kind-1984 report itself. `report_id` is written from the
      // report event's own id (ReportWatcher), not from what it reports on.
      const reports = await queryStrict(nostr, [{ ids: [reportId!] }], { signal, timeoutMs: HOP_TIMEOUT_MS });
      const report = reports[0];
      if (!report) return { status: "report_missing" };
      // Only a report's tags describe a report target. Anything else with this
      // id is not something we can interpret, and guessing from its tags would
      // be worse than saying so.
      if (report.kind !== REPORT_KIND) return { status: "report_missing" };

      // Hop 2: what the report points at. Under-16 cases are filed against the
      // account (a `p` tag and no `e` tag), so there is no single post to show.
      const { eventId } = getReportTargetIds(report);
      if (!eventId) return { status: "account_level" };

      const events = await queryStrict(nostr, [{ ids: [eventId] }], { signal, timeoutMs: HOP_TIMEOUT_MS });
      const target = events[0];
      if (target) {
        // NIP-56 does not require the reported event to be authored by the
        // reported pubkey, and case creation does not check it, so a mis-filed
        // or crafted report can point at a stranger's post. Showing that as this
        // account's "reported content" would put a moderator's age judgement on
        // the wrong person's video.
        if (casePubkey && target.pubkey !== casePubkey) {
          return { status: "target_foreign", targetEventId: eventId, authorPubkey: target.pubkey };
        }
        return { status: "found", event: target, banned: false };
      }

      // Not publicly readable. It may be banned, which admins can still fetch.
      try {
        const banned = await callRelayRpc<NostrEvent>("getbannedevent", [eventId]);
        if (banned) {
          if (casePubkey && banned.pubkey !== casePubkey) {
            return { status: "target_foreign", targetEventId: eventId, authorPubkey: banned.pubkey };
          }
          return { status: "found", event: banned, banned: true };
        }
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
