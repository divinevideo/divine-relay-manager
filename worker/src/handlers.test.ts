// ABOUTME: Tests for worker API handlers via the default export fetch
// ABOUTME: Covers decision CRUD, moderation actions, info endpoint, CORS

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import worker from './index';

// Test nsec (DO NOT USE IN PRODUCTION - throwaway test key)
const TEST_NSEC = 'nsec1vl029mgpspedva04g90vltkh6fvh240zqtv9k0t9af8935ke9laqsnlfe5';

// ============================================================================
// Mock infrastructure
// ============================================================================

// Track WebSocket instances for relay call simulation
let mockWebSockets: MockWebSocket[] = [];

class MockWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;

  readyState = MockWebSocket.CONNECTING;
  url: string;

  private listeners: Map<string, Array<(event: unknown) => void>> = new Map();

  constructor(url: string) {
    this.url = url;
    mockWebSockets.push(this);
    // Simulate async connection
    setTimeout(() => {
      if (this.readyState === MockWebSocket.CONNECTING) {
        this.readyState = MockWebSocket.OPEN;
        this.emit('open', {});
      }
    }, 0);
  }

  addEventListener(type: string, listener: (event: unknown) => void): void {
    if (!this.listeners.has(type)) {
      this.listeners.set(type, []);
    }
    this.listeners.get(type)!.push(listener);
  }

  send = vi.fn((data: string) => {
    // Auto-respond to relay messages for simpler tests
    try {
      const parsed = JSON.parse(data);
      if (parsed[0] === 'EVENT') {
        // Simulate relay OK response
        setTimeout(() => {
          this.emit('message', { data: JSON.stringify(['OK', parsed[1]?.id || 'unknown', true]) });
        }, 0);
      } else if (parsed[0] === 'REQ') {
        // Simulate EOSE (no matching events)
        setTimeout(() => {
          this.emit('message', { data: JSON.stringify(['EOSE', parsed[1]]) });
        }, 0);
      }
    } catch {
      // ignore
    }
  });

  close(): void {
    this.readyState = MockWebSocket.CLOSED;
    this.emit('close', { code: 1000, reason: 'Normal closure' });
  }

  emit(type: string, event: unknown): void {
    const handlers = this.listeners.get(type) || [];
    for (const handler of handlers) {
      handler(event);
    }
  }
}

// D1 mock: tracks prepared statements and stores rows in-memory
interface MockRow {
  [key: string]: unknown;
}

function createMockDB(initialRows: MockRow[] = []) {
  const rows = [...initialRows];
  let lastChanges = 0;

  const mockRun = vi.fn(async () => {
    lastChanges = 0;
    return { success: true, meta: { changes: lastChanges } };
  });

  const mockAll = vi.fn(async () => ({
    results: rows,
    success: true,
  }));

  const mockFirst = vi.fn(async () => rows[0] || null);

  const mockBind = vi.fn(function (..._args: unknown[]) {
    return {
      run: mockRun,
      all: mockAll,
      first: mockFirst,
    };
  });

  const mockPrepare = vi.fn((_sql: string) => ({
    bind: mockBind,
    run: mockRun,
    all: mockAll,
    first: mockFirst,
  }));

  return {
    db: { prepare: mockPrepare } as unknown as D1Database,
    mockPrepare,
    mockBind,
    mockRun,
    mockAll,
    mockFirst,
    rows,
  };
}

function createMockEnv(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    NOSTR_NSEC: TEST_NSEC,
    RELAY_URL: 'wss://relay.test.com',
    ALLOWED_ORIGINS: 'https://relay.admin.divine.video',
    MANAGEMENT_PATH: '/',
    ...overrides,
  };
}

function makeRequest(path: string, options: RequestInit = {}): Request {
  return new Request(`https://api.test.com${path}`, {
    headers: { 'Origin': 'https://relay.admin.divine.video', ...options.headers as Record<string, string> },
    ...options,
  });
}

async function fetchJSON(path: string, env: Record<string, unknown>, options: RequestInit = {}) {
  const req = makeRequest(path, options);
  const res = await worker.fetch(req, env as never);
  const body = await res.json() as Record<string, unknown>;
  return { status: res.status, body, headers: res.headers };
}

// ============================================================================
// Tests
// ============================================================================

describe('Worker handlers', () => {
  let originalWebSocket: typeof globalThis.WebSocket;
  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockWebSockets = [];
    originalWebSocket = globalThis.WebSocket;
    (globalThis as unknown as { WebSocket: typeof MockWebSocket }).WebSocket = MockWebSocket as unknown as typeof WebSocket;

    // Mock fetch for NIP-86 RPC calls (callNip86Rpc uses fetch)
    mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ result: true }),
    });
    vi.stubGlobal('fetch', mockFetch);
  });

  afterEach(() => {
    (globalThis as unknown as { WebSocket: typeof globalThis.WebSocket }).WebSocket = originalWebSocket;
    vi.restoreAllMocks();
  });

  // ==========================================================================
  // OPTIONS / CORS
  // ==========================================================================

  describe('CORS preflight', () => {
    it('should respond to OPTIONS with CORS headers', async () => {
      const env = createMockEnv();
      const req = makeRequest('/api/info', { method: 'OPTIONS' });
      const res = await worker.fetch(req, env as never);

      expect(res.status).toBe(200);
      expect(res.headers.get('Access-Control-Allow-Origin')).toBe('https://relay.admin.divine.video');
      expect(res.headers.get('Access-Control-Allow-Methods')).toContain('POST');
    });
  });

  // ==========================================================================
  // GET /api/info
  // ==========================================================================

  describe('GET /api/info', () => {
    it('should return pubkey and npub', async () => {
      const env = createMockEnv();
      const { status, body } = await fetchJSON('/api/info', env);

      expect(status).toBe(200);
      expect(body.success).toBe(true);
      expect(body.pubkey).toBeDefined();
      expect((body as Record<string, string>).npub).toMatch(/^npub1/);
      expect((body as Record<string, string>).relay).toBe('wss://relay.test.com');
    });

    it('should return 500 when NOSTR_NSEC not configured', async () => {
      const env = createMockEnv({ NOSTR_NSEC: '' });
      const { status, body } = await fetchJSON('/api/info', env);

      expect(status).toBe(500);
      expect(body.success).toBe(false);
    });
  });

  // ==========================================================================
  // POST /api/decisions (handleLogDecision)
  // ==========================================================================

  describe('POST /api/decisions', () => {
    it('should log a decision to D1', async () => {
      const { db, mockPrepare } = createMockDB();
      const env = createMockEnv({ DB: db });

      const { status, body } = await fetchJSON('/api/decisions', env, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          targetType: 'event',
          targetId: 'event123',
          action: 'delete_event',
          reason: 'CSAM',
          moderatorPubkey: 'mod123',
          reportId: 'report456',
        }),
      });

      expect(status).toBe(200);
      expect(body.success).toBe(true);

      // Verify INSERT was prepared
      const insertCall = mockPrepare.mock.calls.find(
        (call: string[]) => call[0].includes('INSERT INTO moderation_decisions')
      );
      expect(insertCall).toBeDefined();
    });

    it('should return 400 when required fields missing', async () => {
      const { db } = createMockDB();
      const env = createMockEnv({ DB: db });

      const { status, body } = await fetchJSON('/api/decisions', env, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ targetType: 'event' }), // missing targetId and action
      });

      expect(status).toBe(400);
      expect(body.success).toBe(false);
      expect(body.error).toContain('Missing required fields');
    });

    it('should return 500 when DB not configured', async () => {
      const env = createMockEnv(); // no DB
      const { status, body } = await fetchJSON('/api/decisions', env, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          targetType: 'event',
          targetId: 'event123',
          action: 'delete_event',
        }),
      });

      expect(status).toBe(500);
      expect(body.success).toBe(false);
      expect(body.error).toContain('Database not configured');
    });

    it('should handle optional fields as null', async () => {
      const { db, mockBind } = createMockDB();
      const env = createMockEnv({ DB: db });

      await fetchJSON('/api/decisions', env, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          targetType: 'pubkey',
          targetId: 'pubkey123',
          action: 'ban_user',
          // no reason, moderatorPubkey, or reportId
        }),
      });

      // Verify bind was called with nulls for optional fields
      const bindCall = mockBind.mock.calls.find(
        (call: unknown[]) => call[0] === 'pubkey' && call[1] === 'pubkey123'
      );
      expect(bindCall).toBeDefined();
      if (bindCall) {
        expect(bindCall[3]).toBeNull(); // reason
        expect(bindCall[4]).toBeNull(); // moderatorPubkey
        expect(bindCall[5]).toBeNull(); // reportId
      }
    });
  });

  // ==========================================================================
  // GET /api/decisions (handleGetAllDecisions)
  // ==========================================================================

  describe('GET /api/decisions', () => {
    it('should return all decisions', async () => {
      const mockRows = [
        { id: 1, target_type: 'event', target_id: 'e1', action: 'delete_event', created_at: '2026-02-11' },
        { id: 2, target_type: 'pubkey', target_id: 'p1', action: 'ban_user', created_at: '2026-02-10' },
      ];
      const { db } = createMockDB(mockRows);
      const env = createMockEnv({ DB: db });

      const { status, body } = await fetchJSON('/api/decisions', env);

      expect(status).toBe(200);
      expect(body.success).toBe(true);
      expect(body.decisions).toHaveLength(2);
    });

    it('should return empty array when no decisions', async () => {
      const { db } = createMockDB([]);
      const env = createMockEnv({ DB: db });

      const { status, body } = await fetchJSON('/api/decisions', env);

      expect(status).toBe(200);
      expect(body.success).toBe(true);
      expect(body.decisions).toHaveLength(0);
    });

    it('should return 500 when DB not configured', async () => {
      const env = createMockEnv();
      const { status, body } = await fetchJSON('/api/decisions', env);

      expect(status).toBe(500);
      expect(body.error).toContain('Database not configured');
    });
  });

  // ==========================================================================
  // GET /api/decisions/:targetId (handleGetDecisions)
  // ==========================================================================

  describe('GET /api/decisions/:targetId', () => {
    it('should return decisions for a specific target', async () => {
      const mockRows = [
        { id: 1, target_type: 'event', target_id: 'event123', action: 'delete_event' },
      ];
      const { db, mockPrepare } = createMockDB(mockRows);
      const env = createMockEnv({ DB: db });

      const { status, body } = await fetchJSON('/api/decisions/event123', env);

      expect(status).toBe(200);
      expect(body.success).toBe(true);
      expect(body.decisions).toHaveLength(1);

      // Verify the query includes target_id filter
      const selectCall = mockPrepare.mock.calls.find(
        (call: string[]) => call[0].includes('WHERE target_id')
      );
      expect(selectCall).toBeDefined();
    });

    it('should return empty decisions for unknown target', async () => {
      const { db } = createMockDB([]);
      const env = createMockEnv({ DB: db });

      const { status, body } = await fetchJSON('/api/decisions/nonexistent', env);

      expect(status).toBe(200);
      expect(body.success).toBe(true);
      expect(body.decisions).toHaveLength(0);
    });
  });

  // ==========================================================================
  // DELETE /api/decisions/:targetId (handleDeleteDecisions)
  // ==========================================================================

  describe('DELETE /api/decisions/:targetId', () => {
    it('should delete decisions and return count', async () => {
      const mockRun = vi.fn().mockResolvedValue({
        success: true,
        meta: { changes: 3 },
      });
      const db = {
        prepare: vi.fn().mockReturnValue({
          bind: vi.fn().mockReturnValue({ run: mockRun }),
          run: mockRun,
        }),
      } as unknown as D1Database;
      const env = createMockEnv({ DB: db });

      const { status, body } = await fetchJSON('/api/decisions/event123', env, {
        method: 'DELETE',
      });

      // Wait for any async WebSocket operations
      await new Promise(resolve => setTimeout(resolve, 50));

      expect(status).toBe(200);
      expect(body.success).toBe(true);
      expect(body.deleted).toBeDefined();
    });

    it('should return 500 when DB not configured', async () => {
      const env = createMockEnv();

      const { status, body } = await fetchJSON('/api/decisions/event123', env, {
        method: 'DELETE',
      });

      expect(status).toBe(500);
      expect(body.error).toContain('Database not configured');
    });

    it('should attempt to delete resolution labels from relay', async () => {
      const mockRun = vi.fn().mockResolvedValue({
        success: true,
        meta: { changes: 1 },
      });
      const db = {
        prepare: vi.fn().mockReturnValue({
          bind: vi.fn().mockReturnValue({ run: mockRun }),
          run: mockRun,
        }),
      } as unknown as D1Database;
      const env = createMockEnv({ DB: db });

      await fetchJSON('/api/decisions/event123', env, { method: 'DELETE' });

      // Wait for WebSocket operations
      await new Promise(resolve => setTimeout(resolve, 50));

      // Should have created WebSocket(s) for relay query
      expect(mockWebSockets.length).toBeGreaterThanOrEqual(1);
      // WebSocket should have sent REQ for label events
      const sentMessages = mockWebSockets.flatMap(ws =>
        ws.send.mock.calls.map((c: unknown[]) => JSON.parse(c[0] as string))
      );
      const reqMessages = sentMessages.filter((m: unknown[]) => m[0] === 'REQ');
      expect(reqMessages.length).toBeGreaterThanOrEqual(1);
    });
  });

  // ==========================================================================
  // POST /api/moderate (handleModerate)
  // ==========================================================================

  describe('POST /api/moderate', () => {
    it('should return 400 when action missing', async () => {
      const env = createMockEnv();
      const { status, body } = await fetchJSON('/api/moderate', env, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });

      expect(status).toBe(400);
      expect(body.error).toContain('Missing action');
    });

    it('should return 400 for unknown action', async () => {
      const env = createMockEnv();
      const { status, body } = await fetchJSON('/api/moderate', env, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'unknown_action' }),
      });

      expect(status).toBe(400);
      expect(body.error).toContain('Unknown action');
    });

    it('should return 400 when delete_event missing eventId', async () => {
      const env = createMockEnv();
      const { status, body } = await fetchJSON('/api/moderate', env, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'delete_event' }),
      });

      expect(status).toBe(400);
      expect(body.error).toContain('Missing eventId');
    });

    it('should return 400 when ban_pubkey missing pubkey', async () => {
      const env = createMockEnv();
      const { status, body } = await fetchJSON('/api/moderate', env, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'ban_pubkey' }),
      });

      expect(status).toBe(400);
      expect(body.error).toContain('Missing pubkey');
    });

    it('should return 400 when allow_pubkey missing pubkey', async () => {
      const env = createMockEnv();
      const { status, body } = await fetchJSON('/api/moderate', env, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'allow_pubkey' }),
      });

      expect(status).toBe(400);
      expect(body.error).toContain('Missing pubkey');
    });

    it('should call banevent RPC for delete_event', async () => {
      const env = createMockEnv();
      const { status, body } = await fetchJSON('/api/moderate', env, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'delete_event',
          eventId: 'event_to_delete',
          reason: 'CSAM content',
        }),
      });

      // The handler calls handleRelayRpc internally which calls callNip86Rpc (via fetch)
      expect(status).toBe(200);
      expect(body.success).toBe(true);

      // Verify fetch was called with banevent RPC
      const fetchCalls = mockFetch.mock.calls;
      const rpcCall = fetchCalls.find((call: unknown[]) => {
        const body = (call[1] as { body?: string })?.body;
        return body && body.includes('banevent');
      });
      expect(rpcCall).toBeDefined();
    });

    it('should publish event for ban_pubkey', async () => {
      const env = createMockEnv();

      const req = makeRequest('/api/moderate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'ban_pubkey',
          pubkey: 'pubkey_to_ban',
          reason: 'Abuse',
        }),
      });

      const res = await worker.fetch(req, env as never);
      // Wait for WebSocket operations
      await new Promise(resolve => setTimeout(resolve, 50));

      const body = await res.json() as Record<string, unknown>;
      expect(res.status).toBe(200);
      expect(body.success).toBe(true);
      expect(body.event).toBeDefined();

      // Verify a WebSocket was opened to the relay
      const relaySockets = mockWebSockets.filter(ws => ws.url === 'wss://relay.test.com');
      expect(relaySockets.length).toBeGreaterThanOrEqual(1);
    });

    it('should publish event for allow_pubkey', async () => {
      const env = createMockEnv();

      const req = makeRequest('/api/moderate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'allow_pubkey',
          pubkey: 'pubkey_to_allow',
        }),
      });

      const res = await worker.fetch(req, env as never);
      await new Promise(resolve => setTimeout(resolve, 50));

      const body = await res.json() as Record<string, unknown>;
      expect(res.status).toBe(200);
      expect(body.success).toBe(true);
    });
  });

  // ==========================================================================
  // POST /api/relay-rpc (handleRelayRpc)
  // ==========================================================================

  describe('POST /api/relay-rpc', () => {
    it('should forward RPC call via NIP-86', async () => {
      const env = createMockEnv();
      const { status, body } = await fetchJSON('/api/relay-rpc', env, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          method: 'listbannedevents',
          params: [],
        }),
      });

      expect(status).toBe(200);
      expect(body.success).toBe(true);

      // Verify fetch was called to the management endpoint
      expect(mockFetch).toHaveBeenCalled();
      const [url, options] = mockFetch.mock.calls[0];
      expect(url).toContain('relay.test.com');
      expect(options.method).toBe('POST');
    });

    it('should handle RPC with params', async () => {
      const env = createMockEnv();
      await fetchJSON('/api/relay-rpc', env, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          method: 'banevent',
          params: ['event123', 'spam'],
        }),
      });

      const rpcBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(rpcBody.method).toBe('banevent');
      expect(rpcBody.params).toContain('event123');
    });
  });

  // ==========================================================================
  // 404 for unknown routes
  // ==========================================================================

  describe('Unknown routes', () => {
    it('should return 404 for unknown path', async () => {
      const env = createMockEnv();
      const { status, body } = await fetchJSON('/api/nonexistent', env);

      expect(status).toBe(404);
      expect(body.success).toBe(false);
      expect(body.error).toContain('Not found');
    });
  });

  // ==========================================================================
  // D1 error handling
  // ==========================================================================

  describe('D1 error handling', () => {
    it('should return 500 when D1 query fails', async () => {
      const db = {
        prepare: vi.fn().mockReturnValue({
          bind: vi.fn().mockReturnValue({
            run: vi.fn().mockRejectedValue(new Error('D1 internal error')),
          }),
          run: vi.fn().mockResolvedValue({ success: true }), // for ensureDecisionsTable
        }),
      } as unknown as D1Database;
      const env = createMockEnv({ DB: db });

      const { status, body } = await fetchJSON('/api/decisions', env, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          targetType: 'event',
          targetId: 'event123',
          action: 'delete_event',
        }),
      });

      expect(status).toBe(500);
      expect(body.success).toBe(false);
    });
  });
});
