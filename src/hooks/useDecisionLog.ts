// ABOUTME: Hook to fetch and manage moderation decision history
// ABOUTME: Tracks what actions have been taken on report targets

import { useQuery } from "@tanstack/react-query";
import { useAdminApi } from "@/hooks/useAdminApi";
import { AUTO_HIDE_ACTION, getLatestAutoHideState } from "@/lib/constants";
import { isAutomatedDecision } from "../../shared/automated-decision";

export function useDecisionLog(targetId: string | null | undefined) {
  const { getDecisions } = useAdminApi();

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['decisions', targetId],
    queryFn: async () => {
      if (!targetId) return [];
      return getDecisions(targetId);
    },
    enabled: !!targetId,
    staleTime: 30_000, // Cache decisions for 30s when navigating between reports
  });

  // Check if target has any decisions
  const hasDecisions = (data?.length ?? 0) > 0;

  // The newest decision that handled the report. An auto-hide that was skipped
  // (a list report, an untrusted client), failed at the relay, or is still
  // pending leaves the report waiting for a moderator, so it records history
  // without handling anything, and must not stand in for the moderator's
  // action when it lands later. Neither does a decision the worker made by
  // itself, such as opening an age-review case: no person has looked at the
  // report, which is also why the sensitive switch keeps it.
  const latestHandlingDecision = data?.find(
    d => d.action !== AUTO_HIDE_ACTION.skipped
      && d.action !== AUTO_HIDE_ACTION.failed
      && d.action !== AUTO_HIDE_ACTION.pending
      && !isAutomatedDecision(d),
  );
  const hasHandlingDecisions = latestHandlingDecision !== undefined;

  // Get the most recent decision
  const latestDecision = data?.[0];

  // Check for specific action types
  const isBanned = data?.some(d => d.action === 'ban_user' || d.action === 'ban');
  const isDeleted = data?.some(d => d.action === 'delete_event' || d.action === 'delete');
  const isMediaBlocked = data?.some(d => d.action === 'block_media' || d.action === 'PERMANENT_BAN');
  const isReviewed = data?.some(d => d.action === 'reviewed' || d.action === 'mark_ok');
  const isFalsePositive = data?.some(d => d.action === 'false_positive' || d.action === 'false-positive');

  // Auto-hide specific checks
  const latestAutoHideAction = getLatestAutoHideState(data?.map(d => d.action) ?? []);
  const isAutoHideRestoreFailed = latestAutoHideAction === AUTO_HIDE_ACTION.restoreFailed;
  // The ban landed, but the worker could not check for a moderator's restore racing it
  const isAutoHideUnresolved = latestAutoHideAction === AUTO_HIDE_ACTION.unresolved;
  const isAutoHidden = latestAutoHideAction === AUTO_HIDE_ACTION.hidden
    || latestAutoHideAction === AUTO_HIDE_ACTION.unresolved
    || isAutoHideRestoreFailed;
  const isAutoHideConfirmed = latestAutoHideAction === AUTO_HIDE_ACTION.confirmed;
  const isAutoHideRestored = latestAutoHideAction === AUTO_HIDE_ACTION.restored || latestAutoHideAction === AUTO_HIDE_ACTION.reversed;
  const isPendingReview = isAutoHidden;

  return {
    decisions: data || [],
    hasDecisions,
    hasHandlingDecisions,
    latestHandlingDecision,
    latestDecision,
    isBanned,
    isDeleted,
    isMediaBlocked,
    isReviewed,
    isFalsePositive,
    isAutoHidden,
    isAutoHideConfirmed,
    isAutoHideRestored,
    isAutoHideRestoreFailed,
    isAutoHideUnresolved,
    isPendingReview,
    isLoading,
    error,
    refetch,
  };
}
