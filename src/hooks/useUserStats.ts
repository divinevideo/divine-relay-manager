// ABOUTME: Fetches aggregated stats for a Nostr user
// ABOUTME: Returns post count, report count, label count, and recent posts

import { useNostr } from "@nostrify/react";
import { useQuery } from "@tanstack/react-query";
import type { NostrEvent } from "@nostrify/nostrify";

export const USER_STATS_LIMITS = {
  recentPosts: 20,
  existingLabels: 50,
  previousReports: 50,
} as const;

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
        // User's recent posts (text notes, video events, and other content)
        // Video kinds per NIP-71: 21 (Video), 22 (Short Video), 34235 (Addressable Video), 34236 (Addressable Short Video)
        nostr.query(
          [{ kinds: [1, 21, 22, 1063, 1064, 20, 30023, 34235, 34236], authors: [pubkey], limit: 20 }],
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
