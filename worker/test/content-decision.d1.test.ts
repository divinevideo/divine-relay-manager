// ABOUTME: Exercises recorded content decisions against real D1 SQLite.
// ABOUTME: Pins event-id canonicalization and the ReportWatcher-readable row shape.

import { Miniflare } from 'miniflare';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import worker from '../src/index';
import { ensureSchema } from '../src/db';
import { hasActiveAutoHide, hasLatestHumanRestore } from '../src/ReportWatcher';
import { markHumanAction } from '../src/human-decision';

const TEST_NSEC = 'nsec1vl029mgpspedva04g90vltkh6fvh240zqtv9k0t9af8935ke9laqsnlfe5';

let mf: Miniflare;
let DB: D1Database;

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

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await mf?.dispose();
});

describe('recorded content decisions on real D1', () => {
  it('stores an uppercase request id in the lowercase form ReportWatcher queries', async () => {
    const eventId = 'ab'.repeat(32);
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async () =>
      new Response(JSON.stringify({ result: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    ));

    const response = await worker.fetch(
      new Request('https://api-relay-prod.divine.video/api/moderate', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Admin-Key': 'test-admin-key',
        },
        body: JSON.stringify({ action: 'allow_event', eventId: eventId.toUpperCase() }),
      }),
      {
        NOSTR_NSEC: TEST_NSEC,
        RELAY_URL: 'wss://relay.divine.video',
        ALLOWED_ORIGINS: '',
        ADMIN_API_KEY: 'test-admin-key',
        DB,
        REPORT_WATCHER: {
          idFromName: () => 'singleton',
          get: () => ({
            fetch: async (request: Request) => {
              const operation = await request.json() as { eventId: string; humanAction: string };
              const recorded = await markHumanAction(DB, 'event', operation.eventId, operation.humanAction);
              return Response.json({ success: true, recorded });
            },
          }),
        },
      } as never,
      { waitUntil: vi.fn() } as unknown as ExecutionContext,
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ success: true, eventId, recorded: true });
    const row = await DB.prepare(`
      SELECT target_id, target_type, ever_human_reviewed, last_human_action
      FROM moderation_targets
      WHERE target_id = ? AND ever_human_reviewed = 1
    `).bind(eventId).first();
    expect(row).toEqual({
      target_id: eventId,
      target_type: 'event',
      ever_human_reviewed: 1,
      last_human_action: 'allow_event',
    });
  });

  it('compensates allow-direction actions but not hides or deletes', async () => {
    const eventId = 'cd'.repeat(32);
    const expected: Record<string, boolean> = {
      allow_event: true,
      restore_event: true,
      auto_hide_restored: true,
      reviewed: false,
      dismissed: false,
      'no-action': false,
      'false-positive': false,
      hide_event: false,
      delete_event: false,
    };

    for (const [action, restores] of Object.entries(expected)) {
      await DB.prepare(`
        INSERT INTO moderation_targets (target_id, target_type, ever_human_reviewed, last_human_action)
        VALUES (?, 'event', 1, ?)
        ON CONFLICT(target_id) DO UPDATE SET last_human_action = excluded.last_human_action
      `).bind(eventId, action).run();
      expect(await hasLatestHumanRestore(DB, eventId), action).toBe(restores);
    }
  });

  it('restores only an active auto-hide without a later manual hide', async () => {
    const eventId = 'ce'.repeat(32);
    await DB.prepare(`DELETE FROM moderation_decisions WHERE target_id = ?`).bind(eventId).run();
    await DB.prepare(`DELETE FROM moderation_targets WHERE target_id = ?`).bind(eventId).run();
    await DB.prepare(`
      INSERT INTO moderation_decisions (target_type, target_id, action)
      VALUES ('event', ?, 'auto_hidden')
    `).bind(eventId).run();

    expect(await hasActiveAutoHide(DB, eventId)).toBe(true);

    await DB.prepare(`
      INSERT INTO moderation_decisions (target_type, target_id, action)
      VALUES ('event', ?, 'auto_hide_confirmed')
    `).bind(eventId).run();
    expect(await hasActiveAutoHide(DB, eventId)).toBe(false);

    await DB.prepare(`
      INSERT INTO moderation_decisions (target_type, target_id, action)
      VALUES ('event', ?, 'auto_hidden')
    `).bind(eventId).run();
    expect(await hasActiveAutoHide(DB, eventId)).toBe(true);

    await markHumanAction(DB, 'event', eventId, 'delete_event');
    expect(await hasActiveAutoHide(DB, eventId)).toBe(false);

    await DB.prepare(`DELETE FROM moderation_targets WHERE target_id = ?`).bind(eventId).run();
    await DB.prepare(`
      INSERT INTO moderation_decisions (target_type, target_id, action)
      VALUES ('event', ?, 'auto_hide_restored')
    `).bind(eventId).run();
    expect(await hasActiveAutoHide(DB, eventId)).toBe(false);
  });

  it('does not let a delayed audit write overwrite authoritative visibility intent', async () => {
    const eventId = 'ef'.repeat(32);
    await DB.prepare(`
      INSERT INTO moderation_targets (target_id, target_type, ever_human_reviewed, last_human_action)
      VALUES (?, 'event', 1, 'delete_event')
    `).bind(eventId).run();

    const response = await worker.fetch(
      new Request('https://api-relay-prod.divine.video/api/decisions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Admin-Key': 'test-admin-key',
        },
        body: JSON.stringify({
          targetType: 'event',
          targetId: eventId,
          action: 'restore_event',
        }),
      }),
      {
        NOSTR_NSEC: TEST_NSEC,
        ALLOWED_ORIGINS: '',
        ADMIN_API_KEY: 'test-admin-key',
        DB,
      } as never,
      { waitUntil: vi.fn() } as unknown as ExecutionContext,
    );

    expect(response.status).toBe(200);
    const row = await DB.prepare(`
      SELECT ever_human_reviewed, last_human_action
      FROM moderation_targets
      WHERE target_id = ?
    `).bind(eventId).first();
    expect(row).toEqual({ ever_human_reviewed: 1, last_human_action: 'delete_event' });
  });

  it('rejects delayed generic writes that would redefine event auto-hide state', async () => {
    const eventId = 'f0'.repeat(32);
    await DB.prepare(`DELETE FROM moderation_decisions WHERE target_id = ?`).bind(eventId).run();
    await DB.prepare(`DELETE FROM moderation_targets WHERE target_id = ?`).bind(eventId).run();
    await DB.prepare(`
      INSERT INTO moderation_decisions (target_type, target_id, action)
      VALUES ('event', ?, 'auto_hidden')
    `).bind(eventId).run();

    for (const action of ['auto_hide_confirmed', 'auto_hide_restored']) {
      const response = await worker.fetch(
        new Request('https://api-relay-prod.divine.video/api/decisions', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Admin-Key': 'test-admin-key',
          },
          body: JSON.stringify({ targetType: 'event', targetId: eventId, action }),
        }),
        {
          NOSTR_NSEC: TEST_NSEC,
          ALLOWED_ORIGINS: '',
          ADMIN_API_KEY: 'test-admin-key',
          DB,
        } as never,
        { waitUntil: vi.fn() } as unknown as ExecutionContext,
      );

      expect(response.status, action).toBe(400);
      expect(await hasActiveAutoHide(DB, eventId), action).toBe(true);
    }
  });

  it('returns same-second decisions in append order for list and target reads', async () => {
    const eventId = 'f1'.repeat(32);
    await DB.prepare(`DELETE FROM moderation_decisions WHERE target_id = ?`).bind(eventId).run();
    for (const action of ['auto_hide_unresolved', 'auto_hide_restored']) {
      await DB.prepare(`
        INSERT INTO moderation_decisions (target_type, target_id, action, created_at)
        VALUES ('event', ?, ?, '2026-08-15 00:00:00')
      `).bind(eventId, action).run();
    }

    const env = {
      ALLOWED_ORIGINS: '',
      ADMIN_API_KEY: 'test-admin-key',
      DB,
    } as never;
    const context = { waitUntil: vi.fn() } as unknown as ExecutionContext;
    const request = (path: string) => new Request(`https://api-relay-prod.divine.video${path}`, {
      headers: { 'X-Admin-Key': 'test-admin-key' },
    });

    const targetResponse = await worker.fetch(request(`/api/decisions/${eventId}`), env, context);
    const targetBody = await targetResponse.json() as { decisions: Array<{ action: string }> };
    expect(targetBody.decisions.map(decision => decision.action)).toEqual([
      'auto_hide_restored',
      'auto_hide_unresolved',
    ]);

    const allResponse = await worker.fetch(request('/api/decisions'), env, context);
    const allBody = await allResponse.json() as { decisions: Array<{ target_id: string; action: string }> };
    expect(allBody.decisions
      .filter(decision => decision.target_id === eventId)
      .map(decision => decision.action)).toEqual([
      'auto_hide_restored',
      'auto_hide_unresolved',
    ]);
  });

  it('adds last_human_action to a pre-upgrade moderation_targets table', async () => {
    const legacyMf = new Miniflare({
      modules: true,
      script: 'export default { fetch() { return new Response("ok"); } };',
      compatibilityDate: '2024-12-01',
      compatibilityFlags: ['nodejs_compat'],
      d1Databases: ['DB'],
    });

    try {
      const legacyDb = (await legacyMf.getD1Database('DB')) as unknown as D1Database;
      await legacyDb.prepare(`
        CREATE TABLE moderation_targets (
          target_id TEXT PRIMARY KEY,
          target_type TEXT NOT NULL,
          ever_human_reviewed INTEGER DEFAULT 0
        )
      `).run();

      await ensureSchema(legacyDb);
      const columns = await legacyDb.prepare(`PRAGMA table_info(moderation_targets)`).all<{ name: string }>();
      expect(columns.results.map(column => column.name)).toContain('last_human_action');
      await legacyDb.prepare(`
        INSERT INTO moderation_targets (target_id, target_type, ever_human_reviewed, last_human_action)
        VALUES ('legacy-event', 'event', 1, 'allow_event')
      `).run();
      expect(await hasLatestHumanRestore(legacyDb, 'legacy-event')).toBe(true);
    } finally {
      await legacyMf.dispose();
    }
  });
});
