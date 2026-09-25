// ABOUTME: Walks a relay back through time with an inclusive `until` cursor.
// ABOUTME: One pager for the worker's report and label reads and the browser's history reads.

export interface PagedEvent {
  id: string;
  created_at: number;
}

export interface PagedResult<T> {
  events: T[];
  truncated: boolean;
  oldestCovered: number | null;
}

// Fetches pages until one comes back shorter than `pageSize`, which is the relay
// saying it has nothing older (NIP-01: `limit` is a maximum). `truncated` is set
// whenever the walk stops for any other reason -- out of pages, or a full page
// that leaves no cursor to advance -- because a bounded read must never claim to
// be complete (#221).
//
// No catch, deliberately: a failed page must reach the caller as a failure, not
// as a shorter list (#186).
//
// `until` is inclusive, so the oldest event of each page comes back on the next
// one. Events are de-duplicated by id: callers that return events (reports)
// would otherwise show the boundary report twice. Events without a string id
// are kept as-is, matching what the label pager did before it moved here.
export async function pageByUntil<T extends PagedEvent>(
  fetchPage: (until: number | undefined) => Promise<T[]>,
  opts: { pageSize: number; maxPages: number },
): Promise<PagedResult<T>> {
  const seen = new Set<string>();
  const events: T[] = [];
  let until: number | undefined;
  let oldestCovered: number | null = null;
  let truncated = false;

  for (let page = 0; page < opts.maxPages; page += 1) {
    const batch = await fetchPage(until);

    let pageOldest = Infinity;
    for (const event of batch) {
      if (!event) continue;
      if (typeof event.created_at === 'number' && event.created_at < pageOldest) {
        pageOldest = event.created_at;
      }
      if (typeof event.id === 'string') {
        if (seen.has(event.id)) continue;
        seen.add(event.id);
      }
      events.push(event);
    }
    if (pageOldest !== Infinity) {
      oldestCovered = oldestCovered === null ? pageOldest : Math.min(oldestCovered, pageOldest);
    }

    if (batch.length < opts.pageSize) break;

    if (page === opts.maxPages - 1) {
      truncated = true;
      break;
    }
    // A full page with no usable created_at, or one whose oldest event is the
    // cursor itself, means the next request would repeat this one.
    if (pageOldest === Infinity || pageOldest === until) {
      truncated = true;
      break;
    }
    until = pageOldest;
  }

  return { events, truncated, oldestCovered };
}
