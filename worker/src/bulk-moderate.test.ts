import { describe, expect, it, vi } from 'vitest';
import { handleBulkModerate, extractMediaHashes, type BulkModerateEnv } from './bulk-moderate';

describe('handleBulkModerate', () => {
  const mockEnv = {
    NOSTR_NSEC: 'nsec1vl029mgpspedva04g90vltkh6fvh240zqtv9k0t9af8935ke9laqsnlfe5',
    RELAY_URL: 'wss://relay.test',
    DB: {
      prepare: vi.fn().mockReturnValue({
        bind: vi.fn().mockReturnValue({
          run: vi.fn().mockResolvedValue({ meta: { changes: 1 } }),
        }),
      }),
    },
  };

  it('rejects invalid action', async () => {
    const request = new Request('https://test/api/bulk-moderate', {
      method: 'POST',
      body: JSON.stringify({ pubkey: 'a'.repeat(64), action: 'invalid' }),
    });
    const response = await handleBulkModerate(request, mockEnv as unknown as BulkModerateEnv, {});
    expect(response.status).toBe(400);
    const body = await response.json() as { error: string };
    expect(body.error).toMatch(/Invalid action/);
  });

  it('requires 64-char hex pubkey', async () => {
    const request = new Request('https://test/api/bulk-moderate', {
      method: 'POST',
      body: JSON.stringify({ pubkey: 'short', action: 'age-restrict-all' }),
    });
    const response = await handleBulkModerate(request, mockEnv as unknown as BulkModerateEnv, {});
    expect(response.status).toBe(400);
    const body = await response.json() as { error: string };
    expect(body.error).toMatch(/pubkey/);
  });

  it('rejects missing pubkey', async () => {
    const request = new Request('https://test/api/bulk-moderate', {
      method: 'POST',
      body: JSON.stringify({ action: 'delete-all' }),
    });
    const response = await handleBulkModerate(request, mockEnv as unknown as BulkModerateEnv, {});
    expect(response.status).toBe(400);
  });

  it('accepts all three valid actions', async () => {
    for (const action of ['age-restrict-all', 'un-age-restrict-all', 'delete-all']) {
      const request = new Request('https://test/api/bulk-moderate', {
        method: 'POST',
        body: JSON.stringify({ pubkey: 'a'.repeat(64), action }),
      });
      const response = await handleBulkModerate(request, mockEnv as unknown as BulkModerateEnv, {});
      expect(response.status).toBe(200);
    }
  });
});

describe('extractMediaHashes', () => {
  it('extracts sha256 from imeta tags on video events', () => {
    const events = [
      {
        id: 'e1',
        kind: 34235,
        tags: [
          ['imeta', 'url https://example.com/video.mp4', 'sha256 abcd1234'],
          ['imeta', 'url https://example.com/thumb.jpg', 'sha256 efgh5678'],
        ],
      },
    ];
    const hashes = extractMediaHashes(events);
    expect(hashes).toContain('abcd1234');
    expect(hashes).toContain('efgh5678');
    expect(hashes).toHaveLength(2);
  });

  it('extracts from x tags on video events', () => {
    const events = [
      { id: 'e1', kind: 34236, tags: [['x', 'hash1234']] },
    ];
    expect(extractMediaHashes(events)).toEqual(['hash1234']);
  });

  it('ignores non-video event kinds', () => {
    const events = [
      { id: 'e1', kind: 1, tags: [['imeta', 'sha256 should-be-ignored']] },
      { id: 'e2', kind: 34235, tags: [['imeta', 'sha256 should-be-included']] },
    ];
    const hashes = extractMediaHashes(events);
    expect(hashes).toEqual(['should-be-included']);
  });

  it('deduplicates hashes', () => {
    const events = [
      { id: 'e1', kind: 34235, tags: [['x', 'same-hash']] },
      { id: 'e2', kind: 34236, tags: [['x', 'same-hash']] },
    ];
    expect(extractMediaHashes(events)).toEqual(['same-hash']);
  });

  it('extracts from short-form video kinds 21 and 22', () => {
    const events = [
      { id: 'e1', kind: 21, tags: [['x', 'short-hash-1']] },
      { id: 'e2', kind: 22, tags: [['imeta', 'sha256 short-hash-2']] },
    ];
    const hashes = extractMediaHashes(events);
    expect(hashes).toContain('short-hash-1');
    expect(hashes).toContain('short-hash-2');
    expect(hashes).toHaveLength(2);
  });

  it('returns empty array when no video events', () => {
    const events = [
      { id: 'e1', kind: 1, tags: [] },
      { id: 'e2', kind: 30023, tags: [['x', 'hash']] },
    ];
    expect(extractMediaHashes(events)).toEqual([]);
  });
});
