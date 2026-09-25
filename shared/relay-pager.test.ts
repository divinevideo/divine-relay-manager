import { describe, it, expect } from 'vitest';
import { pageByUntil, type PagedEvent } from './relay-pager';

// A relay honouring `until` (inclusive) and `limit` over a fixed corpus.
function relay(corpus: PagedEvent[], pageSize: number) {
  const sorted = [...corpus].sort((a, b) => b.created_at - a.created_at);
  const calls: Array<number | undefined> = [];
  const fetchPage = async (until: number | undefined) => {
    calls.push(until);
    const eligible = until === undefined ? sorted : sorted.filter(e => e.created_at <= until);
    return eligible.slice(0, pageSize);
  };
  return { fetchPage, calls };
}

const ev = (n: number, createdAt: number): PagedEvent => ({ id: n.toString(16).padStart(64, '0'), created_at: createdAt });

describe('pageByUntil', () => {
  it('stops at the first short page and reports the walk complete', async () => {
    const { fetchPage, calls } = relay([ev(1, 100), ev(2, 99)], 5);
    const result = await pageByUntil(fetchPage, { pageSize: 5, maxPages: 10 });
    expect(result.events).toHaveLength(2);
    expect(result.truncated).toBe(false);
    expect(result.oldestCovered).toBe(99);
    expect(calls).toEqual([undefined]);
  });

  it('walks past a full page, cursoring on the oldest event it saw', async () => {
    const corpus = Array.from({ length: 7 }, (_, i) => ev(i, 100 - i));
    const { fetchPage, calls } = relay(corpus, 5);
    const result = await pageByUntil(fetchPage, { pageSize: 5, maxPages: 10 });
    expect(calls).toEqual([undefined, 96]);
    expect(result.events.map(e => e.created_at)).toEqual([100, 99, 98, 97, 96, 95, 94]);
  });

  it('returns the boundary event once although `until` sends it back twice', async () => {
    // Review Focus 2: inclusive `until` repeats the oldest event of each page.
    const corpus = Array.from({ length: 7 }, (_, i) => ev(i, 100 - i));
    const { fetchPage } = relay(corpus, 5);
    const result = await pageByUntil(fetchPage, { pageSize: 5, maxPages: 10 });
    const ids = result.events.map(e => e.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('reports truncation when it runs out of pages before the relay runs out of events', async () => {
    const corpus = Array.from({ length: 30 }, (_, i) => ev(i, 1000 - i));
    const { fetchPage } = relay(corpus, 5);
    const result = await pageByUntil(fetchPage, { pageSize: 5, maxPages: 2 });
    expect(result.truncated).toBe(true);
  });

  it('reports truncation when a full page all shares one second and the cursor cannot move', async () => {
    const corpus = Array.from({ length: 8 }, (_, i) => ev(i, 500));
    const { fetchPage } = relay(corpus, 5);
    const result = await pageByUntil(fetchPage, { pageSize: 5, maxPages: 10 });
    expect(result.truncated).toBe(true);
  });

  it('lets a failed page reach the caller instead of reading it as the end', async () => {
    const fetchPage = async () => { throw new Error('relay unconfirmed'); };
    await expect(pageByUntil(fetchPage, { pageSize: 5, maxPages: 10 })).rejects.toThrow('relay unconfirmed');
  });
});
