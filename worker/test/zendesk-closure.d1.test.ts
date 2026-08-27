// Real-D1 (Miniflare SQLite) validation that syncZendeskAfterAction matches
// linked tickets case-insensitively. The mock-DB unit tests stub SQL and so
// cannot exercise lower() semantics; this seeds a mixed-case event_id and proves
// a lowercase action-side id still resolves it. Removing lower() from the query
// makes this fail (exact match would miss the mixed-case row).
import { Miniflare } from 'miniflare';
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { ensureZendeskTable, syncZendeskAfterAction, closeTicketById } from '../src/zendesk-sync';

let mf: Miniflare;
let DB: D1Database;

// Full Zendesk creds + a succeeding fetch stub: the resolution UPDATE only runs
// when the Zendesk solve confirms (best-effort, honest-status behavior), so the
// row is marked resolved and the case-insensitive match is observable through it.
function makeEnv(db: D1Database) {
  return {
    DB: db,
    NOSTR_NSEC: 'nsec-test',
    RELAY_URL: 'wss://relay.test',
    ZENDESK_SUBDOMAIN: 'rabblelabs',
    ZENDESK_API_TOKEN: 'test-token',
    ZENDESK_EMAIL: 'test@divine.video',
  } as never;
}

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, text: async () => '' }));
});

afterEach(() => {
  vi.restoreAllMocks();
});

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

describe('closeTicketById preserves the audit trail (real D1)', () => {
  it('does not overwrite an already-resolved ticket\'s resolution', async () => {
    await ensureZendeskTable(DB);
    // A ticket already resolved by a real moderation action.
    await DB.prepare(
      `INSERT INTO zendesk_tickets (ticket_id, status, resolution_action, resolution_moderator)
       VALUES (?, 'resolved', 'ban_pubkey', ?)`
    ).bind(800, 'a'.repeat(64)).run();

    // A later manual close of the same ticket (reachable via direct API).
    await closeTicketById(makeEnv(DB), 800, 'b'.repeat(64));

    const row = await DB.prepare(
      `SELECT status, resolution_action, resolution_moderator FROM zendesk_tickets WHERE ticket_id = 800`
    ).first<{ status: string; resolution_action: string; resolution_moderator: string }>();
    // The original ban decision must survive — the guard declines to rewrite it.
    expect(row?.resolution_action).toBe('ban_pubkey');
    expect(row?.resolution_moderator).toBe('a'.repeat(64));
    expect(fetch).not.toHaveBeenCalled();
  });

  it('does not solve an untracked Zendesk ticket', async () => {
    await ensureZendeskTable(DB);

    await expect(closeTicketById(makeEnv(DB), 899, 'b'.repeat(64))).resolves.toBe(false);
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('handleParseReport INSERT tolerates a concurrent duplicate (real D1)', () => {
  it('does not throw when the same ticket_id is inserted twice (ON CONFLICT DO NOTHING)', async () => {
    await ensureZendeskTable(DB);
    const insert = () => DB.prepare(
      `INSERT INTO zendesk_tickets (ticket_id, event_id, status)
       VALUES (?, ?, 'open') ON CONFLICT(ticket_id) DO NOTHING`
    ).bind(850, 'e'.repeat(64)).run();

    await insert();
    // The second delivery (the race the already-processed check can't close) must
    // not throw and must not create a duplicate row.
    await expect(insert()).resolves.toBeDefined();

    const count = await DB.prepare(
      `SELECT COUNT(*) AS n FROM zendesk_tickets WHERE ticket_id = 850`
    ).first<{ n: number }>();
    expect(count?.n).toBe(1);
  });
});
