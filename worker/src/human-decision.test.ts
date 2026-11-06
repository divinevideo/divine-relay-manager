// ABOUTME: Tests for human decision persistence in moderation handlers
// ABOUTME: Verifies markHumanReviewed is called from action paths and reopen preserves moderation_targets

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import worker from './index';
import { markHumanReviewed } from './human-decision';
import { __clearModeratorLoginCache } from './moderator-identity';

// Test nsec (same throwaway key as nip86.test.ts)
const TEST_NSEC = 'nsec1vl029mgpspedva04g90vltkh6fvh240zqtv9k0t9af8935ke9laqsnlfe5';

// Mock WebSocket that auto-accepts published events
class MockWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;

  readyState = MockWebSocket.OPEN;
  private listeners: Map<string, Array<(event: unknown) => void>> = new Map();

  constructor(_url: string) {
    // Auto-fire open
    setTimeout(() => this.emit('open', {}), 0);
  }

  addEventListener(type: string, listener: (event: unknown) => void): void {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type)!.push(listener);
  }

  send(data: string): void {
    const parsed = JSON.parse(data);
    if (parsed[0] === 'EVENT') {
      // Auto-respond OK to EVENT publishes
      setTimeout(() => {
        this.emit('message', { data: JSON.stringify(['OK', parsed[1]?.id || 'test', true, '']) });
      }, 0);
    } else if (parsed[0] === 'REQ') {
      // Auto-respond EOSE (no results) to REQ subscriptions
      const subId = parsed[1];
      setTimeout(() => {
        this.emit('message', { data: JSON.stringify(['EOSE', subId]) });
      }, 0);
    }
  }

  close(): void {
    this.readyState = MockWebSocket.CLOSED;
  }

  private emit(type: string, event: unknown): void {
    for (const handler of this.listeners.get(type) || []) handler(event);
  }
}

// Track all SQL statements executed against the mock DB
function createMockDB() {
  const sqlLog: { sql: string; bindings: unknown[] }[] = [];

  const db = {
    prepare: vi.fn().mockImplementation((sql: string) => {
      const stmt = {
        bind: vi.fn().mockImplementation((...args: unknown[]) => {
          sqlLog.push({ sql, bindings: args });
          return {
            run: vi.fn().mockResolvedValue({ success: true, meta: { changes: 1 } }),
            first: vi.fn().mockResolvedValue(null),
            all: vi.fn().mockResolvedValue({ results: [] }),
          };
        }),
        run: vi.fn().mockResolvedValue({ success: true, meta: { changes: 0 } }),
        first: vi.fn().mockResolvedValue(null),
        all: vi.fn().mockResolvedValue({ results: [] }),
      };
      return stmt;
    }),
  };

  return { db, sqlLog };
}

const TEST_ADMIN_KEY = 'test-admin-key';

function createEnv(db: unknown, operations: unknown[] = []) {
  return {
    NOSTR_NSEC: TEST_NSEC,
    RELAY_URL: 'wss://relay.test.com',
    ALLOWED_ORIGINS: 'http://localhost:5173',
    ADMIN_API_KEY: TEST_ADMIN_KEY,
    DB: db,
    REPORT_WATCHER: {
      idFromName: () => 'singleton',
      get: () => ({
        fetch: async (request: Request) => {
          const operation = await request.json() as { eventId: string; relayAction: string };
          operations.push(operation);
          const recorded = operation.relayAction === 'review'
            ? await markHumanReviewed(db as D1Database, 'event', operation.eventId)
            : true;
          return Response.json({ success: true, recorded });
        },
      }),
    },
  };
}

describe('human decision persistence', () => {
  let mockFetch: ReturnType<typeof vi.fn>;
  let mockCtx: ExecutionContext;

  beforeEach(() => {
    mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ result: true }),
    });
    vi.stubGlobal('fetch', mockFetch);
    vi.stubGlobal('WebSocket', MockWebSocket);
    mockCtx = { waitUntil: vi.fn(), passThroughOnException: vi.fn() } as unknown as ExecutionContext;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('POST /api/decisions (handleLogDecision)', () => {
    it('should call markHumanReviewed when logging a generic decision', async () => {
      const { db, sqlLog } = createMockDB();
      const env = createEnv(db);

      const request = new Request('http://localhost/api/decisions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Admin-Key': TEST_ADMIN_KEY },
        body: JSON.stringify({
          targetType: 'event',
          targetId: 'event_abc123',
          action: 'reviewed',
          reason: 'Reviewed by moderator',
        }),
      });

      const response = await worker.fetch(request, env as never, mockCtx);
      expect(response.status).toBe(200);

      // Should have an INSERT into moderation_targets
      const targetInserts = sqlLog.filter(s => s.sql.includes('moderation_targets'));
      expect(targetInserts.length).toBeGreaterThan(0);

      const upsert = targetInserts.find(s => s.sql.includes('INSERT INTO moderation_targets'));
      expect(upsert).toBeDefined();
      expect(upsert!.bindings).toContain('event_abc123');
      expect(upsert!.bindings).toContain('event');
      expect(upsert!.sql).not.toContain('last_human_action');
    });

    it.each([
      'auto_hidden',
      'auto_hide_reversed',
      'auto_hide_restored',
      'auto_hide_confirmed',
    ])('rejects coordinated event state action %s', async (action) => {
      const { db, sqlLog } = createMockDB();
      const env = createEnv(db);

      const response = await worker.fetch(new Request('http://localhost/api/decisions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Admin-Key': TEST_ADMIN_KEY },
        body: JSON.stringify({ targetType: 'event', targetId: 'event_abc123', action }),
      }), env as never, mockCtx);

      expect(response.status).toBe(400);
      expect(sqlLog.some(({ sql }) => sql.includes('INSERT INTO moderation_decisions'))).toBe(false);
    });

    // The repo's scripts post decisions without one.
    it('records a decision sent with no moderatorPubkey as NULL', async () => {
      const { db, sqlLog } = createMockDB();
      const env = createEnv(db);

      const response = await worker.fetch(new Request('http://localhost/api/decisions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Admin-Key': TEST_ADMIN_KEY },
        body: JSON.stringify({ targetType: 'event', targetId: 'c'.repeat(64), action: 'dismiss', reason: 'Test: dismiss' }),
      }), env as never, mockCtx);

      expect(response.status).toBe(200);
      const insert = sqlLog.find(({ sql }) => sql.includes('INSERT INTO moderation_decisions'));
      expect(insert?.bindings).toEqual(['event', 'c'.repeat(64), 'dismiss', 'Test: dismiss', null, null]);
    });

    it('should mark human reviewed for all moderator action types', async () => {
      const actions = [
        'reviewed',
        'restore_event',
        'ban_user',
        'delete_event',
        'block_media',
      ];

      for (const action of actions) {
        const { db, sqlLog } = createMockDB();
        const env = createEnv(db);

        const request = new Request('http://localhost/api/decisions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Admin-Key': TEST_ADMIN_KEY },
          body: JSON.stringify({
            targetType: 'event',
            targetId: `target_${action}`,
            action,
            reason: `Test ${action}`,
          }),
        });

        const response = await worker.fetch(request, env as never, mockCtx);
        expect(response.status).toBe(200);

        const targetInserts = sqlLog.filter(s => s.sql.includes('moderation_targets'));
        expect(targetInserts.length).toBeGreaterThan(0);
      }
    });
  });

  describe('DELETE /api/decisions/:targetId (handleDeleteDecisions)', () => {
    it('should delete decisions but NOT touch moderation_targets', async () => {
      const { db, sqlLog } = createMockDB();
      const env = createEnv(db);

      // Mock fetch to return empty results for relay label queries
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ([]),
        text: async () => '[]',
      });

      const request = new Request('http://localhost/api/decisions/event_abc123', {
        method: 'DELETE',
        headers: { 'X-Admin-Key': TEST_ADMIN_KEY },
      });

      const response = await worker.fetch(request, env as never, mockCtx);
      const body = await response.json() as { success: boolean };
      expect(body.success).toBe(true);

      // Should have DELETE from moderation_decisions
      const deletes = sqlLog.filter(s => s.sql.includes('DELETE FROM moderation_decisions'));
      expect(deletes.length).toBe(1);
      expect(deletes[0].bindings).toContain('event_abc123');

      // Should NOT have any DELETE/UPDATE on moderation_targets
      const targetDeletes = sqlLog.filter(s =>
        s.sql.includes('moderation_targets') &&
        (s.sql.includes('DELETE') || s.sql.includes('UPDATE'))
      );
      expect(targetDeletes.length).toBe(0);
    });
  });

  describe('POST /api/publish (handlePublish, kind 1985 resolution labels)', () => {
    it('should call markHumanReviewed for resolution labels', async () => {
      const { db, sqlLog } = createMockDB();
      const env = createEnv(db);

      // Mock publishToRelay to succeed
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ['OK', 'event_id', true, ''],
        text: async () => JSON.stringify(['OK', 'event_id', true, '']),
      });

      const request = new Request('http://localhost/api/publish', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Admin-Key': TEST_ADMIN_KEY },
        body: JSON.stringify({
          kind: 1985,
          content: 'Reviewed',
          tags: [
            ['L', 'moderation/resolution'],
            ['l', 'reviewed', 'moderation/resolution'],
            ['e', 'target_event_xyz'],
          ],
        }),
      });

      const response = await worker.fetch(request, env as never, mockCtx);
      expect(response.status).toBe(200);

      // Should have an INSERT into moderation_targets for the target event
      const targetInserts = sqlLog.filter(s => s.sql.includes('moderation_targets'));
      expect(targetInserts.length).toBeGreaterThan(0);

      const upsert = targetInserts.find(s => s.sql.includes('INSERT INTO moderation_targets'));
      expect(upsert).toBeDefined();
      expect(upsert!.bindings).toContain('target_event_xyz');
    });

    it('should NOT call markHumanReviewed for non-resolution labels', async () => {
      const { db, sqlLog } = createMockDB();
      const env = createEnv(db);

      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ['OK', 'event_id', true, ''],
        text: async () => JSON.stringify(['OK', 'event_id', true, '']),
      });

      const request = new Request('http://localhost/api/publish', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Admin-Key': TEST_ADMIN_KEY },
        body: JSON.stringify({
          kind: 1985,
          content: 'Some label',
          tags: [
            ['L', 'some/other/namespace'],
            ['l', 'some-label', 'some/other/namespace'],
            ['e', 'target_event_xyz'],
          ],
        }),
      });

      const response = await worker.fetch(request, env as never, mockCtx);
      expect(response.status).toBe(200);

      // Should NOT have an INSERT into moderation_targets
      const targetInserts = sqlLog.filter(s =>
        s.sql.includes('moderation_targets') && s.sql.includes('INSERT')
      );
      expect(targetInserts.length).toBe(0);
    });

    it('persists the admission fence before publishing an event resolution label', async () => {
      const { db, sqlLog } = createMockDB();
      const env = createEnv(db);
      let reviewedAtPublication = false;
      const originalSend = MockWebSocket.prototype.send;
      vi.spyOn(MockWebSocket.prototype, 'send').mockImplementation(function (this: MockWebSocket, data: string) {
        if (JSON.parse(data)[0] === 'EVENT') {
          reviewedAtPublication = sqlLog.some(entry => entry.sql.includes('INSERT INTO moderation_targets'));
        }
        originalSend.call(this, data);
      });
      const response = await worker.fetch(new Request('http://localhost/api/publish', {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Admin-Key': TEST_ADMIN_KEY },
        body: JSON.stringify({ kind: 1985, content: 'Reviewed', tags: [
          ['L', 'moderation/resolution'], ['l', 'reviewed', 'moderation/resolution'], ['e', 'cd'.repeat(32)],
        ] }),
      }), env as never, mockCtx);
      expect(response.status).toBe(200);
      expect(reviewedAtPublication).toBe(true);
    });

    it('reports saved human review when the later label publication fails', async () => {
      const { db, sqlLog } = createMockDB();
      vi.stubGlobal('WebSocket', class { constructor() { throw new Error('Synthetic relay unavailable'); } });
      const response = await worker.fetch(new Request('http://localhost/api/publish', {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Admin-Key': TEST_ADMIN_KEY },
        body: JSON.stringify({ kind: 1985, content: 'Reviewed', tags: [
          ['L', 'moderation/resolution'], ['l', 'reviewed', 'moderation/resolution'], ['e', 'cd'.repeat(32)],
        ] }),
      }), createEnv(db) as never, mockCtx);
      expect(response.status).toBe(500);
      expect(await response.json()).toMatchObject({ success: false, recorded: true, reconciled: true });
      expect(sqlLog.some(entry => entry.sql.includes('INSERT INTO moderation_targets'))).toBe(true);
      expect(sqlLog.some(entry => entry.sql.includes('zendesk_tickets'))).toBe(false);
    });

    it('serializes a dismissal mark without allowing the event or replacing hide direction', async () => {
      const { db, sqlLog } = createMockDB();
      const operations: unknown[] = [];
      const env = createEnv(db, operations);
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ['OK', 'event_id', true, ''],
        text: async () => JSON.stringify(['OK', 'event_id', true, '']),
      });
      const eventId = 'ab'.repeat(32);

      const response = await worker.fetch(new Request('http://localhost/api/publish', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Admin-Key': TEST_ADMIN_KEY },
        body: JSON.stringify({
          kind: 1985,
          content: 'Dismissed',
          tags: [
            ['L', 'moderation/resolution'],
            ['l', 'dismissed', 'moderation/resolution'],
            ['e', eventId],
          ],
          moderationReason: 'False positive report',
        }),
      }), env as never, mockCtx);

      expect(response.status).toBe(200);
      expect(operations).toEqual([{
        eventId,
        relayAction: 'review',
        humanAction: 'dismissed',
        reason: 'False positive report',
      }]);
      expect(await response.json()).toMatchObject({ success: true, recorded: true, reconciled: true });
      const upsert = sqlLog.find(entry => entry.sql.includes('INSERT INTO moderation_targets'));
      expect(upsert).toBeDefined();
      expect(upsert?.sql).not.toContain('last_human_action');
    });

    it('reports unresolved dismissal state when D1 is not configured', async () => {
      const { db } = createMockDB();
      const env = { ...createEnv(db), DB: undefined };
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ['OK', 'event_id', true, ''],
        text: async () => JSON.stringify(['OK', 'event_id', true, '']),
      });

      const response = await worker.fetch(new Request('http://localhost/api/publish', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Admin-Key': TEST_ADMIN_KEY },
        body: JSON.stringify({
          kind: 1985,
          content: 'Dismissed',
          tags: [
            ['L', 'moderation/resolution'],
            ['l', 'dismissed', 'moderation/resolution'],
            ['e', 'ab'.repeat(32)],
          ],
        }),
      }), env as never, mockCtx);

      expect(response.status).toBe(502);
      const body = await response.json() as Record<string, unknown>;
      expect(body).toMatchObject({
        success: false,
        recorded: false,
        reconciled: false,
        error: 'Moderation database is not configured',
      });
      expect(body).not.toHaveProperty('event');
    });

    it('reports reconciliation false when restore succeeds but the human mark fails', async () => {
      const { db } = createMockDB();
      const env = createEnv(db);
      env.REPORT_WATCHER.get = () => ({
        fetch: async () => Response.json({ success: true, recorded: false }),
      });
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ['OK', 'event_id', true, ''],
        text: async () => JSON.stringify(['OK', 'event_id', true, '']),
      });

      const response = await worker.fetch(new Request('http://localhost/api/publish', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Admin-Key': TEST_ADMIN_KEY },
        body: JSON.stringify({
          kind: 1985,
          content: 'Dismissed',
          tags: [
            ['L', 'moderation/resolution'],
            ['l', 'dismissed', 'moderation/resolution'],
            ['e', 'cd'.repeat(32)],
          ],
        }),
      }), env as never, mockCtx);

      expect(response.status).toBe(502);
      expect(await response.json()).toMatchObject({
        success: false,
        recorded: false,
        reconciled: false,
        error: 'Human-review state was not recorded',
      });
    });

    it('routes Reports reviewed through the case guard before recording human review', async () => {
      const { db, sqlLog } = createMockDB();
      const env = createEnv(db);
      env.REPORT_WATCHER.get = () => ({
        fetch: async () => Response.json({ success: false, conflict: true, error: 'Review the current revision' }),
      });
      const response = await worker.fetch(new Request('http://localhost/api/publish', {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Admin-Key': TEST_ADMIN_KEY },
        body: JSON.stringify({ kind: 1985, content: 'Reviewed', tags: [
          ['L', 'moderation/resolution'], ['l', 'reviewed', 'moderation/resolution'], ['e', 'cd'.repeat(32)],
        ] }),
      }), env as never, mockCtx);
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({ success: false, reconciled: false });
      expect(sqlLog.some(entry => entry.sql.includes('INSERT INTO moderation_targets'))).toBe(false);
      expect(sqlLog.some(entry => entry.sql.includes('zendesk_tickets'))).toBe(false);
    });

    it.each(['dismissed', 'no-action', 'false-positive'])('does not publish or close tickets when a case refuses %s', async status => {
      const { db, sqlLog } = createMockDB();
      const env = createEnv(db);
      const published = vi.spyOn(MockWebSocket.prototype, 'send');
      env.REPORT_WATCHER.get = () => ({
        fetch: async () => Response.json({ success: false, conflict: true, error: 'Review the current revision' }),
      });
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ['OK', 'event_id', true, ''],
        text: async () => JSON.stringify(['OK', 'event_id', true, '']),
      });

      const response = await worker.fetch(new Request('http://localhost/api/publish', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Admin-Key': TEST_ADMIN_KEY },
        body: JSON.stringify({
          kind: 1985,
          content: 'Dismissed',
          tags: [
            ['L', 'moderation/resolution'],
            ['l', status, 'moderation/resolution'],
            ['e', 'cd'.repeat(32)],
          ],
        }),
      }), env as never, mockCtx);

      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({ success: false, recorded: false, reconciled: false });
      expect(sqlLog.some(entry => entry.sql.includes('zendesk_tickets'))).toBe(false);
      expect(published).not.toHaveBeenCalled();
    });

    it('returns explicit recording status for a pubkey dismissal', async () => {
      const { db } = createMockDB();
      const env = createEnv(db);
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ['OK', 'event_id', true, ''],
        text: async () => JSON.stringify(['OK', 'event_id', true, '']),
      });

      const response = await worker.fetch(new Request('http://localhost/api/publish', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Admin-Key': TEST_ADMIN_KEY },
        body: JSON.stringify({
          kind: 1985,
          content: 'Dismissed',
          tags: [
            ['L', 'moderation/resolution'],
            ['l', 'dismissed', 'moderation/resolution'],
            ['p', 'ef'.repeat(32)],
          ],
        }),
      }), env as never, mockCtx);

      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ success: true, recorded: true, reconciled: true });
    });
  });

  describe('DM notification failure isolation', () => {
    it('banpubkey via relay-rpc succeeds when notify fails', async () => {
      const { db } = createMockDB();
      const env = createEnv(db);
      // No MODERATION_ADMIN_URL -- notifyModerationService will throw

      const request = new Request('http://localhost/api/relay-rpc', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Admin-Key': TEST_ADMIN_KEY },
        body: JSON.stringify({
          method: 'banpubkey',
          params: ['abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234', 'spam'],
        }),
      });

      const response = await worker.fetch(request, env as never, mockCtx);
      expect(response.status).toBe(200);
      const body = await response.json() as { success: boolean };
      expect(body.success).toBe(true);

      // waitUntil should have been called with the DM promise
      expect(mockCtx.waitUntil).toHaveBeenCalled();
    });

    it('ban_pubkey via moderate succeeds when notify fails', async () => {
      const { db } = createMockDB();
      const env = createEnv(db);
      // No MODERATION_ADMIN_URL -- notifyModerationService will throw

      const request = new Request('http://localhost/api/moderate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Admin-Key': TEST_ADMIN_KEY },
        body: JSON.stringify({
          action: 'ban_pubkey',
          pubkey: 'abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234',
          reason: 'spam',
        }),
      });

      const response = await worker.fetch(request, env as never, mockCtx);
      expect(response.status).toBe(200);
      const body = await response.json() as { success: boolean };
      expect(body.success).toBe(true);

      expect(mockCtx.waitUntil).toHaveBeenCalled();
    });

    it('delete_event via moderate succeeds when notify fails', async () => {
      const { db } = createMockDB();
      const env = createEnv(db);
      // No MODERATION_ADMIN_URL -- notifyModerationService will throw

      const request = new Request('http://localhost/api/moderate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Admin-Key': TEST_ADMIN_KEY },
        body: JSON.stringify({
          action: 'delete_event',
          eventId: 'ab'.repeat(32),
          pubkey: 'abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234',
          reason: 'Content violation',
        }),
      });

      const response = await worker.fetch(request, env as never, mockCtx);
      expect(response.status).toBe(200);
      const body = await response.json() as { success: boolean };
      expect(body.success).toBe(true);

      expect(mockCtx.waitUntil).toHaveBeenCalled();
    });
  });

  // #178 phase 2: the recorded moderator is the verified Divine login, never a
  // body field. Each route is driven three ways: a verified login, no login
  // (the route's existing fallback), and a body claim with no login (ignored).
  describe('moderator attribution comes from the verified login', () => {
    const VERIFIED = 'b'.repeat(64);
    const FORGED = 'c'.repeat(64);
    const EVENT_ID = 'ab'.repeat(32);
    const resolutionTags = [
      ['L', 'moderation/resolution'],
      ['l', 'reviewed', 'moderation/resolution'],
      ['e', EVENT_ID],
    ];

    type Route = {
      name: string;
      path: string;
      body: Record<string, unknown>;
      // What the route recorded as the moderator: undefined when it recorded none.
      recorded: (ctx: { operations: Array<Record<string, unknown>>; sqlLog: { sql: string; bindings: unknown[] }[] }) => unknown;
      fallback: unknown;
      // Defaults to the verified pubkey; routes with two sinks give a pair.
      verified?: unknown;
    };
    // A missing op must not read as "op without a moderator": return a sentinel
    // so a route that skips the DO call cannot pass the fallback cases.
    const NO_OP = 'no coordinated operation was sent';
    const opModerator = (operations: Array<Record<string, unknown>>) =>
      operations.length === 0 ? NO_OP : operations[0].moderatorPubkey;
    const fromOps = ({ operations }: { operations: Array<Record<string, unknown>> }) => opModerator(operations);
    const routes: Route[] = [
      { name: '/api/publish (resolution label)', path: '/api/publish',
        body: { kind: 1985, content: 'Reviewed', tags: resolutionTags }, recorded: fromOps, fallback: undefined },
      { name: '/api/decisions', path: '/api/decisions',
        body: { targetType: 'pubkey', targetId: 'b'.repeat(64), action: 'reviewed', reason: 'r' },
        recorded: ({ sqlLog }) => sqlLog.find(e => e.sql.includes('INSERT INTO moderation_decisions'))?.bindings[4],
        fallback: null },
      { name: '/api/decisions (event target)', path: '/api/decisions',
        body: { targetType: 'event', targetId: EVENT_ID, action: 'dismiss', reason: 'r' },
        // Two sinks: the review operation and the decisions row.
        recorded: ({ operations, sqlLog }) => [
          opModerator(operations),
          sqlLog.find(e => e.sql.includes('INSERT INTO moderation_decisions'))?.bindings[4],
        ],
        verified: [VERIFIED, VERIFIED], fallback: [undefined, null] },
      { name: '/api/confirm-auto-hide', path: '/api/confirm-auto-hide',
        body: { eventId: EVENT_ID }, recorded: fromOps, fallback: undefined },
      { name: '/api/moderate allow_event', path: '/api/moderate',
        body: { action: 'allow_event', eventId: EVENT_ID }, recorded: fromOps, fallback: undefined },
      { name: '/api/moderate delete_event', path: '/api/moderate',
        body: { action: 'delete_event', eventId: EVENT_ID }, recorded: fromOps, fallback: undefined },
    ];

    async function call(route: Route, opts: { token?: boolean; extra?: Record<string, unknown> }) {
      const { db, sqlLog } = createMockDB();
      const operations: Array<Record<string, unknown>> = [];
      const env = { ...createEnv(db, operations), MODERATOR_LOGIN_URL: 'https://login.example.test' };
      const response = await worker.fetch(new Request(`http://localhost${route.path}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Admin-Key': TEST_ADMIN_KEY,
          ...(opts.token ? { 'X-Divine-Login-Token': 'tok' } : {}),
        },
        body: JSON.stringify({ ...route.body, ...opts.extra }),
      }), env as never, mockCtx);
      return { response, recorded: route.recorded({ operations, sqlLog }) };
    }

    const mismatchLines = (spy: { mock: { calls: unknown[][] } }) =>
      spy.mock.calls.filter(c => String(c[0]).includes('[moderator-identity]'));

    beforeEach(() => {
      __clearModeratorLoginCache();
      // Wrap the base stub once per test, not once per call.
      const baseFetch = mockFetch.getMockImplementation() as (i: unknown, o?: unknown) => Promise<unknown>;
      mockFetch.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) =>
        String(input).endsWith('/api/nostr')
          ? new Response(JSON.stringify({ result: VERIFIED }), { status: 200 })
          : baseFetch(input, init));
    });

    describe.each(routes)('$name', (route) => {
      it('records the verified moderator', async () => {
        const { response, recorded } = await call(route, { token: true });
        expect(response.status).toBe(200);
        expect(recorded).toEqual(route.verified ?? VERIFIED);
      });

      it('records the fallback without a verified login', async () => {
        const { response, recorded } = await call(route, {});
        expect(response.status).toBe(200);
        expect(recorded).toEqual(route.fallback);
      });

      it('ignores a body moderator, and logs no mismatch when nothing is verified', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        for (const claim of [FORGED, { forged: true }, ['e'.repeat(64)]]) {
          const { response, recorded } = await call(route, { extra: { moderatorPubkey: claim } });
          expect(response.status).toBe(200);
          expect(recorded).toEqual(route.fallback);
        }
        expect(mismatchLines(warn)).toEqual([]);
      });
    });

    it('/api/decisions logs one mismatch line and still succeeds when the body claims another moderator', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const { response, recorded } = await call(routes.find(r => r.name === '/api/decisions')!, { token: true, extra: { moderatorPubkey: FORGED } });
      expect(response.status).toBe(200);
      expect(recorded).toBe(VERIFIED);
      expect(mismatchLines(warn)).toHaveLength(1);
    });
  });
});
