import { describe, it, expect, vi, afterEach } from 'vitest';
import { fetchFunnelcakeEvent, fetchFunnelcakeUser } from './funnelcakeApi';

describe('fetchFunnelcakeEvent', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns a NostrEvent on success', async () => {
    const mockEvent = {
      id: 'abc123'.padEnd(64, '0'),
      pubkey: 'def456'.padEnd(64, '0'),
      kind: 1,
      created_at: 1700000000,
      tags: [],
      content: 'hello',
      sig: 'sig'.padEnd(128, '0'),
    };
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify(mockEvent), { status: 200 }),
    );

    const result = await fetchFunnelcakeEvent('https://api-relay-prod.divine.video', mockEvent.id);
    expect(result).toEqual(mockEvent);
    expect(globalThis.fetch).toHaveBeenCalledWith(
      `https://api-relay-prod.divine.video/api/funnelcake/event/${mockEvent.id}`,
      expect.objectContaining({ headers: expect.any(Object) }),
    );
  });

  it('returns null on 404', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response('', { status: 404 }),
    );
    const result = await fetchFunnelcakeEvent('https://api-relay-prod.divine.video', 'a'.repeat(64));
    expect(result).toBeNull();
  });

  it('returns null on network error', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(new Error('Network error'));
    const result = await fetchFunnelcakeEvent('https://api-relay-prod.divine.video', 'a'.repeat(64));
    expect(result).toBeNull();
  });
});

describe('fetchFunnelcakeUser', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns flattened metadata on success', async () => {
    const mockUser = {
      pubkey: 'abc'.padEnd(64, '0'),
      profile: {
        name: 'alice',
        display_name: 'Alice',
        picture: 'https://example.com/pic.jpg',
        about: 'hello',
        nip05: 'alice@example.com',
      },
      social: { follower_count: 10 },
      stats: { video_count: 5 },
    };
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify(mockUser), { status: 200 }),
    );

    const result = await fetchFunnelcakeUser('https://api-relay-prod.divine.video', mockUser.pubkey);
    expect(result).toEqual({ metadata: mockUser.profile });
  });

  it('returns null when profile is missing', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ pubkey: 'a'.repeat(64) }), { status: 200 }),
    );
    const result = await fetchFunnelcakeUser('https://api-relay-prod.divine.video', 'a'.repeat(64));
    expect(result).toBeNull();
  });

  it('returns null on network error', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(new Error('fail'));
    const result = await fetchFunnelcakeUser('https://api-relay-prod.divine.video', 'a'.repeat(64));
    expect(result).toBeNull();
  });
});
