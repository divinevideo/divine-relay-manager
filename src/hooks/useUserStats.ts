// ABOUTME: Fetches aggregated stats for a Nostr user
// ABOUTME: Returns post count, report count, label count, and recent posts

import { useNostr } from "@nostrify/react";
import { useQuery } from "@tanstack/react-query";
import { useAppContext } from "@/hooks/useAppContext";
import { queryStrict } from "@/lib/relayRead";
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

      // queryStrict throws on anything short of a completed read (timeout, a
      // relay CLOSED, no route). We record that rather than rethrowing: this
      // hook has four other consumers whose behaviour is not in scope to change
      // here, so the failure is reported as a flag and only callers that state
      // absence to a user act on it. Promoting this to a real error is #210.
      let incomplete = false;
      const read = async (filters: Parameters<typeof queryStrict>[1]) => {
        try {
          return await queryStrict(nostr, filters, { signal, timeoutMs: 8000 });
        } catch {
          incomplete = true;
          return [];
        }
      };

      // Fetch in parallel
      const [recentPosts, existingLabels, previousReports] = await Promise.all([
        // User's recent authored content — RECENT_CONTENT_KINDS is shared with
        // BannedUserCard so the two review surfaces stay aligned (#159).
        read([{ kinds: [...RECENT_CONTENT_KINDS], authors: [pubkey], limit: 20 }]),
        // Labels against this user
        read([{ kinds: [1985], '#p': [pubkey], limit: 50 }]),
        // Reports against this user
        read([{ kinds: [1984], '#p': [pubkey], limit: 50 }]),
      ]);

      return {
        postCount: recentPosts.length, // Recent authored events of any queried kind (posts, comments, reposts) — not a total
        reportCount: previousReports.length,
        labelCount: existingLabels.length,
        recentPosts: recentPosts.sort((a, b) => b.created_at - a.created_at),
        existingLabels,
        previousReports,
        // At least one read did not finish, so these counts are a floor, not a
        // fact, and a zero here proves nothing about the account.
        relayIncomplete: incomplete,
      };
    },
    enabled: !!pubkey,
    staleTime: 2 * 60_000, // Cache user stats for 2 minutes when switching between reports
  });
}
