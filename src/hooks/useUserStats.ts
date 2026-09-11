// ABOUTME: Fetches aggregated stats for a Nostr user
// ABOUTME: Returns post count, report count, label count, and recent posts

import { useNostr } from "@nostrify/react";
import { useQuery } from "@tanstack/react-query";
import { useAppContext } from "@/hooks/useAppContext";
import { queryStrict, readWithCompleteness } from "@/lib/relayRead";
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

      // An incomplete read (timeout, a relay CLOSED, no route) is recorded as a
      // per-read `incomplete` flag rather than rethrown, and every consumer that
      // states absence to a moderator honors it (AgeReviewContent, UserProfileCard,
      // and UserStatsRow in EventDetail) by showing an honest unknown in place of a
      // confident count. #210 settled on this over promoting the flag to a thrown
      // error, which would discard partial data and regress the flag-based
      // age-review surface that already reads these flags off `data`.
      const read = (filters: Parameters<typeof queryStrict>[1]) =>
        readWithCompleteness(nostr, filters, { signal, timeoutMs: 8000 });

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
