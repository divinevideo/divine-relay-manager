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
  /**
   * The report points at an event authored by someone other than this case's
   * subject. The event is carried so the pane can still show it, labelled, since
   * hiding it would lose evidence a moderator may legitimately need (a report
   * about a repost can name the original, which a third party authored). The
   * author is read from the event itself, so the label and the byline cannot
   * disagree.
   */
  | { status: "target_foreign"; event: NostrEvent; banned: boolean };

// Per hop, not shared: a single budget across both hops meant a healthy but slow
// relay got roughly half the time the pre-two-hop lookup had.
const HOP_TIMEOUT_MS = 5000;

const REPORT_KIND = 1984;

// A NIP-56 report names one target. The list is untrusted input and each
// unresolved id costs a signed management request, so cap it.
const MAX_TARGET_IDS = 4;

/**
 * Whether a management-API result is shaped well enough to render. The RPC
 * result is unvalidated `unknown` at the type level, and ContentCard reads
 * `pubkey`, `kind`, `created_at` and `content` directly, so a malformed
 * response would otherwise crash the pane during render (an object in
 * `content` throws "Objects are not valid as a React child").
 */
function isRenderableEvent(value: unknown): value is NostrEvent {
  if (!value || typeof value !== "object") return false;
  const e = value as Partial<NostrEvent>;
  return (
    isHex64(e.pubkey) &&
    isHex64(e.id) &&
    typeof e.kind === "number" &&
    typeof e.created_at === "number" &&
    typeof e.content === "string" &&
    Array.isArray(e.tags)
  );
}

export function useReportedEvent(reportId: string | undefined, casePubkey: string | undefined) {
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
      // Hex is compared lowercased throughout: isHex64 accepts either case and
      // the case pubkey is stored verbatim from the reporter's `p` tag, so a
      // non-canonical client could otherwise make an account look foreign to
      // its own post.
      const targetIds = report.tags
        .filter((t) => t[0] === "e" && isHex64(t[1]))
        .map((t) => t[1].toLowerCase());
      if (targetIds.length === 0) {
        // An `e` tag we could not parse is not the same as no `e` tag at all:
        // saying "filed against the account" would be a claim about the report.
        return report.tags.some((t) => t[0] === "e")
          ? { status: "target_unreadable" }
          : { status: "account_level" };
      }
      const subject = casePubkey?.toLowerCase();
      // Deduped and capped. The tag list comes from an untrusted event: anyone
      // can publish a report, and each unresolved id below costs a signed
      // management request. A NIP-56 report names one target, so a handful is
      // already generous, and the cap keeps a hostile report from turning one
      // case-open into hundreds of RPCs.
      const uniqueIds = [...new Set(targetIds)].slice(0, MAX_TARGET_IDS);

      const events = await queryStrict(nostr, [{ ids: uniqueIds }], { signal, timeoutMs: HOP_TIMEOUT_MS });
      // Keyed by id so selection can walk tag order rather than relay arrival
      // order, and so the banned results below join the same ordering.
      const resolved = new Map<string, { event: NostrEvent; banned: boolean }>();
      for (const e of events) resolved.set(e.id.toLowerCase(), { event: e, banned: false });

      // NIP-56 does not require the reported event to be authored by the reported
      // pubkey, and case creation does not check it, so a mis-filed report can
      // name a third party's post. Prefer one this account actually wrote, taking
      // the earliest such tag.
      const pickSubjectOwned = () => {
        for (const id of uniqueIds) {
          const hit = resolved.get(id);
          if (hit && (!subject || hit.event.pubkey.toLowerCase() === subject)) return hit;
        }
      };

      const ownReadable = pickSubjectOwned();
      if (ownReadable) return { status: "found", event: ownReadable.event, banned: ownReadable.banned };

      // Anything not publicly readable may be banned, which admins can still
      // fetch. This runs even when another tagged event was readable: skipping it
      // would silently disable the banned-content path this feature exists for.
      for (const id of uniqueIds.filter((i) => !resolved.has(i))) {
        // callRelayRpc takes no signal and each call can run for 30s, so check
        // between iterations: without this the loop keeps issuing signed requests
        // after the moderator has moved to another case.
        if (signal.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError");
        try {
          const banned = await callRelayRpc<NostrEvent>("getbannedevent", [id]);
          if (isRenderableEvent(banned)) resolved.set(id, { event: banned, banned: true });
        } catch (e) {
          // Only "the relay says it is not banned" is a real negative. Transport,
          // auth, and unknown failures propagate, so the pane shows an error
          // rather than asserting the content was deleted.
          if (!isDefinitiveRpcNegative(e)) throw e;
        }
      }

      const own = pickSubjectOwned();
      if (own) return { status: "found", event: own.event, banned: own.banned };

      // Nothing the subject authored. Show what the report does name, labelled,
      // rather than hiding it: a report about a repost legitimately names the
      // original, and a moderator may need to see it. Tag order again, so a
      // banned first tag is not passed over for a readable second one.
      for (const id of uniqueIds) {
        const hit = resolved.get(id);
        if (hit) return { status: "target_foreign", event: hit.event, banned: hit.banned };
      }

      return { status: "target_missing", targetEventId: uniqueIds[0] };
    },
    enabled: !!reportId,
    staleTime: 60_000,
  });
}
