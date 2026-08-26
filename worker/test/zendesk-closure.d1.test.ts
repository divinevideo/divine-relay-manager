// Real-D1 (Miniflare SQLite) validation that syncZendeskAfterAction matches
// linked tickets case-insensitively. The mock-DB unit tests stub SQL and so
// cannot exercise lower() semantics; this seeds a mixed-case event_id and proves
// a lowercase action-side id still resolves it. Removing lower() from the query
// makes this fail (exact match would miss the mixed-case row).
import { Miniflare } from 'miniflare';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { ensureZendeskTable, syncZendeskAfterAction } from '../src/zendesk-sync';

let mf: Miniflare;
let DB: D1Database;

// No Zendesk creds: addZendeskInternalNote no-ops (no network) while the D1
// resolution UPDATE still runs, so the test needs no fetch mocking.
function makeEnv(db: D1Database) {
  return { DB: db, NOSTR_NSEC: 'nsec-test', RELAY_URL: 'wss://relay.test' } as never;
}

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

describe('syncZendeskAfterAction case-insensitive linkage (real D1)', () => {
  it('resolves a ticket whose stored event_id is mixed-case, given a lowercase action id', async () => {
    await ensureZendeskTable(DB);
    // 64 hex chars, deliberately mixed-case.
    const mixedCaseEventId = 'AbCdEf' + '0'.repeat(58);
    await DB.prepare(
      `INSERT INTO zendesk_tickets (ticket_id, event_id, status) VALUES (?, ?, 'open')`
    ).bind(700, mixedCaseEventId).run();

    // Moderation paths lowercase the id before syncing; the stored row is mixed-case.
    await syncZendeskAfterAction(makeEnv(DB), 'delete_event', 'event', mixedCaseEventId.toLowerCase(), '0'.repeat(64));

    const row = await DB.prepare(
      `SELECT status, resolution_action FROM zendesk_tickets WHERE ticket_id = 700`
    ).first<{ status: string; resolution_action: string }>();
    expect(row?.status).toBe('resolved');
    expect(row?.resolution_action).toBe('delete_event');
  });

  it('resolves a ticket whose stored author_pubkey is mixed-case for a pubkey action', async () => {
    await ensureZendeskTable(DB);
    const mixedCasePubkey = 'FEDCBA' + '9'.repeat(58);
    await DB.prepare(
      `INSERT INTO zendesk_tickets (ticket_id, author_pubkey, status) VALUES (?, ?, 'open')`
    ).bind(701, mixedCasePubkey).run();

    await syncZendeskAfterAction(makeEnv(DB), 'ban_pubkey', 'pubkey', mixedCasePubkey.toLowerCase(), '0'.repeat(64));

    const row = await DB.prepare(
      `SELECT status FROM zendesk_tickets WHERE ticket_id = 701`
    ).first<{ status: string }>();
    expect(row?.status).toBe('resolved');
  });
});
