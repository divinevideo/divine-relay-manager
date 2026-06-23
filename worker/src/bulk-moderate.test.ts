import { beforeEach, describe, expect, it, vi } from 'vitest';
import { handleBulkModerate, extractMediaHashes, queryRelayEvents, type BulkModerateEnv } from './bulk-moderate';

vi.mock('./nip86', () => ({
  getAdminPubkey: vi.fn().mockResolvedValue('moderator-pubkey'),
  banEvent: vi.fn().mockResolvedValue({ success: true }),
  publishKind5Deletion: vi.fn().mockResolvedValue({ success: true }),
}));

vi.mock('./zendesk-sync', () => ({
  syncZendeskAfterAction: vi.fn().mockResolvedValue(undefined),
}));

const hashA = 'a'.repeat(64);
const hashB = 'b'.repeat(64);

function mockRelay(events: Array<{ id: string; kind: number; content?: string; tags: string[][] }>) {
  vi.spyOn(globalThis, 'WebSocket').mockImplementation((function () {
    const listeners = new Map<string, Array<(value?: unknown) => void>>();
    let subId = 'bulk-test';

    queueMicrotask(() => {
      listeners.get('open')?.forEach((handler) => handler());
      for (const event of events) {
        listeners.get('message')?.forEach((handler) => handler({
          data: JSON.stringify(['EVENT', subId, event]),
        }));
      }
      listeners.get('message')?.forEach((handler) => handler({
        data: JSON.stringify(['EOSE', subId]),
      }));
    });

    return {
      addEventListener: (event: string, handler: (value?: unknown) => void) => {
        listeners.set(event, [...(listeners.get(event) || []), handler]);
      },
      send: vi.fn((payload: string) => {
        const data = JSON.parse(payload);
        subId = data[1];
      }),
      close: vi.fn(),
    };
  } as unknown as typeof WebSocket));
}

describe('handleBulkModerate', () => {
  let mockEnv: BulkModerateEnv;

  beforeEach(() => {
    vi.restoreAllMocks();
    mockEnv = {
      NOSTR_NSEC: 'nsec1vl029mgpspedva04g90vltkh6fvh240zqtv9k0t9af8935ke9laqsnlfe5',
      RELAY_URL: 'wss://relay.test',
      MODERATION_API: {
        fetch: vi.fn().mockResolvedValue(new Response(null, { status: 200 })),
      } as unknown as Fetcher,
      DB: {
        prepare: vi.fn().mockReturnValue({
          bind: vi.fn().mockReturnThis(),
        }),
        batch: vi.fn().mockResolvedValue([]),
      } as unknown as D1Database,
    };
  });

  it('rejects invalid action', async () => {
    const request = new Request('https://test/api/bulk-moderate', {
      method: 'POST',
      body: JSON.stringify({ pubkey: 'a'.repeat(64), action: 'invalid' }),
    });
    const response = await handleBulkModerate(request, mockEnv, {});
    expect(response.status).toBe(400);
    const body = await response.json() as { error: string };
    expect(body.error).toMatch(/Invalid action/);
  });

  it('requires 64-char hex pubkey', async () => {
    const request = new Request('https://test/api/bulk-moderate', {
      method: 'POST',
      body: JSON.stringify({ pubkey: 'short', action: 'age-restrict-all' }),
    });
    const response = await handleBulkModerate(request, mockEnv, {});
    expect(response.status).toBe(400);
    const body = await response.json() as { error: string };
    expect(body.error).toMatch(/pubkey/);
  });

  it('rejects missing pubkey', async () => {
    const request = new Request('https://test/api/bulk-moderate', {
      method: 'POST',
      body: JSON.stringify({ action: 'delete-all' }),
    });
    const response = await handleBulkModerate(request, mockEnv, {});
    expect(response.status).toBe(400);
  });

  it('accepts all three valid actions', async () => {
    mockRelay([]);

    for (const action of ['age-restrict-all', 'un-age-restrict-all', 'delete-all'] as const) {
      const request = new Request('https://test/api/bulk-moderate', {
        method: 'POST',
        body: JSON.stringify({ pubkey: 'a'.repeat(64), action }),
      });
      const response = await handleBulkModerate(request, mockEnv, {});
      expect(response.status).toBe(200);
    }
  });

  it('marks bulk delete as failed when relay deletion returns success false', async () => {
    const { banEvent } = await import('./nip86');
    vi.mocked(banEvent).mockResolvedValueOnce({ success: false, error: 'relay refused' });
    mockRelay([{ id: 'e'.repeat(64), kind: 1, content: '', tags: [] }]);

    const request = new Request('https://test/api/bulk-moderate', {
      method: 'POST',
      body: JSON.stringify({ pubkey: 'a'.repeat(64), action: 'delete-all' }),
    });
    const response = await handleBulkModerate(request, mockEnv, {});
    const body = await response.json() as { success: boolean; failures: string[]; eventsProcessed: number };

    expect(body.success).toBe(false);
    expect(body.eventsProcessed).toBe(0);
    expect(body.failures[0]).toContain('relay refused');
  });
});

// Paginating mock relay: responds to each REQ with up to `limit` events whose
// created_at <= filter.until (descending), then EOSE for that sub. Models a
// relay that supports until-cursoring.
function mockPaginatedRelay(all: Array<{ id: string; kind: number; content: string; tags: string[][]; created_at: number }>) {
  const sorted = [...all].sort((a, b) => b.created_at - a.created_at);
  vi.spyOn(globalThis, 'WebSocket').mockImplementation((function () {
    const listeners = new Map<string, Array<(value?: unknown) => void>>();
    const emit = (type: string, value?: unknown) => listeners.get(type)?.forEach((h) => h(value));
    const sock = {
      addEventListener: (t: string, h: (value?: unknown) => void) => listeners.set(t, [...(listeners.get(t) || []), h]),
      send: (payload: string) => {
        const data = JSON.parse(payload);
        if (data[0] !== 'REQ') return; // ignore CLOSE
        const sub = data[1];
        const until = data[2].until ?? Infinity;
        const limit = data[2].limit ?? 500;
        const page = sorted.filter((e) => e.created_at <= until).slice(0, limit);
        queueMicrotask(() => {
          for (const ev of page) emit('message', { data: JSON.stringify(['EVENT', sub, ev]) });
          emit('message', { data: JSON.stringify(['EOSE', sub]) });
        });
      },
      close: vi.fn(),
    };
    queueMicrotask(() => emit('open'));
    return sock;
  } as unknown as typeof WebSocket));
}

describe('queryRelayEvents pagination (C4)', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('pages through >500 events via until cursor instead of rejecting', async () => {
    // 1200 events with distinct descending created_at -> 3 pages (500/500/200).
    const all = Array.from({ length: 1200 }, (_, i) => ({
      id: `e${i}`, kind: 1, content: '', tags: [] as string[][], created_at: 1200 - i,
    }));
    mockPaginatedRelay(all);
    const events = await queryRelayEvents('a'.repeat(64), { RELAY_URL: 'wss://relay.test' });
    expect(events).toHaveLength(1200); // all collected, deduped across page boundaries; no throw
  });
});

describe('extractMediaHashes', () => {
  it('extracts sha256 from imeta tags on video events', () => {
    const events = [
      {
        id: 'e1',
        kind: 34235,
        content: '',
        tags: [
          ['imeta', `url https://example.com/${hashA}.mp4`, 'm video/mp4', `x ${hashA}`],
          ['imeta', `url https://example.com/${hashB}.jpg`, 'm image/jpeg', `x ${hashB}`],
        ],
      },
    ];
    const hashes = extractMediaHashes(events);
    expect(hashes).toContain(hashA);
    expect(hashes).toContain(hashB);
    expect(hashes).toHaveLength(2);
  });

  it('extracts from x tags', () => {
    const events = [
      { id: 'e1', kind: 34236, content: '', tags: [['x', hashA]] },
    ];
    expect(extractMediaHashes(events)).toEqual([hashA]);
  });

  it('extracts from content URLs and url tags', () => {
    const events = [
      { id: 'e1', kind: 1, content: `https://cdn.test/${hashA}.jpg`, tags: [] },
      { id: 'e2', kind: 30023, content: '', tags: [['url', `https://cdn.test/${hashB}.png`]] },
    ];
    expect(extractMediaHashes(events)).toEqual([hashA, hashB]);
  });

  it('deduplicates hashes', () => {
    const events = [
      { id: 'e1', kind: 34235, content: '', tags: [['x', hashA]] },
      { id: 'e2', kind: 34236, content: '', tags: [['x', hashA]] },
    ];
    expect(extractMediaHashes(events)).toEqual([hashA]);
  });

  it('ignores thumbnail image hashes embedded in video imeta tags', () => {
    const events = [
      {
        id: 'e1',
        kind: 34235,
        content: '',
        tags: [[
          'imeta',
          `url https://media.divine.video/${hashA}`,
          'm video/mp4',
          `image https://media.divine.video/${hashB}`,
          `x ${hashA}`,
        ]],
      },
    ];
    expect(extractMediaHashes(events)).toEqual([hashA]);
  });

  it('returns empty array when there are no valid hashes', () => {
    const events = [
      { id: 'e1', kind: 1, content: '', tags: [] },
      { id: 'e2', kind: 30023, content: '', tags: [['x', 'not-a-hash']] },
    ];
    expect(extractMediaHashes(events)).toEqual([]);
  });
});
