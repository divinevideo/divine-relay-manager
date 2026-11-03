// ABOUTME: Pins what the resolved-history footer says for each state of the paged read.
// ABOUTME: A stop, a failure or a stale re-read must never read as the end of history.

import { describe, expect, it } from 'vitest';
import { historyFooterState, type HistoryFooterInput } from './historyFooter';

const base: HistoryFooterInput = {
  firstPageFailed: false,
  refreshFailed: false,
  lastPage: { done: false, nextCursor: 1751000000 },
  loadingMore: false,
  busy: false,
  loadMoreFailed: false,
  resolvedRowsShown: 3,
  incompleteSources: [],
  filterActive: false,
  skippedWithinSecond: false,
  resolutionTruncated: false,
};

describe('historyFooterState', () => {
  it('is loading until the first page lands', () => {
    expect(historyFooterState({ ...base, lastPage: undefined })).toEqual({ kind: 'loading' });
  });

  it('says the first page failed rather than that history is empty', () => {
    expect(historyFooterState({ ...base, lastPage: undefined, firstPageFailed: true })).toEqual({ kind: 'failed' });
  });

  it('offers more while the last page left a cursor and did not end', () => {
    expect(historyFooterState(base)).toEqual({
      kind: 'more', shown: 3, loadingMore: false, busy: false, loadMoreFailed: false, filterCaveat: false, notes: [],
    });
  });

  it('offers more after a page that had nothing resolved on it', () => {
    expect(historyFooterState({ ...base, resolvedRowsShown: 0 })).toMatchObject({ kind: 'more', shown: 0 });
  });

  it('warns that filters only searched what is loaded, while more remains', () => {
    expect(historyFooterState({ ...base, filterActive: true })).toMatchObject({ kind: 'more', filterCaveat: true });
  });

  it('passes a Load more in flight, or one that failed, through to the button', () => {
    expect(historyFooterState({ ...base, loadingMore: true, loadMoreFailed: true }))
      .toMatchObject({ kind: 'more', loadingMore: true, loadMoreFailed: true });
  });

  it('passes a re-read of loaded pages in flight through to the button', () => {
    expect(historyFooterState({ ...base, busy: true })).toMatchObject({ kind: 'more', busy: true });
  });

  it('ends only when the worker said history ended', () => {
    expect(historyFooterState({ ...base, lastPage: { done: true, nextCursor: null } }))
      .toEqual({ kind: 'ended', shown: 3, filterActive: false, notes: [] });
  });

  it('never offers more once history ended, whatever the cursor', () => {
    expect(historyFooterState({ ...base, lastPage: { done: true, nextCursor: 5 } })).toMatchObject({ kind: 'ended' });
  });

  it('says the walk stopped when a page left no cursor but history did not end', () => {
    expect(historyFooterState({ ...base, lastPage: { done: false, nextCursor: null } }))
      .toEqual({ kind: 'stopped', shown: 3, notes: [] });
  });

  it('carries notes about skipped reports and unread labels', () => {
    expect(historyFooterState({ ...base, skippedWithinSecond: true, resolutionTruncated: true }))
      .toMatchObject({ notes: ['skipped-within-second', 'resolution-truncated'] });
  });

  it('says a failed re-read of loaded history failed, never that history ended or has more', () => {
    // The pages on screen are from the last good read. Whatever that read
    // said about the end is stale once a re-read has failed.
    expect(historyFooterState({ ...base, refreshFailed: true, lastPage: { done: true, nextCursor: null } }))
      .toEqual({ kind: 'refreshFailed', shown: 3, sources: [], notes: [] });
    expect(historyFooterState({ ...base, refreshFailed: true })).toEqual({ kind: 'refreshFailed', shown: 3, sources: [], notes: [] });
  });

  describe('with a resolution source the moderator went on without', () => {
    // Rows that source would resolve are listed as unresolved, so neither a
    // count nor the end of history ("No resolved reports.") can be stated.
    const incomplete = { ...base, incompleteSources: ['Banned posts'] };

    it('withholds the count and the end, and names the source', () => {
      expect(historyFooterState({ ...incomplete, lastPage: { done: true, nextCursor: null } })).toEqual({
        kind: 'resolutionIncomplete', sources: ['Banned posts'], hasMore: false,
        loadingMore: false, busy: false, loadMoreFailed: false, filterCaveat: false, notes: [],
      });
      expect(historyFooterState({ ...incomplete, lastPage: { done: false, nextCursor: null } }))
        .toMatchObject({ kind: 'resolutionIncomplete', hasMore: false });
    });

    it('keeps Load more while history has more, with its paging state', () => {
      expect(historyFooterState({ ...incomplete, loadingMore: true, busy: true, loadMoreFailed: true, filterActive: true }))
        .toMatchObject({ kind: 'resolutionIncomplete', hasMore: true, loadingMore: true, busy: true, loadMoreFailed: true, filterCaveat: true });
    });

    it('still says first that a re-read of loaded history failed, and carries the sources so it states no count', () => {
      expect(historyFooterState({ ...incomplete, refreshFailed: true }))
        .toMatchObject({ kind: 'refreshFailed', sources: ['Banned posts'] });
    });
  });
});
