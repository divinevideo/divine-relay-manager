// ABOUTME: Tests that moderation verification never reports success it did not observe.
// ABOUTME: An unreachable relay must read as "could not confirm", never as a completed action.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import {
  verifyPubkeyBanned,
  verifyPubkeyUnbanned,
  verifyEventDeleted,
} from './adminApi';

const mockFetch = vi.fn();
global.fetch = mockFetch;

const API_URL = 'https://test-api.example.com';
const RELAY_URL = 'wss://relay.test.example.com';
const PUBKEY = 'a'.repeat(64);
const EVENT_ID = 'b'.repeat(64);

/** Minimal WebSocket double whose behaviour each test drives explicitly. */
class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;

  constructor(public url: string) {
    FakeWebSocket.instances.push(this);
  }

  send() { /* the tests drive responses directly */ }
  close() { this.closed = true; }
}

beforeEach(() => {
  mockFetch.mockReset();
  FakeWebSocket.instances = [];
  vi.stubGlobal('WebSocket', FakeWebSocket as unknown as typeof WebSocket);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('verifyPubkeyBanned', () => {
  it('confirms a ban that is present on the relay', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ success: true, result: [PUBKEY] }),
    });

    await expect(verifyPubkeyBanned(API_URL, PUBKEY)).resolves.toBe(true);
  });

  it('reports not-banned when the relay does not list the pubkey', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ success: true, result: [] }),
    });

    await expect(verifyPubkeyBanned(API_URL, PUBKEY)).resolves.toBe(false);
  });

  it('returns null instead of claiming success when the check itself fails', async () => {
    mockFetch.mockRejectedValueOnce(new Error('network down'));

    await expect(verifyPubkeyBanned(API_URL, PUBKEY)).resolves.toBeNull();
  });
});

describe('verifyPubkeyUnbanned', () => {
  it('confirms an unban when the pubkey is absent', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ success: true, result: [] }),
    });

    await expect(verifyPubkeyUnbanned(API_URL, PUBKEY)).resolves.toBe(true);
  });

  it('returns null instead of claiming success when the check itself fails', async () => {
    mockFetch.mockRejectedValueOnce(new Error('network down'));

    await expect(verifyPubkeyUnbanned(API_URL, PUBKEY)).resolves.toBeNull();
  });
});

describe('verifyEventDeleted', () => {
  it('confirms deletion when the relay returns EOSE with no event', async () => {
    const pending = verifyEventDeleted(EVENT_ID, RELAY_URL);
    await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1), { timeout: 3000 });

    const ws = FakeWebSocket.instances[0];
    ws.onopen?.();
    ws.onmessage?.({ data: JSON.stringify(['EOSE', 'sub']) });

    await expect(pending).resolves.toBe(true);
  });

  it('reports still-present when the relay returns the event', async () => {
    const pending = verifyEventDeleted(EVENT_ID, RELAY_URL);
    await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1), { timeout: 3000 });

    const ws = FakeWebSocket.instances[0];
    ws.onopen?.();
    ws.onmessage?.({ data: JSON.stringify(['EVENT', 'sub', { id: EVENT_ID }]) });

    await expect(pending).resolves.toBe(false);
  });

  it('returns null when the socket errors rather than assuming deletion', async () => {
    const pending = verifyEventDeleted(EVENT_ID, RELAY_URL);
    await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1), { timeout: 3000 });

    FakeWebSocket.instances[0].onerror?.();

    await expect(pending).resolves.toBeNull();
  });

  it('returns null when the relay never answers rather than assuming deletion', async () => {
    const pending = verifyEventDeleted(EVENT_ID, RELAY_URL);
    await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1), { timeout: 3000 });

    // Relay accepts the socket but never sends EOSE — the timeout path.
    FakeWebSocket.instances[0].onopen?.();

    await expect(pending).resolves.toBeNull();
  }, 10000);

  it('returns null when the socket cannot be constructed at all', async () => {
    vi.stubGlobal('WebSocket', function () {
      throw new Error('blocked');
    } as unknown as typeof WebSocket);

    await expect(verifyEventDeleted(EVENT_ID, RELAY_URL)).resolves.toBeNull();
  });
});
