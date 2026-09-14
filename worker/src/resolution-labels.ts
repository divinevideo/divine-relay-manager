// ABOUTME: Reduces kind-1985 moderation/resolution labels to the distinct
// ABOUTME: target keys the reports queue subtracts as already handled.

export interface LabelTarget {
  type: 'event' | 'pubkey';
  value: string;
}

export interface ResolutionLabelEvent {
  id: string;
  created_at: number;
  tags: string[][];
}

export interface PagedLabelTargets {
  targets: LabelTarget[];
  truncated: boolean;
  oldestCovered: number | null;
}

export type LabelPageFetcher = (until: number | undefined) => Promise<ResolutionLabelEvent[]>;

export const LABEL_PAGE_SIZE = 500;
export const LABEL_MAX_PAGES = 20;

// Walks the relay's resolution labels back through time with an `until` cursor
// until they run out, then projects the whole set down to distinct targets.
//
// Deliberately simpler than the pager in bulk-moderate.ts, which carries a
// saturated-second guard and a strict step-past. That machinery earns its keep
// there because bulk-moderate DELETES, so an event skipped by a stuck cursor is
// destroyed unreviewed. Here the read is projection-only: a label this never
// reaches means its target reads as pending, which is the queue's status quo and
// is disclosed by `truncated` rather than hidden. So a stuck cursor stops and
// reports instead of trying to subdivide the second.
//
// `truncated` is the same safety valve #221 installed: coverage is bounded, but
// a bounded read must never claim to be complete.
export async function pageResolutionLabels(
  fetchPage: LabelPageFetcher,
  opts?: { pageSize?: number; maxPages?: number }
): Promise<PagedLabelTargets> {
  const pageSize = opts?.pageSize ?? LABEL_PAGE_SIZE;
  const maxPages = opts?.maxPages ?? LABEL_MAX_PAGES;

  const collected: ResolutionLabelEvent[] = [];
  let until: number | undefined;
  let oldestCovered: number | null = null;
  let truncated = false;

  for (let page = 0; page < maxPages; page += 1) {
    // No catch, deliberately: see the propagation test. An unconfirmed relay read
    // must reach the caller as a failure, not as a shorter list.
    const events = await fetchPage(until);

    let pageOldest = Infinity;
    for (const event of events) {
      if (typeof event?.created_at === 'number' && event.created_at < pageOldest) {
        pageOldest = event.created_at;
      }
      if (!event) continue;
      collected.push(event);
    }
    if (pageOldest !== Infinity) {
      oldestCovered = oldestCovered === null ? pageOldest : Math.min(oldestCovered, pageOldest);
    }

    // A short page is the relay saying it has nothing older. Exhausted, not capped.
    if (events.length < pageSize) break;

    // Everything below is a reason to stop WITHOUT having reached the end.
    if (page === maxPages - 1) {
      truncated = true;
      break;
    }
    // A full page whose events carry no usable created_at leaves no cursor to
    // advance, and a cursor that did not move means one second holds more than a
    // page of labels. Either way the next request would repeat this one.
    if (pageOldest === Infinity || pageOldest === until) {
      truncated = true;
      break;
    }

    // `until` is inclusive, so the boundary event comes back on the next page.
    //
    // The nostr-pagination convention says to deduplicate by event id. That is
    // satisfied here by reduceLabelsToTargets, which keys by target, so a
    // repeated label collapses into the same entry. An id set in front of it
    // would be a second dedup with no observable effect -- removing it broke no
    // test, which is how it was found. The only cost of the repeat is that it
    // occupies a slot in `collected` until the reduce, which is bounded by the
    // page cap below.
    until = pageOldest;
  }

  return { targets: reduceLabelsToTargets(collected), truncated, oldestCovered };
}

// A label may name an event, an author, or both, and both count independently:
// Reports.tsx added each without preferring one, so an event-scoped resolution
// also resolves its author. Stopping at the first match would quietly stop
// resolving that author side.
//
// Relay payloads are untrusted, so a tag without a value is dropped rather than
// becoming a target key of `event:undefined` that matches nothing.
export function reduceLabelsToTargets(events: ResolutionLabelEvent[]): LabelTarget[] {
  const seen = new Set<string>();
  const targets: LabelTarget[] = [];

  const add = (type: LabelTarget['type'], value: unknown) => {
    if (typeof value !== 'string' || value.length === 0) return;
    const key = `${type}:${value}`;
    if (seen.has(key)) return;
    seen.add(key);
    targets.push({ type, value });
  };

  for (const event of events) {
    const tags = Array.isArray(event?.tags) ? event.tags : [];
    add('event', tags.find((t) => t[0] === 'e')?.[1]);
    add('pubkey', tags.find((t) => t[0] === 'p')?.[1]);
  }

  return targets;
}
