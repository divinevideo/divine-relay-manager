// ABOUTME: Fetches aggregated stats for a Nostr user
// ABOUTME: Returns post count, report count, label count, and recent posts

import { useNostr } from "@nostrify/react";
import { useQuery } from "@tanstack/react-query";
import { useAppContext } from "@/hooks/useAppContext";
import { queryStrict, RelayReadError } from "@/lib/relayRead";
import { RECENT_CONTENT_KINDS } from "@/lib/constants";
import type { NostrEvent } from "@nostrify/nostrify";

export interface UserStats {
  postCount: number;
  reportCount: number;
  labelCount: number;
  recentPosts: NostrEvent[];
  existingLabels: NostrEvent[];
  previousReports: NostrEvent[];
  /** True when the authored-content read did not complete. */
  authoredContentIncomplete: boolean;
  /** True when the labels-against-this-user read did not complete. */
  labelsIncomplete: boolean;
  /** True when the reports-against-this-user read did not complete. */
  reportsIncomplete: boolean;
  /**
   * Aggregate compatibility signal for consumers that treat these stats as a
   * single unit. Read-specific consumers should use the flags above.
   */
  relayIncomplete: boolean;
}

export function useUserStats(pubkey: string | undefined) {
  const { nostr } = useNostr();
  const { config } = useAppContext();
  const relayUrl = config.relayUrl;

  return useQuery<UserStats>({
    // relayUrl in the key: the QueryClient is a singleton and these events are
    // shown as evidence, so a cached read must never cross environments.
    queryKey: ['user-stats', relayUrl, pubkey],
    queryFn: async ({ signal }) => {
      if (!pubkey) {
        return {
          postCount: 0,
          reportCount: 0,
          labelCount: 0,
          recentPosts: [],
          existingLabels: [],
          previousReports: [],
          authoredContentIncomplete: false,
          labelsIncomplete: false,
          reportsIncomplete: false,
          relayIncomplete: false,
        };
      }

      // queryStrict throws on anything short of a completed read (timeout, a
      // relay CLOSED, no route). We record that rather than rethrowing: this
      // hook has four other consumers whose behaviour is not in scope to change
      // here, so the failure is reported as a flag and only callers that state
      // absence to a user act on it. Promoting this to a real error is #210.
      const read = async (filters: Parameters<typeof queryStrict>[1]) => {
        try {
          return {
            events: await queryStrict(nostr, filters, { signal, timeoutMs: 8000 }),
            incomplete: false,
          };
        } catch (e) {
          // Only classify as a relay problem what queryStrict actually raises for
          // one. A TypeError from our own code would otherwise be reported to the
          // moderator as "relay error, retry" forever, with nothing logged.
          const isReadFailure =
            e instanceof RelayReadError || (e instanceof DOMException && e.name === 'AbortError');
          if (!isReadFailure) throw e;
          return { events: [], incomplete: true };
        }
      };

      // Fetch in parallel
      const [authoredContentRead, labelsRead, reportsRead] = await Promise.all([
        // User's recent authored content — RECENT_CONTENT_KINDS is shared with
        // BannedUserCard so the two review surfaces stay aligned (#159).
        read([{ kinds: [...RECENT_CONTENT_KINDS], authors: [pubkey], limit: 20 }]),
        // Labels against this user
        read([{ kinds: [1985], '#p': [pubkey], limit: 50 }]),
        // Reports against this user
        read([{ kinds: [1984], '#p': [pubkey], limit: 50 }]),
      ]);
      const recentPosts = authoredContentRead.events;
      const existingLabels = labelsRead.events;
      const previousReports = reportsRead.events;

      return {
        postCount: recentPosts.length, // Recent authored events of any queried kind (posts, comments, reposts) — not a total
        reportCount: previousReports.length,
        labelCount: existingLabels.length,
        recentPosts: recentPosts.sort((a, b) => b.created_at - a.created_at),
        existingLabels,
        previousReports,
        authoredContentIncomplete: authoredContentRead.incomplete,
        labelsIncomplete: labelsRead.incomplete,
        reportsIncomplete: reportsRead.incomplete,
        relayIncomplete:
          authoredContentRead.incomplete ||
          labelsRead.incomplete ||
          reportsRead.incomplete,
      };
    },
    enabled: !!pubkey,
    staleTime: 2 * 60_000, // Cache user stats for 2 minutes when switching between reports
  });
}
