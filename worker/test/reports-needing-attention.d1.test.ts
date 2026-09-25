// worker/test/reports-needing-attention.d1.test.ts
// Real handler, real D1 (Miniflare), fake relay. The unit tests drive the pieces
// through injected inputs; this is the only place the relay filter's `limit`,
// the pager, the D1 projections and the label walk meet.
import { Miniflare } from 'miniflare';
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { ensureSchema } from '../src/db';
import worker from '../src/index';
import { REPORTS_PAGE_SIZE } from '../src/reports-filter';
import { getReportsNeedingAttention, getResolvedReportsPage } from '../src/reports-needing-attention';

let mf: Miniflare;
let DB: D1Database;
const ctx = {} as ExecutionContext;

beforeAll(async () => {
  mf = new Miniflare({
    modules: true,
    script: 'export default { fetch() { return new Response("ok"); } };',
    compatibilityDate: '2024-12-01',
    compatibilityFlags: ['nodejs_compat'],
    d1Databases: ['DB'],
  });
  DB = (await mf.getD1Database('DB')) as unknown as D1Database;
  await ensureSchema(DB);
});

afterAll(async () => {
  await mf?.dispose();
});

beforeEach(async () => {
  await DB.exec('DELETE FROM moderation_decisions');
});

afterEach(() => {
  vi.unstubAllGlobals();
});

type RelayEvent = { id: string; created_at: number; kind: number; tags: string[][] };
type SeenFilter = { kinds?: number[]; limit?: number; until?: number; '#e'?: string[]; '#p'?: string[] };

// A relay honouring kinds, #e, #p, limit and until (inclusive) over a fixed
// corpus, recording every filter it was sent. `closeKind` makes every read of
// that kind end in CLOSED, which queryRelay reports as an unconfirmed read.
function stubRelay(corpus: RelayEvent[], opts: { closeKind?: number } = {}) {
  const filters: SeenFilter[] = [];
  const sorted = [...corpus].sort((a, b) => b.created_at - a.created_at);

  class FakeWebSocket {
    private listeners = new Map<string, Array<(event: unknown) => void>>();
    constructor(_url: string) {
      setTimeout(() => this.emit('open', {}), 0);
    }
    addEventListener(type: string, listener: (event: unknown) => void) {
      if (!this.listeners.has(type)) this.listeners.set(type, []);
      this.listeners.get(type)!.push(listener);
    }
    send(raw: string) {
      const [, subId, filter] = JSON.parse(raw) as [string, string, SeenFilter];
      filters.push(filter);
      if (opts.closeKind !== undefined && filter.kinds?.includes(opts.closeKind)) {
        setTimeout(() => this.emit('message', { data: JSON.stringify(['CLOSED', subId, 'error: test']) }), 0);
        return;
      }
      const matches = sorted.filter(e =>
        (!filter.kinds || filter.kinds.includes(e.kind))
        && (filter.until === undefined || e.created_at <= filter.until)
        && (!filter['#e'] || e.tags.some(t => t[0] === 'e' && filter['#e']!.includes(t[1])))
        && (!filter['#p'] || e.tags.some(t => t[0] === 'p' && filter['#p']!.includes(t[1]))));
      const page = matches.slice(0, filter.limit ?? matches.length);
      setTimeout(() => {
        for (const ev of page) this.emit('message', { data: JSON.stringify(['EVENT', subId, ev]) });
        this.emit('message', { data: JSON.stringify(['EOSE', subId]) });
      }, 0);
    }
    close() { /* no-op */ }
    private emit(type: string, event: unknown) {
      for (const handler of this.listeners.get(type) || []) handler(event);
    }
  }
  vi.stubGlobal('WebSocket', FakeWebSocket as never);
  return filters;
}

const id = (n: number) => n.toString(16).padStart(64, '0');
const report = (n: number, createdAt: number, tags: string[][]): RelayEvent => ({ id: id(n), created_at: createdAt, kind: 1984, tags });
const label = (n: number, createdAt: number, target: string[]): RelayEvent => ({
  id: id(1_000_000 + n), created_at: createdAt, kind: 1985,
  tags: [['L', 'moderation/resolution'], ['l', 'resolved', 'moderation/resolution'], target],
});

async function decide(targetType: string, targetId: string, action: string) {
  await DB.prepare('INSERT INTO moderation_decisions (target_type, target_id, action, created_at) VALUES (?, ?, ?, ?)')
    .bind(targetType, targetId, action, '2026-01-01 00:00:00').run();
}

function env(withDb = true) {
  return {
    ALLOWED_ORIGINS: 'https://app.divine.video',
    RELAY_URL: 'wss://relay.divine.video',
    ADMIN_API_KEY: 'test-admin-key',
    ...(withDb ? { DB } : {}),
  } as never;
}

async function get(path: string, withDb = true) {
  return worker.fetch(new Request(`https://api.example${path}`, { headers: { 'X-Admin-Key': 'test-admin-key' } }), env(withDb), ctx);
}

const E = (n: number) => 'e'.repeat(63) + n.toString(16);
const P1 = 'a'.repeat(64);

describe('GET /api/reports needs-attention mode, against real D1', () => {
  it('leaves the legacy bulk read exactly as it was', async () => {
    const filters = stubRelay([report(1, 100, [['e', E(1)]])]);
    const body = await (await get('/api/reports')).json() as Record<string, unknown>;
    expect(filters).toEqual([{ kinds: [1984], limit: 200 }]);
    expect(Object.keys(body).sort()).toEqual(['events', 'success']);
  });

  it('returns unresolved and pending-review targets, and drops resolved ones', async () => {
    stubRelay([
      report(1, 100, [['e', E(1)]]),        // unresolved
      report(2, 99, [['e', E(2)]]),         // resolved by a decision
      report(3, 98, [['e', E(3)]]),         // resolved by a label
      report(4, 97, [['e', E(4)]]),         // auto-hidden only: never counted as resolved
      report(5, 96, [['e', E(5)]]),         // resolved by a label AND pending review
      report(6, 95, [['p', P1]]),           // unresolved account report
      label(1, 50, ['e', E(3)]),
      label(2, 49, ['e', E(5)]),
    ]);
    await decide('event', E(2), 'reviewed');
    await decide('event', E(4), 'auto_hidden');
    await decide('event', E(5), 'auto_hidden');

    const body = await (await get('/api/reports?needs_attention=1')).json() as {
      success: boolean; events: RelayEvent[]; counts: { targets: number; resolved: number };
      truncated: boolean; resolution_truncated: boolean; oldest_covered: number | null;
    };

    expect(body.success).toBe(true);
    expect(body.events.map(e => e.id).sort()).toEqual([id(1), id(4), id(5), id(6)].sort());
    expect(body.counts).toEqual({ targets: 4, resolved: 2 });
    expect(body.truncated).toBe(false);
    expect(body.resolution_truncated).toBe(false);
    expect(body.oldest_covered).toBe(95);
  });

  it('asks the relay for the page size its pager treats as full, and walks past a full page', async () => {
    const corpus = Array.from({ length: REPORTS_PAGE_SIZE + 3 }, (_, i) => report(i, 1_760_000_000 - i, [['e', E(i % 7)]]));
    const filters = stubRelay(corpus);

    const body = await (await get('/api/reports?needs_attention=1')).json() as { events: RelayEvent[] };

    const reportReads = filters.filter(f => f.kinds?.includes(1984));
    expect(reportReads[0].limit).toBe(REPORTS_PAGE_SIZE);
    expect(reportReads).toHaveLength(2);
    expect(body.events).toHaveLength(REPORTS_PAGE_SIZE + 3);
  });

  it('fails the request when a report page is unconfirmed', async () => {
    stubRelay([report(1, 100, [['e', E(1)]])], { closeKind: 1984 });
    const res = await get('/api/reports?needs_attention=1');
    expect(res.status).toBe(502);
  });

  it('fails the request when a label page is unconfirmed', async () => {
    stubRelay([report(1, 100, [['e', E(1)]])], { closeKind: 1985 });
    const res = await get('/api/reports?needs_attention=1');
    expect(res.status).toBe(502);
  });

  it('refuses to answer without the database rather than returning an unfiltered set', async () => {
    stubRelay([report(1, 100, [['e', E(1)]])]);
    const res = await get('/api/reports?needs_attention=1', false);
    expect(res.status).toBe(503);
  });

  it('creates the D1 schema on a database that has never been migrated, matching handleGetResolutionState', async () => {
    stubRelay([]);
    // A separate, unmigrated D1 -- ensureSchema was never called on it, unlike
    // the shared `DB` this file's beforeAll sets up. `schemaReady` in index.ts
    // is module-level, so once any earlier test reaches ensureSchemaOnce it
    // becomes a no-op for every request after -- including one against a
    // different, unmigrated database. vi.resetModules() forces a cold isolate
    // so this only passes if THIS request is what creates the schema.
    const freshMf = new Miniflare({
      modules: true,
      script: 'export default { fetch() { return new Response("ok"); } };',
      compatibilityDate: '2024-12-01',
      compatibilityFlags: ['nodejs_compat'],
      d1Databases: ['DB'],
    });
    try {
      const freshDb = (await freshMf.getD1Database('DB')) as unknown as D1Database;
      vi.resetModules();
      const freshWorker = (await import('../src/index')).default;
      const res = await freshWorker.fetch(
        new Request('https://api.example/api/reports?needs_attention=1', {
          headers: { 'X-Admin-Key': 'test-admin-key' },
        }),
        {
          ALLOWED_ORIGINS: 'https://app.divine.video',
          RELAY_URL: 'wss://relay.divine.video',
          ADMIN_API_KEY: 'test-admin-key',
          DB: freshDb,
        } as never,
        ctx,
      );
      expect(res.status).toBe(200);
      const body = await res.json() as { success: boolean; events: RelayEvent[] };
      expect(body.success).toBe(true);
      expect(body.events).toEqual([]);
    } finally {
      await freshMf.dispose();
    }
  });

  it('fails the request, not with a shorter list, when the D1 resolved-targets read fails', async () => {
    stubRelay([report(1, 100, [['e', E(1)]])]);
    // A fresh, migrated D1 with its `moderation_decisions` table dropped out
    // from under it afterward, isolated from the shared `DB` so this doesn't
    // leave the suite's database broken for later tests.
    const brokenMf = new Miniflare({
      modules: true,
      script: 'export default { fetch() { return new Response("ok"); } };',
      compatibilityDate: '2024-12-01',
      compatibilityFlags: ['nodejs_compat'],
      d1Databases: ['DB'],
    });
    try {
      const brokenDb = (await brokenMf.getD1Database('DB')) as unknown as D1Database;
      await ensureSchema(brokenDb);
      await brokenDb.exec('DROP TABLE moderation_decisions');

      const { status, body } = await getReportsNeedingAttention(brokenDb, 'wss://relay.divine.video');
      expect(status).not.toBe(200);
      expect((body as { success: boolean }).success).toBe(false);
    } finally {
      await brokenMf.dispose();
    }
  });

  describe('truncation flags point in the direction that failed', () => {
    it('a report walk that hits its page cap sets truncated but not resolution_truncated', async () => {
      // Page size 2, one page allowed: the first page comes back full (2 of 3),
      // so the walk stops at its cap rather than the relay running dry.
      stubRelay([
        report(1, 100, [['e', E(1)]]),
        report(2, 99, [['e', E(2)]]),
        report(3, 98, [['e', E(3)]]),
      ]);

      const { body } = await getReportsNeedingAttention(DB, 'wss://relay.divine.video', {
        reportsPaging: { pageSize: 2, maxPages: 1 },
      });

      expect(body.truncated).toBe(true);
      expect(body.resolution_truncated).toBe(false);
    });

    it('a label walk that hits its page cap sets resolution_truncated but not truncated', async () => {
      // Report corpus fits in the default single page; the label corpus does
      // not fit in a one-event, one-page cap, so only the label walk stops early.
      stubRelay([
        report(1, 100, [['e', E(1)]]),
        label(1, 50, ['e', E(2)]),
        label(2, 49, ['e', E(3)]),
      ]);

      const { body } = await getReportsNeedingAttention(DB, 'wss://relay.divine.video', {
        labelsPaging: { pageSize: 1, maxPages: 1 },
      });

      expect(body.truncated).toBe(false);
      expect(body.resolution_truncated).toBe(true);
    });
  });
});

describe('GET /api/reports single-target lookups', () => {
  it('returns every report for one account, past the old cap of 200', async () => {
    stubRelay(Array.from({ length: 250 }, (_, i) => report(i, 1_760_000_000 - i, [['p', P1]])));
    const body = await (await get(`/api/reports?pubkey=${P1}`)).json() as { events: RelayEvent[]; truncated: boolean };
    expect(body.events).toHaveLength(250);
    expect(body.truncated).toBe(false);
  });

  it('returns a resolved target, and does not need the database to do it', async () => {
    // The deep-link fallback relies on this to tell "gone" from "still loading".
    stubRelay([report(1, 100, [['e', E(1)]]), label(1, 50, ['e', E(1)])]);
    const res = await get(`/api/reports?event=${E(1)}&needs_attention=1`, false);
    const body = await res.json() as { events: RelayEvent[] };
    expect(res.status).toBe(200);
    expect(body.events.map(e => e.id)).toEqual([id(1)]);
  });

  it('fails a lookup whose page is unconfirmed', async () => {
    stubRelay([report(1, 100, [['p', P1]])], { closeKind: 1984 });
    expect((await get(`/api/reports?pubkey=${P1}`)).status).toBe(502);
  });
});

describe('GET /api/reports/resolved', () => {
  it('returns only reports the worker resolved, and a cursor when the page was full', async () => {
    stubRelay([
      report(1, 100, [['e', E(1)]]),   // resolved by a decision
      report(2, 99, [['e', E(2)]]),    // unresolved: belongs to the queue, not here
      report(3, 98, [['e', E(3)]]),    // resolved but pending review: the queue shows it
      report(4, 97, [['e', E(4)]]),    // resolved by a label
      label(1, 50, ['e', E(4)]),
    ]);
    await decide('event', E(1), 'reviewed');
    await decide('event', E(3), 'reviewed');
    await decide('event', E(3), 'auto_hidden');

    const body = await (await get('/api/reports/resolved?limit=4')).json() as {
      events: RelayEvent[]; next_cursor: number | null; done: boolean; skipped_within_second: boolean;
    };

    expect(body.events.map(e => e.id)).toEqual([id(1), id(4)]);
    expect(body.next_cursor).toBe(97);
    expect(body.done).toBe(false);
    expect(body.skipped_within_second).toBe(false);
  });

  it('reads the page ending at the cursor, and says done when the relay runs out', async () => {
    const filters = stubRelay([report(1, 100, [['e', E(1)]]), report(2, 90, [['e', E(2)]])]);
    await decide('event', E(2), 'reviewed');

    const body = await (await get('/api/reports/resolved?cursor=95&limit=10')).json() as {
      events: RelayEvent[]; next_cursor: number | null; done: boolean;
    };

    const reportRead = filters.find(f => f.kinds?.includes(1984))!;
    expect(reportRead).toEqual({ kinds: [1984], limit: 10, until: 95 });
    expect(body.events.map(e => e.id)).toEqual([id(2)]);
    expect(body.next_cursor).toBeNull();
    expect(body.done).toBe(true);
  });

  it('defaults to 200 per page and never reads more than 500', async () => {
    const filters = stubRelay([]);
    await get('/api/reports/resolved');
    await get('/api/reports/resolved?limit=9000');
    const reportReads = filters.filter(f => f.kinds?.includes(1984));
    expect(reportReads.map(f => f.limit)).toEqual([200, 500]);
  });

  it('steps past a second that fills a whole page, and says so', async () => {
    // Review Focus 5: an `until` cursor cannot advance inside one second.
    stubRelay(Array.from({ length: 3 }, (_, i) => report(i, 500, [['e', E(i)]])));
    const body = await (await get('/api/reports/resolved?cursor=500&limit=3')).json() as {
      next_cursor: number | null; done: boolean; skipped_within_second: boolean;
    };
    expect(body.next_cursor).toBe(499);
    expect(body.done).toBe(false);
    expect(body.skipped_within_second).toBe(true);
  });

  it('rejects a cursor that is not a whole number of seconds', async () => {
    stubRelay([]);
    expect((await get('/api/reports/resolved?cursor=yesterday')).status).toBe(400);
  });

  it('fails without the database, and on an unconfirmed page', async () => {
    stubRelay([]);
    expect((await get('/api/reports/resolved', false)).status).toBe(503);
    stubRelay([report(1, 100, [['e', E(1)]])], { closeKind: 1984 });
    expect((await get('/api/reports/resolved')).status).toBe(502);
  });

  it('fails the request when the label page is unconfirmed', async () => {
    stubRelay([report(1, 100, [['e', E(1)]])], { closeKind: 1985 });
    expect((await get('/api/reports/resolved')).status).toBe(502);
  });

  it('fails the request, not with a shorter list, when the D1 resolved-targets read fails', async () => {
    stubRelay([report(1, 100, [['e', E(1)]])]);
    // A fresh, migrated D1 with its `moderation_decisions` table dropped out
    // from under it afterward, isolated from the shared `DB` so this doesn't
    // leave the suite's database broken for later tests.
    const brokenMf = new Miniflare({
      modules: true,
      script: 'export default { fetch() { return new Response("ok"); } };',
      compatibilityDate: '2024-12-01',
      compatibilityFlags: ['nodejs_compat'],
      d1Databases: ['DB'],
    });
    try {
      const brokenDb = (await brokenMf.getD1Database('DB')) as unknown as D1Database;
      await ensureSchema(brokenDb);
      await brokenDb.exec('DROP TABLE moderation_decisions');

      const { status, body } = await getResolvedReportsPage(new URLSearchParams(), brokenDb, 'wss://relay.divine.video');
      expect(status).not.toBe(200);
      expect((body as { success: boolean }).success).toBe(false);
    } finally {
      await brokenMf.dispose();
    }
  });

  it('falls back to the default page size for a zero, negative, or non-numeric limit', async () => {
    const filters = stubRelay([]);
    await get('/api/reports/resolved?limit=0');
    await get('/api/reports/resolved?limit=-5');
    await get('/api/reports/resolved?limit=abc');
    const reportReads = filters.filter(f => f.kinds?.includes(1984));
    expect(reportReads.map(f => f.limit)).toEqual([200, 200, 200]);
  });

  it('says not done and gives no cursor when a full page has no usable created_at', async () => {
    // Neither report has a numeric created_at, so nothing can anchor the next
    // cursor. That is not the same as the relay running out: `done` must stay
    // false so the screen says history could not be followed, not that it ended.
    const bad = (n: number, tags: string[][]) => ({ ...report(n, 100, tags), created_at: 'unknown' as unknown as number });
    stubRelay([bad(1, [['e', E(1)]]), bad(2, [['e', E(2)]])]);

    const body = await (await get('/api/reports/resolved?limit=2')).json() as {
      next_cursor: number | null; done: boolean;
    };

    expect(body.done).toBe(false);
    expect(body.next_cursor).toBeNull();
  });

  it('ignores a fractional created_at when choosing the next cursor', async () => {
    // M1: a non-integer created_at must not become next_cursor, since the
    // cursor is re-sent as `cursor=<n>` and rejected by the whole-seconds check.
    stubRelay([
      report(1, 90.5, [['e', E(1)]]),
      report(2, 100, [['e', E(2)]]),
    ]);

    const body = await (await get('/api/reports/resolved?limit=2')).json() as { next_cursor: number | null };

    expect(body.next_cursor).toBe(100);
  });

  it('says done, with no cursor, when stepping back within second 0', async () => {
    // M1: a full page all in second 0 cannot step to -1, which the whole-seconds
    // check would reject. There is nothing older than second 0, so this is the
    // end, and the skip that produced it is still reported.
    stubRelay(Array.from({ length: 3 }, (_, i) => report(i, 0, [['e', E(i)]])));

    const body = await (await get('/api/reports/resolved?cursor=0&limit=3')).json() as {
      next_cursor: number | null; done: boolean; skipped_within_second: boolean;
    };

    expect(body.next_cursor).toBeNull();
    expect(body.done).toBe(true);
    expect(body.skipped_within_second).toBe(true);
  });

  it('surfaces resolution_truncated when the label walk hits its page cap', async () => {
    stubRelay([
      report(1, 100, [['e', E(1)]]),
      label(1, 50, ['e', E(2)]),
      label(2, 49, ['e', E(3)]),
    ]);

    const { body } = await getResolvedReportsPage(
      new URLSearchParams(), DB, 'wss://relay.divine.video', { pageSize: 1, maxPages: 1 },
    );

    expect((body as { resolution_truncated: boolean }).resolution_truncated).toBe(true);
  });
});
