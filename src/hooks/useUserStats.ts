// ABOUTME: Fetches aggregated stats for a Nostr user
// ABOUTME: Returns post count, report count, label count, and recent posts

import { useNostr } from "@nostrify/react";
import { useQuery } from "@tanstack/react-query";
import { useAppContext } from "@/hooks/useAppContext";
import { RECENT_CONTENT_KINDS } from "@/lib/constants";
import type { NostrEvent } from "@nostrify/nostrify";

export interface UserStats {
  postCount: number;
  reportCount: number;
  labelCount: number;
  recentPosts: NostrEvent[];
  existingLabels: NostrEvent[];
  previousReports: NostrEvent[];
  /**
   * True when the relay read was cut short by our timeout, so the counts below
   * are a floor rather than a fact. `NPool.query` resolves with partial results
   * instead of throwing, so without this a dead relay is indistinguishable from
   * an empty account. Reported as a flag rather than a thrown error to keep this
   * shared hook's behaviour unchanged for its other consumers; callers that
   * state absence to a user (age review) must check it.
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
          relayIncomplete: false,
        };
      }

      const timeout = AbortSignal.timeout(8000);
      const combinedSignal = AbortSignal.any([signal, timeout]);

      // Fetch in parallel
      const [recentPosts, existingLabels, previousReports] = await Promise.all([
        // User's recent authored content — RECENT_CONTENT_KINDS is shared with
        // BannedUserCard so the two review surfaces stay aligned (#159).
        nostr.query(
          [{ kinds: [...RECENT_CONTENT_KINDS], authors: [pubkey], limit: 20 }],
          { signal: combinedSignal }
        ),
        // Labels against this user
        nostr.query(
          [{ kinds: [1985], '#p': [pubkey], limit: 50 }],
          { signal: combinedSignal }
        ),
        // Reports against this user
        nostr.query(
          [{ kinds: [1984], '#p': [pubkey], limit: 50 }],
          { signal: combinedSignal }
        ),
      ]);

      return {
        postCount: recentPosts.length, // Recent authored events of any queried kind (posts, comments, reposts) — not a total
        reportCount: previousReports.length,
        labelCount: existingLabels.length,
        recentPosts: recentPosts.sort((a, b) => b.created_at - a.created_at),
        existingLabels,
        previousReports,
        // Our timeout fired rather than the query being cancelled upstream, so
        // the relay did not finish answering and these counts understate.
        relayIncomplete: timeout.aborted && !signal.aborted,
      };
    },
    enabled: !!pubkey,
    staleTime: 2 * 60_000, // Cache user stats for 2 minutes when switching between reports
  });
}
