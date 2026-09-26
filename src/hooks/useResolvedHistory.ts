// ABOUTME: Resolved report history, read a page at a time and only while it is on screen.
// ABOUTME: Held apart from the polled queue so loaded pages survive every poll and retry.

import { useInfiniteQuery } from '@tanstack/react-query';
import { useAdminApi } from '@/hooks/useAdminApi';
import type { ResolvedReportsPage } from '@/lib/adminApi';
import { RESOLVED_HISTORY_KEY_ROOT } from '@/lib/queueInvalidation';

// Roughly the payload the queue's old single read carried per request.
export const RESOLVED_HISTORY_PAGE_SIZE = 200;

// Its own cache entry, not part of the queue's ['reports', relayUrl] read. The
// queue polls that every minute; a moderator several pages back must not
// lose their place to it. Deliberately not in the queue's Retry invalidation
// list either (Reports.tsx), for the same reason.
export function useResolvedHistory(relayUrl: string, enabled: boolean) {
  const { fetchResolvedReportsPage } = useAdminApi();
  return useInfiniteQuery({
    // relayUrl in the key, as for every evidence-bearing read here: a page from
    // one environment must never be shown in another. No placeholderData, for
    // the same reason.
    queryKey: [RESOLVED_HISTORY_KEY_ROOT, relayUrl],
    queryFn: ({ pageParam }) =>
      fetchResolvedReportsPage({ cursor: pageParam, limit: RESOLVED_HISTORY_PAGE_SIZE }),
    initialPageParam: undefined as number | undefined,
    // A page with no cursor has no next page. Whether that is the end or a walk
    // that could not continue is the page's own `done`, which the footer reads.
    getNextPageParam: (lastPage: ResolvedReportsPage) => lastPage.nextCursor ?? undefined,
    enabled,
    // No refetchInterval, and not on window focus: either re-reads every loaded
    // page. History is re-read when the view opens, when the moderator
    // refreshes, and when an action changes what is resolved
    // (invalidateResolutionState).
    refetchOnWindowFocus: false,
    // One retry, as the queue's other relay-backed reads: one slow relay read
    // should not cost a Load more.
    retry: 1,
  });
}
