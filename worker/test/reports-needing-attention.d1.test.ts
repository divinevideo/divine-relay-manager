// worker/test/reports-needing-attention.d1.test.ts
// Real handler, real D1 (Miniflare), fake relay. The unit tests drive the pieces
// through injected inputs; this is the only place the relay filter's `limit`,
// the pager, the D1 projections and the label walk meet.
import { Miniflare } from 'miniflare';
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { ensureSchema } from '../src/db';
import worker from '../src/index';
import { REPORTS_PAGE_SIZE } from '../src/reports-filter';

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
});
