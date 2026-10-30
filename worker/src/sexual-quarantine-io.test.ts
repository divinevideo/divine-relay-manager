import { afterEach, describe, expect, it, vi } from 'vitest';
import { finalizeEvent } from 'nostr-tools';
import { OutsideVideoScope, ConfirmedAbsentTarget, TargetEvidenceLimit } from './sexual-quarantine';
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
  it('admits media eligibility from authenticated owner metadata', async () => {
    const event = video();
    vi.mocked(queryRelay).mockResolvedValue({ success: true, events: [event] });
    const fetcher = vi.fn(async () => Response.json({ sha256: HASH, owner: event.pubkey }));
    vi.stubGlobal('fetch', fetcher);
    const io = createQuarantineIO(env);
    expect(await io.resolveAssets!(await io.snapshot(event.id))).toEqual({ assets: [HASH], incomplete: false });
    expect(fetcher).toHaveBeenCalledWith(`https://media.example.test/admin/api/blob/${HASH}`,
      expect.objectContaining({ headers: { Authorization: 'Bearer test-only-secret' }, redirect: 'manual' }));
  });

  it('keeps unresolved media eligibility pending while preserving signed evidence', async () => {
    const event = video();
    vi.mocked(queryRelay).mockResolvedValue({ success: true, events: [event] });
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ sha256: HASH, owner: 'f'.repeat(64) })));
    const io = createQuarantineIO(env);
    const snapshot = await io.snapshot(event.id);
    expect(snapshot).toMatchObject({ event, assets: [HASH] });
    expect(await io.resolveAssets!(snapshot)).toEqual({ assets: [], incomplete: true });
    await expect(createQuarantineIO(env).mediaHold(HASH, `sexual:${event.id}`, true, 2)).rejects.toThrow();
  });

  it('maps signed hash candidates with authenticated metadata even for mirror URLs', async () => {
    const event = video([['imeta', `url https://mirror.example.test/${HASH}.mp4`, `x ${HASH}`], ['x', 'b'.repeat(64)]]);
    vi.mocked(queryRelay).mockResolvedValue({ success: true, events: [event] });
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL | Request) => Response.json({
      sha256: String(url).split('/').pop(), owner: event.pubkey,
    })));
    expect((await createQuarantineIO(env).snapshot(event.id)).assets).toEqual([HASH, 'b'.repeat(64)]);
  });

  it('does not treat an unapplied media capacity response as a hold', async () => {
    const event = video();
    vi.mocked(queryRelay).mockResolvedValue({ success: true, events: [event] });
    const fetcher = vi.fn(async (url: string | URL | Request) => String(url).includes('/admin/api/blob/')
      ? Response.json({ sha256: HASH, owner: event.pubkey }) : new Response(null, { status: 409 }));
    vi.stubGlobal('fetch', fetcher);
    await expect(createQuarantineIO(env).mediaHold(HASH, `sexual:${event.id}`, true, 2)).rejects.toThrow();
  });

  it('writes a newer release fence after an ambiguous media hold response', async () => {
    const event = video(); const hold = `sexual:${event.id}`;
    vi.mocked(callNip86Rpc).mockResolvedValue({ success: true, result: [{ hold_id: hold, version: 3, active: 0 }] });
    vi.mocked(queryRelay).mockResolvedValue({ success: true, events: [event] });
    let row: { hold_id: string; version: number; active: boolean } | undefined;
    let delayedHold!: () => void;
    const status = () => ({ quarantined: !!row?.active, holds: row ? [row] : [] });
    const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input).includes('/admin/api/blob/')) return Response.json({ sha256: HASH, owner: event.pubkey });
      if (init?.method === 'POST') {
        const body = JSON.parse(init.body as string);
        const apply = () => {
          if (!row || body.version > row.version) row = { hold_id: body.hold_id, version: body.version, active: body.action === 'hold' };
        };
        if (body.action === 'hold') { delayedHold = apply; throw new DOMException('Timed out', 'TimeoutError'); }
        apply();
      }
      return Response.json(status());
    });
    vi.stubGlobal('fetch', fetcher);
    const io = createQuarantineIO(env);
    await expect(io.mediaHold(HASH, hold, true, 2)).rejects.toThrow();
    await io.mediaHold(HASH, hold, false, 3);
    expect(await io.verify(snapshotVideo(event.id, event, env), hold, false)).toBe(true);
    delayedHold();
    expect(row).toMatchObject({ version: 3, active: false });
    expect(await io.verify(snapshotVideo(event.id, event, env), hold, false)).toBe(true);
  });

  it('can release a definitively unapplied ID at lifetime capacity without clearing other holds', async () => {
    const event = video(); const hold = `sexual:${event.id}`;
    const full = Array.from({ length: 128 }, (_, i) => ({ hold_id: `other:${i}`, version: 1, active: i === 0 }));
    vi.mocked(callNip86Rpc).mockResolvedValue({ success: true, result: [{ hold_id: hold, version: 3, active: 0 }] });
    vi.mocked(queryRelay).mockResolvedValue({ success: true, events: [event] });
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input).includes('/admin/api/blob/')) return Response.json({ sha256: HASH, owner: event.pubkey });
      if (init?.method === 'POST') return new Response(null, { status: 409 });
      return Response.json({ quarantined: true, holds: full });
    }));
    const io = createQuarantineIO(env);
    await expect(io.mediaHold(HASH, hold, true, 2)).rejects.toThrow();
    await expect(io.mediaHold(HASH, hold, false, 3)).resolves.toBeUndefined();
    expect(await io.verify(snapshotVideo(event.id, event, env), hold, false)).toBe(true);
    expect(await io.restorationStatus(snapshotVideo(event.id, event, env))).toBe('restricted');
  });

  it('distinguishes an absent target response from an incomplete lookup', async () => {
    vi.mocked(queryRelay).mockResolvedValue({ success: true, events: [] });
    vi.mocked(callNip86Rpc).mockResolvedValue({ success: false, error: 'Event not found or not banned' });
    await expect(createQuarantineIO(env).snapshot('f'.repeat(64))).rejects.toBeInstanceOf(ConfirmedAbsentTarget);
    vi.mocked(queryRelay).mockResolvedValue({ success: false, events: [] });
    await expect(createQuarantineIO(env).snapshot('f'.repeat(64))).rejects.not.toBeInstanceOf(ConfirmedAbsentTarget);
  });

  it('records an author deletion as a remaining restriction after scoped release', async () => {
    const event = video([]);
    const deletion = finalizeEvent({ kind: 5, created_at: 2, tags: [['e', event.id]], content: '' }, new Uint8Array(32).fill(2));
    vi.mocked(queryRelay).mockImplementation(async filter => ({ success: true, events: (filter as { kinds?: number[] }).kinds?.includes(5) ? [deletion] : [] }));
    vi.mocked(callNip86Rpc).mockImplementation(async method => method === 'geteventholds'
      ? { success: true, result: [{ hold_id: `sexual:${event.id}`, version: 3, active: 0 }] }
      : { success: false, error: 'Event not found or not banned' });
    expect(await createQuarantineIO(env).restorationStatus(snapshotVideo(event.id, event, env))).toBe('restricted');
  });
  it('binds media actions to a signed event and matching controlled URL', () => {
    const event = video();
    expect(snapshotVideo(event.id, event, env).assets).toEqual([HASH]);
    expect(() => snapshotVideo(event.id, { ...event, content: 'changed' }, env)).toThrow();
    const mismatch = video([['imeta', `url https://media.example.test/${HASH}.mp4`, `x ${'b'.repeat(64)}`]]);
    expect(snapshotVideo(mismatch.id, mismatch, env)).toMatchObject({ assets: [], mappingIncomplete: true });
    const external = video([['imeta', `url https://external.example.test/${HASH}.mp4`, `x ${HASH}`]]);
    expect(snapshotVideo(external.id, external, env).assets).toEqual([HASH]);
  });

  it('preserves valid video mappings when ancillary metadata is unusable', async () => {
    const event = video([['url', `https://media.example.test/${HASH}.mp4`],
      ['image', 'not-a-url'], ['thumb', 'https://media.example.test/thumbnail.jpg']]);
    const snapshot = snapshotVideo(event.id, event, env);
    expect(snapshot.assets).toEqual([HASH]);
    expect(snapshot.unmappedMediaPaths).toEqual(['/thumbnail.jpg']);
    const hold = `sexual:${event.id}`;
    vi.mocked(callNip86Rpc).mockResolvedValue({ success: true, result: [{ hold_id: hold, version: 2, active: 1 }] });
    vi.mocked(queryRelay).mockResolvedValue({ success: true, events: [] });
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL | Request) => String(url).includes('/admin/api/quarantine/')
      ? Response.json({ quarantined: true, holds: [{ hold_id: hold, version: 2, active: true }] })
      : new Response(null, { status: String(url).endsWith('/thumbnail.jpg') ? 200 : 404 })));
    expect(await createQuarantineIO(env).verify(snapshot, hold, true)).toBe(false);
  });

  it('retains bounded partial mappings without claiming full hiding', () => {
    const tags = Array.from({ length: 9 }, (_, i) => ['url', `https://media.example.test/${(i + 1).toString(16).padStart(64, '0')}.mp4`]);
    const event = video(tags);
    const snapshot = snapshotVideo(event.id, event, env);
    expect(snapshot.assets).toHaveLength(8);
    expect(snapshot.mappingIncomplete).toBe(true);
  });

  it('captures signed hash candidates while requiring a verified event identity', () => {
    const event = video([['x', HASH]]);
    expect(snapshotVideo(event.id, event, env).assets).toEqual([HASH]);
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

  it('classifies a large verified non-video target instead of leaving it unclassifiable', () => {
    const article = finalizeEvent({ kind: 30023, created_at: 1, tags: [['d', 'synthetic']], content: 'x'.repeat(70_000) }, new Uint8Array(32).fill(2));
    expect(() => snapshotVideo(article.id, article, env)).toThrow(OutsideVideoScope);
    const large = video([['imeta', `url https://media.example.test/${HASH}.mp4`, `x ${HASH}`], ['alt', 'x'.repeat(70_000)]]);
    expect(snapshotVideo(large.id, large, env).assets).toEqual([HASH]);
    const overLimit = video([['alt', 'x'.repeat(530_000)]]);
    expect(() => snapshotVideo(overLimit.id, overLimit, env)).toThrow(TargetEvidenceLimit);
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
