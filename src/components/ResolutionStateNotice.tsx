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
