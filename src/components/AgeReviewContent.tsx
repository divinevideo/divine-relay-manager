// ABOUTME: Renders an age-review target's content: the reported event (resolved
// ABOUTME: through the report's target tag, with a getbannedevent fallback) plus
// ABOUTME: recent posts via MediaPreview (which proxies Blossom-blocked media),
// ABOUTME: or a verified reason it is not visible. Never a blank, never a guess,
// ABOUTME: never an error or an in-flight read presented as absence.
import type { ReactNode } from "react";
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
  // The account read resolved but was truncated, so a zero count proves nothing.
  contentIncomplete?: boolean;
  accountStatus: AccountStatusResponse | undefined;
  accountStatusFailed?: boolean;
  recentPosts: NostrEvent[];
  onRetry?: () => void;
  // Outcome of resolving what the report targets. Undefined while it has not run.
  reportedEvent?: ReportedEventResult | null;
  reportedEventLoading?: boolean;
  // The lookup failed. Distinct from any "not retrievable" outcome, so a
  // transient failure is never labelled as a deletion.
  reportedEventError?: boolean;
  onRetryReported?: () => void;
  // Whether the case has a report_id at all (so the reported section only
  // appears for cases that came from a report).
  hasReportId?: boolean;
}

// One content item: click-to-reveal media (MediaPreview default; the media-proxy
// fallback handles Blossom-blocked blobs), kind + timestamp, author, and any text.
function ContentCard({ event }: { event: NostrEvent }) {
  return (
    <div className="rounded-md border p-2.5 space-y-1.5">
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <span>{getKindName(event.kind)}</span>
        <span>·</span>
        <span>{new Date(event.created_at * 1000).toLocaleString()}</span>
        <span>·</span>
        {/* Author is shown so content can never be attributed by position alone. */}
        <span className="font-mono">{event.pubkey.slice(0, 12)}…</span>
      </div>
      <MediaPreview event={event} maxItems={4} />
      {event.content ? (
        <p className="text-sm whitespace-pre-wrap break-words">{event.content}</p>
      ) : null}
    </div>
  );
}

function Note({ children }: { children: ReactNode }) {
  return <p className="text-xs text-muted-foreground">{children}</p>;
}

/**
 * Why the reported event is not on screen. A suspend or ban explains it
 * definitively, so those are checked before falling back to "not retrievable":
 * suspension hides the account's events from the relay read and `getbannedevent`
 * only knows per-event bans, so without this an enforced account reads as
 * "deleted", which is a different and much more final claim.
 */
function reportedMissingReason(
  accountStatus: AccountStatusResponse | undefined,
  accountStatusFailed: boolean | undefined,
): string {
  // A status we no longer trust cannot explain anything. TanStack keeps the last
  // successful data while isError is true, so without this the section could
  // blame a suspension that has since been lifted, while the card directly below
  // correctly says the status is unavailable.
  if (!accountStatusFailed) {
    if (accountStatus?.status === "suspended") {
      return "The reported post is hidden by the account's suspension, so it cannot be shown here.";
    }
    if (accountStatus?.status === "banned") {
      return "The reported post was removed with the account ban.";
    }
  }
  return "The reported post is not retrievable from the relay (deleted, aged out, or hidden).";
}

export function AgeReviewContent({
  postCount,
  contentLoading,
  contentError,
  contentIncomplete,
  accountStatus,
  accountStatusFailed,
  recentPosts,
  onRetry,
  reportedEvent,
  reportedEventLoading,
  reportedEventError,
  onRetryReported,
  hasReportId,
}: AgeReviewContentProps) {
  const vis = deriveContentVisibility({
    postCount,
    contentLoading,
    contentError,
    contentIncomplete,
    accountStatus,
    accountStatusFailed,
  });

  const foundReported = reportedEvent?.status === "found" ? reportedEvent : undefined;
  const reportedId = foundReported?.event.id;
  const otherPosts = recentPosts.filter((e) => e.id !== reportedId);

  // Built first so the heading is only rendered when something sits under it,
  // rather than leaving a bare "Reported content" label over empty space.
  const reportedBody = !hasReportId ? null : foundReported ? (
    // Keyed so the click-to-reveal state cannot carry over when the pane is
    // reused for another case (MediaPreview keeps `showMedia` across an event
    // swap, and revealing media is a deliberate gate here).
    <ContentCard key={foundReported.event.id} event={foundReported.event} />
  ) : reportedEventLoading ? (
    <Note>Loading reported content…</Note>
  ) : reportedEventError ? (
    <div className="flex items-center justify-between gap-2 text-xs text-amber-700 dark:text-amber-400">
      <span>Couldn't load the reported content (relay error).</span>
      {onRetryReported ? (
        <Button variant="outline" size="sm" onClick={onRetryReported}>
          <RefreshCw className="mr-1 h-3 w-3" /> Retry
        </Button>
      ) : null}
    </div>
  ) : reportedEvent?.status === "account_level" ? (
    <Note>This report was filed against the account rather than a specific post, so there is no single item to show.</Note>
  ) : reportedEvent?.status === "report_missing" ? (
    <Note>The report event is no longer on the relay, so its target cannot be resolved.</Note>
  ) : reportedEvent?.status === "not_a_report" ? (
    <Note>The linked event is not a report, so what it refers to cannot be determined.</Note>
  ) : reportedEvent?.status === "target_unreadable" ? (
    <Note>This report names a target we cannot read, so the reported post cannot be resolved.</Note>
  ) : reportedEvent?.status === "target_foreign" ? (
    // Deliberately not rendered: judging this account by another account's post
    // is how the wrong person gets enforced against. Stated as a fact about the
    // tag, not an accusation, since a client quirk is likelier than bad faith.
    <div className="rounded-md border border-amber-500/40 p-2.5 text-xs text-amber-700 dark:text-amber-400">
      This report points at an event authored by a different account
      (<span className="font-mono">{reportedEvent.authorPubkey.slice(0, 12)}…</span>),
      not by this case's subject, so it is not shown here as this account's content.
    </div>
  ) : reportedEvent?.status === "target_missing" ? (
    <Note>{reportedMissingReason(accountStatus, accountStatusFailed)}</Note>
  ) : null;

  return (
    <div className="space-y-3">
      {/* The specific content the case was opened about. */}
      {reportedBody ? (
        <div className="space-y-1.5">
          <h4 className="flex items-center gap-2 text-sm font-medium">
            Reported content
            {foundReported?.banned ? (
              <Badge variant="destructive" className="text-xs">removed (banned)</Badge>
            ) : null}
          </h4>
          {reportedBody}
        </div>
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
              {/* `unknown` gets a retry too: it is reached when the account-status
                  read failed, and refetching content alone can never clear it. */}
              {(vis.state === "error" || vis.state === "unknown") && onRetry ? (
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
