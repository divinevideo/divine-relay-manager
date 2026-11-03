// ABOUTME: The footer under the resolved-history view: how much is shown and whether more exists.
// ABOUTME: Counts only rows on screen; a fetched total would disagree with the list beside it.

import { Loader2, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import type { HistoryFooterState, HistoryNote } from '@/lib/historyFooter';

const NOTE_TEXT: Record<HistoryNote, string> = {
  'skipped-within-second': 'Some reports filed within the same second were skipped.',
  'resolution-truncated': 'Some resolved reports may be missing: not every resolution label could be read.',
};

// "Banned posts", "Banned posts and Resolution labels", "A, B and C".
function sourceNames(sources: string[]): string {
  return sources.length > 1
    ? `${sources.slice(0, -1).join(', ')} and ${sources[sources.length - 1]}`
    : sources.join('');
}

interface ResolvedHistoryFooterProps {
  state: HistoryFooterState;
  errorMessage?: string;
  // A Try again re-read of loaded pages is in flight. With pages loaded the
  // query keeps its error until the re-read settles, so without this a retry
  // that fails again looks like a dead click. Only the refreshFailed state
  // reads it: with nothing loaded, query-core puts the query back to pending
  // and the footer shows loading instead of the failure.
  retrying?: boolean;
  onLoadMore: () => void;
  onRetry: () => void;
}

export function ResolvedHistoryFooter({ state, errorMessage, retrying = false, onLoadMore, onRetry }: ResolvedHistoryFooterProps) {
  const reason = errorMessage ? `: ${errorMessage}` : '.';

  if (state.kind === 'loading') {
    return (
      <div data-testid="resolved-history-footer" className="flex items-center justify-center gap-2 py-3 text-xs text-muted-foreground">
        <Loader2 className="h-3 w-3 animate-spin" />
        Loading resolved history…
      </div>
    );
  }

  if (state.kind === 'failed') {
    return (
      <div data-testid="resolved-history-footer" className="space-y-2 py-3 text-center text-xs">
        <p className="text-destructive">Couldn't load resolved history{reason}</p>
        <Button variant="outline" size="sm" onClick={onRetry}>
          <RefreshCw className="mr-1 h-3 w-3" />
          Try again
        </Button>
      </div>
    );
  }

  const notes = state.notes.map(note => <p key={note}>{NOTE_TEXT[note]}</p>);

  const countUnavailable = (sources: string[]) =>
    `Resolved count unavailable: ${sourceNames(sources)} couldn't be read.`;

  // Never says the history ended or has more: that came from the read that
  // just failed to repeat. "As loaded earlier" is true of the pages, not of
  // the count, which is taken live from them: with a source unread it would
  // be short, so it gives way to the same line resolutionIncomplete shows.
  if (state.kind === 'refreshFailed') {
    return (
      <div data-testid="resolved-history-footer" className="space-y-2 py-3 text-center text-xs">
        <p className="text-muted-foreground">
          {state.sources.length > 0
            ? countUnavailable(state.sources)
            : `Showing ${state.shown} resolved, as loaded earlier.`}
        </p>
        <p className="text-destructive">Couldn't refresh resolved history{reason}</p>
        {notes}
        <Button variant="outline" size="sm" onClick={onRetry} disabled={retrying}>
          {retrying ? <Loader2 className="mr-1 h-3 w-3 animate-spin" /> : <RefreshCw className="mr-1 h-3 w-3" />}
          Try again
        </Button>
      </div>
    );
  }

  const loadMore = (paging: { filterCaveat: boolean; loadMoreFailed: boolean; loadingMore: boolean; busy: boolean }) => (
    <>
      {paging.filterCaveat && (
        <p>Filters only search the history loaded so far. Load more to search further back.</p>
      )}
      {paging.loadMoreFailed && <p className="text-destructive">Couldn't load the next page{reason}</p>}
      {notes}
      <Button variant="outline" size="sm" onClick={onLoadMore} disabled={paging.loadingMore || paging.busy}>
        {(paging.loadingMore || paging.busy) && <Loader2 className="mr-1 h-3 w-3 animate-spin" />}
        {paging.loadMoreFailed ? 'Try again' : 'Load more'}
      </Button>
    </>
  );

  // Neither a count nor the end: the rows the named sources would resolve are
  // listed as unresolved. The rows themselves are real, so Load more stays.
  if (state.kind === 'resolutionIncomplete') {
    return (
      <div data-testid="resolved-history-footer" className="space-y-2 py-3 text-center text-xs text-muted-foreground">
        <p>{countUnavailable(state.sources)}</p>
        {state.hasMore ? loadMore(state) : notes}
      </div>
    );
  }

  if (state.kind === 'more') {
    return (
      <div data-testid="resolved-history-footer" className="space-y-2 py-3 text-center text-xs text-muted-foreground">
        <p>Showing {state.shown} resolved. More further back.</p>
        {loadMore(state)}
      </div>
    );
  }

  if (state.kind === 'stopped') {
    return (
      <div data-testid="resolved-history-footer" className="space-y-2 py-3 text-center text-xs text-muted-foreground">
        <p>Showing {state.shown} resolved. Resolved history can't be followed further back from here.</p>
        {notes}
      </div>
    );
  }

  return (
    <div data-testid="resolved-history-footer" className="space-y-2 py-3 text-center text-xs text-muted-foreground">
      <p>
        {state.shown > 0
          ? `Showing ${state.shown} resolved. End of resolved history.`
          : state.filterActive
            ? 'No resolved reports match the current filters.'
            : 'No resolved reports.'}
      </p>
      {notes}
    </div>
  );
}
