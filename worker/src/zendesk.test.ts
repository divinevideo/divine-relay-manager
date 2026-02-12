// ABOUTME: Tests for Zendesk integration handlers
// ABOUTME: Covers webhook, parse-report, mobile-jwt, context, action, sync

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { nip19 } from 'nostr-tools';
import worker from './index';

const TEST_NSEC = 'nsec1vl029mgpspedva04g90vltkh6fvh240zqtv9k0t9af8935ke9laqsnlfe5';
const WEBHOOK_SECRET = 'test-webhook-secret';
const JWT_SECRET = 'test-zendesk-jwt-secret';
const PARSE_REPORT_SECRET = 'test-parse-report-secret';

// ============================================================================
// Mock infrastructure
// ============================================================================

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
    setTimeout(() => {
      if (this.readyState === MockWebSocket.CONNECTING) {
        this.readyState = MockWebSocket.OPEN;
        this.emit('open', {});
      }
    }, 0);
  }

  addEventListener(type: string, listener: (event: unknown) => void): void {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type)!.push(listener);
  }

  send = vi.fn((data: string) => {
    try {
      const parsed = JSON.parse(data);
      if (parsed[0] === 'EVENT') {
        setTimeout(() => this.emit('message', { data: JSON.stringify(['OK', parsed[1]?.id || 'x', true]) }), 0);
      } else if (parsed[0] === 'REQ') {
        setTimeout(() => this.emit('message', { data: JSON.stringify(['EOSE', parsed[1]]) }), 0);
      }
    } catch { /* ignore */ }
  });

  close(): void {
    this.readyState = MockWebSocket.CLOSED;
    this.emit('close', { code: 1000 });
  }

  emit(type: string, event: unknown): void {
    for (const handler of this.listeners.get(type) || []) handler(event);
  }
}

// JWT helpers
function base64UrlEncode(str: string): string {
  return btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function signJwt(payload: Record<string, unknown>, secret: string): Promise<string> {
  const header = base64UrlEncode(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = base64UrlEncode(JSON.stringify(payload));
  const data = new TextEncoder().encode(`${header}.${body}`);
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, data);
  return `${header}.${body}.${base64UrlEncode(String.fromCharCode(...new Uint8Array(sig)))}`;
}

async function makeValidJwt(): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return signJwt({ iss: 'test', iat: now, exp: now + 300, email: 'mod@divine.video', name: 'Moderator' }, JWT_SECRET);
}

// D1 mock
function createMockDB(opts: { firstResult?: unknown; allResults?: unknown[] } = {}) {
  const mockRun = vi.fn().mockResolvedValue({ success: true, meta: { changes: 1 } });
  const mockAll = vi.fn().mockResolvedValue({ results: opts.allResults || [], success: true });
  const mockFirst = vi.fn().mockResolvedValue(opts.firstResult ?? null);

  const mockBind = vi.fn().mockReturnValue({ run: mockRun, all: mockAll, first: mockFirst });
  const mockPrepare = vi.fn().mockReturnValue({ bind: mockBind, run: mockRun, all: mockAll, first: mockFirst });

  return { db: { prepare: mockPrepare } as unknown as D1Database, mockPrepare, mockBind, mockRun, mockAll, mockFirst };
}

function createEnv(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    NOSTR_NSEC: TEST_NSEC,
    RELAY_URL: 'wss://relay.test.com',
    ALLOWED_ORIGINS: 'https://relay.admin.divine.video',
    MANAGEMENT_PATH: '/',
    ZENDESK_JWT_SECRET: JWT_SECRET,
    ZENDESK_WEBHOOK_SECRET: WEBHOOK_SECRET,
    ZENDESK_PARSE_REPORT_SECRET: PARSE_REPORT_SECRET,
    ZENDESK_SUBDOMAIN: 'test',
    ZENDESK_API_TOKEN: 'token123',
    ZENDESK_EMAIL: 'bot@divine.video',
    ZENDESK_FIELD_ACTION_STATUS: '12345',
    ZENDESK_FIELD_ACTION_REQUESTED: '67890',
    ...overrides,
  };
}

function makeRequest(path: string, options: RequestInit & { headers?: Record<string, string> } = {}): Request {
  return new Request(`https://api.test.com${path}`, {
    headers: { Origin: 'https://relay.admin.divine.video', ...options.headers },
    ...options,
  });
}

async function fetchJSON(path: string, env: Record<string, unknown>, options: RequestInit & { headers?: Record<string, string> } = {}) {
  const res = await worker.fetch(makeRequest(path, options), env as never);
  const body = await res.json() as Record<string, unknown>;
  return { status: res.status, body };
}

// ============================================================================
// Tests
// ============================================================================

describe('Zendesk handlers', () => {
  let originalWebSocket: typeof globalThis.WebSocket;
  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockWebSockets = [];
    originalWebSocket = globalThis.WebSocket;
    (globalThis as unknown as { WebSocket: typeof MockWebSocket }).WebSocket = MockWebSocket as unknown as typeof WebSocket;

    // Mock fetch for Zendesk API calls and NIP-86 RPC
    mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ result: true }),
      text: async () => '{}',
    });
    vi.stubGlobal('fetch', mockFetch);
  });

  afterEach(() => {
    (globalThis as unknown as { WebSocket: typeof globalThis.WebSocket }).WebSocket = originalWebSocket;
    vi.restoreAllMocks();
  });

  // ==========================================================================
  // POST /api/zendesk/webhook
  // ==========================================================================

  describe('POST /api/zendesk/webhook', () => {
    function webhookRequest(body: Record<string, unknown>, secret = WEBHOOK_SECRET) {
      const bodyStr = JSON.stringify(body);
      return makeRequest('/api/zendesk/webhook', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Webhook-Key': secret,
        },
        body: bodyStr,
      });
    }

    it('should reject invalid webhook signature', async () => {
      const env = createEnv();
      const { status, body } = await fetchJSON('/api/zendesk/webhook', env, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Webhook-Key': 'wrong-key' },
        body: JSON.stringify({ ticket_id: 1 }),
      });

      expect(status).toBe(401);
      expect(body.error).toContain('Invalid webhook signature');
    });

    it('should accept valid webhook with no action requested', async () => {
      const env = createEnv();
      const req = webhookRequest({ ticket_id: 100, action_requested: 'none' });
      const res = await worker.fetch(req, env as never);
      const body = await res.json() as Record<string, unknown>;

      expect(res.status).toBe(200);
      expect(body.message).toContain('No action');
    });

    it('should accept empty action_requested', async () => {
      const env = createEnv();
      const req = webhookRequest({ ticket_id: 100 });
      const res = await worker.fetch(req, env as never);
      const body = await res.json() as Record<string, unknown>;

      expect(res.status).toBe(200);
      expect(body.message).toContain('No action');
    });

    it('should execute ban_user action', async () => {
      const env = createEnv();
      const req = webhookRequest({
        ticket_id: 100,
        action_requested: 'ban_user',
        nostr_pubkey: 'abcd1234'.repeat(8),
        agent_email: 'admin@divine.video',
      });

      const res = await worker.fetch(req, env as never);
      await new Promise(r => setTimeout(r, 50));
      const body = await res.json() as Record<string, unknown>;

      expect(res.status).toBe(200);
      expect(body.success).toBe(true);
      expect(body.action).toBe('ban_user');

      // Verify NIP-86 RPC call was made (banpubkey)
      const rpcCall = mockFetch.mock.calls.find((c: unknown[]) => {
        const opts = c[1] as { body?: string };
        return opts?.body?.includes('banpubkey');
      });
      expect(rpcCall).toBeDefined();
    });

    it('should execute delete_event action via relay', async () => {
      const env = createEnv();
      const req = webhookRequest({
        ticket_id: 101,
        action_requested: 'delete_event',
        nostr_event_id: 'ef01'.repeat(16),
      });

      const res = await worker.fetch(req, env as never);
      await new Promise(r => setTimeout(r, 50));
      const body = await res.json() as Record<string, unknown>;

      expect(res.status).toBe(200);
      expect(body.success).toBe(true);

      // Verify a WebSocket was opened (publishToRelay)
      expect(mockWebSockets.length).toBeGreaterThanOrEqual(1);
    });

    it('should execute allow_user action', async () => {
      const env = createEnv();
      const req = webhookRequest({
        ticket_id: 102,
        action_requested: 'allow_user',
        nostr_pubkey: '1234abcd'.repeat(8),
      });

      const res = await worker.fetch(req, env as never);
      const body = await res.json() as Record<string, unknown>;

      expect(res.status).toBe(200);
      expect(body.success).toBe(true);

      // allow_user calls allowpubkey RPC
      const rpcCall = mockFetch.mock.calls.find((c: unknown[]) => {
        const opts = c[1] as { body?: string };
        return opts?.body?.includes('allowpubkey');
      });
      expect(rpcCall).toBeDefined();
    });

    it('should log decision to D1 on success', async () => {
      const { db, mockPrepare } = createMockDB();
      const env = createEnv({ DB: db });
      const req = webhookRequest({
        ticket_id: 100,
        action_requested: 'ban_user',
        nostr_pubkey: 'abcd1234'.repeat(8),
        agent_email: 'admin@divine.video',
      });

      await worker.fetch(req, env as never);
      await new Promise(r => setTimeout(r, 50));

      // Verify INSERT was called
      const insertCall = mockPrepare.mock.calls.find(
        (c: string[]) => c[0].includes('INSERT INTO moderation_decisions')
      );
      expect(insertCall).toBeDefined();
    });

    it('should call updateZendeskTicket for non-allow actions', async () => {
      const env = createEnv();
      const req = webhookRequest({
        ticket_id: 100,
        action_requested: 'ban_user',
        nostr_pubkey: 'abcd1234'.repeat(8),
      });

      await worker.fetch(req, env as never);
      await new Promise(r => setTimeout(r, 50));

      // Should call Zendesk API to update ticket (updateZendeskTicket uses fetch)
      const zendeskCall = mockFetch.mock.calls.find((c: unknown[]) => {
        const url = c[0] as string;
        return url.includes('zendesk.com/api/v2/tickets/');
      });
      expect(zendeskCall).toBeDefined();
    });
  });

  // ==========================================================================
  // POST /api/zendesk/parse-report
  // ==========================================================================

  describe('POST /api/zendesk/parse-report', () => {
    function parseReportRequest(body: Record<string, unknown>) {
      return makeRequest('/api/zendesk/parse-report', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Webhook-Key': PARSE_REPORT_SECRET,
        },
        body: JSON.stringify(body),
      });
    }

    it('should reject invalid signature', async () => {
      const env = createEnv();
      const { status, body } = await fetchJSON('/api/zendesk/parse-report', env, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Webhook-Key': 'wrong' },
        body: JSON.stringify({ ticket_id: 1, description: 'test' }),
      });

      expect(status).toBe(401);
      expect(body.error).toContain('Invalid webhook signature');
    });

    it('should parse event_id and author_pubkey from description', async () => {
      const { db } = createMockDB();
      const env = createEnv({ DB: db });
      const eventId = 'a'.repeat(64);
      const pubkey = 'b'.repeat(64);

      const req = parseReportRequest({
        ticket_id: 200,
        description: `Content Report\nEvent ID: ${eventId}\nAuthor Pubkey: ${pubkey}\nViolation Type: spam`,
      });

      const res = await worker.fetch(req, env as never);
      await new Promise(r => setTimeout(r, 50));
      const body = await res.json() as Record<string, unknown>;

      expect(res.status).toBe(200);
      expect(body.success).toBe(true);
      expect(body.event_id).toBe(eventId);
      expect(body.author_pubkey).toBe(pubkey);
      expect(body.violation_type).toBe('spam');
    });

    it('should return 400 when no IDs found in description', async () => {
      const env = createEnv();
      const req = parseReportRequest({
        ticket_id: 201,
        description: 'This is a generic complaint with no IDs',
      });

      const res = await worker.fetch(req, env as never);
      const body = await res.json() as Record<string, unknown>;

      expect(res.status).toBe(400);
      expect(body.error).toContain('Could not parse');
    });

    it('should return 400 when ticket_id missing', async () => {
      const env = createEnv();
      const req = parseReportRequest({ description: 'Event ID: ' + 'a'.repeat(64) });

      const res = await worker.fetch(req, env as never);
      const body = await res.json() as Record<string, unknown>;

      expect(res.status).toBe(400);
      expect(body.error).toContain('Missing ticket_id');
    });

    it('should skip if ticket already processed', async () => {
      const { db } = createMockDB({ firstResult: { id: 1 } }); // existing ticket
      const env = createEnv({ DB: db });

      const req = parseReportRequest({
        ticket_id: 200,
        description: `Event ID: ${'c'.repeat(64)}`,
      });

      const res = await worker.fetch(req, env as never);
      const body = await res.json() as Record<string, unknown>;

      expect(res.status).toBe(200);
      expect(body.success).toBe(true);
      expect(body.skipped).toBe(true);
    });

    it('should store mapping in D1', async () => {
      const { db, mockPrepare } = createMockDB();
      const env = createEnv({ DB: db });

      const req = parseReportRequest({
        ticket_id: 202,
        description: `Event ID: ${'d'.repeat(64)}\nAuthor Pubkey: ${'e'.repeat(64)}`,
      });

      await worker.fetch(req, env as never);
      await new Promise(r => setTimeout(r, 50));

      const insertCall = mockPrepare.mock.calls.find(
        (c: string[]) => c[0].includes('INSERT INTO zendesk_tickets')
      );
      expect(insertCall).toBeDefined();
    });

    it('should add internal note to Zendesk', async () => {
      const { db } = createMockDB();
      const env = createEnv({ DB: db });

      const req = parseReportRequest({
        ticket_id: 203,
        description: `Event ID: ${'f'.repeat(64)}`,
      });

      await worker.fetch(req, env as never);
      await new Promise(r => setTimeout(r, 50));

      // Verify Zendesk API was called to add note
      const noteCall = mockFetch.mock.calls.find((c: unknown[]) => {
        const url = c[0] as string;
        return url.includes('zendesk.com/api/v2/tickets/203');
      });
      expect(noteCall).toBeDefined();
    });
  });

  // ==========================================================================
  // POST /api/zendesk/mobile-jwt
  // ==========================================================================

  describe('POST /api/zendesk/mobile-jwt', () => {
    it('should return 500 when JWT_SECRET not configured', async () => {
      const env = createEnv({ ZENDESK_JWT_SECRET: undefined });
      const { status, body } = await fetchJSON('/api/zendesk/mobile-jwt', env, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'user_token=npub1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqsd5axgy',
      });

      expect(status).toBe(500);
      expect(body.error).toContain('not configured');
    });

    it('should generate JWT from form-encoded npub (Zendesk callback)', async () => {
      const env = createEnv();
      // Generate a valid npub from a known hex pubkey
      const hexPubkey = '7e7e9c42a91bfef19fa929e5fda1b72e0ebc1a4c1141673e2794234d86addf4e';
      const validNpub = nip19.npubEncode(hexPubkey);
      const { status, body } = await fetchJSON('/api/zendesk/mobile-jwt', env, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: `user_token=${validNpub}`,
      });

      expect(status).toBe(200);
      expect(body.success).toBe(true);
      expect(body.jwt).toBeDefined();
      expect(body.expires_at).toBeDefined();
      // JWT should have 3 parts
      expect((body.jwt as string).split('.')).toHaveLength(3);
    });

    it('should generate JWT from hex pubkey (Zendesk callback)', async () => {
      const env = createEnv();
      const hexPubkey = '7e7e9c42a91bfef19fa929e5fda1b72e0ebc1a4c1141673e2794234d86addf4e';

      const { status, body } = await fetchJSON('/api/zendesk/mobile-jwt', env, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: `user_token=${hexPubkey}`,
      });

      expect(status).toBe(200);
      expect(body.success).toBe(true);
      expect(body.jwt).toBeDefined();
    });

    it('should return 400 for invalid pubkey', async () => {
      const env = createEnv();
      const { status, body } = await fetchJSON('/api/zendesk/mobile-jwt', env, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'user_token=not-a-valid-key',
      });

      expect(status).toBe(400);
      expect(body.error).toContain('Missing or invalid pubkey');
    });

    it('should return 400 for empty user_token', async () => {
      const env = createEnv();
      const { status, body } = await fetchJSON('/api/zendesk/mobile-jwt', env, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'user_token=',
      });

      expect(status).toBe(400);
      expect(body.error).toContain('Missing or invalid pubkey');
    });
  });

  // ==========================================================================
  // GET /api/zendesk/context (JWT-protected)
  // ==========================================================================

  describe('GET /api/zendesk/context', () => {
    it('should reject without JWT', async () => {
      const env = createEnv();
      const { status, body } = await fetchJSON('/api/zendesk/context?pubkey=abc', env);

      expect(status).toBe(401);
      expect(body.error).toContain('Missing');
    });

    it('should reject expired JWT', async () => {
      const now = Math.floor(Date.now() / 1000);
      const expiredJwt = await signJwt({ iss: 'test', iat: now - 600, exp: now - 300, email: 'a@b.com', name: 'A' }, JWT_SECRET);
      const env = createEnv();

      const { status } = await fetchJSON('/api/zendesk/context?pubkey=abc', env, {
        headers: { Authorization: `Bearer ${expiredJwt}` },
      });

      expect(status).toBe(401);
    });

    it('should return 400 when no pubkey or event_id', async () => {
      const jwt = await makeValidJwt();
      const env = createEnv();

      const { status, body } = await fetchJSON('/api/zendesk/context', env, {
        headers: { Authorization: `Bearer ${jwt}` },
      });

      expect(status).toBe(400);
      expect(body.error).toContain('Missing pubkey or event_id');
    });

    it('should return context with decision history', async () => {
      const jwt = await makeValidJwt();
      const decisions = [
        { id: 1, target_type: 'event', target_id: 'ev1', action: 'delete_event', created_at: '2026-02-11' },
      ];
      const { db } = createMockDB({ allResults: decisions });
      const env = createEnv({ DB: db });

      const { status, body } = await fetchJSON('/api/zendesk/context?event_id=ev1', env, {
        headers: { Authorization: `Bearer ${jwt}` },
      });

      expect(status).toBe(200);
      expect(body.success).toBe(true);
      const ctx = body.context as Record<string, unknown>;
      expect(ctx.requested_by).toBe('mod@divine.video');
      expect(ctx.decisions).toHaveLength(1);
    });

    it('should check ban status for pubkey queries', async () => {
      const jwt = await makeValidJwt();
      // Mock relay returning banned pubkeys list
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ result: [{ pubkey: 'target_pub' }] }),
        text: async () => '{}',
      });
      const { db } = createMockDB();
      const env = createEnv({ DB: db });

      const { status, body } = await fetchJSON('/api/zendesk/context?pubkey=target_pub', env, {
        headers: { Authorization: `Bearer ${jwt}` },
      });

      expect(status).toBe(200);
      const ctx = body.context as Record<string, unknown>;
      expect(ctx.is_banned).toBe(true);
    });
  });

  // ==========================================================================
  // GET /api/zendesk/verify (JWT-protected)
  // ==========================================================================

  describe('GET /api/zendesk/verify', () => {
    it('should return user info for valid JWT', async () => {
      const jwt = await makeValidJwt();
      const env = createEnv();

      const { status, body } = await fetchJSON('/api/zendesk/verify', env, {
        headers: { Authorization: `Bearer ${jwt}` },
      });

      expect(status).toBe(200);
      expect(body.success).toBe(true);
      const user = body.user as Record<string, string>;
      expect(user.email).toBe('mod@divine.video');
      expect(user.name).toBe('Moderator');
    });
  });

  // ==========================================================================
  // POST /api/zendesk/action (JWT-protected)
  // ==========================================================================

  describe('POST /api/zendesk/action', () => {
    it('should reject without JWT', async () => {
      const env = createEnv();
      const { status } = await fetchJSON('/api/zendesk/action', env, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'ban_user', pubkey: 'abc' }),
      });

      expect(status).toBe(401);
    });

    it('should return 400 when action missing', async () => {
      const jwt = await makeValidJwt();
      const env = createEnv();

      const { status, body } = await fetchJSON('/api/zendesk/action', env, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${jwt}` },
        body: JSON.stringify({}),
      });

      expect(status).toBe(400);
      expect(body.error).toContain('Missing action');
    });

    it('should execute ban_user action', async () => {
      const jwt = await makeValidJwt();
      const env = createEnv();

      const { status, body } = await fetchJSON('/api/zendesk/action', env, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${jwt}` },
        body: JSON.stringify({ action: 'ban_user', pubkey: 'ab'.repeat(32), ticket_id: 300 }),
      });

      expect(status).toBe(200);
      expect(body.success).toBe(true);
      expect(body.moderator).toBe('mod@divine.video');

      // Verify banpubkey RPC
      const rpcCall = mockFetch.mock.calls.find((c: unknown[]) =>
        (c[1] as { body?: string })?.body?.includes('banpubkey')
      );
      expect(rpcCall).toBeDefined();
    });

    it('should return error when pubkey missing for ban_user', async () => {
      const jwt = await makeValidJwt();
      const env = createEnv();

      const { status, body } = await fetchJSON('/api/zendesk/action', env, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${jwt}` },
        body: JSON.stringify({ action: 'ban_user' }),
      });

      expect(status).toBe(500);
      expect(body.error).toContain('Missing pubkey');
    });

    it('should execute allow_user action', async () => {
      const jwt = await makeValidJwt();
      const env = createEnv();

      const { status, body } = await fetchJSON('/api/zendesk/action', env, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${jwt}` },
        body: JSON.stringify({ action: 'allow_user', pubkey: 'cd'.repeat(32) }),
      });

      expect(status).toBe(200);
      expect(body.success).toBe(true);
    });

    it('should execute delete_event action', async () => {
      const jwt = await makeValidJwt();
      const env = createEnv();

      const { status, body } = await fetchJSON('/api/zendesk/action', env, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${jwt}` },
        body: JSON.stringify({ action: 'delete_event', event_id: 'ef'.repeat(32) }),
      });

      await new Promise(r => setTimeout(r, 50));

      expect(status).toBe(200);
      expect(body.success).toBe(true);
    });

    it('should return error for unknown action', async () => {
      const jwt = await makeValidJwt();
      const env = createEnv();

      const { status, body } = await fetchJSON('/api/zendesk/action', env, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${jwt}` },
        body: JSON.stringify({ action: 'nuke_from_orbit' }),
      });

      expect(status).toBe(500);
      expect(body.error).toContain('Unknown action');
    });

    it('should log decision to D1 on success', async () => {
      const jwt = await makeValidJwt();
      const { db, mockPrepare } = createMockDB();
      const env = createEnv({ DB: db });

      await fetchJSON('/api/zendesk/action', env, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${jwt}` },
        body: JSON.stringify({ action: 'ban_user', pubkey: 'ab'.repeat(32), ticket_id: 301 }),
      });

      await new Promise(r => setTimeout(r, 50));

      const insertCall = mockPrepare.mock.calls.find(
        (c: string[]) => c[0].includes('INSERT INTO moderation_decisions')
      );
      expect(insertCall).toBeDefined();
    });
  });

  // ==========================================================================
  // syncZendeskAfterAction (tested indirectly through handlers)
  // ==========================================================================

  describe('syncZendeskAfterAction (indirect)', () => {
    it('should find linked ticket and add note for resolution action', async () => {
      const jwt = await makeValidJwt();

      // SQL-aware mock: return { ticket_id: 500 } for zendesk_tickets SELECT, null otherwise
      const mockRun = vi.fn().mockResolvedValue({ success: true, meta: { changes: 1 } });
      const mockAll = vi.fn().mockResolvedValue({ results: [], success: true });
      const mockPrepare = vi.fn().mockImplementation((sql: string) => {
        const isZendeskSelect = sql.includes('zendesk_tickets') && sql.trimStart().startsWith('SELECT');
        const first = vi.fn().mockResolvedValue(isZendeskSelect ? { ticket_id: 500 } : null);
        const bind = vi.fn().mockReturnValue({ run: mockRun, all: mockAll, first });
        return { bind, run: mockRun, all: mockAll, first };
      });
      const db = { prepare: mockPrepare } as unknown as D1Database;
      const env = createEnv({ DB: db });

      await fetchJSON('/api/zendesk/action', env, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${jwt}` },
        body: JSON.stringify({ action: 'ban_user', pubkey: 'ab'.repeat(32) }),
      });

      // Wait for fire-and-forget sync
      await new Promise(r => setTimeout(r, 200));

      // Verify Zendesk API was called (addZendeskInternalNote for sync)
      const zendeskCalls = mockFetch.mock.calls.filter((c: unknown[]) => {
        const url = c[0] as string;
        return typeof url === 'string' && url.includes('zendesk.com');
      });
      // At least one Zendesk API call should be made (for the sync note)
      expect(zendeskCalls.length).toBeGreaterThanOrEqual(1);
    });
  });

  // ==========================================================================
  // Zendesk route 404
  // ==========================================================================

  describe('Zendesk route 404', () => {
    it('should return 404 for unknown zendesk sub-path', async () => {
      const jwt = await makeValidJwt();
      const env = createEnv();

      const { status, body } = await fetchJSON('/api/zendesk/nonexistent', env, {
        headers: { Authorization: `Bearer ${jwt}` },
      });

      expect(status).toBe(404);
      expect(body.error).toContain('Not found');
    });
  });
});
