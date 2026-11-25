// ABOUTME: Walks a window of a relay's events of one kind, newest first, with an inclusive `until` cursor.
// ABOUTME: Ends only on a page that adds nothing new, so a relay that caps `limit` is never mistaken for the end.

import { verifyEvent, type Event as NostrEvent } from 'nostr-tools';
import { queryRelay, RELAY_WALK_PAGE_TIMEOUT_MS } from './relay-profile';

export { RELAY_WALK_PAGE_TIMEOUT_MS };

export interface WalkOptions {
  relayUrl: string;
  filter: Record<string, unknown>;
  kind: number;
  since?: number;
  until?: number;
  // Must not exceed the relay's maximum `limit` (funnelcake MAX_LIMIT, default
  // 5000, advertised in NIP-11 limitation.max_limit). A relay that silently caps
  // below pageSize cannot be fully detected from the replies; the cap-evidence
  // rule in walkRelayEvents is best effort only.
  pageSize: number;
  maxPages: number;
  pageTimeoutMs: number;
  // Test seam. The default asks the relay and throws on an unconfirmed read.
  fetchPage?: (filter: Record<string, unknown>) => Promise<unknown[]>;
}

/**
 * Why a walk stopped truncated. Only `page_cap` can be resumed from its
 * cursor; the others mean the cursor cannot move below the second it ended on.
 */
export type WalkStopReason = 'page_cap' | 'saturated_second' | 'evidenced_cap' | 'no_cursor';

export interface WalkResult {
  complete: boolean;
  truncated: boolean;
  pages: number;
  rejected: number;
  /** Set only when truncated. */
  stopReason?: WalkStopReason;
}

// Never retries: the relay keeps running an abandoned query for up to 30s, so a
// retry piles load onto the very relay that was too slow. A failed page fails the
// walk (#186) rather than shortening it.
function defaultFetchPage(relayUrl: string, pageTimeoutMs: number) {
  return async (filter: Record<string, unknown>): Promise<unknown[]> => {
    const result = await queryRelay(filter, relayUrl, { timeoutMs: pageTimeoutMs });
    if (!result.success) throw new Error(result.error || 'Relay query failed');
    return result.events || [];
  };
}

function isCandidate(value: unknown, kind: number): value is NostrEvent {
  if (!value || typeof value !== 'object') return false;
  const e = value as Partial<NostrEvent>;
  if (e.kind !== kind || typeof e.id !== 'string') return false;
  try {
    return verifyEvent(value as NostrEvent);
  } catch {
    return false;
  }
}

/**
 * Walks the window newest first. A page ends the walk only when it adds no id
 * not already seen; a short page proves nothing, because a relay may return
 * fewer rows than `limit` (NIP-01: `limit` is a maximum). `onPage` is awaited
 * before the next page and receives the page's verified events plus the
 * inclusive cursor (its oldest second) to resume from.
 *
 * The walk stops `truncated`, never `complete`, when it cannot prove it reached
 * the end: it ran out of pages, or a full page lies entirely in one second (more
 * events share that second than a page returns, and `until` cannot step inside
 * a second). Best effort, not a proof: once a short page has been followed by
 * older rows (evidence the relay caps `limit` below pageSize), a zero-new page
 * lying in the cursor second that is at least as big as that evidenced cap is
 * also treated as truncated. A cap that was never evidenced is not detected.
 */
export async function walkRelayEvents<T extends { id: string; created_at: number }>(
  opts: WalkOptions,
  onPage: (events: T[], nextUntil: number) => Promise<void>,
): Promise<WalkResult> {
  const fetchPage = opts.fetchPage ?? defaultFetchPage(opts.relayUrl, opts.pageTimeoutMs);
  // Ids of events that verified. A rejected copy is remembered separately (by its
  // whole content) so a tampered copy neither counts as new on every page nor
  // shadows a genuine copy of the same id arriving later.
  const seen = new Set<string>();
  const seenBad = new Set<string>();
  let until = opts.until;
  let pages = 0;
  let rejected = 0;
  // Length of the previous page when it was short but added rows, and the largest
  // such length a later page proved too small (older new rows followed it).
  let prevShort: { length: number; oldest: number } | null = null;
  let evidencedCap = 0;

  while (pages < opts.maxPages) {
    const filter: Record<string, unknown> = { ...opts.filter, kinds: [opts.kind], limit: opts.pageSize };
    if (opts.since !== undefined) filter.since = opts.since;
    if (until !== undefined) filter.until = until;

    const batch = await fetchPage(filter);
    pages += 1;

    const fresh: T[] = [];
    let newIds = 0;
    let oldest = Infinity;
    let newest = -Infinity;
    let olderThanPrev = false;
    for (const raw of batch) {
      const id = raw && typeof raw === 'object' ? (raw as { id?: unknown }).id : undefined;
      if (typeof id === 'string' && seen.has(id)) continue;
      const badKey = JSON.stringify(raw) ?? String(raw);
      if (seenBad.has(badKey)) continue;
      newIds += 1;
      const createdAt = raw && typeof raw === 'object' ? (raw as { created_at?: unknown }).created_at : undefined;
      if (typeof createdAt === 'number' && Number.isFinite(createdAt)) {
        oldest = Math.min(oldest, createdAt);
        newest = Math.max(newest, createdAt);
        if (prevShort && createdAt < prevShort.oldest) olderThanPrev = true;
      }
      if (isCandidate(raw, opts.kind)) {
        seen.add((raw as NostrEvent).id);
        fresh.push(raw as unknown as T);
      } else {
        seenBad.add(badKey);
        rejected += 1;
      }
    }

    if (prevShort && olderThanPrev) evidencedCap = Math.max(evidencedCap, prevShort.length);

    if (newIds === 0) {
      const lies = batch.length > 0 && until !== undefined && batch.every((e) => (e as { created_at?: unknown } | null)?.created_at === until);
      if (lies && evidencedCap > 0 && batch.length >= evidencedCap) {
        return { complete: false, truncated: true, pages, rejected, stopReason: 'evidenced_cap' };
      }
      return { complete: true, truncated: false, pages, rejected };
    }

    // No usable cursor: cannot continue without risking a loop or a gap.
    if (oldest === Infinity) return { complete: false, truncated: true, pages, rejected, stopReason: 'no_cursor' };

    await onPage(fresh, oldest);

    // A full page entirely inside one second: rows beyond the page share that
    // second and the cursor cannot reach them.
    if (batch.length >= opts.pageSize && oldest === newest) {
      return { complete: false, truncated: true, pages, rejected, stopReason: 'saturated_second' };
    }

    prevShort = batch.length < opts.pageSize ? { length: batch.length, oldest } : null;
    until = oldest;
  }
  return { complete: false, truncated: true, pages, rejected, stopReason: 'page_cap' };
}
