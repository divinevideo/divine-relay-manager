import { beforeEach, describe, expect, it, vi } from 'vitest';
import { handleBulkModerate, queryRelayEvents, queryUserMediaHashes, type BulkModerateEnv } from './bulk-moderate';

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
const hashC = 'c'.repeat(64);

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

// Mock the funnelcake REST videos endpoint that queryUserMediaHashes fetches.
// This is the dedup-correct source for media hashes (funnelcake#471), distinct
// from the WebSocket REQ used for event IDs.
function mockUserVideos(videos: Array<{ sha256: string }>) {
  vi.spyOn(globalThis, 'fetch').mockImplementation((async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    if (url.pathname.includes('/api/users/') && url.pathname.includes('/videos')) {
      // Honor limit/offset so the mock paginates exactly like funnelcake (default
      // 25, max 100) -- a non-paginating mock would hide the first-page-only bug.
      const limit = Number(url.searchParams.get('limit') ?? '25');
      const offset = Number(url.searchParams.get('offset') ?? '0');
      return new Response(JSON.stringify(videos.slice(offset, offset + limit)), { status: 200 });
    }
    return new Response('not found', { status: 404 });
  }) as typeof fetch);
}

describe('handleBulkModerate', () => {
  let mockEnv: BulkModerateEnv;

  beforeEach(() => {
    vi.restoreAllMocks();
    mockUserVideos([]); // default: no videos unless a test provides them
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

  function moderationActionFor(sha256: string): string | undefined {
    const fetchMock = vi.mocked((mockEnv.MODERATION_API as unknown as { fetch: ReturnType<typeof vi.fn> }).fetch);
    for (const call of fetchMock.mock.calls) {
      const body = JSON.parse((call[1] as RequestInit).body as string);
      if (body.sha256 === sha256) return body.action;
    }
    return undefined;
  }

  it('age-restrict-all sends QUARANTINE (reversible withhold) for media', async () => {
    mockUserVideos([{ sha256: hashA }]); // media hashes come from the REST API now
    const request = new Request('https://test/api/bulk-moderate', {
      method: 'POST',
      body: JSON.stringify({ pubkey: 'a'.repeat(64), action: 'age-restrict-all' }),
    });
    const response = await handleBulkModerate(request, mockEnv, {});
    expect(response.status).toBe(200);
    // NOT 'AGE_RESTRICTED' (which would serve bytes to any signed-in viewer).
    expect(moderationActionFor(hashA)).toBe('QUARANTINE');
  });

  it('age-restrict-all QUARANTINEs EVERY video the REST API returns, not 1/kind (funnelcake#471)', async () => {
    // The WebSocket REQ dedup bug surfaced ~1 video/kind; the REST endpoint
    // returns all of them. Three same-kind videos must ALL be withheld -- this
    // is the correctness fix and the guard against regressing to WS extraction.
    mockUserVideos([{ sha256: hashA }, { sha256: hashB }, { sha256: hashC }]);
    const request = new Request('https://test/api/bulk-moderate', {
      method: 'POST',
      body: JSON.stringify({ pubkey: 'a'.repeat(64), action: 'age-restrict-all' }),
    });
    const response = await handleBulkModerate(request, mockEnv, {});
    const result = await response.json() as { mediaProcessed: number };
    expect(result.mediaProcessed).toBe(3);
    expect(moderationActionFor(hashA)).toBe('QUARANTINE');
    expect(moderationActionFor(hashB)).toBe('QUARANTINE');
    expect(moderationActionFor(hashC)).toBe('QUARANTINE');
  });

  it('pages through ALL videos beyond the funnelcake per-page limit, not just the first page', async () => {
    // 250 videos = 3 pages (100/100/50). funnelcake caps a page at 100 (default 25),
    // so without offset paging only the first page would be withheld and the rest
    // would stay live -- the exact under-enforcement this guards against.
    const many = Array.from({ length: 250 }, (_, i) => ({ sha256: i.toString(16).padStart(64, '0') }));
    mockUserVideos(many);
    const request = new Request('https://test/api/bulk-moderate', {
      method: 'POST',
      body: JSON.stringify({ pubkey: 'a'.repeat(64), action: 'age-restrict-all' }),
    });
    const response = await handleBulkModerate(request, mockEnv, {});
    const result = await response.json() as { mediaProcessed: number };
    expect(result.mediaProcessed).toBe(250);
  });

  it('keeps paging when the server caps a page below the requested limit (no short-page early stop)', async () => {
    // The server clamps every page to 50 even though we ask for 100. The old
    // `videos.length < VIDEO_PAGE_SIZE` check read the first 50-row page as the
    // end and enumerated only page 0. Advancing offset by the actual count and
    // terminating on an EMPTY page collects all 120.
    const many = Array.from({ length: 120 }, (_, i) => ({ sha256: i.toString(16).padStart(64, '0') }));
    vi.spyOn(globalThis, 'fetch').mockImplementation((async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.pathname.includes('/api/users/') && url.pathname.includes('/videos')) {
        const offset = Number(url.searchParams.get('offset') ?? '0');
        return new Response(JSON.stringify(many.slice(offset, offset + 50)), { status: 200 }); // hard cap at 50
      }
      return new Response('not found', { status: 404 });
    }) as typeof fetch);
    const hashes = await queryUserMediaHashes('a'.repeat(64), { RELAY_URL: 'wss://relay.test' });
    expect(hashes).toHaveLength(120);
  });

  it('enumerates an account whose video count exactly fills the page bound (no false over-limit throw)', async () => {
    // Exactly 10000 videos: every page is full, so the loop only knows it is done
    // when the next fetch returns empty. The <= VIDEO_MAX_TOTAL headroom lets that
    // terminating empty fetch happen instead of throwing on a completed account.
    const many = Array.from({ length: 10000 }, (_, i) => ({ sha256: i.toString(16).padStart(64, '0') }));
    mockUserVideos(many);
    const hashes = await queryUserMediaHashes('a'.repeat(64), { RELAY_URL: 'wss://relay.test' });
    expect(hashes).toHaveLength(10000);
  });

  it('throws past the anti-runaway ceiling (over-limit account still fails closed)', async () => {
    const many = Array.from({ length: 10101 }, (_, i) => ({ sha256: i.toString(16).padStart(64, '0') }));
    mockUserVideos(many);
    await expect(queryUserMediaHashes('a'.repeat(64), { RELAY_URL: 'wss://relay.test' }))
      .rejects.toThrow(/More than 10000 videos/);
  });

  it('fails closed when a page returns rows but no valid sha256 (shape drift)', async () => {
    // 200 OK full of rows whose sha256 field is missing/renamed -> zero hashes.
    // Reporting success here would withhold nothing while showing "done".
    vi.spyOn(globalThis, 'fetch').mockImplementation((async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.pathname.includes('/api/users/') && url.pathname.includes('/videos')) {
        return new Response(JSON.stringify([{ id: 'v1' }, { id: 'v2' }]), { status: 200 });
      }
      return new Response('not found', { status: 404 });
    }) as typeof fetch);
    await expect(queryUserMediaHashes('a'.repeat(64), { RELAY_URL: 'wss://relay.test' }))
      .rejects.toThrow(/no valid sha256/);
  });

  it('fails closed on a non-array body instead of throwing an opaque "not iterable"', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation((async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.pathname.includes('/api/users/') && url.pathname.includes('/videos')) {
        return new Response(JSON.stringify({ videos: [{ sha256: hashA }], total: 1 }), { status: 200 });
      }
      return new Response('not found', { status: 404 });
    }) as typeof fetch);
    await expect(queryUserMediaHashes('a'.repeat(64), { RELAY_URL: 'wss://relay.test' }))
      .rejects.toThrow(/non-array body/);
  });

  it('un-age-restrict-all sends SAFE (restore) for media', async () => {
    mockUserVideos([{ sha256: hashA }]);
    const request = new Request('https://test/api/bulk-moderate', {
      method: 'POST',
      body: JSON.stringify({ pubkey: 'a'.repeat(64), action: 'un-age-restrict-all' }),
    });
    await handleBulkModerate(request, mockEnv, {});
    expect(moderationActionFor(hashA)).toBe('SAFE');
  });

  it('delete-all bans events from the relay (WS) and DELETEs media hashes from the REST API', async () => {
    // Events still come from the WebSocket (delete needs event IDs); media
    // hashes come from REST. The WS event's x-tag (hashB) must NOT be the media
    // source -- only the REST list (hashA) is.
    mockRelay([{ id: 'e'.repeat(64), kind: 34235, content: '', tags: [['x', hashB]] }]);
    mockUserVideos([{ sha256: hashA }]);
    const request = new Request('https://test/api/bulk-moderate', {
      method: 'POST',
      body: JSON.stringify({ pubkey: 'a'.repeat(64), action: 'delete-all' }),
    });
    const response = await handleBulkModerate(request, mockEnv, {});
    const result = await response.json() as { eventsProcessed: number; mediaProcessed: number };
    expect(result.eventsProcessed).toBe(1);
    expect(result.mediaProcessed).toBe(1);
    expect(moderationActionFor(hashA)).toBe('DELETE'); // from REST
    expect(moderationActionFor(hashB)).toBeUndefined(); // NOT from the WS x-tag
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

  it('age-restrict-all fails closed when the videos REST call errors (no false success)', async () => {
    // A failed enumeration must NOT report a successful withhold; queryUserMediaHashes
    // throws so the worker returns an error rather than a 200 success.
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('err', { status: 500 }));
    const request = new Request('https://test/api/bulk-moderate', {
      method: 'POST',
      body: JSON.stringify({ pubkey: 'a'.repeat(64), action: 'age-restrict-all' }),
    });
    await expect(handleBulkModerate(request, mockEnv, {})).rejects.toThrow(/Video query failed: 500/);
    expect(vi.mocked((mockEnv.MODERATION_API as unknown as { fetch: ReturnType<typeof vi.fn> }).fetch)).not.toHaveBeenCalled();
  });

  it('delete-all fails closed when the videos REST call errors (no events banned)', async () => {
    const { banEvent } = await import('./nip86');
    vi.mocked(banEvent).mockClear(); // call history accumulates across tests
    mockRelay([{ id: 'e'.repeat(64), kind: 34235, content: '', tags: [] }]);
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('err', { status: 500 }));
    const request = new Request('https://test/api/bulk-moderate', {
      method: 'POST',
      body: JSON.stringify({ pubkey: 'a'.repeat(64), action: 'delete-all' }),
    });
    await expect(handleBulkModerate(request, mockEnv, {})).rejects.toThrow(/Video query failed: 500/);
    expect(vi.mocked(banEvent)).not.toHaveBeenCalled();
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

describe('queryRelayEvents pagination', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('pages through >500 events via until cursor instead of rejecting', async () => {
    // 1200 events with distinct descending created_at -> 3 pages (500/500/200).
    const all = Array.from({ length: 1200 }, (_, i) => ({
      id: `e${i}`, kind: 1, content: '', tags: [] as string[][], created_at: 1200 - i,
    }));
    mockPaginatedRelay(all);
    const { events, complete } = await queryRelayEvents('a'.repeat(64), { RELAY_URL: 'wss://relay.test' });
    expect(events).toHaveLength(1200); // all collected, deduped across page boundaries; no throw
    expect(complete).toBe(true);
  });

  it('terminates and reports incomplete when >1 page of events share one created_at', async () => {
    // 600 events all at the same second: an inclusive `until` cursor cannot
    // subdivide a second, so it must not loop forever or silently report success.
    const all = Array.from({ length: 600 }, (_, i) => ({
      id: `e${i}`, kind: 1, content: '', tags: [] as string[][], created_at: 1000,
    }));
    mockPaginatedRelay(all);
    const { events, complete } = await queryRelayEvents('a'.repeat(64), { RELAY_URL: 'wss://relay.test' });
    expect(complete).toBe(false);            // surfaced, not a silent success
    expect(events.length).toBe(500);         // escaped the saturated second after one page
    expect(events.length).toBeLessThan(600); // the excess at that second was not silently claimed as done
  });
});
