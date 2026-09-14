// Real-D1 (Miniflare SQLite) proof that /api/resolution-state covers the WHOLE
// decisions table, not a capped window. /api/decisions returns the newest 1000
// rows, so a target whose only decision predates that window is invisible to it
// and sits in the queue as pending forever with nothing explaining why. The
// truncation banner (#221) disclosed that bound honestly; this endpoint removes
// it. A stubbed DB cannot catch a bad GROUP BY or bind mismatch, so this runs
// against real SQLite.
import { Miniflare } from 'miniflare';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { ensureSchema } from '../src/db';
import { getResolvedTargets, getAutoHideStates } from '../src/resolution-state';
import worker from '../src/index';

let mf: Miniflare;
let DB: D1Database;

const ctx = {} as ExecutionContext;

const RECENT_TARGET = 'a'.repeat(64);
const PRE_CAP_TARGET = 'b'.repeat(64);
const PRE_CAP_HIDDEN_TARGET = 'c'.repeat(64);
const PRE_CAP_CONFIRMED_TARGET = 'd'.repeat(64);

const SAME_SECOND_TARGET = 'e'.repeat(64);
const NULL_DATED_TARGET = 'f'.repeat(64);
const DISTINCT_TARGET_COUNT = 8;
const distinctTarget = (i: number) => `${i}`.repeat(64).slice(0, 64);

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

  // created_at is nullable (TEXT DEFAULT CURRENT_TIMESTAMP, no NOT NULL). No
  // writer produces this today and prod holds none, but the keyset cursor
  // compares on created_at, and every comparison against NULL is NULL -- so an
  // unguarded cursor drops such a row from every page after the first, silently,
  // and a pending-review target would vanish from the queue built to work it.
  // The unpaginated query this replaced would have returned it.
  await DB.prepare(
    `INSERT INTO moderation_decisions (target_type, target_id, action, created_at)
     VALUES (?, ?, ?, NULL)`
  ).bind('event', NULL_DATED_TARGET, 'auto_hidden').run();

  // Two state actions sharing one created_at. The keyset cursor orders by
  // (created_at, id), and the id half of that pair is the only thing that can
  // separate these: a cursor that steps by created_at alone skips whichever of
  // them falls on the chunk boundary.
  batch.push(stmt.bind('event', SAME_SECOND_TARGET, 'auto_hidden', '2026-01-02 00:00:00'));
  batch.push(stmt.bind('event', SAME_SECOND_TARGET, 'auto_hide_confirmed', '2026-01-02 00:00:00'));

  // Distinct targets, one decision each, on consecutive ids. These are what make
  // the chunking tests able to fail: where a target repeats across many rows, a
  // cursor that skips rows still finds it, so only one-row-per-target data can
  // tell a correct cursor from one that overshoots the boundary.
  for (let i = 0; i < DISTINCT_TARGET_COUNT; i++) {
    batch.push(stmt.bind('pubkey', distinctTarget(i), 'dismissed', '2026-02-01 00:00:00'));
  }

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

function env() {
  return {
    ALLOWED_ORIGINS: 'https://app.divine.video',
    RELAY_URL: 'wss://relay.divine.video',
    ADMIN_API_KEY: 'test-admin-key',
    DB,
  } as never;
}

async function resolutionState() {
  const res = await worker.fetch(
    new Request('https://api.example/api/resolution-state', {
      headers: { 'X-Admin-Key': 'test-admin-key' },
    }),
    env(),
    ctx
  );
  const body = (await res.json()) as {
    success: boolean;
    resolved: Array<{ target_type: string; target_id: string }>;
    states: Array<{ target_type: string; target_id: string; action: string }>;
  };
  return { res, body };
}

describe('/api/resolution-state against real D1', () => {
  it('resolves a target whose only decision predates the /api/decisions window', async () => {
    const { res, body } = await resolutionState();

    expect(res.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.resolved).toContainEqual({
      target_type: 'pubkey',
      target_id: PRE_CAP_TARGET,
    });
  });

  it('does not treat an auto-hidden target as resolved', async () => {
    // Auto-hidden content is waiting FOR review. Counting it as handled would
    // subtract the pending-review queue from the view built to work it.
    const { body } = await resolutionState();

    expect(body.resolved).not.toContainEqual({
      target_type: 'event',
      target_id: PRE_CAP_HIDDEN_TARGET,
    });
  });

  it('returns auto-hide state actions for a target beyond the window', async () => {
    const { body } = await resolutionState();

    expect(body.states).toContainEqual({
      target_type: 'event',
      target_id: PRE_CAP_HIDDEN_TARGET,
      action: 'auto_hidden',
    });
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

  // The reads are chunked so no single D1 query has to return the whole table.
  // Chunking is invisible in the result by design, so the only way to tell a
  // working cursor from a broken one is to force several chunks and count.
  it('returns every resolved target across chunk boundaries', async () => {
    const all = await getResolvedTargets(DB);
    const chunked = await getResolvedTargets(DB, { chunkSize: 1 });

    expect(chunked).toHaveLength(all.length);
    expect(chunked).toEqual(expect.arrayContaining(all));

    // Named explicitly, because the assertions above would still hold if BOTH
    // reads dropped the same targets. Each of these appears in exactly one row,
    // so a cursor that steps past its boundary loses it outright.
    for (let i = 0; i < DISTINCT_TARGET_COUNT; i++) {
      expect(chunked).toContainEqual({ target_type: 'pubkey', target_id: distinctTarget(i) });
    }
  });

  it('returns every auto-hide state action across chunk boundaries, still newest-first', async () => {
    const all = await getAutoHideStates(DB);
    const chunked = await getAutoHideStates(DB, { chunkSize: 1 });

    // Order is load-bearing: getLatestAutoHideState takes the first state
    // action it sees, so chunking must not reshuffle them.
    expect(chunked).toEqual(all);
    expect(
      chunked.filter((s) => s.target_id === PRE_CAP_CONFIRMED_TARGET).map((s) => s.action)
    ).toEqual(['auto_hide_confirmed', 'auto_hidden']);

    // Both halves of the same-second pair survive the chunk boundary between
    // them. Without the id tiebreak in the cursor, one of these is skipped.
    expect(
      chunked.filter((s) => s.target_id === SAME_SECOND_TARGET).map((s) => s.action).sort()
    ).toEqual(['auto_hidden', 'auto_hide_confirmed'].sort());

    // And the undated row is still there. It is reachable in a single unchunked
    // read either way, so only the chunked path can lose it.
    expect(
      chunked.filter((s) => s.target_id === NULL_DATED_TARGET).map((s) => s.action)
    ).toEqual(['auto_hidden']);
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
