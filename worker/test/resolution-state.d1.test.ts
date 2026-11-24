// Real-D1 (Miniflare SQLite) proof that /api/resolution-state covers the WHOLE
// decisions table, not a capped window. /api/decisions returns the newest 1000
// rows, so a target whose only decision predates that window is invisible to it
// and sits in the queue as pending forever with nothing explaining why. The
// truncation banner (#221) disclosed that bound honestly; this endpoint removes
// it. A stubbed DB cannot catch a bad GROUP BY or bind mismatch, so this runs
// against real SQLite.
import { Miniflare } from 'miniflare';
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { ensureSchema } from '../src/db';
import { getAutoHideStates, getHandlingRows } from '../src/resolution-state';
import { handlingByTarget } from '../../shared/handling';
import { ReportWatcher, type ReportEvent } from '../src/ReportWatcher';
import worker from '../src/index';

// ReportWatcher looks the reported account up on the relay before it opens an
// age-review case. There is no relay here, so the lookup finds nothing.
vi.mock('../src/relay-profile', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/relay-profile')>(),
  fetchAccountIdentity: vi.fn(async () => ({ completed: false, profile: null })),
}));

let mf: Miniflare;
let DB: D1Database;

const ctx = {} as ExecutionContext;

const RECENT_TARGET = 'a'.repeat(64);
const PRE_CAP_TARGET = 'b'.repeat(64);
const PRE_CAP_HIDDEN_TARGET = 'c'.repeat(64);
const PRE_CAP_CONFIRMED_TARGET = 'd'.repeat(64);

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

  const stmt = DB.prepare(
    `INSERT INTO moderation_decisions (target_type, target_id, action, created_at)
     VALUES (?, ?, ?, ?)`
  );
  const batch = [];

  // The one decision that the 1000-row window cannot reach: oldest in the table.
  batch.push(stmt.bind('pubkey', PRE_CAP_TARGET, 'dismissed', '2026-01-01 00:00:00'));

  // Auto-hidden and never reviewed: belongs in the pending-review queue, NOT in
  // resolved. Also beyond the window.
  batch.push(stmt.bind('event', PRE_CAP_HIDDEN_TARGET, 'auto_hidden', '2026-01-01 00:00:01'));

  // Auto-hidden and then confirmed by a human. Seeded oldest-action-first so a
  // response that forgets to order newest-first returns 'auto_hidden' at the
  // head and reads as still-pending.
  batch.push(stmt.bind('event', PRE_CAP_CONFIRMED_TARGET, 'auto_hidden', '2026-01-01 00:00:02'));
  batch.push(stmt.bind('event', PRE_CAP_CONFIRMED_TARGET, 'auto_hide_confirmed', '2026-01-01 00:00:03'));

  // 1005 newer rows, all on one other target, so they fill the window by row
  // count without adding distinct targets.
  for (let i = 0; i < 1005; i++) {
    const day = String(1 + Math.floor(i / 100)).padStart(2, '0');
    const min = String(Math.floor((i % 100) / 60)).padStart(2, '0');
    const sec = String(i % 60).padStart(2, '0');
    batch.push(stmt.bind('pubkey', RECENT_TARGET, 'dismissed', `2026-06-${day} 00:${min}:${sec}`));
  }
  await DB.batch(batch);
});

afterAll(async () => {
  await mf?.dispose();
});

function env(db: D1Database = DB) {
  return {
    ALLOWED_ORIGINS: 'https://app.divine.video',
    RELAY_URL: 'wss://relay.divine.video',
    ADMIN_API_KEY: 'test-admin-key',
    DB: db,
  } as never;
}

async function resolutionState(db: D1Database = DB) {
  const res = await worker.fetch(
    new Request('https://api.example/api/resolution-state', {
      headers: { 'X-Admin-Key': 'test-admin-key' },
    }),
    env(db),
    ctx
  );
  const body = (await res.json()) as {
    success: boolean;
    states: Array<{ target_type: string; target_id: string; action: string; at: number | null }>;
    handling_rows: Array<{
      target_type: string; target_id: string; action: string; moderator_pubkey: string | null; at: number | null;
    }>;
  };
  return { res, body };
}

describe('/api/resolution-state against real D1', () => {
  it('sends the handling row of a target whose only decision predates the /api/decisions window', async () => {
    const { res, body } = await resolutionState();

    expect(res.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.handling_rows).toContainEqual({
      target_type: 'pubkey',
      target_id: PRE_CAP_TARGET,
      action: 'dismissed',
      moderator_pubkey: null,
      at: Date.UTC(2026, 0, 1, 0, 0, 0) / 1000,
    });
  });

  it('does not send an auto-hide row as handling', async () => {
    // Auto-hidden content is waiting FOR review. Counting it as handled would
    // subtract the pending-review queue from the view built to work it.
    const { body } = await resolutionState();

    expect(body.handling_rows.some((r) => r.target_id === PRE_CAP_HIDDEN_TARGET)).toBe(false);
  });

  it('returns auto-hide state actions for a target beyond the window', async () => {
    const { body } = await resolutionState();

    expect(body.states).toContainEqual({
      target_type: 'event',
      target_id: PRE_CAP_HIDDEN_TARGET,
      action: 'auto_hidden',
      at: Date.UTC(2026, 0, 1, 0, 0, 1) / 1000,
    });
  });

  // The sensitive switch compares a report with the time a person confirmed or
  // restored an auto-hide (#324), so each state row carries its unix seconds.
  it('dates each auto-hide state row in unix seconds', async () => {
    const { body } = await resolutionState();

    const confirmed = body.states.find(
      (s) => s.target_id === PRE_CAP_CONFIRMED_TARGET && s.action === 'auto_hide_confirmed'
    );
    expect(confirmed?.at).toBe(Date.UTC(2026, 0, 1, 0, 0, 3) / 1000);
  });

  it("orders a target's auto-hide actions newest-first", async () => {
    // getLatestAutoHideState takes the FIRST state action it sees, so the
    // ordering here is what decides whether a confirmed target still reads as
    // pending review.
    const { body } = await resolutionState();

    const actions = body.states
      .filter((s) => s.target_id === PRE_CAP_CONFIRMED_TARGET)
      .map((s) => s.action);

    expect(actions).toEqual(['auto_hide_confirmed', 'auto_hidden']);
  });

  it('leaves that target out of the capped /api/decisions read', async () => {
    // The control: without this contrast the test above could pass against an
    // endpoint that is itself capped, just at a higher number.
    const res = await worker.fetch(
      new Request('https://api.example/api/decisions', {
        headers: { 'X-Admin-Key': 'test-admin-key' },
      }),
      env(),
      ctx
    );
    const body = (await res.json()) as {
      decisions: Array<{ target_id: string }>;
      truncated: boolean;
    };

    expect(body.truncated).toBe(true);
    expect(body.decisions.some((d) => d.target_id === PRE_CAP_TARGET)).toBe(false);
  });
});

// Chunking gets its own database, deliberately small. The reads walk the whole
// table, so forcing many chunks over the 1000-row fixture above meant a thousand
// sequential D1 queries -- eleven seconds of CPU, enough to slow the runner and
// trip a time-sensitive test in another file. A dozen purpose-built rows exercise
// the same cursors in milliseconds.
describe('resolution-state chunking against real D1', () => {
  let chunkMf: Miniflare;
  let chunkDB: D1Database;

  const SAME_SECOND_TARGET = 'e'.repeat(64);
  const NULL_DATED_TARGET = 'f'.repeat(64);
  const DISTINCT_TARGET_COUNT = 8;
  const distinctTarget = (i: number) => `${i}`.repeat(64).slice(0, 64);

  beforeAll(async () => {
    chunkMf = new Miniflare({
      modules: true,
      script: 'export default { fetch() { return new Response("ok"); } };',
      compatibilityDate: '2024-12-01',
      compatibilityFlags: ['nodejs_compat'],
      d1Databases: ['DB'],
    });
    chunkDB = (await chunkMf.getD1Database('DB')) as unknown as D1Database;
    await ensureSchema(chunkDB);

    const stmt = chunkDB.prepare(
      `INSERT INTO moderation_decisions (target_type, target_id, action, created_at)
       VALUES (?, ?, ?, ?)`
    );
    const batch = [];

    // Distinct targets, one decision each, on consecutive ids. One row per target
    // is what makes these tests able to fail: where a target repeats across many
    // rows, a cursor that skips rows still finds it.
    for (let i = 0; i < DISTINCT_TARGET_COUNT; i++) {
      batch.push(stmt.bind('pubkey', distinctTarget(i), 'dismissed', '2026-02-01 00:00:00'));
    }

    // Two state actions sharing one created_at. The cursor orders by
    // (created_at, id), and the id half is the only thing that separates these:
    // a cursor stepping by created_at alone skips whichever falls on a boundary.
    batch.push(stmt.bind('event', SAME_SECOND_TARGET, 'auto_hidden', '2026-01-02 00:00:00'));
    batch.push(stmt.bind('event', SAME_SECOND_TARGET, 'auto_hide_confirmed', '2026-01-02 00:00:00'));

    await chunkDB.batch(batch);

    // created_at is nullable (TEXT DEFAULT CURRENT_TIMESTAMP, no NOT NULL). No
    // writer produces this today and prod holds none, but every comparison
    // against NULL is NULL, so an unguarded cursor drops such a row from every
    // page after the first -- silently, and a pending-review target would vanish
    // from the queue built to work it. The unpaginated read this replaced
    // returned it regardless of date.
    await chunkDB.prepare(
      `INSERT INTO moderation_decisions (target_type, target_id, action, created_at)
       VALUES (?, ?, ?, NULL)`
    ).bind('event', NULL_DATED_TARGET, 'auto_hidden').run();
  });

  afterAll(async () => {
    await chunkMf?.dispose();
  });

  it('returns every handling row across chunk boundaries', async () => {
    const all = await getHandlingRows(chunkDB);
    const chunked = await getHandlingRows(chunkDB, { chunkSize: 1 });

    expect(chunked).toStrictEqual(all);

    // Named explicitly, because the assertion above would still hold if BOTH
    // reads dropped the same targets.
    for (let i = 0; i < DISTINCT_TARGET_COUNT; i++) {
      expect(chunked.filter((r) => r.target_id === distinctTarget(i))).toHaveLength(1);
    }
  });

  it('returns every auto-hide state action across chunk boundaries, still newest-first', async () => {
    const all = await getAutoHideStates(chunkDB);
    const chunked = await getAutoHideStates(chunkDB, { chunkSize: 1 });

    // Order is load-bearing: getLatestAutoHideState takes the first state action
    // it sees, so chunking must not reshuffle them.
    expect(chunked).toEqual(all);

    // Both halves of the same-second pair survive the boundary between them.
    // Without the id tiebreak in the cursor, one of these is skipped.
    expect(
      chunked.filter((s) => s.target_id === SAME_SECOND_TARGET).map((s) => s.action).sort()
    ).toEqual(['auto_hidden', 'auto_hide_confirmed'].sort());

    // And the undated row is still there. A single unchunked read finds it
    // either way, so only the chunked path can lose it.
    expect(
      chunked.filter((s) => s.target_id === NULL_DATED_TARGET).map((s) => s.action)
    ).toEqual(['auto_hidden']);
    // An undated row says so, rather than carrying a made-up time.
    expect(chunked.find((s) => s.target_id === NULL_DATED_TARGET)?.at).toBeNull();
  });
});

// ReportWatcher logs some decisions itself, with moderator_pubkey 'auto' --
// today age_review_case_created on a reported account. No person has looked at
// such a target, so the rows come through getHandlingRows and handlingByTarget
// does not count them as handling (#332). Its own small database, so the
// chunkSize: 1 reads stay fast.
describe('targets only automation has touched, against real D1', () => {
  let autoMf: Miniflare;
  let autoDB: D1Database;

  const AUTO_ONLY = 'ab'.repeat(32);
  const AUTO_THEN_HUMAN = 'cd'.repeat(32);
  const HUMAN_THEN_AUTO = 'ef'.repeat(32);
  const NULL_MODERATOR = 'a1'.repeat(32);
  const MODERATOR = '7e'.repeat(32);

  beforeAll(async () => {
    autoMf = new Miniflare({
      modules: true,
      script: 'export default { fetch() { return new Response("ok"); } };',
      compatibilityDate: '2024-12-01',
      compatibilityFlags: ['nodejs_compat'],
      d1Databases: ['DB'],
    });
    autoDB = (await autoMf.getD1Database('DB')) as unknown as D1Database;
    await ensureSchema(autoDB);

    const stmt = autoDB.prepare(
      `INSERT INTO moderation_decisions (target_type, target_id, action, moderator_pubkey, created_at)
       VALUES (?, ?, ?, ?, ?)`
    );
    // Interleaved, so each target's rows are apart in id order, as they are in
    // production. With chunkSize: 1 every row is its own chunk.
    await autoDB.batch([
      stmt.bind('pubkey', AUTO_ONLY, 'age_review_case_created', 'auto', '2026-03-01 00:00:00'),
      stmt.bind('pubkey', AUTO_THEN_HUMAN, 'age_review_case_created', 'auto', '2026-03-01 00:00:01'),
      stmt.bind('pubkey', HUMAN_THEN_AUTO, 'reviewed', MODERATOR, '2026-03-01 00:00:02'),
      // Human paths write NULL when the moderator's pubkey was not available.
      stmt.bind('pubkey', NULL_MODERATOR, 'reviewed', null, '2026-03-01 00:00:03'),
      stmt.bind('pubkey', AUTO_THEN_HUMAN, 'reviewed', MODERATOR, '2026-03-01 00:00:04'),
      stmt.bind('pubkey', HUMAN_THEN_AUTO, 'age_review_case_created', 'auto', '2026-03-01 00:00:05'),
    ]);
  });

  afterAll(async () => {
    await autoMf?.dispose();
  });

  async function handlingFor(opts?: { chunkSize?: number }) {
    return handlingByTarget(await getHandlingRows(autoDB, opts), []);
  }

  it('gives a target whose only decision the worker wrote itself no handling', async () => {
    expect((await handlingFor()).has(`pubkey:${AUTO_ONLY}`)).toBe(false);
  });

  it('handles a target a moderator also decided on, whichever came first', async () => {
    const handling = await handlingFor();
    expect(handling.has(`pubkey:${AUTO_THEN_HUMAN}`)).toBe(true);
    expect(handling.has(`pubkey:${HUMAN_THEN_AUTO}`)).toBe(true);
  });

  it('handles a decision with no moderator recorded', async () => {
    expect((await handlingFor()).has(`pubkey:${NULL_MODERATOR}`)).toBe(true);
  });

  it('reads the same across chunk boundaries', async () => {
    expect(await handlingFor({ chunkSize: 1 })).toStrictEqual(await handlingFor());
  });

  it('sends the rows to the queue through /api/resolution-state', async () => {
    const { res, body } = await resolutionState(autoDB);

    expect(res.status).toBe(200);
    expect(body.handling_rows).toContainEqual({
      target_type: 'pubkey',
      target_id: AUTO_ONLY,
      action: 'age_review_case_created',
      moderator_pubkey: 'auto',
      at: Date.UTC(2026, 2, 1, 0, 0, 0) / 1000,
    });
  });

  // The fixtures above write 'auto' by hand. This one lets the worker write its
  // own row, so the writer and the rule that reads it cannot drift apart unnoticed.
  it('reads the decision the worker writes when it opens an age-review case as no handling', async () => {
    const state = {
      // The constructor looks for unfinished quarantine jobs in a transaction.
      storage: { get: async () => undefined, put: async () => {},
        transaction: async (fn: (tx: unknown) => unknown) => fn({ getAlarm: async () => null, list: async () => new Map() }) },
      blockConcurrencyWhile: async (callback: () => Promise<void>) => callback(),
    } as unknown as DurableObjectState;
    // Only DB is read on this path: the relay lookup is mocked above, and
    // nothing here signs or calls keycast.
    const watcher = new ReportWatcher(state, { DB: autoDB, NOSTR_NSEC: '', RELAY_URL: 'wss://relay.invalid' });
    const reported = '5c'.repeat(32);
    const event: ReportEvent = {
      id: '6d'.repeat(32),
      pubkey: '8f'.repeat(32),
      kind: 1984,
      content: '',
      tags: [['p', reported]],
      created_at: Math.floor(Date.now() / 1000),
    };

    await watcher['createAgeReviewCase'](event, reported);

    const rows = (await getHandlingRows(autoDB)).filter((r) => r.target_id === reported);
    expect(rows).toHaveLength(1);
    expect(rows[0].action).toBe('age_review_case_created');
    expect(handlingByTarget(rows, []).has(`pubkey:${reported}`)).toBe(false);
  });
});

// The dated decision rows the handled-before rule reads (#324), and Reopen as
// handlingByTarget reads them. Its own small database.
describe('handling rows and reopened targets, against real D1', () => {
  let rowsMf: Miniflare;
  let rowsDB: D1Database;

  const MODERATOR = '7e'.repeat(32);
  const HANDLED = '11'.repeat(32);
  const AUTO_HIDDEN = '22'.repeat(32);
  const REOPENED = '33'.repeat(32);
  const REOPENED_THEN_HANDLED = '44'.repeat(32);
  const REOPENED_THEN_AUTOMATED = '55'.repeat(32);
  const UNDATED = '66'.repeat(32);
  const MAR_1 = 1_772_323_200; // 2026-03-01 00:00:00 UTC

  beforeAll(async () => {
    rowsMf = new Miniflare({
      modules: true,
      script: 'export default { fetch() { return new Response("ok"); } };',
      compatibilityDate: '2024-12-01',
      compatibilityFlags: ['nodejs_compat'],
      d1Databases: ['DB'],
    });
    rowsDB = (await rowsMf.getD1Database('DB')) as unknown as D1Database;
    await ensureSchema(rowsDB);

    const stmt = rowsDB.prepare(
      `INSERT INTO moderation_decisions (target_type, target_id, action, moderator_pubkey, created_at)
       VALUES (?, ?, ?, ?, ?)`
    );
    // Interleaved, so each target's rows sit apart in id order; with
    // chunkSize: 1 every row is its own chunk.
    await rowsDB.batch([
      stmt.bind('event', HANDLED, 'reviewed', MODERATOR, '2026-03-01 00:00:00'),
      stmt.bind('event', AUTO_HIDDEN, 'auto_hidden', 'auto', '2026-03-01 00:00:01'),
      stmt.bind('pubkey', REOPENED, 'banned', MODERATOR, '2026-03-01 00:00:02'),
      stmt.bind('event', REOPENED_THEN_HANDLED, 'reviewed', MODERATOR, '2026-03-01 00:00:03'),
      stmt.bind('event', AUTO_HIDDEN, 'auto_hide_confirmed', MODERATOR, '2026-03-01 00:00:04'),
      stmt.bind('pubkey', REOPENED_THEN_AUTOMATED, 'reviewed', MODERATOR, '2026-03-01 00:00:05'),
      stmt.bind('media', 'f'.repeat(64), 'blocked', MODERATOR, '2026-03-01 00:00:06'),
      stmt.bind('pubkey', REOPENED, 'reopened', MODERATOR, '2026-03-01 00:00:07'),
      stmt.bind('event', REOPENED_THEN_HANDLED, 'reopened', MODERATOR, '2026-03-01 00:00:08'),
      stmt.bind('pubkey', REOPENED_THEN_AUTOMATED, 'reopened', MODERATOR, '2026-03-01 00:00:09'),
      stmt.bind('event', REOPENED_THEN_HANDLED, 'dismissed', MODERATOR, '2026-03-01 00:00:10'),
      stmt.bind('pubkey', REOPENED_THEN_AUTOMATED, 'age_review_case_created', 'auto', '2026-03-01 00:00:11'),
      stmt.bind('event', UNDATED, 'reviewed', null, null),
    ]);
  });

  afterAll(async () => {
    await rowsMf?.dispose();
  });

  it('returns event and pubkey rows dated in unix seconds, without auto-hide rows', async () => {
    const rows = await getHandlingRows(rowsDB);

    expect(rows.filter((r) => r.target_id === HANDLED)).toStrictEqual([
      { target_type: 'event', target_id: HANDLED, action: 'reviewed', moderator_pubkey: MODERATOR, at: MAR_1 },
    ]);
    // A person confirming an auto-hide is not handling (spec): every auto-hide
    // action stays out. And a media decision names no report.
    expect(rows.some((r) => r.target_id === AUTO_HIDDEN)).toBe(false);
    expect(rows.some((r) => r.target_type === 'media')).toBe(false);
  });

  it('keeps the reopened and automated rows the rule needs, and an undated row as null', async () => {
    const rows = await getHandlingRows(rowsDB);

    expect(rows.filter((r) => r.target_id === REOPENED_THEN_AUTOMATED)).toStrictEqual([
      { target_type: 'pubkey', target_id: REOPENED_THEN_AUTOMATED, action: 'reviewed', moderator_pubkey: MODERATOR, at: MAR_1 + 5 },
      { target_type: 'pubkey', target_id: REOPENED_THEN_AUTOMATED, action: 'reopened', moderator_pubkey: MODERATOR, at: MAR_1 + 9 },
      { target_type: 'pubkey', target_id: REOPENED_THEN_AUTOMATED, action: 'age_review_case_created', moderator_pubkey: 'auto', at: MAR_1 + 11 },
    ]);
    expect(rows.filter((r) => r.target_id === UNDATED)).toStrictEqual([
      { target_type: 'event', target_id: UNDATED, action: 'reviewed', moderator_pubkey: null, at: null },
    ]);
  });

  it('returns every row across chunk boundaries', async () => {
    const all = await getHandlingRows(rowsDB);
    const chunked = await getHandlingRows(rowsDB, { chunkSize: 1 });

    // 13 rows seeded, less two auto-hide rows and one media row.
    expect(all).toHaveLength(10);
    expect(chunked).toStrictEqual(all);
  });

  it('leaves a target without handling once it is reopened', async () => {
    const handling = handlingByTarget(await getHandlingRows(rowsDB, { chunkSize: 1 }), []);

    expect(handling.has(`pubkey:${REOPENED}`)).toBe(false);
    expect(handling.has(`event:${HANDLED}`)).toBe(true);
  });

  it('handles a reopened target again when a person handles it after the reopen', async () => {
    const handling = handlingByTarget(await getHandlingRows(rowsDB, { chunkSize: 1 }), []);

    expect(handling.get(`event:${REOPENED_THEN_HANDLED}`)?.handledAt).toBe(MAR_1 + 10);
  });

  it('counts only what came after the reopen: a later automated row alone is no handling', async () => {
    // The person's decision before the reopen no longer counts, so the target
    // has only the worker's row.
    const handling = handlingByTarget(await getHandlingRows(rowsDB, { chunkSize: 1 }), []);

    expect(handling.has(`pubkey:${REOPENED_THEN_AUTOMATED}`)).toBe(false);
  });

  it('sends the rows and states through /api/resolution-state', async () => {
    const { res, body } = await resolutionState(rowsDB);

    expect(res.status).toBe(200);
    expect(Object.keys(body).sort()).toEqual(['handling_rows', 'states', 'success']);
    expect(body.handling_rows).toStrictEqual(await getHandlingRows(rowsDB));
    expect(body.states).toContainEqual({
      target_type: 'event',
      target_id: AUTO_HIDDEN,
      action: 'auto_hide_confirmed',
      at: Date.UTC(2026, 2, 1, 0, 0, 4) / 1000,
    });
  });
});
