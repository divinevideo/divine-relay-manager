import { beforeEach, describe, expect, it, vi } from 'vitest';
import { handleBulkModerate, extractMediaHashes, type BulkModerateEnv } from './bulk-moderate';

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

  function moderationActionFor(sha256: string): string | undefined {
    const fetchMock = vi.mocked((mockEnv.MODERATION_API as unknown as { fetch: ReturnType<typeof vi.fn> }).fetch);
    for (const call of fetchMock.mock.calls) {
      const body = JSON.parse((call[1] as RequestInit).body as string);
      if (body.sha256 === sha256) return body.action;
    }
    return undefined;
  }

  it('C3: age-restrict-all sends QUARANTINE (reversible withhold) for media', async () => {
    mockRelay([{ id: 'e'.repeat(64), kind: 34235, content: '', tags: [['x', hashA]] }]);
    const request = new Request('https://test/api/bulk-moderate', {
      method: 'POST',
      body: JSON.stringify({ pubkey: 'a'.repeat(64), action: 'age-restrict-all' }),
    });
    const response = await handleBulkModerate(request, mockEnv, {});
    expect(response.status).toBe(200);
    // NOT 'AGE_RESTRICTED' (which would serve bytes to any signed-in viewer).
    expect(moderationActionFor(hashA)).toBe('QUARANTINE');
  });

  it('C3: un-age-restrict-all sends SAFE (restore) for media', async () => {
    mockRelay([{ id: 'e'.repeat(64), kind: 34235, content: '', tags: [['x', hashA]] }]);
    const request = new Request('https://test/api/bulk-moderate', {
      method: 'POST',
      body: JSON.stringify({ pubkey: 'a'.repeat(64), action: 'un-age-restrict-all' }),
    });
    await handleBulkModerate(request, mockEnv, {});
    expect(moderationActionFor(hashA)).toBe('SAFE');
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
