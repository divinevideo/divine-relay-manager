// ABOUTME: Tests for Zendesk sync reliability fixes
// ABOUTME: Covers parse-report regex variants and solved-ticket Zendesk payload behavior

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import worker from './index';

const WEBHOOK_SECRET = 'test-parse-report-secret';
const TEST_NSEC = 'nsec1vl029mgpspedva04g90vltkh6fvh240zqtv9k0t9af8935ke9laqsnlfe5';
const LINKED_TICKET_ID = 926;

const ctx = {} as ExecutionContext;

class MockWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;

  readyState = MockWebSocket.OPEN;
  private listeners: Map<string, Array<(event: unknown) => void>> = new Map();

  constructor(_url: string) {
    setTimeout(() => this.emit('open', {}), 0);
  }

  addEventListener(type: string, listener: (event: unknown) => void): void {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type)!.push(listener);
  }

  send(data: string): void {
    const parsed = JSON.parse(data);
    if (parsed[0] === 'EVENT') {
      setTimeout(() => {
        this.emit('message', { data: JSON.stringify(['OK', parsed[1]?.id || 'test', true, '']) });
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

function makeEnv(overrides: Record<string, unknown> = {}) {
  return {
    NOSTR_NSEC: TEST_NSEC,
    ALLOWED_ORIGINS: 'https://relay.admin.divine.video',
    RELAY_URL: 'wss://relay.divine.video',
    ZENDESK_PARSE_REPORT_SECRET: WEBHOOK_SECRET,
    ZENDESK_SUBDOMAIN: 'rabblelabs',
    ZENDESK_API_TOKEN: 'test-token',
    ZENDESK_EMAIL: 'test@divine.video',
    ZENDESK_FIELD_CATEGORY: '14559549220879',
    ZENDESK_FIELD_ISSUE: '14560383908879',
    DB: {
      prepare: () => ({
        bind: (..._args: unknown[]) => ({
          first: async () => null,
          run: async () => ({ success: true }),
          all: async () => ({ results: [] }),
        }),
        run: async () => ({ success: true }),
        all: async () => ({ results: [] }),
        first: async () => null,
      }),
      exec: async () => ({}),
      batch: async () => [],
      dump: async () => new ArrayBuffer(0),
    },
    ...overrides,
  } as never;
}

function createMockDB() {
  const sqlLog: { sql: string; bindings: unknown[] }[] = [];

  const db = {
    prepare: vi.fn().mockImplementation((sql: string) => ({
      bind: vi.fn().mockImplementation((...args: unknown[]) => {
        sqlLog.push({ sql, bindings: args });

        if (sql.includes("SELECT ticket_id FROM zendesk_tickets WHERE event_id = ? AND status = 'open'")) {
          return {
            first: vi.fn().mockResolvedValue({ ticket_id: LINKED_TICKET_ID }),
            run: vi.fn().mockResolvedValue({ success: true, meta: { changes: 0 } }),
            all: vi.fn().mockResolvedValue({ results: [] }),
          };
        }

        return {
          first: vi.fn().mockResolvedValue(null),
          run: vi.fn().mockResolvedValue({ success: true, meta: { changes: 1 } }),
          all: vi.fn().mockResolvedValue({ results: [] }),
        };
      }),
      run: vi.fn().mockResolvedValue({ success: true, meta: { changes: 0 } }),
      first: vi.fn().mockResolvedValue(null),
      all: vi.fn().mockResolvedValue({ results: [] }),
    })),
    exec: vi.fn().mockResolvedValue({}),
    batch: vi.fn().mockResolvedValue([]),
    dump: vi.fn().mockResolvedValue(new ArrayBuffer(0)),
  };

  return { db, sqlLog };
}

function makeParseReportRequest(description: string, ticketId = 12345) {
  return new Request('https://api-relay-prod.divine.video/api/zendesk/parse-report', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Webhook-Key': WEBHOOK_SECRET,
    },
    body: JSON.stringify({ ticket_id: ticketId, description }),
  });
}

function makeResolutionPublishRequest(targetEventId: string) {
  return new Request('https://api-relay-prod.divine.video/api/publish', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Cf-Access-Jwt-Assertion': 'test',
    },
    body: JSON.stringify({
      kind: 1985,
      content: '',
      tags: [
        ['L', 'moderation/resolution'],
        ['l', 'reviewed', 'moderation/resolution'],
        ['e', targetEventId],
      ],
    }),
  });
}

describe('handleParseReport regex', () => {
  const EVENT_ID = 'ab13eb2c66bea4cd8f538798054d23a02d5dca879401be5045b8482590e2482c';
  const PUBKEY = '92aad7891d89ec67d3527ad2d25205a342cb2c121817dde5b0e2f5af2fb37101';

  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ result: true }),
      text: async () => '',
    }));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('parses divine-mobile plain text format', async () => {
    const description = [
      'Content Report - NIP-56',
      '',
      `Event ID: ${EVENT_ID}`,
      `Author Pubkey: ${PUBKEY}`,
      '',
      'Violation Type: other',
    ].join('\n');

    const response = await worker.fetch(makeParseReportRequest(description), makeEnv(), ctx);
    const data = await response.json() as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(data.event_id).toBe(EVENT_ID);
    expect(data.author_pubkey).toBe(PUBKEY);
    expect(data.violation_type).toBe('other');
  });

  it('parses divine-web markdown bold format', async () => {
    const description = [
      `**Content Type:** video`,
      `**Reason:** violence`,
      `**Event ID:** ${EVENT_ID}`,
      `**Reported Pubkey:** ${PUBKEY}`,
      `**Content URL:** https://media.divine.video/abc`,
    ].join('\n');

    const response = await worker.fetch(makeParseReportRequest(description), makeEnv(), ctx);
    const data = await response.json() as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(data.event_id).toBe(EVENT_ID);
    expect(data.author_pubkey).toBe(PUBKEY);
  });

  it('parses Reported Pubkey (web) same as Author Pubkey (mobile)', async () => {
    const description = `Reported Pubkey: ${PUBKEY}\nEvent ID: ${EVENT_ID}`;

    const response = await worker.fetch(makeParseReportRequest(description), makeEnv(), ctx);
    const data = await response.json() as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(data.author_pubkey).toBe(PUBKEY);
  });

  it('parses multi-word violation types without crossing lines', async () => {
    const description = [
      `Event ID: ${EVENT_ID}`,
      `Violation Type: Sexual Content`,
      `Author Pubkey: ${PUBKEY}`,
    ].join('\n');

    const response = await worker.fetch(makeParseReportRequest(description), makeEnv(), ctx);
    const data = await response.json() as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(data.violation_type).toBe('Sexual Content');
  });

  it('returns 400 when no event_id or pubkey can be parsed', async () => {
    const description = 'This is a report with no identifiers';

    const response = await worker.fetch(makeParseReportRequest(description), makeEnv(), ctx);
    expect(response.status).toBe(400);
  });

  it('rejects requests without valid webhook key', async () => {
    const request = new Request('https://api-relay-prod.divine.video/api/zendesk/parse-report', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Webhook-Key': 'wrong-secret',
      },
      body: JSON.stringify({ ticket_id: 999, description: `Event ID: ${EVENT_ID}` }),
    });

    const response = await worker.fetch(request, makeEnv(), ctx);
    expect(response.status).toBe(401);
  });
});

describe('addZendeskInternalNote solve payload', () => {
  beforeEach(() => {
    vi.stubGlobal('WebSocket', MockWebSocket);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('sends solved status, assignee, and required custom fields for resolution actions', async () => {
    const { db, sqlLog } = createMockDB();
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ result: true }),
      text: async () => '',
    });
    vi.stubGlobal('fetch', mockFetch);

    const targetEventId = 'ab13eb2c66bea4cd8f538798054d23a02d5dca879401be5045b8482590e2482c';
    const response = await worker.fetch(
      makeResolutionPublishRequest(targetEventId),
      makeEnv({ DB: db }),
      ctx,
    );

    expect(response.status).toBe(200);
    expect(mockFetch).toHaveBeenCalledTimes(1);

    const [url, options] = mockFetch.mock.calls[0];
    expect(url).toBe(`https://rabblelabs.zendesk.com/api/v2/tickets/${LINKED_TICKET_ID}`);
    expect(options.method).toBe('PUT');

    const payload = JSON.parse(options.body as string);
    expect(payload.ticket.status).toBe('solved');
    expect(payload.ticket.assignee_email).toBe('test@divine.video');
    expect(payload.ticket.custom_fields).toEqual([
      { id: 14559549220879, value: 'trust___safety' },
      { id: 14560383908879, value: 'other_content_report' },
    ]);
    expect(payload.ticket.comment.public).toBe(false);

    const resolvedUpdate = sqlLog.find(entry => entry.sql.includes('UPDATE zendesk_tickets'));
    expect(resolvedUpdate).toBeDefined();
    expect(resolvedUpdate?.bindings).toEqual(['reviewed', expect.any(String), LINKED_TICKET_ID]);
  });
});
