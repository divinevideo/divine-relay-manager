// ABOUTME: Fetches AI-generated behavioral summary for a user
// ABOUTME: Calls worker endpoint that uses Claude API

import { useQuery } from "@tanstack/react-query";
import type { NostrEvent } from "@nostrify/nostrify";
import { useApiUrl } from "@/hooks/useAdminApi";

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
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          pubkey,
          recentPosts: recentPosts.slice(0, 10).map(e => ({
            content: e.content,
            created_at: e.created_at,
          })),
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
