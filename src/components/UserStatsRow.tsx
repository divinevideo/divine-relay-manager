// ABOUTME: Compact events/reports/labels row for a user, shown in EventDetail.
// ABOUTME: Each count shows "?" when its relay read did not complete, so a
// ABOUTME: truncated read never renders as a confident number (#210).

import { FileText, Flag, Tag } from "lucide-react";
import type { UserStats } from "@/hooks/useUserStats";
import { statCountText, STAT_UNKNOWN_TITLE } from "@/lib/statDisplay";

/**
 * The three moderation-relevant counts as inline spans. Rendered by both
 * EventDetail stats blocks so their honest-count treatment cannot drift apart.
 * Returns the spans only; callers supply the wrapper.
 */
export function UserStatsRow({ stats }: { stats: UserStats }) {
  return (
    <>
      <span
        className="flex items-center gap-1"
        title={stats.authoredContentIncomplete ? STAT_UNKNOWN_TITLE : undefined}
      >
        <FileText className="h-3 w-3" />
        {statCountText(stats.postCount, stats.authoredContentIncomplete)} events
      </span>
      <span
        className="flex items-center gap-1"
        title={stats.reportsIncomplete ? STAT_UNKNOWN_TITLE : undefined}
      >
        <Flag className="h-3 w-3" />
        {statCountText(stats.reportCount, stats.reportsIncomplete)} reports
      </span>
      <span
        className="flex items-center gap-1"
        title={stats.labelsIncomplete ? STAT_UNKNOWN_TITLE : undefined}
      >
        <Tag className="h-3 w-3" />
        {statCountText(stats.labelCount, stats.labelsIncomplete)} labels
      </span>
    </>
  );
}
