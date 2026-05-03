import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import worker from './index';

function createMockDB() {
  const rows: Record<string, unknown>[] = [];
  let nextId = 1;

  const db = {
    prepare: vi.fn().mockImplementation((sql: string) => {
      const stmt = {
        bind: vi.fn().mockImplementation((...args: unknown[]) => ({
          run: vi.fn().mockImplementation(async () => {
            if (sql.includes('INSERT INTO pending_verdicts')) {
              const row = {
                id: nextId++,
                event_id: args[0],
                pubkey: args[1],
                verdict: args[2],
                category: args[3],
                rule_name: args[4],
                source: args[5],
                status: 'pending',
                created_at: new Date().toISOString(),
                resolved_at: null,
                resolved_by: null,
              };
              rows.push(row);
              return { success: true, meta: { last_row_id: row.id } };
            }
            if (sql.includes('UPDATE pending_verdicts')) {
              const id = args[args.length - 1];
              const row = rows.find(r => r.id === Number(id));
              if (row) {
                row.status = args[0];
                row.resolved_by = args[1];
              }
              return { success: true, meta: { changes: 1 } };
            }
            return { success: true, meta: { changes: 0 } };
          }),
          first: vi.fn().mockImplementation(async () => {
            if (sql.includes('SELECT * FROM pending_verdicts WHERE id')) {
              const id = Number(args[0]);
              return rows.find(r => r.id === id) || null;
            }
            return null;
          }),
          all: vi.fn().mockImplementation(async () => {
            if (sql.includes('SELECT * FROM pending_verdicts')) {
              const status = args[0] as string;
              return { results: rows.filter(r => r.status === status) };
            }
            return { results: [] };
          }),
        })),
        run: vi.fn().mockResolvedValue({ success: true }),
        first: vi.fn().mockResolvedValue(null),
        all: vi.fn().mockResolvedValue({ results: [] }),
      };
      return stmt;
    }),
  };

  return { db, rows };
}

function createEnv(db: unknown) {
  return {
    RELAY_URL: 'wss://relay.test.com',
    ALLOWED_ORIGINS: 'http://localhost:5173',
    DB: db,
  };
}

function authedRequest(url: string, init?: RequestInit): Request {
  const headers = new Headers(init?.headers);
  headers.set('Cf-Access-Jwt-Assertion', 'test-jwt');
  headers.set('Origin', 'http://localhost:5173');
  return new Request(url, { ...init, headers });
}

describe('pending review queue', () => {
  let mockCtx: ExecutionContext;

  beforeEach(() => {
    mockCtx = { waitUntil: vi.fn(), passThroughOnException: vi.fn() } as unknown as ExecutionContext;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('POST /api/pending-review (submit verdict)', () => {
    it('should create a pending verdict with event_id', async () => {
      const { db } = createMockDB();
      const env = createEnv(db);

      const request = authedRequest('http://localhost/api/pending-review', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          event_id: 'abc123',
          verdict: 'flag_for_review',
          category: 'NS-sexualContent',
          rule_name: 'multi_report_auto_hide',
        }),
      });

      const response = await worker.fetch(request, env as never, mockCtx);
      expect(response.status).toBe(201);

      const body = await response.json() as { success: boolean; id: number };
      expect(body.success).toBe(true);
      expect(body.id).toBe(1);
    });

    it('should create a pending verdict with pubkey only', async () => {
      const { db } = createMockDB();
      const env = createEnv(db);

      const request = authedRequest('http://localhost/api/pending-review', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          pubkey: 'deadbeef',
          verdict: 'flag_for_review',
          category: 'behavioral',
          rule_name: 'repeat_offender',
          source: 'osprey',
        }),
      });

      const response = await worker.fetch(request, env as never, mockCtx);
      expect(response.status).toBe(201);
    });

    it('should reject when neither event_id nor pubkey provided', async () => {
      const { db } = createMockDB();
      const env = createEnv(db);

      const request = authedRequest('http://localhost/api/pending-review', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ verdict: 'flag_for_review' }),
      });

      const response = await worker.fetch(request, env as never, mockCtx);
      expect(response.status).toBe(400);

      const body = await response.json() as { success: boolean; error: string };
      expect(body.success).toBe(false);
      expect(body.error).toContain('event_id or pubkey');
    });
  });

  describe('GET /api/pending-review (list verdicts)', () => {
    it('should list pending verdicts', async () => {
      const { db, rows } = createMockDB();
      rows.push({
        id: 1,
        event_id: 'abc123',
        pubkey: null,
        verdict: 'flag_for_review',
        category: 'NS-sexualContent',
        rule_name: 'test_rule',
        source: 'osprey',
        status: 'pending',
        created_at: new Date().toISOString(),
        resolved_at: null,
        resolved_by: null,
      });
      const env = createEnv(db);

      const request = authedRequest('http://localhost/api/pending-review?status=pending');
      const response = await worker.fetch(request, env as never, mockCtx);
      expect(response.status).toBe(200);

      const body = await response.json() as { success: boolean; verdicts: unknown[] };
      expect(body.success).toBe(true);
      expect(body.verdicts).toHaveLength(1);
    });

    it('should default to pending status when no query param', async () => {
      const { db } = createMockDB();
      const env = createEnv(db);

      const request = authedRequest('http://localhost/api/pending-review');
      const response = await worker.fetch(request, env as never, mockCtx);
      expect(response.status).toBe(200);

      const body = await response.json() as { success: boolean; verdicts: unknown[] };
      expect(body.success).toBe(true);
    });
  });

  describe('POST /api/pending-review/:id/resolve', () => {
    it('should dismiss a pending verdict without enforcement', async () => {
      const { db, rows } = createMockDB();
      rows.push({
        id: 1,
        event_id: 'abc123',
        pubkey: null,
        verdict: 'flag_for_review',
        category: 'NS-sexualContent',
        rule_name: 'test_rule',
        source: 'osprey',
        status: 'pending',
        created_at: new Date().toISOString(),
        resolved_at: null,
        resolved_by: null,
      });
      const env = createEnv(db);

      const request = authedRequest('http://localhost/api/pending-review/1/resolve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'dismiss', resolved_by: 'moderator_npub' }),
      });

      const response = await worker.fetch(request, env as never, mockCtx);
      expect(response.status).toBe(200);

      const body = await response.json() as { success: boolean };
      expect(body.success).toBe(true);
    });

    it('should reject invalid action', async () => {
      const { db } = createMockDB();
      const env = createEnv(db);

      const request = authedRequest('http://localhost/api/pending-review/1/resolve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'invalid' }),
      });

      const response = await worker.fetch(request, env as never, mockCtx);
      expect(response.status).toBe(400);
    });

    it('should return 404 for non-existent verdict', async () => {
      const { db } = createMockDB();
      const env = createEnv(db);

      const request = authedRequest('http://localhost/api/pending-review/999/resolve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'dismiss' }),
      });

      const response = await worker.fetch(request, env as never, mockCtx);
      expect(response.status).toBe(404);
    });

    it('should require auth', async () => {
      const { db } = createMockDB();
      const env = createEnv(db);

      const request = new Request('http://localhost/api/pending-review/1/resolve', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Origin': 'http://localhost:5173',
        },
        body: JSON.stringify({ action: 'dismiss' }),
      });

      const response = await worker.fetch(request, env as never, mockCtx);
      expect(response.status).toBe(401);
    });
  });
});
