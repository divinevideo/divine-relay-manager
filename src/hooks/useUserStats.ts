// ABOUTME: Fetches aggregated stats for a Nostr user
// ABOUTME: Returns post count, report count, label count, and recent posts

import { useNostr } from "@nostrify/react";
import { useQuery } from "@tanstack/react-query";
import type { NostrEvent } from "@nostrify/nostrify";

export interface UserStats {
  postCount: number;
  reportCount: number;
  labelCount: number;
  recentPosts: NostrEvent[];
  existingLabels: NostrEvent[];
  previousReports: NostrEvent[];
}

export function useUserStats(pubkey: string | undefined) {
  const { nostr } = useNostr();

  return useQuery<UserStats>({
    queryKey: ['user-stats', pubkey],
    queryFn: async ({ signal }) => {
      if (!pubkey) {
        return {
          postCount: 0,
          reportCount: 0,
          labelCount: 0,
          recentPosts: [],
          existingLabels: [],
          previousReports: [],
        };
      }

      const timeout = AbortSignal.timeout(8000);
      const combinedSignal = AbortSignal.any([signal, timeout]);

      // Fetch in parallel
      const [recentPosts, existingLabels, previousReports] = await Promise.all([
        // User's recent posts
        nostr.query(
          [{ kinds: [1], authors: [pubkey], limit: 10 }],
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
        postCount: recentPosts.length, // Note: This is just recent, not total
        reportCount: previousReports.length,
        labelCount: existingLabels.length,
        recentPosts: recentPosts.sort((a, b) => b.created_at - a.created_at),
        existingLabels,
        previousReports,
      };
    },
    enabled: !!pubkey,
  });
}
