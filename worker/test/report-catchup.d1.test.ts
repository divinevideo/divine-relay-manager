// ABOUTME: Restart catch-up against real D1: a report filed while the listener was down gets the live handler, once.
// ABOUTME: A fake relay answers the walk's REQs and the live subscription; fetch records NIP-86 calls and webhook posts.

import { Miniflare } from 'miniflare';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { finalizeEvent, generateSecretKey, getPublicKey, type Event as NostrEvent } from 'nostr-tools';
import { ensureSchema } from '../src/db';
import { ReportWatcher, type ReportWatcherEnv } from '../src/ReportWatcher';
import {
  CATCHUP_MIN_ATTEMPT_INTERVAL_MS,
  CATCHUP_SUCCESS_INTERVAL_MS,
  addPendingWindow,
  addStoppedPeriod,
  planCatchUpWindow,
  runPendingCatchUp,
  type CatchUpWindow,
} from '../src/report-catchup';
import { metaStatement, type SignedReport } from '../src/report-index';
import { partialEnv } from '../src/test-helpers/partial-env';
import { createQuarantineIO } from '../src/sexual-quarantine-io';

vi.mock('../src/relay-profile', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/relay-profile')>(),
  fetchAccountIdentity: vi.fn().mockResolvedValue({ completed: true, profile: null }),
}));
// Only reached when a test turns the sexual quarantine on; it then reads the
// reported video through this IO instead of a relay.
vi.mock('../src/sexual-quarantine-io', () => ({ createQuarantineIO: vi.fn() }));

const RELAY_URL = 'wss://relay.catchup.test';
const MANAGEMENT_URL = 'https://relay.catchup.test/';
const WEBHOOK_URL = 'https://hooks.example.test/report-index';
// Throwaway test key (the one ReportWatcher.test.ts uses). Never a real signer.
const TEST_NSEC = 'nsec1vl029mgpspedva04g90vltkh6fvh240zqtv9k0t9af8935ke9laqsnlfe5';

// ---------------------------------------------------------------------------
// Fake relay
// ---------------------------------------------------------------------------

type Listener = (event: unknown) => void;

const relay = {
  corpus: [] as NostrEvent[],
  // Every non-live REQ filter, in the order the relay received them.
  queries: [] as Array<Record<string, unknown>>,
  live: null as { socket: FakeSocket; subId: string } | null,
  // Runs before the relay answers query n (0-based).
  beforeAnswer: undefined as undefined | ((n: number) => Promise<void>),
  // Query numbers the relay ends with CLOSED instead of answering.
  closeQueries: new Set<number>(),
  // Every socket opened, in order. With autoOpen off, a socket stays
  // CONNECTING until the test opens it.
  sockets: [] as FakeSocket[],
  autoOpen: true,
  // How the relay answers the live subscription: EOSE (healthy), CLOSED (the
  // relay refuses or aborts it), or nothing.
  liveReply: 'eose' as 'eose' | 'closed' | 'none',
  reset() {
    this.corpus = [];
    this.queries = [];
    this.live = null;
    this.beforeAnswer = undefined;
    this.closeQueries = new Set();
    this.sockets = [];
    this.autoOpen = true;
    this.liveReply = 'eose';
  },
  pushLive(event: NostrEvent) {
    if (!this.live) throw new Error('no live subscription');
    this.live.socket.emit('message', { data: JSON.stringify(['EVENT', this.live.subId, event]) });
  },
};

class FakeSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  readyState = FakeSocket.CONNECTING;
  private listeners = new Map<string, Listener[]>();

  constructor(readonly url: string) {
    if (url !== RELAY_URL) throw new Error(`unexpected relay ${url}`);
    relay.sockets.push(this);
    if (relay.autoOpen) setTimeout(() => this.open(), 0);
  }

  open(): void {
    if (this.readyState !== FakeSocket.CONNECTING) return;
    this.readyState = FakeSocket.OPEN;
    this.emit('open', {});
  }

  addEventListener(type: string, listener: Listener): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }

  send(data: string): void {
    const message = JSON.parse(data) as unknown[];
    if (message[0] !== 'REQ') return;
    const subId = message[1] as string;
    const filter = message[2] as Record<string, unknown>;
    if (filter.limit === 0) {
      relay.live = { socket: this, subId };
      const reply = relay.liveReply;
      if (reply !== 'none') {
        setTimeout(() => {
          const message = reply === 'eose' ? ['EOSE', subId] : ['CLOSED', subId, 'rate-limited: synthetic'];
          this.emit('message', { data: JSON.stringify(message) });
        }, 0);
      }
      return;
    }
    const n = relay.queries.length;
    relay.queries.push(filter);
    void this.answer(subId, filter, n);
  }

  close(): void {
    if (this.readyState === FakeSocket.CLOSED) return;
    this.readyState = FakeSocket.CLOSED;
    this.emit('close', { code: 1000, reason: '' });
  }

  emit(type: string, event: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }

  private async answer(subId: string, filter: Record<string, unknown>, n: number): Promise<void> {
    await new Promise(resolve => setTimeout(resolve, 0));
    await relay.beforeAnswer?.(n);
    if (this.readyState !== FakeSocket.OPEN) return;
    if (relay.closeQueries.has(n)) {
      this.emit('message', { data: JSON.stringify(['CLOSED', subId, 'error: synthetic failure']) });
      return;
    }
    const kinds = filter.kinds as number[];
    const since = filter.since as number | undefined;
    const until = filter.until as number | undefined;
    const rows = relay.corpus
      .filter(e => kinds.includes(e.kind)
        && (since === undefined || e.created_at >= since)
        && (until === undefined || e.created_at <= until))
      .sort((a, b) => b.created_at - a.created_at || (a.id < b.id ? -1 : 1))
      .slice(0, filter.limit as number);
    for (const e of rows) this.emit('message', { data: JSON.stringify(['EVENT', subId, e]) });
    this.emit('message', { data: JSON.stringify(['EOSE', subId]) });
  }
}

// ---------------------------------------------------------------------------
// Durable Object state, fetch, D1
// ---------------------------------------------------------------------------

function makeState() {
  const data = new Map<string, unknown>();
  let alarm: number | null = null;
  let gate: Promise<unknown> = Promise.resolve();
  const pending: Promise<unknown>[] = [];
  // Awaited by every get after it reads and before it returns, so a test can
  // pause a reader between its get and its put and let another writer in.
  let onGet: ((key: string) => Promise<void>) | undefined;
  const ops = {
    // Copies, as Durable Object storage does: a caller mutating what it read
    // must not change what is stored.
    get: async (key: string) => {
      const value = structuredClone(data.get(key));
      await onGet?.(key);
      return value;
    },
    put: async (key: string, value: unknown) => { data.set(key, structuredClone(value)); },
    delete: async (key: string) => data.delete(key),
    list: async ({ prefix = '', limit = Infinity, startAfter = '' }: { prefix?: string; limit?: number; startAfter?: string } = {}) =>
      new Map([...data].filter(([key]) => key.startsWith(prefix) && key > startAfter)
        .sort(([a], [b]) => a.localeCompare(b)).slice(0, limit)),
    getAlarm: async () => alarm,
    setAlarm: async (time: number) => { alarm = time; },
    deleteAlarm: async () => { alarm = null; },
  };
  // Transactions run one at a time, as in Durable Object storage: a second
  // transaction waits for the first to commit.
  let txChain: Promise<unknown> = Promise.resolve();
  const storage = {
    ...ops,
    transaction: <T>(fn: (tx: typeof ops) => Promise<T>): Promise<T> => {
      const run = txChain.then(() => fn(ops));
      txChain = run.catch(() => undefined);
      return run;
    },
  };
  const state = {
    storage,
    blockConcurrencyWhile: <T>(fn: () => Promise<T>): Promise<T> => {
      const result = gate.then(fn);
      gate = result.catch(() => undefined);
      return result;
    },
    waitUntil: (promise: Promise<unknown>) => { pending.push(promise); },
  };
  return {
    state: state as unknown as DurableObjectState,
    storage: storage as unknown as DurableObjectStorage,
    data,
    pending,
    setOnGet: (hook: ((key: string) => Promise<void>) | undefined) => { onGet = hook; },
  };
}

// Waits until every background task the watcher handed to waitUntil, and every
// task those started, has settled.
async function settle(pending: Promise<unknown>[]): Promise<void> {
  let idle = 0;
  while (idle < 3) {
    await new Promise(resolve => setTimeout(resolve, 10));
    if (pending.length === 0) { idle += 1; continue; }
    idle = 0;
    await Promise.allSettled(pending.splice(0));
  }
}

async function waitFor(condition: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('waitFor timed out');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

let nip86: Array<{ method: string; params: unknown[] }> = [];
let webhookPosts: Array<{ text: string }> = [];
// Runs inside the NIP-86 fetch for banevent, before it answers.
let onBan: ((params: unknown[]) => Promise<void>) | undefined;

function stubFetch() {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    const body = JSON.parse(String(init?.body ?? (input instanceof Request ? await input.text() : '{}')));
    if (url === WEBHOOK_URL) {
      webhookPosts.push(body);
      return new Response('ok');
    }
    if (url === MANAGEMENT_URL) {
      nip86.push({ method: body.method, params: body.params });
      if (body.method === 'banevent' && onBan) await onBan(body.params);
      return Response.json({ result: true });
    }
    throw new Error(`unexpected fetch ${url}`);
  }));
}

let mf: Miniflare;
let DB: D1Database;

beforeAll(async () => {
  mf = new Miniflare({ modules: true, script: 'export default { fetch() { return new Response("ok"); } };', compatibilityDate: '2024-12-01', d1Databases: ['DB'] });
  DB = (await mf.getD1Database('DB')) as unknown as D1Database;
  await ensureSchema(DB);
});
afterAll(async () => { await mf.dispose(); });

beforeEach(async () => {
  for (const table of ['report_index_refs', 'report_index', 'report_arrivals', 'report_index_meta', 'moderation_decisions', 'moderation_targets', 'age_review_cases']) {
    await DB.prepare(`DELETE FROM ${table}`).run();
  }
  relay.reset();
  nip86 = [];
  webhookPosts = [];
  onBan = undefined;
  vi.stubGlobal('WebSocket', FakeSocket);
  stubFetch();
  vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function watcherEnv(overrides: Partial<ReportWatcherEnv> = {}): ReportWatcherEnv {
  return partialEnv<ReportWatcherEnv>({
    DB,
    NOSTR_NSEC: TEST_NSEC,
    RELAY_URL,
    MANAGEMENT_PATH: '/',
    AUTO_HIDE_ENABLED: 'true',
    ENVIRONMENT: 'test',
    ...overrides,
  });
}

async function newWatcher(overrides: Partial<ReportWatcherEnv> = {}) {
  const s = makeState();
  const watcher = new ReportWatcher(s.state, watcherEnv(overrides));
  // The constructor's restore runs behind the concurrency gate; let it finish.
  await s.state.blockConcurrencyWhile(async () => {});
  const post = async (path: string) => watcher.fetch(new Request(`https://do${path}`, { method: 'POST' }));
  return { watcher, ...s, post };
}

const reporterKey = generateSecretKey();
const nowSec = () => Math.floor(Date.now() / 1000);
const hex = (n: number) => n.toString(16).padStart(64, '0');

function signed(tags: string[][], createdAt: number): NostrEvent {
  return finalizeEvent({ kind: 1984, created_at: createdAt, content: '', tags }, reporterKey);
}
// Immediate tier, trusted client: one report hides the event.
const minorsReport = (target: string, createdAt: number) =>
  signed([['e', target], ['report', 'sexual_minors'], ['client', 'diVine']], createdAt);
const underageReport = (pubkey: string, createdAt: number) =>
  signed([['p', pubkey], ['report', 'NS-underageUser'], ['client', 'diVine']], createdAt);

async function seedHeartbeat(at: number) {
  await metaStatement(DB, 'watcher_last_alive_at', at).run();
}
const bansFor = (target: string) => nip86.filter(c => c.method === 'banevent' && c.params[0] === target);
const allRows = async (sql: string) => (await DB.prepare(sql).all()).results ?? [];

describe('catch-up when the listener connects', () => {
  it('runs auto-hide and age-review intake on a report filed while the watcher was down', async () => {
    const now = nowSec();
    const aliveAt = now - 120;
    await seedHeartbeat(aliveAt);
    const targetA = hex(0xa1);
    const pubkeyB = getPublicKey(generateSecretKey());
    const a = minorsReport(targetA, now - 60);
    const b = underageReport(pubkeyB, now - 60);
    relay.corpus = [a, b];

    const w = await newWatcher();
    await w.post('/start');
    await settle(w.pending);

    // The window comes from the watcher's own clock, with the overlap, and every
    // catch-up REQ names the kind and both bounds.
    expect(relay.queries.length).toBeGreaterThan(0);
    for (const q of relay.queries) {
      expect(q.kinds).toEqual([1984]);
      expect(q.since).toBe(aliveAt - 600);
      expect(typeof q.until).toBe('number');
    }
    // Two minutes past the connect, for a client clock that runs fast.
    expect(relay.queries[0].until as number).toBeGreaterThanOrEqual(now + 120);

    expect(bansFor(targetA)).toHaveLength(1);
    expect(await allRows(`SELECT pubkey FROM age_review_cases WHERE pubkey = '${pubkeyB}'`)).toHaveLength(1);
    expect(await allRows('SELECT report_id, source FROM report_index ORDER BY report_id')).toEqual(
      [a.id, b.id].sort().map(id => ({ report_id: id, source: 'catchup' })),
    );
    expect((await allRows('SELECT report_id FROM report_arrivals ORDER BY report_id')).map(r => r.report_id)).toEqual([a.id, b.id].sort());

    // The window is done: the cron route finds nothing pending.
    expect(w.data.get('report-catchup-windows')).toEqual([]);
    const response = await w.post('/internal/report-catchup');
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ran: false, complete: true });
  });

  it('skips a report already in report_arrivals', async () => {
    const now = nowSec();
    await seedHeartbeat(now - 120);
    const targetA = hex(0xa2);
    const a = minorsReport(targetA, now - 60);
    relay.corpus = [a];
    await DB.prepare('INSERT INTO report_arrivals (report_id, first_seen_at) VALUES (?, ?)').bind(a.id, now - 60).run();

    const w = await newWatcher();
    await w.post('/start');
    await settle(w.pending);

    expect(relay.queries.length).toBeGreaterThan(0);
    expect(bansFor(targetA)).toHaveLength(0);
    expect(await allRows('SELECT report_id FROM report_index')).toEqual([]);
  });

  it('indexes but runs no auto-hide or age review after a deliberate stop', async () => {
    const w = await newWatcher();
    // First connect ever: no heartbeat yet, so nothing to catch up.
    await w.post('/start');
    await settle(w.pending);
    // The heartbeat stamps once this connection's window is planned.
    await w.watcher.alarm();
    const stamped = await DB.prepare("SELECT value FROM report_index_meta WHERE key = 'watcher_last_alive_at'").first<{ value: number }>();
    expect(stamped?.value).toBeGreaterThan(0);

    await w.post('/stop');
    expect(w.data.get('report-watcher-deliberate-stop')).toEqual(expect.any(Number));

    // No outage: the last heartbeat came just before the stop. Rewind both
    // clocks so the stopped period has room for reports.
    const now = nowSec();
    await seedHeartbeat(now - 60);
    w.data.set('report-watcher-deliberate-stop', now - 30);
    // Seen live before the stop: the handler-on slice reaches it, and the
    // seen check filters it.
    const seenLive = minorsReport(hex(0xa9), now - 45);
    await DB.prepare('INSERT INTO report_arrivals (report_id, first_seen_at) VALUES (?, ?)').bind(seenLive.id, now - 45).run();
    const targetA = hex(0xa3);
    const pubkeyB = getPublicKey(generateSecretKey());
    const a = minorsReport(targetA, now - 10);
    const b = underageReport(pubkeyB, now - 10);
    relay.corpus = [seenLive, a, b];

    await w.post('/start');
    await settle(w.pending);

    expect(relay.queries.length).toBeGreaterThan(0);
    expect(await allRows('SELECT report_id, source FROM report_index ORDER BY report_id')).toEqual(
      [a.id, b.id].sort().map(id => ({ report_id: id, source: 'catchup' })),
    );
    expect((await allRows('SELECT report_id FROM report_arrivals ORDER BY report_id')).map(r => r.report_id)).toEqual([seenLive.id, a.id, b.id].sort());
    expect(nip86.filter(c => c.method === 'banevent')).toEqual([]);
    expect(await allRows('SELECT pubkey FROM age_review_cases')).toEqual([]);
    // The marker is consumed with the window it described.
    expect(w.data.has('report-watcher-deliberate-stop')).toBe(false);
  });

  it('an outage before a deliberate stop keeps the live treatment for reports filed before the stop', async () => {
    // The relay dropped two minutes ago (last heartbeat), and someone stopped
    // the watcher 30 seconds ago, during the outage.
    const now = nowSec();
    await seedHeartbeat(now - 120);
    const beforeStop = hex(0xaa);
    const duringStop = hex(0xab);
    const pubkeyBefore = getPublicKey(generateSecretKey());
    const pubkeyDuring = getPublicKey(generateSecretKey());
    relay.corpus = [
      minorsReport(beforeStop, now - 60), underageReport(pubkeyBefore, now - 60),
      minorsReport(duringStop, now - 10), underageReport(pubkeyDuring, now - 10),
    ];

    const w = await newWatcher();
    w.data.set('report-watcher-deliberate-stop', now - 30);
    await w.post('/start');
    await settle(w.pending);

    expect(bansFor(beforeStop)).toHaveLength(1);
    expect(await allRows(`SELECT pubkey FROM age_review_cases WHERE pubkey = '${pubkeyBefore}'`)).toHaveLength(1);
    expect(bansFor(duringStop)).toHaveLength(0);
    expect(await allRows(`SELECT pubkey FROM age_review_cases WHERE pubkey = '${pubkeyDuring}'`)).toEqual([]);
    expect((await DB.prepare('SELECT COUNT(*) AS n FROM report_index').first<{ n: number }>())?.n).toBe(4);
    expect(w.data.get('report-catchup-windows')).toEqual([]);
    expect(w.data.has('report-watcher-deliberate-stop')).toBe(false);
  });

  it('a reconnect before the first heartbeat after a stop still runs no handler on the stopped period', async () => {
    const now = nowSec();
    // The relay dropped at the heartbeat; the watcher was stopped during the
    // outage and has just been started.
    const heartbeat = now - 120;
    const stopAt = now - 60;
    await seedHeartbeat(heartbeat);
    const outageTarget = hex(0xd1);
    const stoppedTarget = hex(0xd2);
    const stoppedPubkey = getPublicKey(generateSecretKey());
    relay.corpus = [
      minorsReport(outageTarget, now - 90),
      minorsReport(stoppedTarget, now - 30), underageReport(stoppedPubkey, now - 30),
    ];

    const w = await newWatcher();
    w.data.set('report-watcher-deliberate-stop', stopAt);
    // Hold the first pass so the reconnect's window is planned before any walk.
    w.data.set('report-catchup-last-attempt', Date.now());
    await w.post('/start');
    await settle(w.pending);
    expect(relay.queries).toEqual([]);
    expect(w.data.get('report-catchup-stopped-periods')).toEqual([{ after: stopAt, until: expect.any(Number) }]);

    // The socket drops before any heartbeat stamp; the alarm reconnects and
    // the new connection plans [heartbeat - 600, now], which folds into the
    // handler-on window ahead of the handler-off one.
    relay.sockets[0].close();
    await w.watcher.alarm();
    await settle(w.pending);
    const pending = w.data.get('report-catchup-windows') as CatchUpWindow[];
    expect(pending[0]).toMatchObject({ since: heartbeat - 600, handlerEnabled: true });
    expect(pending[0].until).toBeGreaterThan(stopAt);

    w.data.delete('report-catchup-last-attempt');
    await w.post('/internal/report-catchup');
    await settle(w.pending);

    expect(bansFor(outageTarget)).toHaveLength(1);
    expect(bansFor(stoppedTarget)).toHaveLength(0);
    expect(await allRows(`SELECT pubkey FROM age_review_cases WHERE pubkey = '${stoppedPubkey}'`)).toEqual([]);
    expect((await DB.prepare('SELECT COUNT(*) AS n FROM report_index').first<{ n: number }>())?.n).toBe(3);
    expect(w.data.get('report-catchup-windows')).toEqual([]);
  });

  it('prunes a stopped period once every pending window starts after it', async () => {
    const now = nowSec();
    const old = { after: now - 5000, until: now - 4000 };
    const live = { after: now - 200, until: now - 100 };
    const s = makeState();
    await s.storage.put('report-catchup-windows', [{ since: now - 1000, until: now - 900, handlerEnabled: true }, { since: now - 300, until: now, handlerEnabled: true }]);
    await s.storage.put('report-catchup-stopped-periods', [old, live]);
    // Query 0 walks the first window (empty, so complete); query 1, the
    // second window's first page, fails.
    relay.closeQueries = new Set([1]);
    vi.spyOn(console, 'error').mockImplementation(() => {});

    await runPendingCatchUp({
      db: DB, relayUrl: RELAY_URL, storage: s.storage, claim: () => true, handle: async () => {},
      isRunning: () => true, alert: vi.fn(async () => {}), nowMs: () => 9_000_000,
    });

    // The first window finished; the second failed and is kept. Only the
    // period that window can still reach survives.
    expect(await s.storage.get('report-catchup-windows')).toEqual([{ since: now - 300, until: now, handlerEnabled: true }]);
    expect(await s.storage.get('report-catchup-stopped-periods')).toEqual([live]);
  });

  it('does nothing on the first connect when no heartbeat was ever recorded', async () => {
    const now = nowSec();
    relay.corpus = [minorsReport(hex(0xa4), now - 60)];

    const w = await newWatcher();
    await w.post('/start');
    await settle(w.pending);

    expect(relay.live).not.toBeNull();
    expect(relay.queries).toEqual([]);
    expect(await allRows('SELECT report_id FROM report_index')).toEqual([]);
    expect(nip86).toEqual([]);
    // The connection still counts as planned, so the heartbeat starts and the
    // next restart has a window to catch up from.
    await w.watcher.alarm();
    expect(await DB.prepare("SELECT value FROM report_index_meta WHERE key = 'watcher_last_alive_at'").first()).not.toBeNull();
  });

  it('a report delivered live during catch-up is handled once', async () => {
    const now = nowSec();
    await seedHeartbeat(now - 120);
    const liveFirstTarget = hex(0xb1);
    const catchUpFirstTarget = hex(0xb2);
    const liveFirst = minorsReport(liveFirstTarget, now - 60);
    const catchUpFirst = minorsReport(catchUpFirstTarget, now - 50);
    relay.corpus = [liveFirst, catchUpFirst];

    const w = await newWatcher();
    // Before the first catch-up page returns, the live subscription delivers one
    // of the reports and the live handler finishes with it.
    relay.beforeAnswer = async (n) => {
      if (n !== 0) return;
      relay.pushLive(liveFirst);
      // Not settle(): the catch-up task itself is pending on this answer.
      await waitFor(() => bansFor(liveFirstTarget).length === 1);
      await new Promise(resolve => setTimeout(resolve, 50));
    };
    // While catch-up is hiding the other report, the live subscription delivers
    // that one too.
    let pushed = false;
    onBan = async (params) => {
      if (params[0] !== catchUpFirstTarget || pushed) return;
      pushed = true;
      relay.pushLive(catchUpFirst);
      await new Promise(resolve => setTimeout(resolve, 100));
    };

    await w.post('/start');
    await settle(w.pending);

    expect(pushed).toBe(true);
    expect(bansFor(liveFirstTarget)).toHaveLength(1);
    expect(bansFor(catchUpFirstTarget)).toHaveLength(1);
  });

  it('does not hand catch-up a report the live path handled but failed to record', async () => {
    const now = nowSec();
    await seedHeartbeat(now - 120);
    const target = hex(0xb3);
    const a = minorsReport(target, now - 60);
    relay.corpus = [a];
    vi.spyOn(console, 'error').mockImplementation(() => {});

    // The watcher's D1, with one batch failure on demand.
    let failNextBatch = false;
    const flakyDb = new Proxy(DB, {
      get(target, prop) {
        if (prop === 'batch' && failNextBatch) {
          failNextBatch = false;
          return async () => { throw new Error('synthetic D1 failure'); };
        }
        const value = Reflect.get(target, prop);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const w = await newWatcher({ DB: flakyDb });
    relay.beforeAnswer = async (n) => {
      if (n !== 0) return;
      // The live arrival write fails, so D1 cannot tell catch-up the report
      // was seen; only the in-memory claim can.
      failNextBatch = true;
      relay.pushLive(a);
      await waitFor(() => bansFor(target).length === 1);
      expect(failNextBatch).toBe(false);
    };

    await w.post('/start');
    await settle(w.pending);

    expect(await allRows(`SELECT report_id FROM report_arrivals WHERE report_id = '${a.id}'`)).toEqual([]);
    expect(bansFor(target)).toHaveLength(1);
  });

  it('alerts once when one pass auto-hides more than ten reports', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const alerts = () => errors.mock.calls.filter(call => String(call[0]).startsWith('[ALERT] [report-index]'));

    const runPass = async (count: number, base: number) => {
      const now = nowSec();
      await seedHeartbeat(now - 120);
      relay.reset();
      relay.corpus = Array.from({ length: count }, (_, i) => minorsReport(hex(base + i), now - 60 + (i % 30)));
      const w = await newWatcher({ SLACK_WEBHOOK_URL: WEBHOOK_URL });
      await w.post('/start');
      await settle(w.pending);
      return count;
    };

    await runPass(10, 0xc00);
    expect(nip86.filter(c => c.method === 'banevent')).toHaveLength(10);
    expect(alerts()).toHaveLength(0);
    expect(webhookPosts).toHaveLength(0);

    nip86 = [];
    await runPass(11, 0xd00);
    expect(nip86.filter(c => c.method === 'banevent')).toHaveLength(11);
    expect(alerts()).toHaveLength(1);
    expect(webhookPosts).toHaveLength(1);
    expect(webhookPosts[0].text).toContain('11');
  });

  it('keeps a failed window and resumes it from its saved cursor no sooner than the attempt interval', async () => {
    const base = nowSec() - 1000;
    const window: CatchUpWindow = { since: base - 600, until: base, handlerEnabled: true };
    const reports = [minorsReport(hex(0xe1), base - 10), minorsReport(hex(0xe2), base - 20), minorsReport(hex(0xe3), base - 30)];
    relay.corpus = reports;
    // Page 1 answers; page 2 (the walk's confirming page) fails.
    relay.closeQueries = new Set([1]);

    const s = makeState();
    await s.storage.put('report-catchup-windows', [window]);
    const claimed = new Set<string>();
    const handled: Array<{ id: string; handlerEnabled: boolean }> = [];
    let clock = 5_000_000;
    const deps = {
      db: DB,
      relayUrl: RELAY_URL,
      storage: s.storage,
      claim: (id: string) => (claimed.has(id) ? false : (claimed.add(id), true)),
      handle: async (report: SignedReport, handlerEnabled: boolean) => { handled.push({ id: report.id, handlerEnabled }); },
      isRunning: () => true,
      alert: vi.fn(async () => {}),
      nowMs: () => clock,
    };
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const first = await runPendingCatchUp(deps);
    expect(first).toMatchObject({ ran: true, complete: false, found: 3, handled: 3 });
    expect(handled.map(h => h.id).sort()).toEqual(reports.map(r => r.id).sort());
    expect(handled.every(h => h.handlerEnabled)).toBe(true);
    expect(relay.queries).toHaveLength(2);
    // Saved at page 1's cursor: its oldest second, inclusive.
    expect(await s.storage.get('report-catchup-windows')).toEqual([{ ...window, until: base - 30 }]);

    relay.closeQueries = new Set();
    clock += CATCHUP_MIN_ATTEMPT_INTERVAL_MS - 1;
    expect(await runPendingCatchUp(deps)).toMatchObject({ ran: false });
    expect(relay.queries).toHaveLength(2);

    clock += 1;
    const resumed = await runPendingCatchUp(deps);
    expect(resumed).toMatchObject({ ran: true, complete: true });
    expect(relay.queries[2]).toMatchObject({ kinds: [1984], since: base - 600, until: base - 30 });
    expect(await s.storage.get('report-catchup-windows')).toEqual([]);
    // Nothing handled twice across the resume.
    expect(handled).toHaveLength(3);
    expect(deps.alert).not.toHaveBeenCalled();
  });
  it('a pass runs no handler on a stopped-period report found by a folded handler-on window', async () => {
    // The reviewer's sequence against the real planning functions, then a real
    // pass: the handler-on window found first spans the stopped period.
    const now = nowSec();
    const heartbeat = now - 300;
    const stopAt = now - 200;
    const startAt = now - 100;
    let windows = planCatchUpWindow(heartbeat, startAt, stopAt);
    const periods = addStoppedPeriod([], { after: stopAt, until: startAt }, windows);
    for (const w of planCatchUpWindow(heartbeat, startAt + 20)) windows = addPendingWindow(windows, w).windows;
    expect(windows[0]).toEqual({ since: heartbeat - 600, until: startAt + 20 + 120, handlerEnabled: true });

    const outage = minorsReport(hex(0xc1), heartbeat + 50);
    const stopped = minorsReport(hex(0xc2), stopAt + 50);
    const afterStart = minorsReport(hex(0xc3), startAt + 10);
    relay.corpus = [outage, stopped, afterStart];
    const s = makeState();
    await s.storage.put('report-catchup-windows', windows);
    await s.storage.put('report-catchup-stopped-periods', periods);
    const claimed = new Set<string>();
    const handled = new Map<string, boolean>();

    await runPendingCatchUp({
      db: DB, relayUrl: RELAY_URL, storage: s.storage,
      claim: (id: string) => (claimed.has(id) ? false : (claimed.add(id), true)),
      handle: async (report: SignedReport, handlerEnabled: boolean) => { handled.set(report.id, handlerEnabled); },
      isRunning: () => true,
      alert: vi.fn(async () => {}),
      nowMs: () => 9_000_000,
    });

    expect(handled.get(stopped.id)).toBe(false);
    expect(handled.get(outage.id)).toBe(true);
    expect(handled.get(afterStart.id)).toBe(true);
    expect(await s.storage.get('report-catchup-windows')).toEqual([]);
  });

  it('a failed page stops the pass: no later window is walked', async () => {
    const base = nowSec() - 1000;
    const first: CatchUpWindow = { since: base - 100, until: base, handlerEnabled: true };
    const second: CatchUpWindow = { since: base + 100, until: base + 200, handlerEnabled: true };
    relay.corpus = [minorsReport(hex(0xe4), base - 50), minorsReport(hex(0xe5), base + 150)];
    relay.closeQueries = new Set([0]);
    const s = makeState();
    await s.storage.put('report-catchup-windows', [first, second]);
    const handled: string[] = [];
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const result = await runPendingCatchUp({
      db: DB, relayUrl: RELAY_URL, storage: s.storage,
      claim: () => true,
      handle: async (report: SignedReport) => { handled.push(report.id); },
      isRunning: () => true,
      alert: vi.fn(async () => {}),
      nowMs: () => 9_000_000,
    });

    expect(result).toMatchObject({ ran: true, complete: false, handled: 0 });
    expect(relay.queries).toHaveLength(1);
    expect(handled).toEqual([]);
    expect(await s.storage.get('report-catchup-windows')).toEqual([first, second]);
  });

  it('steps past a same-second flood with one alert, and a later window still gets auto-hide', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const alerts = () => errors.mock.calls.filter(call => String(call[0]).startsWith('[ALERT] [report-index]'));
    const base = nowSec() - 2000;
    const flooded: CatchUpWindow = { since: base - 1000, until: base, handlerEnabled: true };
    const later: CatchUpWindow = { since: base + 100, until: base + 200, handlerEnabled: true };
    const second = base - 500;
    // 501 reports in one second: a full page of 500 cannot move the cursor
    // below that second. A category no tier acts on keeps 500 handlings cheap.
    const flood = Array.from({ length: 501 }, (_, i) => signed([['e', hex(0x10000 + i)], ['report', 'spam']], second));
    const laterTarget = hex(0xf1);
    relay.corpus = [...flood, minorsReport(laterTarget, base + 150)];

    const w = await newWatcher({ SLACK_WEBHOOK_URL: WEBHOOK_URL });
    w.data.set('report-catchup-windows', [flooded, later]);
    await w.post('/start');
    await settle(w.pending);

    expect(bansFor(laterTarget)).toHaveLength(1);
    // The flooded window stepped past the flood and finished in the same pass.
    expect(w.data.get('report-catchup-windows')).toEqual([]);
    expect(alerts()).toHaveLength(1);
    expect(String(alerts()[0][0])).toContain(String(second));
    expect(String(alerts()[0][0])).toContain(`${flooded.since}..${flooded.until}`);
    expect(String(alerts()[0][0])).toContain('a full page of 500 reports');
    expect(webhookPosts).toHaveLength(1);
    expect((await DB.prepare('SELECT COUNT(*) AS n FROM report_index').first<{ n: number }>())?.n).toBe(501);
  }, 60_000);

  it('two flooded seconds in one window cost one pass and one alert', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const alerts = () => errors.mock.calls.filter(call => String(call[0]).startsWith('[ALERT] [report-index]'));
    const base = nowSec() - 3000;
    const window: CatchUpWindow = { since: base - 1000, until: base, handlerEnabled: true };
    const first = base - 200;
    const second = base - 400;
    const flood = (at: number, offset: number) =>
      Array.from({ length: 501 }, (_, i) => signed([['e', hex(offset + i)], ['report', 'spam']], at));
    // Below both floods: reached in the same pass only if the walk keeps going.
    const olderTarget = hex(0xf6);
    relay.corpus = [...flood(first, 0x20000), ...flood(second, 0x30000), minorsReport(olderTarget, base - 600)];

    const w = await newWatcher({ SLACK_WEBHOOK_URL: WEBHOOK_URL });
    w.data.set('report-catchup-windows', [window]);
    await w.post('/start');
    await settle(w.pending);

    expect(bansFor(olderTarget)).toHaveLength(1);
    expect(w.data.get('report-catchup-windows')).toEqual([]);
    expect(alerts()).toHaveLength(1);
    expect(String(alerts()[0][0])).toContain(String(first));
    expect(String(alerts()[0][0])).toContain(String(second));
    expect(webhookPosts).toHaveLength(1);
  }, 90_000);

  it('a stop halts a running pass at the next page boundary without stranding claimed ids', async () => {
    const base = nowSec() - 2000;
    const first: CatchUpWindow = { since: base - 100, until: base, handlerEnabled: true };
    const second: CatchUpWindow = { since: base + 100, until: base + 200, handlerEnabled: true };
    const targetA = hex(0xf2);
    const targetB = hex(0xf3);
    const b = minorsReport(targetB, base + 150);
    relay.corpus = [minorsReport(targetA, base - 50), b];

    const w = await newWatcher();
    w.data.set('report-catchup-windows', [first, second]);
    // Queries 0 and 1 walk the first window (its page, then the confirming
    // page); query 2 is the second window's page. The stop lands while that
    // page is in flight.
    relay.beforeAnswer = async (n) => { if (n === 2) await w.post('/stop'); };
    await w.post('/start');
    await settle(w.pending);

    expect(relay.queries).toHaveLength(3);
    expect(bansFor(targetA)).toHaveLength(1);
    expect(bansFor(targetB)).toHaveLength(0);
    expect(await allRows(`SELECT report_id FROM report_index WHERE report_id = '${b.id}'`)).toEqual([]);
    expect(w.data.get('report-catchup-windows')).toEqual([second]);

    // The next start resumes the kept window and B is handled: its id was not
    // claimed by the halted pass.
    relay.beforeAnswer = undefined;
    w.data.delete('report-catchup-last-attempt');
    await w.post('/start');
    await settle(w.pending);
    expect(bansFor(targetB)).toHaveLength(1);
    expect(w.data.get('report-catchup-windows')).toEqual([]);
  });

  it('a stop between windows starts no walk of the next window', async () => {
    const base = nowSec() - 2000;
    const first: CatchUpWindow = { since: base - 100, until: base, handlerEnabled: true };
    const second: CatchUpWindow = { since: base + 100, until: base + 200, handlerEnabled: true };
    relay.corpus = [minorsReport(hex(0xf4), base - 50), minorsReport(hex(0xf5), base + 150)];

    const w = await newWatcher();
    w.data.set('report-catchup-windows', [first, second]);
    // Query 1 is the first window's confirming page; the stop lands during it.
    relay.beforeAnswer = async (n) => { if (n === 1) await w.post('/stop'); };
    await w.post('/start');
    await settle(w.pending);

    expect(relay.queries).toHaveLength(2);
    expect(w.data.get('report-catchup-windows')).toEqual([second]);
  });

  it('alerts when a window merge turns the handler off for a window that had it on', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const alerts = () => errors.mock.calls.filter(call => String(call[0]).startsWith('[ALERT] [report-index]'));
    const base = nowSec() - 5000;
    const windows = (firstTwo: [boolean, boolean]): CatchUpWindow[] => [
      { since: base, until: base + 10, handlerEnabled: firstTwo[0] },
      { since: base + 20, until: base + 30, handlerEnabled: firstTwo[1] },
      ...[1, 2, 3, 4, 5, 6].map(i => ({ since: base + 100 * i, until: base + 100 * i + 10, handlerEnabled: true })),
    ];

    // Both on: the merge keeps the handler, no alert.
    await seedHeartbeat(nowSec() - 120);
    const quiet = await newWatcher({ SLACK_WEBHOOK_URL: WEBHOOK_URL });
    quiet.data.set('report-catchup-windows', windows([true, true]));
    await quiet.post('/start');
    await settle(quiet.pending);
    expect(alerts()).toHaveLength(0);

    // On merged with off: the on window's reports lose auto-hide; say so.
    relay.reset();
    await seedHeartbeat(nowSec() - 120);
    const loud = await newWatcher({ SLACK_WEBHOOK_URL: WEBHOOK_URL });
    loud.data.set('report-catchup-windows', windows([true, false]));
    await loud.post('/start');
    await settle(loud.pending);
    expect(alerts()).toHaveLength(1);
    expect(String(alerts()[0][0])).toContain(`${base}..${base + 30}`);
    expect(webhookPosts).toHaveLength(1);
  });

  it('a superseded connection\'s late plan does not start the heartbeat for the newer connection', async () => {
    const w = await newWatcher();
    // Hold the concurrency gate so the first connection's plan queues behind it.
    let release!: () => void;
    const held = w.state.blockConcurrencyWhile(() => new Promise<void>(resolve => { release = resolve; }));
    relay.autoOpen = false;
    await w.post('/start');
    relay.sockets[0].open();
    // A reconnect replaces the socket before the first plan runs. The new
    // socket is live but has not opened through the watcher, so it has no plan.
    (w.watcher as unknown as { connect(): void }).connect();
    const replacement = relay.sockets[1];
    replacement.readyState = FakeSocket.OPEN;
    release();
    await held;
    await settle(w.pending);

    await w.watcher.alarm();
    expect(await DB.prepare("SELECT value FROM report_index_meta WHERE key = 'watcher_last_alive_at'").first()).toBeNull();
  });

  it('retries a failed plan from the health alarm while the socket is open', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const now = nowSec();
    await seedHeartbeat(now - 120);
    const target = hex(0xf7);
    relay.corpus = [minorsReport(target, now - 60)];
    // The watcher's D1, with the heartbeat read failing on demand.
    let failMetaRead = true;
    const flakyDb = new Proxy(DB, {
      get(target, prop) {
        if (prop === 'prepare') {
          return (sql: string) => {
            if (failMetaRead && sql.includes('FROM report_index_meta')) {
              failMetaRead = false;
              return { all: async () => { throw new Error('synthetic D1 failure'); } };
            }
            return target.prepare(sql);
          };
        }
        const value = Reflect.get(target, prop);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });

    const w = await newWatcher({ DB: flakyDb });
    await w.post('/start');
    await settle(w.pending);
    expect(failMetaRead).toBe(false);
    expect(relay.queries).toEqual([]);

    await w.watcher.alarm();
    await settle(w.pending);
    expect(bansFor(target)).toHaveLength(1);
    // Planned now, so the next alarm advances the heartbeat.
    await w.watcher.alarm();
    const stamped = await DB.prepare("SELECT value FROM report_index_meta WHERE key = 'watcher_last_alive_at'").first<{ value: number }>();
    expect(stamped?.value).toBeGreaterThanOrEqual(now);
  });

  it('reads D1 for the plan outside the concurrency gate', async () => {
    await seedHeartbeat(nowSec() - 120);
    let releaseMeta!: () => void;
    const metaGate = new Promise<void>(resolve => { releaseMeta = resolve; });
    let metaStarted = false;
    const slowDb = new Proxy(DB, {
      get(target, prop) {
        if (prop === 'prepare') {
          return (sql: string) => {
            const statement = target.prepare(sql);
            if (!sql.includes('FROM report_index_meta')) return statement;
            return { all: async () => { metaStarted = true; await metaGate; return statement.all(); } };
          };
        }
        const value = Reflect.get(target, prop);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });

    const w = await newWatcher({ DB: slowDb });
    await w.post('/start');
    await waitFor(() => metaStarted);
    // A slow heartbeat read must not hold the gate (30 s there resets the object).
    const gate = await Promise.race([
      w.state.blockConcurrencyWhile(async () => 'free'),
      new Promise(resolve => setTimeout(() => resolve('held'), 200)),
    ]);
    releaseMeta();
    await settle(w.pending);
    expect(gate).toBe('free');
  });

  it('an alarm during a slow plan does not start a second plan', async () => {
    await seedHeartbeat(nowSec() - 120);
    let releaseMeta!: () => void;
    const metaGate = new Promise<void>(resolve => { releaseMeta = resolve; });
    let metaReads = 0;
    const slowDb = new Proxy(DB, {
      get(target, prop) {
        if (prop === 'prepare') {
          return (sql: string) => {
            const statement = target.prepare(sql);
            if (!sql.includes('FROM report_index_meta')) return statement;
            return { all: async () => { metaReads += 1; await metaGate; return statement.all(); } };
          };
        }
        const value = Reflect.get(target, prop);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });

    const w = await newWatcher({ DB: slowDb });
    await w.post('/start');
    await waitFor(() => metaReads === 1);
    // The plan is still reading; the socket is open and not yet planned.
    await w.watcher.alarm();
    await new Promise(resolve => setTimeout(resolve, 50));
    releaseMeta();
    await settle(w.pending);
    expect(metaReads).toBe(1);
    expect(w.data.get('report-catchup-windows')).toEqual([]);
  });

  it('counts sexual-quarantine hide triggers toward the burst alert', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const alerts = () => errors.mock.calls.filter(call => String(call[0]).startsWith('[ALERT] [report-index]'));
    vi.mocked(createQuarantineIO).mockImplementation(() => ({
      snapshot: vi.fn(async (id: string) => ({ event: { id }, assets: [] })),
      eventHold: vi.fn(async () => {}),
      mediaHold: vi.fn(async () => {}),
      verify: vi.fn(async () => true),
      restorationStatus: vi.fn(async () => 'visible' as const),
      review: vi.fn(async () => {}),
      recordDecision: vi.fn(async () => {}),
    }) as unknown as ReturnType<typeof createQuarantineIO>);
    const now = nowSec();
    await seedHeartbeat(now - 120);
    // Six videos each reach the adult threshold (two reporters) and five get an
    // immediate legacy hide: eleven automated hides, five of them legacy. A
    // third reporter on an already-triggered video adds no new hide.
    const reporterTwo = generateSecretKey();
    const reporterThree = generateSecretKey();
    const adult = (target: string, key: Uint8Array, at: number) =>
      finalizeEvent({ kind: 1984, created_at: at, content: '', tags: [['e', target], ['report', 'NS-sexualContent'], ['client', 'diVine']] }, key);
    const adultTargets = [1, 2, 3, 4, 5, 6].map(i => hex(0x5000 + i));
    relay.corpus = [
      ...adultTargets.flatMap((t, i) => [adult(t, reporterKey, now - 90 + i), adult(t, reporterTwo, now - 80 + i)]),
      adult(adultTargets[0], reporterThree, now - 70),
      ...[1, 2, 3, 4, 5].map(i => minorsReport(hex(0x6000 + i), now - 60 + i)),
    ];

    const w = await newWatcher({ SLACK_WEBHOOK_URL: WEBHOOK_URL, SEXUAL_QUARANTINE_ENABLED: 'true' });
    await w.post('/start');
    await settle(w.pending);

    expect(nip86.filter(c => c.method === 'banevent')).toHaveLength(5);
    expect(alerts()).toHaveLength(1);
    expect(String(alerts()[0][0])).toContain('11');
  });
  it('a relay CLOSED on the live subscription drops the socket, so the heartbeat stops and a reconnect catches up', async () => {
    const w = await newWatcher();
    await w.post('/start');
    await settle(w.pending);
    await w.watcher.alarm();
    // Pretend the last stamp was long ago, to see whether the dead socket stamps.
    const stale = nowSec() - 500;
    await seedHeartbeat(stale);
    const live = relay.live!;
    live.socket.emit('message', { data: JSON.stringify(['CLOSED', live.subId, 'error: shutting down']) });
    await settle(w.pending);
    expect(relay.sockets[0].readyState).toBe(FakeSocket.CLOSED);

    // The alarm reconnects and does not stamp for the dead period.
    await w.watcher.alarm();
    const after = await DB.prepare("SELECT value FROM report_index_meta WHERE key = 'watcher_last_alive_at'").first<{ value: number }>();
    expect(after?.value).toBe(stale);
    await settle(w.pending);
    // A new live subscription, on a new socket.
    expect(relay.live?.socket).not.toBe(live.socket);
    expect(relay.live?.socket.readyState).toBe(FakeSocket.OPEN);
    // The new connection plans its gap from the unchanged heartbeat.
    expect(relay.queries.at(-1)).toMatchObject({ since: stale - 600 });
  });

  it('a CLOSED for another subscription id leaves the live socket open', async () => {
    const w = await newWatcher();
    await w.post('/start');
    await settle(w.pending);
    relay.live!.socket.emit('message', { data: JSON.stringify(['CLOSED', 'some-other-sub', 'error: unrelated']) });
    await settle(w.pending);
    expect(relay.live!.socket.readyState).toBe(FakeSocket.OPEN);
  });

  it('the heartbeat waits for the live subscription\'s EOSE, then stamps', async () => {
    const readHeartbeat = async () =>
      (await DB.prepare("SELECT value FROM report_index_meta WHERE key = 'watcher_last_alive_at'").first<{ value: number }>())?.value;
    relay.liveReply = 'none';
    const w = await newWatcher();
    await w.post('/start');
    await settle(w.pending);
    // Connected and planned, but the relay has not acknowledged the REQ.
    const stale = nowSec() - 500;
    await seedHeartbeat(stale);
    await w.watcher.alarm();
    expect(await readHeartbeat()).toBe(stale);

    const live = relay.live!;
    live.socket.emit('message', { data: JSON.stringify(['EOSE', live.subId]) });
    await settle(w.pending);
    await w.watcher.alarm();
    expect(await readHeartbeat()).toBeGreaterThan(stale);
    await w.post('/stop');
  });

  it('an EOSE on a replaced socket does not let the new socket stamp the heartbeat', async () => {
    const readHeartbeat = async () =>
      (await DB.prepare("SELECT value FROM report_index_meta WHERE key = 'watcher_last_alive_at'").first<{ value: number }>())?.value;
    const w = await newWatcher();
    await w.post('/start');
    await settle(w.pending);
    const old = relay.live!;
    // The new socket's REQ is never acknowledged.
    relay.liveReply = 'none';
    (w.watcher as unknown as { connect(): void }).connect();
    await settle(w.pending);
    expect(relay.live!.socket).not.toBe(old.socket);
    const stale = nowSec() - 500;
    await seedHeartbeat(stale);
    await w.watcher.alarm();
    expect(await readHeartbeat()).toBe(stale);

    // A late EOSE from the replaced socket counts for nothing either.
    old.socket.readyState = FakeSocket.OPEN;
    old.socket.emit('message', { data: JSON.stringify(['EOSE', old.subId]) });
    await settle(w.pending);
    await w.watcher.alarm();
    expect(await readHeartbeat()).toBe(stale);
    await w.post('/stop');
  });

  it('a report filed while the live subscription never acknowledged is caught up after the socket drops', async () => {
    const T0 = nowSec();
    await seedHeartbeat(T0 - 60);
    // The relay accepts the socket and the REQ but never answers the REQ.
    relay.liveReply = 'none';
    const w = await newWatcher();
    await w.post('/start');
    await settle(w.pending);
    // Filed during the stall: the dead live subscription never delivers it.
    const target = hex(0xe05e);
    relay.corpus = [minorsReport(target, T0 + 30)];
    // 25 minutes on, the socket is still open and the health alarm runs. It
    // must not move the heartbeat past the report.
    const real = Date.now.bind(Date);
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => real() + 1_500_000);
    await w.watcher.alarm();
    // The socket finally drops; the reconnect's subscription is healthy.
    relay.liveReply = 'eose';
    relay.sockets[0].close();
    await w.watcher.alarm();
    await settle(w.pending);
    clock.mockRestore();
    expect(bansFor(target)).toHaveLength(1);
  });

  it('a window a connect adds while a pass saves its cursor is not lost', async () => {
    const base = nowSec() - 3000;
    const first: CatchUpWindow = { since: base - 100, until: base, handlerEnabled: true };
    const added: CatchUpWindow = { since: base + 500, until: base + 600, handlerEnabled: true };
    const r1 = minorsReport(hex(0x7001), base - 50);
    const r2 = minorsReport(hex(0x7002), base + 550);
    relay.corpus = [r1, r2];
    const s = makeState();
    await s.storage.put('report-catchup-windows', [first]);
    let reads = 0;
    let connect: Promise<unknown> | undefined;
    s.setOnGet(async (key) => {
      if (key !== 'report-catchup-windows') return;
      reads += 1;
      // Read 1 is the pass's own; read 2 is its first cursor save. A connect
      // adds a window between that save's read and its write.
      if (reads !== 2) return;
      connect = s.storage.transaction(async (tx) => {
        const windows = (await tx.get<CatchUpWindow[]>('report-catchup-windows')) ?? [];
        await tx.put('report-catchup-windows', [...windows, added]);
      });
      await new Promise(resolve => setTimeout(resolve, 20));
    });
    const handled: string[] = [];

    await runPendingCatchUp({
      db: DB, relayUrl: RELAY_URL, storage: s.storage, claim: () => true,
      handle: async (report: SignedReport) => { handled.push(report.id); },
      isRunning: () => true, alert: vi.fn(async () => {}), nowMs: () => 9_000_000,
    });
    await connect;

    expect(handled.sort()).toEqual([r1.id, r2.id].sort());
    expect(await s.storage.get('report-catchup-windows')).toEqual([]);
  });

  it('a stopped period a connect adds while a pass prunes is not lost', async () => {
    const base = nowSec() - 3000;
    const done: CatchUpWindow = { since: base - 100, until: base, handlerEnabled: true };
    const kept: CatchUpWindow = { since: base + 500, until: base + 600, handlerEnabled: true };
    // The empty first window completes on query 0; the second fails on query 1.
    relay.closeQueries = new Set([1]);
    const oldPeriod = { after: base - 2000, until: base - 1900 };
    const newPeriod = { after: base + 510, until: base + 520 };
    const s = makeState();
    await s.storage.put('report-catchup-windows', [done, kept]);
    await s.storage.put('report-catchup-stopped-periods', [oldPeriod]);
    let connect: Promise<unknown> | undefined;
    s.setOnGet(async (key) => {
      if (key !== 'report-catchup-stopped-periods' || connect) return;
      // The pass's end-of-pass prune is reading; a connect adds a period.
      connect = s.storage.transaction(async (tx) => {
        const periods = (await tx.get<unknown[]>('report-catchup-stopped-periods')) ?? [];
        await tx.put('report-catchup-stopped-periods', [...periods, newPeriod]);
      });
      await new Promise(resolve => setTimeout(resolve, 20));
    });
    vi.spyOn(console, 'error').mockImplementation(() => {});

    await runPendingCatchUp({
      db: DB, relayUrl: RELAY_URL, storage: s.storage, claim: () => true, handle: async () => {},
      isRunning: () => true, alert: vi.fn(async () => {}), nowMs: () => 9_000_000,
    });
    await connect;

    // The old period is pruned; the new one survives.
    expect(await s.storage.get('report-catchup-stopped-periods')).toEqual([newPeriod]);
  });

  it('a pass dropping a window while a connect plans does not bring the window back', async () => {
    const now = nowSec();
    const heartbeat = now - 120;
    await seedHeartbeat(heartbeat);
    const old: CatchUpWindow = { since: now - 90_000, until: now - 89_000, handlerEnabled: true };
    const w = await newWatcher();
    w.data.set('report-catchup-windows', [old]);
    // Hold the connect's own pass, so only the plan writes.
    w.data.set('report-catchup-last-attempt', Date.now());
    let pass: Promise<unknown> | undefined;
    w.setOnGet(async (key) => {
      if (key !== 'report-catchup-stopped-periods' || pass) return;
      // The plan has read the windows; a running pass finishes the old one.
      pass = w.storage.transaction(async (tx) => {
        const windows = (await tx.get<CatchUpWindow[]>('report-catchup-windows')) ?? [];
        await tx.put('report-catchup-windows', windows.filter(x => x.since !== old.since));
      });
      await new Promise(resolve => setTimeout(resolve, 20));
    });

    await w.post('/start');
    await settle(w.pending);
    await pass;

    const windows = w.data.get('report-catchup-windows') as CatchUpWindow[];
    expect(windows).toHaveLength(1);
    expect(windows[0]).toMatchObject({ since: heartbeat - 600, handlerEnabled: true });
  });

  it('a second stop keeps the earlier unconsumed stop time', async () => {
    const w = await newWatcher();
    // Stopped earlier; started while the relay is unreachable, so that start
    // never planned and the marker is still unconsumed; then stopped again.
    const earlier = nowSec() - 100;
    w.data.set('report-watcher-deliberate-stop', earlier);
    relay.autoOpen = false;
    await w.post('/start');
    await w.post('/stop');
    expect(w.data.get('report-watcher-deliberate-stop')).toBe(earlier);
  });

  it('runs a window a connect adds during the pass in the same invocation', async () => {
    const base = nowSec() - 3000;
    const first: CatchUpWindow = { since: base - 100, until: base, handlerEnabled: true };
    const added: CatchUpWindow = { since: base + 500, until: base + 600, handlerEnabled: true };
    const r1 = minorsReport(hex(0x7101), base - 50);
    const r2 = minorsReport(hex(0x7102), base + 550);
    relay.corpus = [r1, r2];
    const s = makeState();
    await s.storage.put('report-catchup-windows', [first]);
    relay.beforeAnswer = async (n) => {
      if (n !== 0) return;
      await s.storage.transaction(async (tx) => {
        const windows = (await tx.get<CatchUpWindow[]>('report-catchup-windows')) ?? [];
        await tx.put('report-catchup-windows', [...windows, added]);
      });
    };
    const handled: string[] = [];

    const result = await runPendingCatchUp({
      db: DB, relayUrl: RELAY_URL, storage: s.storage, claim: () => true,
      handle: async (report: SignedReport) => { handled.push(report.id); },
      isRunning: () => true, alert: vi.fn(async () => {}), nowMs: () => 9_000_000,
    });

    expect(handled.sort()).toEqual([r1.id, r2.id].sort());
    expect(result).toMatchObject({ ran: true, complete: true });
    expect(await s.storage.get('report-catchup-windows')).toEqual([]);
  });

  it('a finished pass holds the next one for 30 seconds, not 270', async () => {
    const base = nowSec() - 3000;
    const r1 = minorsReport(hex(0x7201), base - 50);
    const r2 = minorsReport(hex(0x7202), base + 550);
    relay.corpus = [r1, r2];
    const s = makeState();
    await s.storage.put('report-catchup-windows', [{ since: base - 100, until: base, handlerEnabled: true }]);
    const handled: string[] = [];
    let clock = 9_000_000;
    const deps = {
      db: DB, relayUrl: RELAY_URL, storage: s.storage, claim: () => true,
      handle: async (report: SignedReport) => { handled.push(report.id); },
      isRunning: () => true, alert: vi.fn(async () => {}), nowMs: () => clock,
    };
    expect(await runPendingCatchUp(deps)).toMatchObject({ ran: true, complete: true });

    // Back-to-back connects add windows; inside the floor they wait.
    await s.storage.put('report-catchup-windows', [{ since: base + 500, until: base + 600, handlerEnabled: true }]);
    clock += 10_000;
    expect(await runPendingCatchUp(deps)).toMatchObject({ ran: false });
    clock += CATCHUP_SUCCESS_INTERVAL_MS - 10_000 - 1;
    expect(await runPendingCatchUp(deps)).toMatchObject({ ran: false });
    clock += 1;
    expect(await runPendingCatchUp(deps)).toMatchObject({ ran: true, complete: true });
    expect(handled.sort()).toEqual([r1.id, r2.id].sort());
    expect(CATCHUP_SUCCESS_INTERVAL_MS).toBe(30_000);
  });

  it('stepping past a flooded second at the window start drops the window without another query', async () => {
    const second = nowSec() - 3000;
    relay.corpus = Array.from({ length: 501 }, (_, i) => signed([['e', hex(0x40000 + i)], ['report', 'spam']], second));
    const s = makeState();
    await s.storage.put('report-catchup-windows', [{ since: second, until: second, handlerEnabled: true }]);
    const alert = vi.fn(async () => {});

    await runPendingCatchUp({
      db: DB, relayUrl: RELAY_URL, storage: s.storage, claim: () => true, handle: async () => {},
      isRunning: () => true, alert, nowMs: () => 9_000_000,
    });

    expect(relay.queries).toHaveLength(1);
    expect(await s.storage.get('report-catchup-windows')).toEqual([]);
    expect(alert).toHaveBeenCalledTimes(1);
  }, 60_000);
  it('a relay that closes every live subscription gets growing reconnect delays', async () => {
    const w = await newWatcher();
    relay.liveReply = 'closed';
    await w.post('/start');
    await settle(w.pending);
    const delays: number[] = [];
    for (let i = 0; i < 3; i++) {
      delays.push((await w.storage.getAlarm())! - Date.now());
      await w.watcher.alarm();
      await settle(w.pending);
    }
    expect(delays[1]).toBeGreaterThan(delays[0] + 500);
    expect(delays[2]).toBeGreaterThan(delays[1] + 1000);
  });

  it('a live subscription that reaches EOSE resets the reconnect backoff', async () => {
    const w = await newWatcher();
    relay.liveReply = 'closed';
    await w.post('/start');
    await settle(w.pending);
    for (let i = 0; i < 2; i++) {
      await w.watcher.alarm();
      await settle(w.pending);
    }
    // Healthy now: the next subscription reaches EOSE, then the socket drops.
    relay.liveReply = 'eose';
    await w.watcher.alarm();
    await settle(w.pending);
    relay.live!.socket.close();
    const delay = (await w.storage.getAlarm())! - Date.now();
    expect(delay).toBeLessThanOrEqual(1000);
  });

  it('an EOSE for another subscription id does not reset the backoff', async () => {
    const w = await newWatcher();
    relay.liveReply = 'closed';
    await w.post('/start');
    await settle(w.pending);
    await w.watcher.alarm();
    await settle(w.pending);
    // This connection's live REQ gets no answer; a stray EOSE arrives instead.
    relay.liveReply = 'none';
    await w.watcher.alarm();
    await settle(w.pending);
    relay.live!.socket.emit('message', { data: JSON.stringify(['EOSE', 'some-other-sub']) });
    await settle(w.pending);
    relay.live!.socket.close();
    const delay = (await w.storage.getAlarm())! - Date.now();
    expect(delay).toBeGreaterThan(2000);
  });

  it('a stale socket\'s late close neither drops the tracked socket nor schedules a reconnect', async () => {
    const w = await newWatcher();
    // No EOSE, so nothing resets the attempt count behind the test's back.
    relay.liveReply = 'none';
    await w.post('/start');
    await settle(w.pending);
    const stale = relay.live!.socket;
    (w.watcher as unknown as { connect(): void }).connect();
    await settle(w.pending);
    const tracked = relay.live!.socket;
    expect(tracked).not.toBe(stale);

    stale.emit('close', { code: 1006, reason: 'late' });
    expect((w.watcher as unknown as { ws: unknown }).ws).toBe(tracked);
    const status = await (await w.watcher.fetch(new Request('https://do/status'))).json() as { status: { reconnectAttempts: number; connected: boolean } };
    expect(status.status).toMatchObject({ reconnectAttempts: 0, connected: true });
    // Still the health-check alarm from /start, not a reconnect a second out.
    expect((await w.storage.getAlarm())! - Date.now()).toBeGreaterThan(5000);
  });

  it('an orphan socket\'s event after a stop runs nothing', async () => {
    const w = await newWatcher();
    await w.post('/start');
    await settle(w.pending);
    const orphan = relay.live!;
    await w.post('/stop');
    const target = hex(0x7301);
    const report = minorsReport(target, nowSec());
    orphan.socket.emit('message', { data: JSON.stringify(['EVENT', orphan.subId, report]) });
    await settle(w.pending);
    expect(bansFor(target)).toHaveLength(0);
    expect(await allRows(`SELECT report_id FROM report_arrivals WHERE report_id = '${report.id}'`)).toEqual([]);
    expect(await allRows(`SELECT report_id FROM report_index WHERE report_id = '${report.id}'`)).toEqual([]);
  });

  it('a stale socket\'s event while running is ignored; the tracked socket handles it', async () => {
    const w = await newWatcher();
    await w.post('/start');
    await settle(w.pending);
    const stale = relay.live!;
    (w.watcher as unknown as { connect(): void }).connect();
    await settle(w.pending);
    const target = hex(0x7302);
    const report = minorsReport(target, nowSec());
    stale.socket.emit('message', { data: JSON.stringify(['EVENT', stale.subId, report]) });
    await settle(w.pending);
    expect(bansFor(target)).toHaveLength(0);
    relay.pushLive(report);
    await settle(w.pending);
    expect(bansFor(target)).toHaveLength(1);
  });

  it('a stale socket\'s CLOSED leaves the tracked socket open', async () => {
    const w = await newWatcher();
    await w.post('/start');
    await settle(w.pending);
    const stale = relay.live!;
    (w.watcher as unknown as { connect(): void }).connect();
    await settle(w.pending);
    const tracked = relay.live!.socket;
    stale.socket.emit('message', { data: JSON.stringify(['CLOSED', stale.subId, 'error: late']) });
    await settle(w.pending);
    expect(tracked.readyState).toBe(FakeSocket.OPEN);
    expect((w.watcher as unknown as { ws: unknown }).ws).toBe(tracked);
  });
});
