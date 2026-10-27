// ABOUTME: Remembers which error a failed Load more left on the resolved-history query.
// ABOUTME: Lets the footer tell that old error from the failure of a later re-read.

// query-core keeps a query's error, and drops the fetch direction, when the next
// fetch is a plain re-read of the loaded pages, so a re-read that is still
// running reads as a failed refresh with Load more's error. The footer must show
// a refresh failure only for a failure of the re-read itself.
//
// Module level, not component state: the query cache outlives Reports, which
// unmounts when its tab is left. Keyed by the error object, so each query's
// failure is its own (a replaced query has other error objects, and a cache
// with several relays holds several). A WeakMap, so an error the cache has
// dropped is collected. The error's errorUpdatedAt is the value, because
// query-core stamps it on every failed fetch: a later re-read that fails, even
// with the very same error object (a fetch layer sharing one rejection), has a
// newer stamp. Both are needed; neither alone separates every case.
//
// A thrown primitive cannot be a WeakMap key. It is never remembered, so it is
// never taken for a leftover, and its re-read failure shows.
const loadMoreFailures = new WeakMap<object, number>();

const isObjectLike = (value: unknown): value is object =>
  (typeof value === 'object' && value !== null) || typeof value === 'function';

export function rememberLoadMoreFailure(error: unknown, errorUpdatedAt: number): void {
  if (isObjectLike(error)) loadMoreFailures.set(error, errorUpdatedAt);
}

// True only for the very failure remembered: the same error object, from the
// same failed fetch.
export function isLoadMoreFailure(error: unknown, errorUpdatedAt: number): boolean {
  // WeakMap.get of a non-object is undefined, never a match, and never throws.
  return loadMoreFailures.get(error as object) === errorUpdatedAt;
}
