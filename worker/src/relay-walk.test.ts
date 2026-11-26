import { describe, it, expect, vi } from 'vitest';
import { finalizeEvent, generateSecretKey, type Event as NostrEvent } from 'nostr-tools';
import { walkRelayEvents, type WalkOptions } from './relay-walk';

const sk = generateSecretKey();
let counter = 0;

function signed(created_at: number, kind = 1984): NostrEvent {
  counter += 1;
  return finalizeEvent({ kind, created_at, tags: [['n', String(counter)]], content: `r${counter}` }, sk);
}

// An in-memory relay: newest first, inclusive until/since, `cap` models a relay
// that returns fewer rows than the requested limit.
function relayOver(corpus: NostrEvent[], cap = Infinity) {
  const requests: Record<string, unknown>[] = [];
  const fetchPage = vi.fn(async (filter: Record<string, unknown>) => {
    requests.push(filter);
    const until = filter.until as number | undefined;
    const since = filter.since as number | undefined;
    return corpus
      .filter((e) => (filter.kinds as number[]).includes(e.kind))
      .filter((e) => (until === undefined || e.created_at <= until) && (since === undefined || e.created_at >= since))
      .sort((a, b) => b.created_at - a.created_at || (a.id < b.id ? -1 : 1))
      .slice(0, Math.min(filter.limit as number, cap));
  });
  return { fetchPage, requests };
}

function opts(fetchPage: WalkOptions['fetchPage'], extra: Partial<WalkOptions> = {}): WalkOptions {
  return { relayUrl: 'wss://relay.invalid', filter: {}, kind: 1984, pageSize: 5, maxPages: 50, pageTimeoutMs: 15000, fetchPage, ...extra };
}

async function collect(o: WalkOptions) {
  const got: NostrEvent[] = [];
  const result = await walkRelayEvents<NostrEvent>(o, async (events) => {
    got.push(...events);
  });
  return { got, result };
}

const series = (n: number, start = 1000) => Array.from({ length: n }, (_, i) => signed(start + i));

describe('walkRelayEvents', () => {
  it('ends only on a page that adds no new ids', async () => {
    const corpus = series(7);
    const { fetchPage, requests } = relayOver(corpus);
    const { got, result } = await collect(opts(fetchPage));
    const byAge = [...corpus].sort((a, b) => b.created_at - a.created_at);
    expect(requests).toHaveLength(3);
    expect(requests[0].until).toBeUndefined();
    expect(requests[1].until).toBe(byAge[4].created_at);
    expect(requests[2].until).toBe(byAge[6].created_at);
    expect(got.map((e) => e.id).sort()).toEqual(corpus.map((e) => e.id).sort());
    expect(result).toEqual({ complete: true, truncated: false, pages: 3, rejected: 0 });
  });

  it('collects everything when the relay caps limit below the page size', async () => {
    const corpus = series(11);
    const { fetchPage } = relayOver(corpus, 3);
    const { got, result } = await collect(opts(fetchPage));
    expect(got).toHaveLength(11);
    expect(new Set(got.map((e) => e.id)).size).toBe(11);
    expect(result.complete).toBe(true);
    expect(result.truncated).toBe(false);
  });

  it('continues past a short page that is not the end', async () => {
    const corpus = series(9);
    const dropped = [...corpus].sort((a, b) => b.created_at - a.created_at)[2];
    let first = true;
    const fetchPage = vi.fn(async (filter: Record<string, unknown>) => {
      const rows = await relayOver(corpus).fetchPage(filter);
      if (first) {
        first = false;
        return rows.filter((e) => e.id !== dropped.id);
      }
      return rows;
    });
    const { got, result } = await collect(opts(fetchPage));
    expect(got).toHaveLength(8);
    expect(got.filter((e) => e.created_at < dropped.created_at)).toHaveLength(6);
    expect(result.complete).toBe(true);
  });

  it('throws on a failed page and requests nothing more', async () => {
    const corpus = series(12);
    const rel = relayOver(corpus);
    let n = 0;
    const fetchPage = vi.fn(async (filter: Record<string, unknown>) => {
      n += 1;
      if (n === 2) throw new Error('Relay query timed out before EOSE');
      return rel.fetchPage(filter);
    });
    await expect(collect(opts(fetchPage))).rejects.toThrow(/timed out/);
    expect(fetchPage).toHaveBeenCalledTimes(2);
  });

  it('stops truncated when one second fills a whole page', async () => {
    const corpus = [...Array.from({ length: 8 }, () => signed(2000)), signed(1000)];
    const { fetchPage, requests } = relayOver(corpus);
    const { result, got } = await collect(opts(fetchPage));
    expect(result.truncated).toBe(true);
    expect(result.complete).toBe(false);
    expect(result.stopReason).toBe('saturated_second');
    expect(requests.length).toBeLessThanOrEqual(2);
    expect(got.length).toBeGreaterThan(0);
  });

  it('does not read a full page of already-seen rows plus a few new ones in an older second as saturated', async () => {
    // A full page whose new rows all share one second is not a saturated
    // second when the page also holds seen rows from a newer second.
    const corpus = [
      signed(2005),
      ...Array.from({ length: 4 }, () => signed(2000)),
      signed(1999), signed(1999),
    ];
    const { fetchPage } = relayOver(corpus);
    const { result, got } = await collect(opts(fetchPage));
    expect(got.map(e => e.id).sort()).toEqual(corpus.map(e => e.id).sort());
    expect(result).toMatchObject({ complete: true, truncated: false });
  });

  it('stops truncated at maxPages', async () => {
    const { fetchPage } = relayOver(series(40));
    const { result } = await collect(opts(fetchPage, { maxPages: 3 }));
    expect(result).toMatchObject({ complete: false, truncated: true, pages: 3, stopReason: 'page_cap' });
    expect(fetchPage).toHaveBeenCalledTimes(3);
  });

  it('sends since and an inclusive until, and kinds [kind]', async () => {
    const { fetchPage, requests } = relayOver(series(7));
    await collect(opts(fetchPage, { since: 1002, until: 1005, filter: { '#p': ['abc'] } }));
    expect(requests[0]).toEqual({ '#p': ['abc'], kinds: [1984], limit: 5, since: 1002, until: 1005 });
    // Later pages keep since and cursor on the page's oldest second, inclusive.
    expect(requests[1]).toMatchObject({ since: 1002, until: 1002 });
  });

  it('rejects events that fail verification or have another kind, counting them', async () => {
    const good = series(3);
    // JSON round trip drops nostr-tools' cached verified flag, as a real relay frame does.
    const tampered = { ...JSON.parse(JSON.stringify(signed(1500))), content: 'changed after signing' } as NostrEvent;
    const wrongKind = signed(1501, 7);
    const corpus = [...good, tampered, wrongKind];
    const fetchPage = vi.fn(async (filter: Record<string, unknown>) => {
      const until = filter.until as number | undefined;
      return corpus.filter((e) => until === undefined || e.created_at <= until).sort((a, b) => b.created_at - a.created_at).slice(0, 10);
    });
    const { got, result } = await collect(opts(fetchPage, { pageSize: 10 }));
    expect(got.map((e) => e.id).sort()).toEqual(good.map((e) => e.id).sort());
    expect(result.rejected).toBe(2);
    expect(result.complete).toBe(true);
  });

  it('ends complete when a same-second burst is split across the last page boundary', async () => {
    const corpus = [signed(1010), signed(1011), signed(1012), signed(1000), signed(1000), signed(1000)];
    const { fetchPage } = relayOver(corpus);
    const { got, result } = await collect(opts(fetchPage));
    expect(got).toHaveLength(6);
    expect(result).toEqual({ complete: true, truncated: false, pages: 3, rejected: 0 });
  });

  it('ends complete when the window holds only events in the caller until second', async () => {
    const corpus = [signed(1000), signed(1000)];
    const { fetchPage } = relayOver(corpus);
    const { got, result } = await collect(opts(fetchPage, { until: 1000 }));
    expect(got).toHaveLength(2);
    expect(result.complete).toBe(true);
    expect(result.truncated).toBe(false);
  });

  it('stops truncated when a capped relay cannot return a whole second it has shown to be capped', async () => {
    const corpus = [signed(3003), signed(3002), signed(3001), signed(3000), ...Array.from({ length: 5 }, () => signed(1000))];
    const { fetchPage } = relayOver(corpus, 3);
    const { result } = await collect(opts(fetchPage));
    expect(result.truncated).toBe(true);
    expect(result.complete).toBe(false);
    expect(result.stopReason).toBe('evidenced_cap');
  });

  it('stops truncated with no cursor when a page carries no usable timestamps', async () => {
    const fetchPage = vi.fn(async () => [{ id: 'f'.repeat(64), kind: 1984 }]);
    const { result } = await collect(opts(fetchPage));
    expect(result).toMatchObject({ complete: false, truncated: true, pages: 1, stopReason: 'no_cursor' });
  });

  it('does not read a plain end as truncated when a page was merely short', async () => {
    const corpus = [signed(2000), signed(1999), signed(1998), signed(1000), signed(1000)];
    const { fetchPage } = relayOver(corpus);
    const { result } = await collect(opts(fetchPage, { pageSize: 4 }));
    expect(result.complete).toBe(true);
    expect(result.truncated).toBe(false);
  });

  it('keeps the genuine copy when a tampered copy of the same id arrived first', async () => {
    const a = signed(1005);
    const g = signed(1004);
    const b = signed(1003);
    const tamperedG = { ...JSON.parse(JSON.stringify(g)), content: 'changed after signing' } as NostrEvent;
    const pages: unknown[][] = [[a, tamperedG], [g, b], [b]];
    let i = 0;
    const fetchPage = vi.fn(async () => pages[i++] ?? []);
    const { got, result } = await collect(opts(fetchPage, { pageSize: 2 }));
    expect(got.map((e) => e.id).sort()).toEqual([a.id, g.id, b.id].sort());
    expect(result.rejected).toBe(1);
    expect(result.complete).toBe(true);
  });
});
