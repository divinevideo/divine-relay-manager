import { afterEach, describe, expect, it, vi } from 'vitest';
import { finalizeEvent } from 'nostr-tools';
import { OutsideVideoScope } from './sexual-quarantine';
import { createQuarantineIO, snapshotVideo } from './sexual-quarantine-io';
import { callNip86Rpc } from './nip86';
import { queryRelay } from './relay-profile';

vi.mock('./nip86', () => ({ callNip86Rpc: vi.fn() }));
vi.mock('./relay-profile', () => ({ queryRelay: vi.fn() }));
const HASH = 'a'.repeat(64);
const env = { NOSTR_NSEC: 'test', RELAY_URL: 'wss://relay.example.test', CDN_DOMAIN: 'media.example.test', BLOSSOM_WEBHOOK_SECRET: 'test-only-secret' };
const video = (tags = [['imeta', `url https://media.example.test/${HASH}.mp4`, `x ${HASH}`, 'm video/mp4']]) =>
  finalizeEvent({ kind: 34236, created_at: 1, tags, content: '' }, new Uint8Array(32).fill(2));
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('quarantine service IO', () => {
  it('binds media actions to a signed event and matching controlled URL', () => {
    const event = video();
    expect(snapshotVideo(event.id, event, env).assets).toEqual([HASH]);
    expect(() => snapshotVideo(event.id, { ...event, content: 'changed' }, env)).toThrow();
    expect(() => snapshotVideo(event.id, video([['imeta', `url https://media.example.test/${HASH}.mp4`, `x ${'b'.repeat(64)}`]]), env)).toThrow();
    const external = video([['imeta', `url https://external.example.test/${HASH}.mp4`, `x ${HASH}`]]);
    expect(snapshotVideo(external.id, external, env).assets).toEqual([]);
  });

  it('does not use a hash from free text or a reporter-provided field', () => {
    const event = video([['x', HASH]]);
    expect(snapshotVideo(event.id, event, env).assets).toEqual([]);
    expect(() => snapshotVideo('f'.repeat(64), event, env)).toThrow();
  });

  it('captures inline media and separate signed thumbnail assets', () => {
    const thumb = 'b'.repeat(64);
    const event = finalizeEvent({ kind: 21, created_at: 1,
      tags: [['image', `https://media.example.test/${thumb}.jpg`]],
      content: `Watch https://media.example.test/${HASH}.mp4 now.` }, new Uint8Array(32).fill(2));
    expect(snapshotVideo(event.id, event, env).assets).toEqual([thumb, HASH]);
  });

  it('cannot verify a hide while the actual HLS master is public', async () => {
    const event = video(); const hold = `sexual:${event.id}`;
    vi.mocked(callNip86Rpc).mockResolvedValue({ success: true, result: [{ hold_id: hold, version: 2, active: 1 }] });
    vi.mocked(queryRelay).mockResolvedValue({ success: true, events: [] });
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL | Request) => String(url).includes('/admin/api/quarantine/')
      ? Response.json({ quarantined: true, holds: [{ hold_id: hold, version: 2, active: true }] })
      : new Response(null, { status: String(url).endsWith('/hls/master.m3u8') ? 200 : 404 })));
    expect(await createQuarantineIO(env).verify(snapshotVideo(event.id, event, env), hold, true)).toBe(false);
  });

  it('recognizes an independent base event ban after releasing this hold', async () => {
    const event = video(); const hold = `sexual:${event.id}`;
    vi.mocked(callNip86Rpc).mockImplementation(async method => method === 'geteventholds'
      ? { success: true, result: [{ hold_id: hold, version: 3, active: 0 }] }
      : { success: true, result: event });
    vi.mocked(queryRelay).mockResolvedValue({ success: true, events: [] });
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL | Request) => String(url).includes('/admin/api/quarantine/')
      ? Response.json({ quarantined: false, holds: [{ hold_id: hold, version: 3, active: false }] })
      : new Response(null, { status: 200 })));
    expect(await createQuarantineIO(env).restorationStatus(snapshotVideo(event.id, event, env))).toBe('restricted');
  });

  it('accepts real controlled quality variant paths', () => {
    const event = video([['url', `https://media.example.test/${HASH}/720p.mp4`]]);
    expect(snapshotVideo(event.id, event, env).assets).toEqual([HASH]);
  });

  it('rejects malformed hold versions in acknowledgments and reads', async () => {
    const event = video(); const hold = `sexual:${event.id}`;
    for (const version of [undefined, null, -1, 0, 1.5, '3', Number.MAX_SAFE_INTEGER + 1]) {
      vi.mocked(callNip86Rpc).mockResolvedValue({ success: true, result: { hold_id: hold, version, active: 1 } });
      await expect(createQuarantineIO(env).eventHold(event.id, true, 3)).rejects.toThrow();
      vi.stubGlobal('fetch', vi.fn(async () => Response.json({ quarantined: true, holds: [{ hold_id: hold, version, active: true }] })));
      await expect(createQuarantineIO(env).mediaHold(HASH, hold, true, 3)).rejects.toThrow();
      vi.mocked(callNip86Rpc).mockResolvedValue({ success: true, result: [{ hold_id: hold, version, active: 1 }] });
      await expect(createQuarantineIO(env).verify(snapshotVideo(event.id, event, env), hold, true)).rejects.toThrow();
    }
  });

  it('accepts the real empty 202 COOP async submission response', async () => {
    const event = video();
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 202 })));
    const item = { eventId: event.id, goal: 'review', state: 'review', reporters: 1,
      firstReport: { id: 'c'.repeat(64), reason: 'nudity' }, deadlineAt: 1000,
      snapshot: snapshotVideo(event.id, event, env) } as Parameters<ReturnType<typeof createQuarantineIO>['review']>[0];
    await expect(createQuarantineIO({ ...env, COOP_URL: 'https://coop.example.test', COOP_API_KEY: 'test',
      REVIEWER_BASE_URL: 'https://review.example.test' }).review(item)).resolves.toBeUndefined();
  });

  it('keeps restore pending when the advertised HLS URL is still unavailable', async () => {
    const event = video([['url', `https://media.example.test/${HASH}/hls/master.m3u8`]]);
    const hold = `sexual:${event.id}`;
    vi.mocked(callNip86Rpc).mockResolvedValue({ success: true, result: [{ hold_id: hold, version: 3, active: 0 }] });
    vi.mocked(queryRelay).mockResolvedValue({ success: true, events: [event] });
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL | Request) => String(url).includes('/admin/api/quarantine/')
      ? Response.json({ quarantined: false, holds: [{ hold_id: hold, version: 3, active: false }] })
      : new Response(null, { status: String(url).endsWith('master.m3u8') ? 404 : 200 })));
    expect(await createQuarantineIO(env).restorationStatus(snapshotVideo(event.id, event, env))).toBe('pending');
  });

  it('distinguishes a verified comment from an invalid event', () => {
    const comment = finalizeEvent({ kind: 1, created_at: 1, tags: [], content: 'Synthetic comment' }, new Uint8Array(32).fill(2));
    expect(() => snapshotVideo(comment.id, comment, env)).toThrow(OutsideVideoScope);
    expect(() => snapshotVideo(comment.id, { ...comment, content: 'tampered' }, env)).not.toThrow(OutsideVideoScope);
  });

  it('sends a versioned independent event hold, never global unban', async () => {
    const event = video();
    vi.mocked(callNip86Rpc).mockResolvedValue({ success: true, result: { hold_id: `sexual:${event.id}`, version: 3, active: 0 } });
    await createQuarantineIO(env).eventHold(event.id, false, 3);
    expect(callNip86Rpc).toHaveBeenCalledWith('seteventhold', [event.id, `sexual:${event.id}`, 3, 0], env, 3000);
  });

  it('treats stale acknowledgments and non-JSON replies as unconfirmed', async () => {
    vi.mocked(callNip86Rpc).mockResolvedValue({ success: true, result: { version: 4, active: 0 } });
    await expect(createQuarantineIO(env).eventHold('1'.repeat(64), true, 2)).rejects.toThrow();
    vi.stubGlobal('fetch', vi.fn(async () => new Response('<html>sign in</html>')));
    await expect(createQuarantineIO(env).mediaHold(HASH, `sexual:${'1'.repeat(64)}`, true, 2)).rejects.toThrow();
  });

  it('does not verify hiding from a 200, redirect, 401, or server failure', async () => {
    const event = video();
    const hold = `sexual:${event.id}`;
    vi.mocked(callNip86Rpc).mockResolvedValue({ success: true, result: [{ hold_id: hold, version: 2, active: 1 }] });
    vi.mocked(queryRelay).mockResolvedValue({ success: true, events: [] });
    for (const status of [200, 302, 401, 503]) {
      vi.stubGlobal('fetch', vi.fn(async (url: string | URL | Request) => String(url).includes('/admin/api/quarantine/')
        ? Response.json({ quarantined: true, hold_ids: [hold], holds: [{ hold_id: hold, version: 2, active: true }] })
        : new Response(null, { status })));
      expect(await createQuarantineIO(env).verify(snapshotVideo(event.id, event, env), hold, true)).toBe(false);
    }
  });

  it('requires confirmed relay absence and checks original, thumbnail and HLS master', async () => {
    const event = video(); const hold = `sexual:${event.id}`;
    vi.mocked(callNip86Rpc).mockResolvedValue({ success: true, result: [{ hold_id: hold, version: 2, active: 1 }] });
    vi.mocked(queryRelay).mockResolvedValue({ success: true, events: [] });
    const fetcher = vi.fn(async (url: string | URL | Request) => String(url).includes('/admin/api/quarantine/')
      ? Response.json({ quarantined: true, hold_ids: [hold], holds: [{ hold_id: hold, version: 2, active: true }] })
      : new Response(null, { status: 404 }));
    vi.stubGlobal('fetch', fetcher);
    const io = createQuarantineIO(env);
    expect(await io.verify(snapshotVideo(event.id, event, env), hold, true)).toBe(true);
    const urls = fetcher.mock.calls.map(([url]) => String(url));
    for (const path of [`${HASH}.mp4`, `${HASH}.jpg`, `${HASH}/hls/master.m3u8`, `${HASH}/hls/stream_480p.ts`, `${HASH}/720p`]) expect(urls).toContain(`https://media.example.test/${path}`);
    vi.mocked(queryRelay).mockResolvedValue({ success: false, events: [] });
    await expect(io.verify(snapshotVideo(event.id, event, env), hold, true)).rejects.toThrow('incomplete');
  });
});
