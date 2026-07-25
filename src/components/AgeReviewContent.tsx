// ABOUTME: Renders an age-review target's content — the reported event (relay or
// ABOUTME: getbannedevent fallback) plus recent posts via MediaPreview (which proxies
// ABOUTME: Blossom-blocked media) — or a verified "why not visible" reason. Never a
// ABOUTME: blank, never a guess, never an error masked as absent.
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { RefreshCw } from "lucide-react";
import type { NostrEvent } from "@nostrify/nostrify";
import type { AccountStatusResponse } from "@/lib/adminApi";
import type { ReportedEventResult } from "@/hooks/useReportedEvent";
import { MediaPreview } from "@/components/MediaPreview";
import { getKindName } from "@/lib/kindNames";
import { deriveContentVisibility } from "@/lib/contentVisibility";

interface AgeReviewContentProps {
  postCount: number | undefined;
  contentLoading: boolean;
  contentError: boolean;
  accountStatus: AccountStatusResponse | undefined;
  recentPosts: NostrEvent[];
  onRetry?: () => void;
  // The specific reported event (relay-visible or retrieved via getbannedevent).
  reportedEvent?: ReportedEventResult | null;
  reportedEventLoading?: boolean;
  // The reported-event read errored (relay/timeout) — distinct from a confirmed
  // not-found, so we never label a transient failure as "deleted or aged out".
  reportedEventError?: boolean;
  onRetryReported?: () => void;
  // Whether the case has a report_id at all (so "not found" only shows when it does).
  hasReportId?: boolean;
}

// One content item — click-to-reveal media (MediaPreview default; the media-proxy
// fallback handles Blossom-blocked blobs), kind + timestamp, and any text.
function ContentCard({ event }: { event: NostrEvent }) {
  return (
    <div className="rounded-md border p-2.5 space-y-1.5">
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <span>{getKindName(event.kind)}</span>
        <span>·</span>
        <span>{new Date(event.created_at * 1000).toLocaleString()}</span>
      </div>
      <MediaPreview event={event} maxItems={4} />
      {event.content ? (
        <p className="text-sm whitespace-pre-wrap break-words">{event.content}</p>
      ) : null}
    </div>
  );
}

export function AgeReviewContent({
  postCount,
  contentLoading,
  contentError,
  accountStatus,
  recentPosts,
  onRetry,
  reportedEvent,
  reportedEventLoading,
  reportedEventError,
  onRetryReported,
  hasReportId,
}: AgeReviewContentProps) {
  const vis = deriveContentVisibility({ postCount, contentLoading, contentError, accountStatus });
  const reportedId = reportedEvent?.event.id;
  const otherPosts = recentPosts.filter((e) => e.id !== reportedId);

  return (
    <div className="space-y-3">
      {/* The specific event that triggered the case. */}
      {reportedEvent ? (
        <div className="space-y-1.5">
          <h4 className="flex items-center gap-2 text-sm font-medium">
            Reported content
            {reportedEvent.banned ? (
              <Badge variant="destructive" className="text-xs">removed (banned)</Badge>
            ) : null}
          </h4>
          <ContentCard event={reportedEvent.event} />
        </div>
      ) : reportedEventLoading ? (
        <p className="text-xs text-muted-foreground">Loading reported content…</p>
      ) : reportedEventError ? (
        <div className="flex items-center justify-between gap-2 text-xs text-amber-700 dark:text-amber-400">
          <span>Couldn't load the reported event (relay error).</span>
          {onRetryReported ? (
            <Button variant="outline" size="sm" onClick={onRetryReported}>
              <RefreshCw className="mr-1 h-3 w-3" /> Retry
            </Button>
          ) : null}
        </div>
      ) : hasReportId ? (
        <p className="text-xs text-muted-foreground">
          The reported event is not on the relay (deleted or aged out).
        </p>
      ) : null}

      {/* The account's other recent content, or a verified reason it isn't visible. */}
      {vis.state === "has_content" ? (
        otherPosts.length > 0 ? (
          <div className="space-y-2">
            <h4 className="text-sm font-medium">Recent content ({otherPosts.length})</h4>
            <div className="space-y-2">
              {otherPosts.map((e) => (
                <ContentCard key={e.id} event={e} />
              ))}
            </div>
          </div>
        ) : null
      ) : (
        <Card>
          <CardContent
            className={`p-3 text-sm ${
              vis.state === "error" ? "text-amber-700 dark:text-amber-400" : "text-muted-foreground"
            }`}
          >
            <div className="flex items-center justify-between gap-2">
              <span>{vis.message}</span>
              {vis.state === "error" && onRetry ? (
                <Button variant="outline" size="sm" onClick={onRetry}>
                  <RefreshCw className="mr-1 h-3 w-3" /> Retry
                </Button>
              ) : null}
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
