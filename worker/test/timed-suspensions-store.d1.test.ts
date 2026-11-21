// Real-D1 (Miniflare SQLite) validation for the timed suspension record store.
import { readFileSync } from 'node:fs';
import { Miniflare } from 'miniflare';
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { ensureSchema } from '../src/db';
import {
  getSuspensionRecord, listInForceSuspensions, replaceSuspensionRecord, endSuspensionRecord,
  changeSuspensionEnd, casSuspensionRecord, recordSuspensionDecision, toSuspensionView,
} from '../src/timed-suspensions';

const PK = 'a'.repeat(64);
const PK2 = 'b'.repeat(64);
const MOD = 'c'.repeat(64);
const MOD2 = 'd'.repeat(64);
const END = '2030-01-01T00:00:00.000Z';
const END2 = '2031-01-01T00:00:00.000Z';

const miniflareOptions = {
  modules: true,
  script: 'export default { fetch() { return new Response("ok"); } };',
  compatibilityDate: '2024-12-01',
  compatibilityFlags: ['nodejs_compat'],
  d1Databases: ['DB'],
};

let mf: Miniflare;
let DB: D1Database;

beforeAll(async () => {
  mf = new Miniflare(miniflareOptions);
  DB = (await mf.getD1Database('DB')) as unknown as D1Database;
});
afterAll(async () => { await mf?.dispose(); });

beforeEach(async () => {
  await ensureSchema(DB);
  await DB.prepare('DELETE FROM timed_suspensions').run();
  await DB.prepare('DELETE FROM moderation_decisions').run();
  await DB.prepare('DELETE FROM moderation_targets').run();
});

const force = (pubkey: string, status: string, endsAt: string | null = END) =>
  DB.prepare(`INSERT INTO timed_suspensions (pubkey, ends_at, status, set_at, version) VALUES (?, ?, ?, '2026-01-01T00:00:00.000Z', 3)
    ON CONFLICT(pubkey) DO UPDATE SET status = excluded.status, ends_at = excluded.ends_at`)
    .bind(pubkey, endsAt, status).run();

describe('schema', () => {
  it('ensureSchema is idempotent', async () => {
    await ensureSchema(DB);
    await ensureSchema(DB);
    expect(await DB.prepare(`SELECT name FROM sqlite_master WHERE name = 'timed_suspensions'`).first()).not.toBeNull();
  });

  it('migration 0021 yields the same columns as ensureSchema', async () => {
    const fresh = new Miniflare(miniflareOptions);
    try {
      const db2 = (await fresh.getD1Database('DB')) as unknown as D1Database;
      const sql = readFileSync(new URL('../migrations/0021_timed_suspensions.sql', import.meta.url), 'utf8');
      await db2.batch(sql.replace(/^--.*$/gm, '').split(';').map(s => s.trim()).filter(Boolean).map(s => db2.prepare(s)));
      const info = async (d: D1Database) =>
        (await d.prepare(`SELECT name, type, "notnull" AS nn, dflt_value, pk FROM pragma_table_info('timed_suspensions')`).all()).results;
      const fromMigration = await info(db2);
      expect(fromMigration.length).toBe(13);
      expect(fromMigration).toEqual(await info(DB));
      const idx = await db2.prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_timed_suspensions_due'`).first();
      expect(idx).not.toBeNull();
    } finally { await fresh.dispose(); }
  });
});

describe('datetime compare', () => {
  // Review Focus 1: ISO 'T' sorts after the space in datetime('now'), so a lexical
  // compare delays a same-day expiry to midnight.
  // Fixed literals, so the test cannot straddle midnight UTC.
  it('treats an end one minute earlier the same day as due only under datetime()', async () => {
    await force(PK, 'active', '2030-06-15T11:59:00.000Z');
    const dt = await DB.prepare(`SELECT COUNT(*) c FROM timed_suspensions WHERE datetime(ends_at) <= datetime('2030-06-15 12:00:00')`).first<{ c: number }>();
    const lex = await DB.prepare(`SELECT COUNT(*) c FROM timed_suspensions WHERE ends_at <= datetime('2030-06-15 12:00:00')`).first<{ c: number }>();
    expect(dt!.c).toBe(1);
    expect(lex!.c).toBe(0);
  });
});

describe('replaceSuspensionRecord', () => {
  it('creates an active row', async () => {
    expect(await replaceSuspensionRecord(DB, { pubkey: PK, endsAt: END, moderator: MOD })).toBe(true);
    const r = await getSuspensionRecord(DB, PK);
    expect(r).toMatchObject({ pubkey: PK, ends_at: END, status: 'active', set_by: MOD, version: 0, attempts: 0 });
    expect(r!.set_at).toMatch(/^\d{4}-\d\d-\d\dT/);
  });

  it('overwrites an existing row, clears change/attempt/alert/claim fields, and bumps version', async () => {
    await replaceSuspensionRecord(DB, { pubkey: PK, endsAt: END, moderator: MOD });
    await DB.prepare(`UPDATE timed_suspensions SET status='keycast_pending', changed_by=?, changed_at='x', attempts=4,
      last_error='boom', last_attempt_at='y', last_alerted_at='z', claimed_at='w' WHERE pubkey=?`).bind(MOD2, PK).run();
    const before = (await getSuspensionRecord(DB, PK))!;
    expect(await replaceSuspensionRecord(DB, { pubkey: PK, endsAt: null, moderator: MOD2 })).toBe(true);
    const r = (await getSuspensionRecord(DB, PK))!;
    expect(r).toMatchObject({
      ends_at: null, status: 'active', set_by: MOD2, changed_by: null, changed_at: null,
      attempts: 0, last_error: null, last_attempt_at: null, last_alerted_at: null, claimed_at: null,
    });
    expect(r.version).toBe(before.version + 1);
  });
});

describe('replaceSuspensionRecord against a lift in flight (F12)', () => {
  it('refuses and changes nothing when the row is lifting', async () => {
    await force(PK, 'lifting');
    expect(await replaceSuspensionRecord(DB, { pubkey: PK, endsAt: END2, moderator: MOD2 })).toBe(false);
    expect(await getSuspensionRecord(DB, PK)).toMatchObject({ status: 'lifting', ends_at: END, version: 3, set_by: null });
  });

  it.each(['active', 'keycast_pending', 'lifted', 'already_lifted', 'cancelled_unsuspend', 'cancelled_ban'])(
    'writes over a %s row', async (status) => {
      await force(PK, status);
      expect(await replaceSuspensionRecord(DB, { pubkey: PK, endsAt: END2, moderator: MOD2 })).toBe(true);
      expect(await getSuspensionRecord(DB, PK)).toMatchObject({ status: 'active', ends_at: END2, version: 4 });
    });
});

describe('endSuspensionRecord', () => {
  it.each(['active', 'lifting', 'keycast_pending', 'cancelled_ban'])('ends a %s row', async (status) => {
    await force(PK, status);
    await DB.prepare(`UPDATE timed_suspensions SET changed_by = ? WHERE pubkey = ?`).bind(MOD, PK).run();
    expect(await endSuspensionRecord(DB, PK, 'cancelled_unsuspend')).toBe(true);
    const r = (await getSuspensionRecord(DB, PK))!;
    expect(r.status).toBe('cancelled_unsuspend');
    expect(r.changed_by).toBeNull();
    expect(r.version).toBe(4);
  });

  it.each(['lifted', 'already_lifted', 'cancelled_unsuspend'])('leaves a %s row alone', async (status) => {
    await force(PK, status);
    expect(await endSuspensionRecord(DB, PK, 'already_lifted')).toBe(false);
    const r = (await getSuspensionRecord(DB, PK))!;
    expect(r.status).toBe(status);
    expect(r.version).toBe(3);
  });

  it('returns false for an absent row', async () => {
    expect(await endSuspensionRecord(DB, PK, 'cancelled_unsuspend')).toBe(false);
  });
});

describe('changeSuspensionEnd', () => {
  it.each(['lifting', 'keycast_pending'])('refuses with ending on a %s row, changing nothing', async (status) => {
    await force(PK, status);
    expect(await changeSuspensionEnd(DB, { pubkey: PK, endsAt: END2, moderator: MOD })).toEqual({ kind: 'ending' });
    const r = (await getSuspensionRecord(DB, PK))!;
    expect(r).toMatchObject({ ends_at: END, status, version: 3 });
  });

  it.each(['active', 'cancelled_ban'])('changes a %s row, resumes it as active, and resets attempts', async (status) => {
    await force(PK, status);
    await DB.prepare(`UPDATE timed_suspensions SET attempts=5, last_error='boom', last_attempt_at='2026-11-20T13:00:00.000Z', last_alerted_at='alerted', set_by=? WHERE pubkey=?`).bind(MOD, PK).run();
    const res = await changeSuspensionEnd(DB, { pubkey: PK, endsAt: END2, moderator: MOD2 });
    expect(res).toEqual({ kind: 'changed', previousEndsAt: END, created: false });
    const r = (await getSuspensionRecord(DB, PK))!;
    // last_attempt_at cleared too: the scheduler orders by it, so a changed end starts its wait afresh.
    expect(r).toMatchObject({ ends_at: END2, status: 'active', changed_by: MOD2, attempts: 0, last_error: null, last_attempt_at: null, last_alerted_at: null, set_by: MOD, version: 4 });
    expect(r.changed_at).not.toBeNull();
  });

  it('can clear the end date (null) on an active row', async () => {
    await force(PK, 'active');
    expect(await changeSuspensionEnd(DB, { pubkey: PK, endsAt: null, moderator: MOD }))
      .toEqual({ kind: 'changed', previousEndsAt: END, created: false });
    expect((await getSuspensionRecord(DB, PK))!.ends_at).toBeNull();
  });

  it('creates a fresh active row when none exists', async () => {
    const res = await changeSuspensionEnd(DB, { pubkey: PK, endsAt: END2, moderator: MOD });
    expect(res).toEqual({ kind: 'changed', previousEndsAt: null, created: true });
    expect(await getSuspensionRecord(DB, PK)).toMatchObject({ status: 'active', ends_at: END2, set_by: MOD });
  });

  it.each(['lifted', 'already_lifted', 'cancelled_unsuspend'])('starts a fresh active row over a %s row', async (status) => {
    await force(PK, status);
    await DB.prepare(`UPDATE timed_suspensions SET attempts=2, last_error='e', claimed_at='c', changed_by='old' WHERE pubkey=?`).bind(PK).run();
    const res = await changeSuspensionEnd(DB, { pubkey: PK, endsAt: END2, moderator: MOD });
    expect(res).toEqual({ kind: 'changed', previousEndsAt: null, created: true });
    expect(await getSuspensionRecord(DB, PK)).toMatchObject({
      status: 'active', ends_at: END2, set_by: MOD, changed_by: null, attempts: 0, last_error: null, claimed_at: null, version: 4,
    });
  });

  // A concurrent writer between the read and the write must make this write lose.
  // The version guard is what notices; the db wrapper moves the row after the read.
  function racing(afterRead: () => Promise<unknown>): D1Database {
    let injected = false;
    return {
      prepare: (sql: string) => ({
        bind: (...args: unknown[]) => {
          const bound = DB.prepare(sql).bind(...args);
          return {
            first: async <T,>() => {
              const out = await bound.first<T>();
              if (/^\s*SELECT/i.test(sql) && !injected) { injected = true; await afterRead(); }
              return out;
            },
            run: () => bound.run(),
            all: () => bound.all(),
          };
        },
      }),
    } as unknown as D1Database;
  }

  it('returns conflict when the row moves between the read and the write (existing row)', async () => {
    await force(PK, 'active');
    const db = racing(() => DB.prepare(`UPDATE timed_suspensions SET version = version + 1 WHERE pubkey = ?`).bind(PK).run());
    expect(await changeSuspensionEnd(db, { pubkey: PK, endsAt: END2, moderator: MOD })).toEqual({ kind: 'conflict' });
    expect((await getSuspensionRecord(DB, PK))!.ends_at).toBe(END);
  });

  it('returns conflict when a terminal row is replaced between the read and the write', async () => {
    await force(PK, 'lifted');
    const db = racing(() => replaceSuspensionRecord(DB, { pubkey: PK, endsAt: END, moderator: MOD2 }));
    expect(await changeSuspensionEnd(db, { pubkey: PK, endsAt: END2, moderator: MOD })).toEqual({ kind: 'conflict' });
    expect((await getSuspensionRecord(DB, PK))).toMatchObject({ ends_at: END, set_by: MOD2 });
  });

  it('returns conflict when a row appears between the read and the write (absent row)', async () => {
    const db = racing(() => replaceSuspensionRecord(DB, { pubkey: PK, endsAt: END, moderator: MOD2 }));
    expect(await changeSuspensionEnd(db, { pubkey: PK, endsAt: END2, moderator: MOD })).toEqual({ kind: 'conflict' });
    expect((await getSuspensionRecord(DB, PK))).toMatchObject({ ends_at: END, set_by: MOD2 });
  });
});

describe('casSuspensionRecord', () => {
  it('applies the fields and bumps version when the version matches', async () => {
    await force(PK, 'active');
    expect(await casSuspensionRecord(DB, PK, 3, { status: 'lifting', attempts: 1, last_error: 'e', claimed_at: 'now' })).toBe(true);
    expect(await getSuspensionRecord(DB, PK)).toMatchObject({ status: 'lifting', attempts: 1, last_error: 'e', claimed_at: 'now', version: 4 });
  });

  it('returns false and changes nothing on a stale version', async () => {
    await force(PK, 'active');
    expect(await casSuspensionRecord(DB, PK, 2, { status: 'lifting' })).toBe(false);
    expect(await getSuspensionRecord(DB, PK)).toMatchObject({ status: 'active', version: 3 });
  });

  it('leaves a field alone when its value is undefined, and still bumps the version', async () => {
    await force(PK, 'active');
    await casSuspensionRecord(DB, PK, 3, { last_error: 'keep' });
    expect(await casSuspensionRecord(DB, PK, 4, { last_error: undefined, attempts: 2 })).toBe(true);
    expect(await getSuspensionRecord(DB, PK)).toMatchObject({ last_error: 'keep', attempts: 2, version: 5 });
  });

  it('can set a field to null', async () => {
    await force(PK, 'active');
    await casSuspensionRecord(DB, PK, 3, { last_error: 'x' });
    await casSuspensionRecord(DB, PK, 4, { last_error: null });
    expect((await getSuspensionRecord(DB, PK))!.last_error).toBeNull();
  });
});

describe('listInForceSuspensions', () => {
  it('returns active, lifting and cancelled_ban rows only (F16: lifting still suspended)', async () => {
    await force(PK, 'active');
    await force('1'.repeat(64), 'lifting');
    await force('2'.repeat(64), 'cancelled_ban');
    for (const [i, s] of ['keycast_pending', 'lifted', 'already_lifted', 'cancelled_unsuspend'].entries()) {
      await force(String(i + 3).repeat(64), s);
    }
    const rows = await listInForceSuspensions(DB);
    expect(rows.map(r => r.status).sort()).toEqual(['active', 'cancelled_ban', 'lifting']);
  });
});

describe('recordSuspensionDecision', () => {
  const decisions = () => DB.prepare('SELECT * FROM moderation_decisions').all();
  const reviewed = () => DB.prepare('SELECT * FROM moderation_targets WHERE target_id = ?').bind(PK).first();

  it('records a pubkey decision and marks it human reviewed when human', async () => {
    expect(await recordSuspensionDecision(DB, { pubkey: PK, action: 'suspend_user', reason: 'r', moderator: MOD, human: true })).toBe(true);
    const rows = (await decisions()).results;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ target_type: 'pubkey', target_id: PK, action: 'suspend_user', reason: 'r', moderator_pubkey: MOD });
    expect(await reviewed()).toMatchObject({ ever_human_reviewed: 1 });
  });

  it('does not mark human reviewed when the timer wrote it', async () => {
    expect(await recordSuspensionDecision(DB, { pubkey: PK, action: 'auto_unsuspend_user', reason: 'ended', moderator: null, human: false })).toBe(true);
    expect((await decisions()).results).toHaveLength(1);
    expect(await reviewed()).toBeNull();
  });

  it('catches, logs and returns false on failure', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const broken = { prepare: () => { throw new Error('d1 down'); } } as unknown as D1Database;
    expect(await recordSuspensionDecision(broken, { pubkey: PK, action: 'a', reason: 'r', moderator: null, human: true })).toBe(false);
    expect(err).toHaveBeenCalled();
    err.mockRestore();
  });
});

describe('toSuspensionView', () => {
  it('maps a record to the shared view, showing lifting as active', async () => {
    await force(PK, 'lifting');
    const r = (await getSuspensionRecord(DB, PK))!;
    expect(toSuspensionView(r)).toEqual({ pubkey: PK, endsAt: END, status: 'active', setBy: null, setAt: '2026-01-01T00:00:00.000Z', changedAt: null, version: 3 });
    await force(PK2, 'cancelled_ban');
    expect(toSuspensionView((await getSuspensionRecord(DB, PK2))!).status).toBe('cancelled_ban');
  });
});
