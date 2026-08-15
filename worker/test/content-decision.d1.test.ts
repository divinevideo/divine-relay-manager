// ABOUTME: Exercises recorded content decisions against real D1 SQLite.
// ABOUTME: Pins event-id canonicalization and the ReportWatcher-readable row shape.

import { Miniflare } from 'miniflare';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import worker from '../src/index';
import { ensureSchema } from '../src/db';

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
      } as never,
      { waitUntil: vi.fn() } as unknown as ExecutionContext,
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ success: true, eventId, recorded: true });
    const row = await DB.prepare(`
      SELECT target_id, target_type, ever_human_reviewed
      FROM moderation_targets
      WHERE target_id = ? AND ever_human_reviewed = 1
    `).bind(eventId).first();
    expect(row).toEqual({ target_id: eventId, target_type: 'event', ever_human_reviewed: 1 });
  });
});
