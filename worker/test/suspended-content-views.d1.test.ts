// ABOUTME: Real-D1 (Miniflare SQLite) tests for the append-only suspended_content_views audit log.
// ABOUTME: Pins the schema's CHECKs and triggers, which the mock-DB unit tests cannot exercise.
import { Miniflare } from 'miniflare';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ensureSuspendedContentViewsTable,
  guardQuarantineSnapshot,
  handleListSuspendedContentViews,
  handleViewSuspendedAccount,
  recordSuspendedContentView,
  __resetSuspendedContentViewsSchema,
  type SuspendedContentViewRow,
} from '../src/suspended-content';

let mf: Miniflare;
let DB: D1Database;

const MOD = 'a'.repeat(64);
const TARGET = 'b'.repeat(64);
const EVENT = 'c'.repeat(64);

const eventRow: SuspendedContentViewRow = {
  moderatorPubkey: MOD,
  targetPubkey: TARGET,
  scope: 'event',
  eventId: EVENT,
  pageUntil: null,
  surface: 'report',
  eventsServed: 1,
};

beforeAll(async () => {
  mf = new Miniflare({
    modules: true,
    script: 'export default { fetch() { return new Response("ok"); } };',
    compatibilityDate: '2024-12-01',
    compatibilityFlags: ['nodejs_compat'],
    d1Databases: ['DB'],
  });
  DB = (await mf.getD1Database('DB')) as unknown as D1Database;
});

afterAll(async () => {
  await mf?.dispose();
});

beforeEach(async () => {
  __resetSuspendedContentViewsSchema();
  await DB.prepare('DROP TABLE IF EXISTS suspended_content_views').run();
});

async function rows(): Promise<Record<string, unknown>[]> {
  return (await DB.prepare('SELECT * FROM suspended_content_views ORDER BY id').all()).results;
}

describe('suspended_content_views (real D1)', () => {
  it('records one row with the given fields', async () => {
    await ensureSuspendedContentViewsTable(DB);
    await recordSuspendedContentView(DB, eventRow);
    await recordSuspendedContentView(DB, {
      ...eventRow, scope: 'account', eventId: null, pageUntil: 1_700_000_000, surface: 'user', eventsServed: 7,
    });
    const all = await rows();
    expect(all).toHaveLength(2);
    expect(Object.keys(all[0]).sort()).toEqual([
      'event_id', 'events_served', 'id', 'moderator_pubkey', 'page_until', 'scope', 'surface', 'target_pubkey', 'viewed_at',
    ]);
    expect(all[0]).toMatchObject({
      moderator_pubkey: MOD, target_pubkey: TARGET, scope: 'event', event_id: EVENT,
      page_until: null, surface: 'report', events_served: 1,
    });
    expect(typeof all[0].viewed_at).toBe('string');
    expect(all[1]).toMatchObject({ scope: 'account', event_id: null, page_until: 1_700_000_000, surface: 'user', events_served: 7 });
  });

  it('refuses UPDATE and DELETE', async () => {
    await ensureSuspendedContentViewsTable(DB);
    await recordSuspendedContentView(DB, eventRow);
    await expect(DB.prepare('UPDATE suspended_content_views SET events_served = 9').run()).rejects.toThrow(/append-only/);
    await expect(DB.prepare('DELETE FROM suspended_content_views').run()).rejects.toThrow(/append-only/);
    expect(await rows()).toHaveLength(1);
  });

  it.each([
    ['INSERT OR REPLACE', 'INSERT OR REPLACE INTO'],
    ['REPLACE', 'REPLACE INTO'],
  ])('refuses %s onto an existing id, leaving the row as it was', async (_name, verb) => {
    await ensureSuspendedContentViewsTable(DB);
    await recordSuspendedContentView(DB, eventRow);
    const [before] = await rows();
    await expect(DB.prepare(
      `${verb} suspended_content_views (id, moderator_pubkey, target_pubkey, scope, event_id, page_until, surface, events_served)
       VALUES (?, ?, ?, 'event', ?, NULL, 'user', 0)`,
    ).bind(before.id, TARGET, MOD, EVENT).run()).rejects.toThrow(/append-only/);
    expect(await rows()).toEqual([before]);
  });

  it('refuses an upsert that would update an existing id', async () => {
    await ensureSuspendedContentViewsTable(DB);
    await recordSuspendedContentView(DB, eventRow);
    const [before] = await rows();
    await expect(DB.prepare(
      `INSERT INTO suspended_content_views (id, moderator_pubkey, target_pubkey, scope, event_id, page_until, surface, events_served)
       VALUES (?, ?, ?, 'event', ?, NULL, 'user', 0) ON CONFLICT(id) DO UPDATE SET events_served = 9`,
    ).bind(before.id, MOD, TARGET, EVENT).run()).rejects.toThrow(/append-only/);
    expect(await rows()).toEqual([before]);
  });

  it('still accepts a new row with an explicit id', async () => {
    await ensureSuspendedContentViewsTable(DB);
    await DB.prepare(
      `INSERT INTO suspended_content_views (id, moderator_pubkey, target_pubkey, scope, event_id, page_until, surface, events_served)
       VALUES (42, ?, ?, 'event', ?, NULL, 'user', 0)`,
    ).bind(MOD, TARGET, EVENT).run();
    expect((await rows()).map(r => r.id)).toEqual([42]);
  });

  it.each([
    ['an uppercase moderator pubkey', { moderatorPubkey: 'A'.repeat(64) }],
    ['a short target pubkey', { targetPubkey: 'b'.repeat(63) }],
    ['a non-hex target pubkey', { targetPubkey: 'g'.repeat(64) }],
    ['an event row without event_id', { eventId: null }],
    ['an event row with an uppercase event_id', { eventId: 'C'.repeat(64) }],
    ['an account row with an event_id', { scope: 'account' as const }],
    ['an unknown surface', { surface: 'elsewhere' as never }],
    ['a negative events_served', { eventsServed: -1 }],
  ])('rejects %s', async (_name, patch) => {
    await ensureSuspendedContentViewsTable(DB);
    await expect(recordSuspendedContentView(DB, { ...eventRow, ...patch })).rejects.toThrow();
    expect(await rows()).toHaveLength(0);
  });

  it('ensure is idempotent', async () => {
    await ensureSuspendedContentViewsTable(DB);
    __resetSuspendedContentViewsSchema();
    await ensureSuspendedContentViewsTable(DB);
    await recordSuspendedContentView(DB, eventRow);
    expect(await rows()).toHaveLength(1);
  });

  it('runs the DDL once per isolate, and again after a failure', async () => {
    let calls = 0;
    const failing = {
      prepare: () => ({ run: async () => { calls++; throw new Error('D1 down'); } }),
    } as unknown as D1Database;
    await expect(ensureSuspendedContentViewsTable(failing)).rejects.toThrow('D1 down');
    await expect(ensureSuspendedContentViewsTable(failing)).rejects.toThrow('D1 down');
    expect(calls).toBe(2);

    await ensureSuspendedContentViewsTable(DB);
    await DB.prepare('DROP TABLE suspended_content_views').run();
    // Memoized: the second ensure does not recreate the dropped table.
    await ensureSuspendedContentViewsTable(DB);
    await expect(recordSuspendedContentView(DB, eventRow)).rejects.toThrow();
  });
});

describe('POST /api/suspended-content/account on real D1', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('a served page leaves exactly one row', async () => {
    const page = {
      events: [{ id: EVENT, pubkey: TARGET, created_at: 5, kind: 1, tags: [], content: 'x', sig: 's' }],
      next_until: null, next_until_id: null,
    };
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ result: page }))));
    const res = await handleViewSuspendedAccount(
      new Request('https://api.test/api/suspended-content/account', {
        method: 'POST', body: JSON.stringify({ pubkey: TARGET, surface: 'user', until: 10 }),
      }),
      { DB, RELAY_URL: 'wss://relay.test', NOSTR_NSEC: 'nsec1vl029mgpspedva04g90vltkh6fvh240zqtv9k0t9af8935ke9laqsnlfe5' },
      {},
      MOD,
    );
    expect(res.status).toBe(200);
    expect(await rows()).toEqual([expect.objectContaining({
      moderator_pubkey: MOD, target_pubkey: TARGET, scope: 'account', event_id: null,
      page_until: 10, surface: 'user', events_served: 1,
    })]);
  });
});

describe('GET /api/suspended-content/views on real D1', () => {
  const OTHER_MOD = 'd'.repeat(64);
  const OTHER_TARGET = 'e'.repeat(64);

  async function list(query = ''): Promise<{ status: number; body: { views: Array<Record<string, unknown>>; nextBefore: number | null; code?: string } }> {
    const res = await handleListSuspendedContentViews(new URL(`https://api.test/api/suspended-content/views${query}`), { DB }, {});
    return { status: res.status, body: await res.json() as never };
  }

  beforeEach(async () => {
    await ensureSuspendedContentViewsTable(DB);
    // ids 1..5
    await recordSuspendedContentView(DB, eventRow);
    await recordSuspendedContentView(DB, { ...eventRow, moderatorPubkey: OTHER_MOD });
    await recordSuspendedContentView(DB, { ...eventRow, targetPubkey: OTHER_TARGET });
    await recordSuspendedContentView(DB, { ...eventRow, scope: 'account', eventId: null, pageUntil: 9, surface: 'user', eventsServed: 4 });
    await recordSuspendedContentView(DB, { ...eventRow, surface: 'sexual-quarantine' });
  });

  it('lists newest first and pages with before', async () => {
    const first = await list('?limit=2');
    expect(first.status).toBe(200);
    expect(first.body.views.map(v => v.id)).toEqual([5, 4]);
    expect(first.body.nextBefore).toBe(4);
    expect(first.body.views[1]).toEqual({
      id: 4, viewedAt: expect.any(String), moderatorPubkey: MOD, targetPubkey: TARGET, scope: 'account',
      eventId: null, pageUntil: 9, surface: 'user', eventsServed: 4,
    });
    const second = await list('?limit=2&before=4');
    expect(second.body.views.map(v => v.id)).toEqual([3, 2]);
    const last = await list('?limit=2&before=2');
    expect(last.body.views.map(v => v.id)).toEqual([1]);
    expect(last.body.nextBefore).toBeNull();
  });

  it('a page that ends exactly at the limit has no next page', async () => {
    const all = await list('?limit=5');
    expect(all.body.views).toHaveLength(5);
    expect(all.body.nextBefore).toBeNull();
  });

  it('defaults to 50', async () => {
    expect((await list()).body.views).toHaveLength(5);
  });

  it('filters by target and by moderator, in any case', async () => {
    expect((await list(`?pubkey=${OTHER_TARGET.toUpperCase()}`)).body.views.map(v => v.id)).toEqual([3]);
    expect((await list(`?moderator=${OTHER_MOD}`)).body.views.map(v => v.id)).toEqual([2]);
    expect((await list(`?pubkey=${TARGET}&moderator=${MOD}`)).body.views.map(v => v.id)).toEqual([5, 4, 1]);
  });

  it.each([
    ['?pubkey=abc'],
    ['?moderator=' + 'g'.repeat(64)],
    ['?limit=0'],
    ['?limit=201'],
    ['?limit=ten'],
    ['?before=0'],
    ['?before=-3'],
    ['?before=1.5'],
    ['?before=99999999999999999'],
    ['?before=9999999999999999'],
  ])('rejects %s with 400 invalid_request', async (query) => {
    const res = await list(query);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('invalid_request');
  });
});

describe('quarantine snapshot guard on real D1', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('a served snapshot leaves one row with surface sexual-quarantine', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ result: [{ pubkey: TARGET }] }))));
    const sexualCase = { eventId: EVENT, snapshot: { event: { id: EVENT, pubkey: TARGET }, assets: [] } };
    const out = await guardQuarantineSnapshot(
      sexualCase, 200,
      new Request(`https://api.test/api/report-watcher/sexual-quarantine/${EVENT}?snapshot=1`),
      { DB, RELAY_URL: 'wss://relay.test', NOSTR_NSEC: 'nsec1vl029mgpspedva04g90vltkh6fvh240zqtv9k0t9af8935ke9laqsnlfe5' },
      {}, MOD,
    );
    expect(out).toEqual({ data: sexualCase });
    expect(await rows()).toEqual([expect.objectContaining({
      moderator_pubkey: MOD, target_pubkey: TARGET, scope: 'event', event_id: EVENT,
      page_until: null, surface: 'sexual-quarantine', events_served: 1,
    })]);
  });
});
