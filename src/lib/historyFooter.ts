// ABOUTME: What the resolved-history footer says, from the state of the paged read.
// ABOUTME: A list that stopped must never read like a list that ended.

export type HistoryNote = 'skipped-within-second' | 'resolution-truncated';

export interface HistoryFooterInput {
  // The first page failed and nothing is loaded.
  firstPageFailed: boolean;
  // Pages are loaded, and re-reading them (on opening the view, on Refresh,
  // or after a resolve or reopen) failed. The pages on screen are stale.
  refreshFailed: boolean;
  // Paging state of the newest page loaded; undefined before any page lands.
  lastPage?: { done: boolean; nextCursor: number | null };
  loadingMore: boolean;
  // Loaded pages are being re-read (on opening the view, on Refresh, or after
  // a resolve or reopen). Load more would cancel that read and drop what it
  // was fetching, so it waits.
  busy: boolean;
  loadMoreFailed: boolean;
  // Resolved rows the list renders right now. Never a fetched total: the paged
  // read knows only what the worker resolved, and the list beside it also
  // holds ban-resolved reports from the feed.
  resolvedRowsShown: number;
  // Resolution sources the moderator chose to go on without: failed with no
  // data, or stuck offline. Rows they would resolve are listed as unresolved.
  // Not a stale source, which still holds data and keeps counting under the
  // stale banner, as the default view's filter does.
  incompleteSources: string[];
  // A category or target-type filter is narrowing the list.
  filterActive: boolean;
  skippedWithinSecond: boolean;
  resolutionTruncated: boolean;
}

export type HistoryFooterState =
  | { kind: 'loading' }
  | { kind: 'failed' }
  | { kind: 'refreshFailed'; shown: number; notes: HistoryNote[] }
  | {
      kind: 'resolutionIncomplete';
      sources: string[];
      hasMore: boolean;
      loadingMore: boolean;
      busy: boolean;
      loadMoreFailed: boolean;
      filterCaveat: boolean;
      notes: HistoryNote[];
    }
  | { kind: 'more'; shown: number; loadingMore: boolean; busy: boolean; loadMoreFailed: boolean; filterCaveat: boolean; notes: HistoryNote[] }
  | { kind: 'ended'; shown: number; filterActive: boolean; notes: HistoryNote[] }
  | { kind: 'stopped'; shown: number; notes: HistoryNote[] };

// Only the worker's `done` ends history. An empty page with a cursor is more
// history, not none; a page with no cursor that is not done is a walk that
// could not continue, and says so. A failed re-read says so before anything
// else: the last good read's word on the end is stale by then (#221). Next, a
// resolution source the moderator went on without withholds both the count
// and the end: rows it would resolve are listed as unresolved, so "No
// resolved reports." could be false. The rows are real, so Load more stays.
export function historyFooterState(input: HistoryFooterInput): HistoryFooterState {
  if (!input.lastPage) {
    return input.firstPageFailed ? { kind: 'failed' } : { kind: 'loading' };
  }
  const notes: HistoryNote[] = [];
  if (input.skippedWithinSecond) notes.push('skipped-within-second');
  if (input.resolutionTruncated) notes.push('resolution-truncated');
  const shown = input.resolvedRowsShown;

  if (input.refreshFailed) {
    return { kind: 'refreshFailed', shown, notes };
  }
  if (input.incompleteSources.length > 0) {
    const hasMore = !input.lastPage.done && input.lastPage.nextCursor !== null;
    return {
      kind: 'resolutionIncomplete',
      sources: input.incompleteSources,
      hasMore,
      loadingMore: input.loadingMore,
      busy: input.busy,
      loadMoreFailed: input.loadMoreFailed,
      filterCaveat: input.filterActive && hasMore,
      notes,
    };
  }
  if (input.lastPage.done) {
    return { kind: 'ended', shown, filterActive: input.filterActive, notes };
  }
  if (input.lastPage.nextCursor !== null) {
    return {
      kind: 'more',
      shown,
      loadingMore: input.loadingMore,
      busy: input.busy,
      loadMoreFailed: input.loadMoreFailed,
      filterCaveat: input.filterActive,
      notes,
    };
  }
  return { kind: 'stopped', shown, notes };
}
