// ABOUTME: Tests that POST /api/publish signs only the kinds the app publishes
// ABOUTME: A refused kind is never signed, written to D1, or sent to the relay

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { finalizeEvent } from 'nostr-tools';
import worker from './index';
import { getSecretKey } from './nip86';

// Pass-through spies: they observe whether a request reached key retrieval or
// signing, which the response alone cannot show.
vi.mock('nostr-tools', async (importOriginal) => {
  const actual = await importOriginal<typeof import('nostr-tools')>();
  return { ...actual, finalizeEvent: vi.fn(actual.finalizeEvent) };
});
vi.mock('./nip86', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./nip86')>();
  return { ...actual, getSecretKey: vi.fn(actual.getSecretKey) };
});

// Throwaway key (same as nip86.test.ts and human-decision.test.ts).
const TEST_NSEC = 'nsec1vl029mgpspedva04g90vltkh6fvh240zqtv9k0t9af8935ke9laqsnlfe5';
const TEST_ADMIN_KEY = 'test-admin-key';

// Records every relay message, and accepts every EVENT.
const relaySent: string[] = [];

class MockWebSocket {
  static OPEN = 1;
  static CLOSED = 3;
  readyState = MockWebSocket.OPEN;
  private listeners = new Map<string, Array<(event: unknown) => void>>();

  constructor(_url: string) {
    setTimeout(() => this.emit('open', {}), 0);
  }

  addEventListener(type: string, listener: (event: unknown) => void): void {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type)!.push(listener);
  }

  send(data: string): void {
    relaySent.push(data);
    const parsed = JSON.parse(data);
    if (parsed[0] === 'EVENT') {
      setTimeout(() => this.emit('message', { data: JSON.stringify(['OK', parsed[1]?.id, true, '']) }), 0);
    }
  }

  close(): void {
    this.readyState = MockWebSocket.CLOSED;
  }

  private emit(type: string, event: unknown): void {
    for (const handler of this.listeners.get(type) || []) handler(event);
  }
}

function createEnv() {
  const prepare = vi.fn(() => {
    const stmt = {
      bind: vi.fn(() => stmt),
      run: vi.fn().mockResolvedValue({ success: true, meta: { changes: 1 } }),
      first: vi.fn().mockResolvedValue(null),
      all: vi.fn().mockResolvedValue({ results: [] }),
    };
    return stmt;
  });
  const watcherFetch = vi.fn(async () => Response.json({ success: true, recorded: true }));
  return {
    env: {
      NOSTR_NSEC: TEST_NSEC,
      RELAY_URL: 'wss://relay.test.invalid',
      ALLOWED_ORIGINS: 'http://localhost:5173',
      ADMIN_API_KEY: TEST_ADMIN_KEY,
      DB: { prepare },
      REPORT_WATCHER: { idFromName: () => 'singleton', get: () => ({ fetch: watcherFetch }) },
    },
    prepare,
    watcherFetch,
  };
}

function publish(env: unknown, body: unknown) {
  const ctx = { waitUntil: vi.fn(), passThroughOnException: vi.fn() } as unknown as ExecutionContext;
  return worker.fetch(new Request('http://localhost/api/publish', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Admin-Key': TEST_ADMIN_KEY },
    body: JSON.stringify(body),
  }), env as never, ctx);
}

// A resolution label shape: if a refused kind slipped through, this body would
// also reach the human-review fence, D1 and the Zendesk sync.
const resolutionTags = [
  ['L', 'moderation/resolution'],
  ['l', 'reviewed', 'moderation/resolution'],
  ['e', 'ab'.repeat(32)],
];

describe('POST /api/publish signs only the kinds the app publishes', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    relaySent.length = 0;
    fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('WebSocket', MockWebSocket);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  async function expectRefused(body: unknown, code: string) {
    const { env, prepare, watcherFetch } = createEnv();
    const response = await publish(env, body);
    const json = await response.json() as Record<string, unknown>;

    expect(response.status).toBe(400);
    expect(json.success).toBe(false);
    expect(json.code).toBe(code);
    expect(json).not.toHaveProperty('event');
    expect(getSecretKey).not.toHaveBeenCalled();
    expect(finalizeEvent).not.toHaveBeenCalled();
    expect(relaySent).toEqual([]);
    expect(prepare).not.toHaveBeenCalled();
    expect(watcherFetch).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  }

  it('refuses kind 27235 (HTTP auth) without signing or sending anything', async () => {
    await expectRefused({
      kind: 27235,
      content: '',
      tags: [['u', 'https://relay.test.invalid/management'], ['method', 'POST']],
    }, 'kind_not_allowed');
  });

  it('refuses kind 1 (a note), which the app does not publish', async () => {
    await expectRefused({ kind: 1, content: 'hello', tags: resolutionTags }, 'kind_not_allowed');
  });

  it('refuses kind 0, which the app signs in the browser, not here', async () => {
    await expectRefused({ kind: 0, content: '{}' }, 'kind_not_allowed');
  });

  it.each([
    ['a numeric string', '1985'],
    ['a fraction', 1985.5],
    ['a boolean', true],
    ['an array', [1985]],
  ])('refuses a kind sent as %s', async (_label, kind) => {
    await expectRefused({ kind, content: 'Reviewed', tags: resolutionTags }, 'invalid_kind');
  });

  // The label shape moderation automation sends (enforcement namespace, not a
  // resolution): the allowed kind still signs and publishes as before.
  it('still signs and publishes a kind 1985 label', async () => {
    const { env, prepare } = createEnv();
    const tags = [
      ['L', 'moderation/enforcement'],
      ['l', 'auto_hidden', 'moderation/enforcement'],
      ['e', 'cd'.repeat(32)],
    ];
    const response = await publish(env, { kind: 1985, content: 'auto hidden', tags });
    const json = await response.json() as { success: boolean; event: { kind: number; tags: string[][]; sig: string } };

    expect(response.status).toBe(200);
    expect(json.success).toBe(true);
    expect(json.event.kind).toBe(1985);
    expect(json.event.tags).toEqual(tags);
    expect(json.event.sig).toMatch(/^[0-9a-f]{128}$/);
    expect(getSecretKey).toHaveBeenCalledTimes(1);
    expect(finalizeEvent).toHaveBeenCalledTimes(1);
    expect(relaySent.map(m => JSON.parse(m)[0])).toEqual(['EVENT']);
    expect(prepare).not.toHaveBeenCalled();
  });
});
