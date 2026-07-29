// ABOUTME: Resolves the content a kind-1984 report is about, for the age-review
// ABOUTME: case pane. `report_id` is the REPORT's id, not the content's, so this
// ABOUTME: is a two-hop lookup: fetch the report, read its target from the tags,
// ABOUTME: then fetch that event (with a getbannedevent fallback when banned).
import { useQuery } from "@tanstack/react-query";
import type { NostrEvent } from "@nostrify/nostrify";
import { useNostr } from "@/hooks/useNostr";
import { useAdminApi, useApiUrl } from "@/hooks/useAdminApi";
import { useAppContext } from "@/hooks/useAppContext";
import { isHex64 } from "@/lib/constants";
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
  /** The id resolved to something that is not a report, so its tags mean nothing here. */
  | { status: "not_a_report" }
  /** The report carries an `e` tag we cannot parse, so its target is unknown. */
  | { status: "target_unreadable" }
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
      // be worse than saying so. Distinct from report_missing: the event is
      // there, it just is not a report.
      if (report.kind !== REPORT_KIND) return { status: "not_a_report" };

      // Hop 2: what the report points at. Under-16 cases are filed against the
      // account (a `p` tag and no `e` tag), so there is no single post to show.
      // A report may carry more than one `e` tag (a threaded reply also tags its
      // root, a repost its original), so consider all of them rather than
      // declaring the first one foreign and hiding the real target.
      const targetIds = report.tags
        .filter((t) => t[0] === "e" && isHex64(t[1]))
        .map((t) => t[1]);
      if (targetIds.length === 0) {
        // An `e` tag we could not parse is not the same as no `e` tag at all:
        // saying "filed against the account" would be a claim about the report.
        return report.tags.some((t) => t[0] === "e")
          ? { status: "target_unreadable" }
          : { status: "account_level" };
      }

      const events = await queryStrict(nostr, [{ ids: targetIds }], { signal, timeoutMs: HOP_TIMEOUT_MS });
      if (events.length > 0) {
        // NIP-56 does not require the reported event to be authored by the
        // reported pubkey, and case creation does not check it, so a mis-filed
        // or crafted report can point at a stranger's post. Showing that as this
        // account's "reported content" would put a moderator's age judgement on
        // the wrong person's video. Prefer a tagged event this account actually
        // wrote; only if none of them is do we treat the report as mis-targeted.
        const own = casePubkey ? events.find((e) => e.pubkey === casePubkey) : events[0];
        if (own) return { status: "found", event: own, banned: false };
        return { status: "target_foreign", targetEventId: events[0].id, authorPubkey: events[0].pubkey };
      }

      // Not publicly readable. It may be banned, which admins can still fetch.
      try {
        const banned = await callRelayRpc<NostrEvent>("getbannedevent", [targetIds[0]]);
        // Shape-check before trusting it: a malformed response would otherwise
        // fail the author comparison and then crash the render on .slice().
        if (banned && isHex64(banned.pubkey)) {
          if (casePubkey && banned.pubkey !== casePubkey) {
            return { status: "target_foreign", targetEventId: targetIds[0], authorPubkey: banned.pubkey };
          }
          return { status: "found", event: banned, banned: true };
        }
      } catch (e) {
        // Only "the relay says it is not banned" is a real negative. Transport,
        // auth, and unknown failures propagate, so the pane shows an error
        // rather than asserting the content was deleted.
        if (!isDefinitiveRpcNegative(e)) throw e;
      }

      return { status: "target_missing", targetEventId: targetIds[0] };
    },
    enabled: !!reportId,
    staleTime: 60_000,
  });
}
