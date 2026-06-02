import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { handleBulkModerate, extractMediaHashes, queryUserMediaHashes, type BulkModerateEnv } from './bulk-moderate';
import type { BulkModerateResult } from '../../shared/bulk-moderation';

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

function mockRestVideos(videos: Array<{ sha256: string }>) {
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(
    new Response(JSON.stringify(videos), { status: 200 }),
  );
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
    for (const action of ['age-restrict-all', 'un-age-restrict-all', 'delete-all'] as const) {
      vi.restoreAllMocks();
      mockRestVideos([]);
      mockRelay([]);
      const request = new Request('https://test/api/bulk-moderate', {
        method: 'POST',
        body: JSON.stringify({ pubkey: 'a'.repeat(64), action }),
      });
      const response = await handleBulkModerate(request, mockEnv, {});
      expect(response.status).toBe(200);
    }
  });

  it('calls moderation service with AGE_RESTRICTED for age-restrict-all', async () => {
    mockRestVideos([{ sha256: hashA }, { sha256: hashB }]);

    const request = new Request('https://test/api/bulk-moderate', {
      method: 'POST',
      body: JSON.stringify({ pubkey: 'a'.repeat(64), action: 'age-restrict-all', reason: 'test restrict' }),
    });
    const response = await handleBulkModerate(request, mockEnv, {});
    const body = await response.json() as BulkModerateResult;

    expect(response.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.mediaProcessed).toBe(2);

    const fetchMock = mockEnv.MODERATION_API!.fetch as ReturnType<typeof vi.fn>;
    expect(fetchMock).toHaveBeenCalledTimes(2);

    const calls = fetchMock.mock.calls;
    for (const [url, opts] of calls) {
      expect(url).toContain('/api/v1/moderate');
      const payload = JSON.parse(opts.body as string);
      expect(payload.action).toBe('AGE_RESTRICTED');
      expect(payload.source).toBe('relay-manager-bulk');
      expect([hashA, hashB]).toContain(payload.sha256);
    }
  });

  it('calls moderation service with SAFE for un-age-restrict-all', async () => {
    mockRestVideos([{ sha256: hashA }]);

    const request = new Request('https://test/api/bulk-moderate', {
      method: 'POST',
      body: JSON.stringify({ pubkey: 'a'.repeat(64), action: 'un-age-restrict-all' }),
    });
    const response = await handleBulkModerate(request, mockEnv, {});
    const body = await response.json() as BulkModerateResult;

    expect(body.success).toBe(true);
    expect(body.mediaProcessed).toBe(1);

    const fetchMock = mockEnv.MODERATION_API!.fetch as ReturnType<typeof vi.fn>;
    const payload = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(payload.action).toBe('SAFE');
  });

  it('reports failure when moderation service returns non-200', async () => {
    (mockEnv.MODERATION_API!.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      new Response(null, { status: 500 })
    );
    mockRestVideos([{ sha256: hashA }]);

    const request = new Request('https://test/api/bulk-moderate', {
      method: 'POST',
      body: JSON.stringify({ pubkey: 'a'.repeat(64), action: 'age-restrict-all' }),
    });
    const response = await handleBulkModerate(request, mockEnv, {});
    const body = await response.json() as BulkModerateResult;

    expect(body.success).toBe(false);
    expect(body.mediaProcessed).toBe(0);
    expect(body.failures[0]).toContain('500');
  });

  it('marks bulk delete as failed when relay deletion returns success false', async () => {
    const { banEvent } = await import('./nip86');
    vi.mocked(banEvent).mockResolvedValueOnce({ success: false, error: 'relay refused' });
    mockRestVideos([]);
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

describe('queryUserMediaHashes', () => {
  const pubkey = 'a'.repeat(64);
  const env = { RELAY_URL: 'wss://relay.test' };

  afterEach(() => vi.restoreAllMocks());

  it('converts wss:// to https:// and calls REST API', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify([{ sha256: hashA }]), { status: 200 }),
    );
    await queryUserMediaHashes(pubkey, env);
    expect(spy).toHaveBeenCalledWith(expect.stringContaining('https://relay.test/api/users/'));
  });

  it('extracts and deduplicates sha256 from video response', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify([
        { sha256: hashA },
        { sha256: hashB },
        { sha256: hashA },
      ]), { status: 200 }),
    );
    const hashes = await queryUserMediaHashes(pubkey, env);
    expect(hashes).toEqual(expect.arrayContaining([hashA, hashB]));
    expect(hashes).toHaveLength(2);
  });

  it('skips entries without valid sha256', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify([
        { sha256: hashA },
        { sha256: 'not-a-hash' },
        { sha256: null },
        {},
      ]), { status: 200 }),
    );
    expect(await queryUserMediaHashes(pubkey, env)).toEqual([hashA]);
  });

  it('throws on non-200 response', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(null, { status: 404 }),
    );
    await expect(queryUserMediaHashes(pubkey, env)).rejects.toThrow('Video query failed: 404');
  });
});
