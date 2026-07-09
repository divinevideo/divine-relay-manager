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
            // the inner text, never raw NIP-18 JSON; kind-1064 base64 (direct
            // or smuggled through a repost) is replaced with a marker so the
            // AI prompt isn't fed file bytes as authored posts.
            const display = parseRepostForDisplay(e);
            const content = display.isRepost
              ? (display.displayContent
                || `[reposted ${display.targetDescription ?? 'unknown target'}]`)
              : display.contentSuppressed ? '[file data]' : display.displayContent;
            return {
              content,
              created_at: e.created_at,
              // Kind lets the summarizer distinguish authored posts from
              // comments (1111) and reposts of others' content (6/16) — see #156
              kind: e.kind,
            };
          }),
          existingLabels: existingLabels?.map(e => ({
            tags: e.tags,
            created_at: e.created_at,
          })) || [],
          reportHistory: previousReports?.map(e => ({
            content: e.content,
            tags: e.tags,
            created_at: e.created_at,
          })) || [],
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
