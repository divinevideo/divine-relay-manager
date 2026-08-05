// ABOUTME: Moderator-facing notices for incomplete resolution state: the
// ABOUTME: blocked pane, its override warning, and the stale-source banner (#221)

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { AlertTriangle } from 'lucide-react';

export interface NoticeSource {
  key: string;
  label: string;
}

function sourceList(sources: NoticeSource[]): string {
  return sources.map(s => s.label).join(', ');
}

// Shown instead of the queue when a resolution source failed with no previous
// data to fall back on. Rendering the list here would present handled work as
// pending, which is the bug; rendering nothing at all would lock the moderator
// out, which is its own failure. So: say what is missing, and let them proceed
// deliberately.
export function ResolutionUnavailablePane({
  sources,
  decisionsUnavailable,
  onRetry,
  onOverride,
}: {
  sources: NoticeSource[];
  decisionsUnavailable: boolean;
  onRetry: () => void;
  onOverride: () => void;
}) {
  return (
    <Card className="h-[calc(100vh-200px)]">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <AlertTriangle className="h-5 w-5 text-amber-500" />
          Resolution state is unavailable
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-sm text-muted-foreground">
          The queue cannot tell which reports have already been handled, so it is not
          showing the list. Unavailable: {sourceList(sources)}.
        </p>
        <p className="text-sm text-muted-foreground">
          This usually clears on the next automatic refresh.
        </p>
        <div className="flex flex-wrap gap-2">
          <Button onClick={onRetry}>Retry</Button>
          <Button variant="outline" onClick={onOverride}>
            Show the queue without resolution filtering
          </Button>
        </div>
        {decisionsUnavailable && (
          <p className="text-xs text-muted-foreground">
            If you continue, the unfiltered queue will also include auto-hidden content
            that is normally kept out of this view.
          </p>
        )}
      </CardContent>
    </Card>
  );
}

// A source whose refresh is failing but which still holds its last good data.
// The filter is still correct as of that timestamp, so the queue stays up and
// the moderator is told how old the resolution state is.
export function StaleResolutionBanner({
  sources,
}: {
  sources: Array<NoticeSource & { updatedAt: number }>;
}) {
  const oldest = Math.min(...sources.map(s => s.updatedAt));
  const minutes = Math.max(0, Math.floor((Date.now() - oldest) / 60_000));
  const age = minutes < 1 ? 'less than a minute ago' : `${minutes} minute${minutes === 1 ? '' : 's'} ago`;

  return (
    <Alert className="mt-2 py-2">
      <AlertDescription className="text-xs">
        {sourceList(sources)} could not refresh. Showing resolution state from {age};
        retrying automatically.
      </AlertDescription>
    </Alert>
  );
}

// Both /api/decisions and /api/resolution-labels cap how far back they read.
// Neither cap binds today, but when one does, a target whose only resolution
// signal is older than the window ages out of resolvedTargets and sits in the
// queue forever with nothing explaining why (#221).
export function TruncatedHistoryBanner({ oldestCovered }: { oldestCovered: number }) {
  const date = new Date(oldestCovered).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });

  return (
    <Alert className="mt-2 py-2">
      <AlertDescription className="text-xs">
        Resolution history only reaches back to {date}. Anything resolved before then may
        be listed as pending.
      </AlertDescription>
    </Alert>
  );
}

// Stays on screen for as long as the override is in effect. A one-off toast
// would let a moderator forget they are looking at an unfiltered queue.
export function ResolutionOverrideWarning({
  sources,
  decisionsUnavailable,
}: {
  sources: NoticeSource[];
  decisionsUnavailable: boolean;
}) {
  return (
    <Alert variant="destructive" className="mt-2 py-2">
      <AlertDescription className="text-xs">
        Resolution filtering is off ({sourceList(sources)} unavailable), so some of these
        may already be handled.
        {decisionsUnavailable && ' Auto-hidden content is included.'}
      </AlertDescription>
    </Alert>
  );
}
