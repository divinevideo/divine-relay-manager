// ABOUTME: Fetches aggregated stats for a Nostr user
// ABOUTME: Returns post count, report count, label count, and recent posts

import { useNostr } from "@nostrify/react";
import { useQuery } from "@tanstack/react-query";
import { useAppContext } from "@/hooks/useAppContext";
import { queryStrict, RelayReadError } from "@/lib/relayRead";
import { RECENT_CONTENT_KINDS } from "@/lib/constants";
import { pageByUntil } from "../../shared/relay-pager";
import type { NostrEvent, NostrFilter } from "@nostrify/nostrify";

export interface UserStats {
  postCount: number;
  reportCount: number;
  labelCount: number;
  recentPosts: NostrEvent[];
  existingLabels: NostrEvent[];
  previousReports: NostrEvent[];
  /** True when the authored-content read did not complete. */
  authoredContentIncomplete: boolean;
  /** True when the labels-against-this-user read did not complete. */
  labelsIncomplete: boolean;
  /** True when the reports-against-this-user read did not complete. */
  reportsIncomplete: boolean;
  /** The report history walk stopped before the relay ran out: the count is a floor, not a total. */
  reportsTruncated: boolean;
  /** As reportsTruncated, for labels. */
  labelsTruncated: boolean;
  /**
   * Aggregate compatibility signal for consumers that treat these stats as a
   * single unit. Read-specific consumers should use the flags above.
   */
  relayIncomplete: boolean;
}

// Report and label history against one account. Paged rather than capped: a
// cap shown as a total told a moderator 50 when the answer was 80. One page
// covers every account on the relay but one today (2,046 of 2,047, 2026-09-16),
// so the common case costs a single read. The page bound is a safety valve that
// is disclosed, never a silent cap.
export const HISTORY_PAGE_SIZE = 100;
export const HISTORY_MAX_PAGES = 10;

export function useUserStats(pubkey: string | undefined) {
  const { nostr } = useNostr();
  const { config } = useAppContext();
  const relayUrl = config.relayUrl;

  return useQuery<UserStats>({
    // relayUrl in the key: the QueryClient is a singleton and these events are
    // shown as evidence, so a cached read must never cross environments.
    queryKey: ['user-stats', relayUrl, pubkey],
    queryFn: async ({ signal }) => {
      if (!pubkey) {
        return {
          postCount: 0,
          reportCount: 0,
          labelCount: 0,
          recentPosts: [],
          existingLabels: [],
          previousReports: [],
          authoredContentIncomplete: false,
          labelsIncomplete: false,
          reportsIncomplete: false,
          reportsTruncated: false,
          labelsTruncated: false,
          relayIncomplete: false,
        };
      }

      // queryStrict throws on anything short of a completed read (timeout, a
      // relay CLOSED, no route). We record that rather than rethrowing: this
      // hook has four other consumers whose behaviour is not in scope to change
      // here, so the failure is reported as a flag and only callers that state
      // absence to a user act on it. Promoting this to a real error is #210.
      const read = async (filters: Parameters<typeof queryStrict>[1]) => {
        try {
          return {
            events: await queryStrict(nostr, filters, { signal, timeoutMs: 8000 }),
            incomplete: false,
          };
        } catch (e) {
          // Only classify as a relay problem what queryStrict actually raises for
          // one. A TypeError from our own code would otherwise be reported to the
          // moderator as "relay error, retry" forever, with nothing logged.
          const isReadFailure =
            e instanceof RelayReadError || (e instanceof DOMException && e.name === 'AbortError');
          if (!isReadFailure) throw e;
          return { events: [], incomplete: true };
        }
      };

      // The whole history for one filter, walked with the shared pager. Failure
      // classification matches `read` exactly: a relay failure becomes a flag,
      // anything else is our own bug and is rethrown.
      const readAll = async (base: Omit<NostrFilter, 'limit' | 'until'>) => {
        try {
          const { events, truncated } = await pageByUntil<NostrEvent>(
            until => queryStrict(
              nostr,
              [{ ...base, limit: HISTORY_PAGE_SIZE, ...(until !== undefined ? { until } : {}) }],
              { signal, timeoutMs: 8000 },
            ),
            { pageSize: HISTORY_PAGE_SIZE, maxPages: HISTORY_MAX_PAGES },
          );
          return { events, incomplete: false, truncated };
        } catch (e) {
          const isReadFailure =
            e instanceof RelayReadError || (e instanceof DOMException && e.name === 'AbortError');
          if (!isReadFailure) throw e;
          return { events: [] as NostrEvent[], incomplete: true, truncated: false };
        }
      };

      // Fetch in parallel
      const [authoredContentRead, labelsRead, reportsRead] = await Promise.all([
        // User's recent authored content — RECENT_CONTENT_KINDS is shared with
        // BannedUserCard so the two review surfaces stay aligned (#159).
        read([{ kinds: [...RECENT_CONTENT_KINDS], authors: [pubkey], limit: 20 }]),
        // Labels against this user: the whole history, not the newest 50.
        readAll({ kinds: [1985], '#p': [pubkey] }),
        // Reports against this user: the whole history, not the newest 50.
        readAll({ kinds: [1984], '#p': [pubkey] }),
      ]);
      const recentPosts = authoredContentRead.events;
      const existingLabels = labelsRead.events;
      const previousReports = reportsRead.events;

      return {
        postCount: recentPosts.length, // Recent authored events of any queried kind (posts, comments, reposts) — not a total
        reportCount: previousReports.length,
        labelCount: existingLabels.length,
        recentPosts: recentPosts.sort((a, b) => b.created_at - a.created_at),
        existingLabels,
        previousReports,
        authoredContentIncomplete: authoredContentRead.incomplete,
        labelsIncomplete: labelsRead.incomplete,
        reportsIncomplete: reportsRead.incomplete,
        reportsTruncated: reportsRead.truncated,
        labelsTruncated: labelsRead.truncated,
        relayIncomplete:
          authoredContentRead.incomplete ||
          labelsRead.incomplete ||
          reportsRead.incomplete,
      };
    },
    enabled: !!pubkey,
    staleTime: 2 * 60_000, // Cache user stats for 2 minutes when switching between reports
  });
}
