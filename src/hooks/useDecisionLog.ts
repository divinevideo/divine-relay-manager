// ABOUTME: Hook to fetch and manage moderation decision history
// ABOUTME: Tracks what actions have been taken on report targets

import { useQuery } from "@tanstack/react-query";
import { useAdminApi } from "@/hooks/useAdminApi";
import { AUTO_HIDE_ACTION, AUTO_HIDE_ACTIONS, getLatestAutoHideState } from "@/lib/constants";
import { REOPENED_ACTION, isHumanHandling } from "../../shared/handling";

// Every auto-hide action except the three that leave the report waiting for a
// moderator. See latestHandlingDecision below.
const PANE_HANDLING_AUTO_HIDE_ACTIONS: readonly string[] = AUTO_HIDE_ACTIONS.filter(
  action => action !== AUTO_HIDE_ACTION.skipped
    && action !== AUTO_HIDE_ACTION.failed
    && action !== AUTO_HIDE_ACTION.pending,
);

export function useDecisionLog(targetId: string | null | undefined) {
  const { getDecisions } = useAdminApi();

  const { data, isLoading, isPending, error, refetch } = useQuery({
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

  // Reopen (#324) records a `reopened` row instead of deleting the history, and
  // only what came after the newest one says the report is handled, as in the
  // queue's handlingByTarget. Rows come newest first (created_at, then id), so
  // that is everything before it in the list.
  const reopenIndex = data?.findIndex(d => d.action === REOPENED_ACTION) ?? -1;
  const sinceReopen = reopenIndex === -1 ? data : data?.slice(0, reopenIndex);

  // The newest decision that handled the report: a person's decision
  // (isHumanHandling), which leaves out the worker's own decisions, such as
  // opening an age-review case, since no person has looked at the report.
  //
  // The pane also counts the auto-hide actions the queue does not (a hide, its
  // confirmation or restore, and the unresolved and failed-restore states).
  // An auto-hide that was skipped (a list report,
  // an untrusted client), failed at the relay, or is still pending leaves the
  // report waiting for a moderator, so it records history without handling
  // anything, and must not stand in for the moderator's action when it lands
  // later.
  const latestHandlingDecision = sinceReopen?.find(
    d => isHumanHandling(d) || PANE_HANDLING_AUTO_HIDE_ACTIONS.includes(d.action),
  );
  const hasHandlingDecisions = latestHandlingDecision !== undefined;
  // Reopened, and no one has handled the target since.
  const isReopened = reopenIndex !== -1 && !hasHandlingDecisions;

  // Get the most recent decision
  const latestDecision = data?.[0];

  // Check for specific action types
  const isBanned = data?.some(d => d.action === 'ban_user' || d.action === 'ban');
  // A delete counts until a later restore_event row: EventActions' and
  // EventDetail's Restore Event log one beside the relay call. Decisions come
  // newest first, so the first of these wins. Other restores (report detail's
  // Undo toast, the events list) write no decision row, and the worker records
  // allow_event only in moderation_targets, so after those a delete still counts.
  const latestDeleteOrRestore = data?.find(d =>
    d.action === 'delete_event' || d.action === 'delete' || d.action === 'restore_event');
  const isDeleted = data === undefined
    ? undefined
    : latestDeleteOrRestore?.action === 'delete_event' || latestDeleteOrRestore?.action === 'delete';
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
    isReopened,
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
    /**
     * No decisions have been read yet: loading, retrying, or held back offline
     * (where isLoading is false). Until then "nothing recorded" is not known.
     */
    isPending,
    error,
    refetch,
  };
}
