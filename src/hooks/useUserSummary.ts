// ABOUTME: Fetches AI-generated behavioral summary for a user
// ABOUTME: Calls worker endpoint that uses Claude API

import { useQuery } from "@tanstack/react-query";
import type { NostrEvent } from "@nostrify/nostrify";
import { getApiHeaders } from "@/lib/adminApi";
import { useApiUrl } from "@/hooks/useAdminApi";
import { parseRepostForDisplay } from "@/lib/nip18";

interface SummaryResponse {
  summary: string;
  riskLevel: 'low' | 'medium' | 'high' | 'critical';
}

// The moderator-facing history is now complete (useUserStats pages past the
// old 50 cap), but the AI prompt must not grow with it: a larger prompt costs
// more and the summarizer never needed more than the newest reports/labels.
// Kept at the size the prompt always had.
export const SUMMARY_HISTORY_LIMIT = 50;

// Newest N by created_at, without assuming or mutating the caller's order —
// previousReports/existingLabels are shared with useUserStats' cache.
function newestFirst<T extends { created_at: number }>(events: T[] | undefined, limit: number): T[] {
  return [...(events ?? [])].sort((a, b) => b.created_at - a.created_at).slice(0, limit);
}

export function useUserSummary(
  pubkey: string | undefined,
  recentPosts: NostrEvent[] | undefined,
  existingLabels: NostrEvent[] | undefined,
  previousReports: NostrEvent[] | undefined
) {
  const apiUrl = useApiUrl();
  return useQuery<SummaryResponse>({
    queryKey: ['user-summary', pubkey],
    queryFn: async () => {
      if (!pubkey || !recentPosts) {
        throw new Error('Missing required data');
      }

      const response = await fetch(`${apiUrl}/api/summarize-user`, {
        method: 'POST',
        headers: getApiHeaders(),
        body: JSON.stringify({
          pubkey,
          recentPosts: recentPosts.slice(0, 10).map(e => {
            // Shared display derivation (parseRepostForDisplay): reposts send
            // the inner text, never raw NIP-18 JSON. An empty-content repost
            // falls back to its target label.
            const display = parseRepostForDisplay(e);
            const content = display.isRepost
              ? (display.displayContent
                || `[reposted ${display.targetDescription ?? 'unknown target'}]`)
              : display.displayContent;
            return {
              content,
              created_at: e.created_at,
              // Kind lets the summarizer distinguish authored posts from
              // comments (1111) and reposts of others' content (6/16) — see #156
              kind: e.kind,
            };
          }),
          existingLabels: newestFirst(existingLabels, SUMMARY_HISTORY_LIMIT).map(e => ({
            tags: e.tags,
            created_at: e.created_at,
          })),
          reportHistory: newestFirst(previousReports, SUMMARY_HISTORY_LIMIT).map(e => ({
            content: e.content,
            tags: e.tags,
            created_at: e.created_at,
          })),
        }),
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      return response.json();
    },
    enabled: !!pubkey && !!recentPosts && recentPosts.length > 0,
    staleTime: 1000 * 60 * 60, // Cache for 1 hour
    retry: false, // Don't retry AI calls
  });
}
