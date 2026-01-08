// ABOUTME: Hook to fetch and manage moderation decision history
// ABOUTME: Tracks what actions have been taken on report targets

import { useQuery } from "@tanstack/react-query";
import { useAdminApi } from "@/hooks/useAdminApi";
import type { ModerationDecision } from "@/lib/adminApi";

export function useDecisionLog(targetId: string | null | undefined) {
  const { getDecisions } = useAdminApi();

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['decisions', targetId],
    queryFn: async () => {
      if (!targetId) return [];
      return getDecisions(targetId);
    },
    enabled: !!targetId,
  });

  // Check if target has any decisions
  const hasDecisions = (data?.length ?? 0) > 0;

  // Get the most recent decision
  const latestDecision = data?.[0];

  // Check for specific action types
  const isBanned = data?.some(d => d.action === 'ban_user' || d.action === 'ban');
  const isDeleted = data?.some(d => d.action === 'delete_event' || d.action === 'delete');
  const isMediaBlocked = data?.some(d => d.action === 'block_media' || d.action === 'PERMANENT_BAN');
  const isReviewed = data?.some(d => d.action === 'reviewed' || d.action === 'mark_ok');
  const isFalsePositive = data?.some(d => d.action === 'false_positive' || d.action === 'false-positive');

  return {
    decisions: data || [],
    hasDecisions,
    latestDecision,
    isBanned,
    isDeleted,
    isMediaBlocked,
    isReviewed,
    isFalsePositive,
    isLoading,
    error,
    refetch,
  };
}
