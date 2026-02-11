// ABOUTME: Tests for human decision persistence in moderation handlers
// ABOUTME: Verifies markHumanReviewed is called from action paths and reopen preserves moderation_targets

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import worker from './index';

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

function createEnv(db: unknown) {
  return {
    NOSTR_NSEC: TEST_NSEC,
    RELAY_URL: 'wss://relay.test.com',
    ALLOWED_ORIGINS: 'http://localhost:5173',
    DB: db,
  };
}

describe('human decision persistence', () => {
  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ result: true }),
    });
    vi.stubGlobal('fetch', mockFetch);
    vi.stubGlobal('WebSocket', MockWebSocket);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('POST /api/decisions (handleLogDecision)', () => {
    it('should call markHumanReviewed when logging a decision', async () => {
      const { db, sqlLog } = createMockDB();
      const env = createEnv(db);

      const request = new Request('http://localhost/api/decisions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          targetType: 'event',
          targetId: 'event_abc123',
          action: 'auto_hide_confirmed',
          reason: 'Confirmed by moderator',
        }),
      });

      const response = await worker.fetch(request, env as never);
      expect(response.status).toBe(200);

      // Should have an INSERT into moderation_targets
      const targetInserts = sqlLog.filter(s => s.sql.includes('moderation_targets'));
      expect(targetInserts.length).toBeGreaterThan(0);

      const upsert = targetInserts.find(s => s.sql.includes('INSERT INTO moderation_targets'));
      expect(upsert).toBeDefined();
      expect(upsert!.bindings).toContain('event_abc123');
      expect(upsert!.bindings).toContain('event');
    });

    it('should mark human reviewed for all moderator action types', async () => {
      const actions = [
        'auto_hide_confirmed',
        'auto_hide_restored',
        'ban_user',
        'delete_event',
        'block_media',
      ];

      for (const action of actions) {
        const { db, sqlLog } = createMockDB();
        const env = createEnv(db);

        const request = new Request('http://localhost/api/decisions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            targetType: 'event',
            targetId: `target_${action}`,
            action,
            reason: `Test ${action}`,
          }),
        });

        const response = await worker.fetch(request, env as never);
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
      });

      const response = await worker.fetch(request, env as never);
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
        headers: { 'Content-Type': 'application/json' },
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

      const response = await worker.fetch(request, env as never);
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
        headers: { 'Content-Type': 'application/json' },
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

      const response = await worker.fetch(request, env as never);
      expect(response.status).toBe(200);

      // Should NOT have an INSERT into moderation_targets
      const targetInserts = sqlLog.filter(s =>
        s.sql.includes('moderation_targets') && s.sql.includes('INSERT')
      );
      expect(targetInserts.length).toBe(0);
    });
  });
});
