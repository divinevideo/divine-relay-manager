import { vi } from 'vitest';

// A small, stateful model of the services a bulk action talks to, for tests
// that need them to react to each other the way production does (#299):
//
//   - the relay (WebSocket REQ by author) and funnelcake's public per-user
//     video list (GET /api/v2/users/{pk}/videos). Both hide a banned event as
//     soon as it is banned, hide every event of a banned or suspended account
//     (funnelcake's public visibility filter), and hide a quarantined event
//     (funnelcake's quarantine set, below). The video list pages by offset
//     with `o:N` cursors and answers 400 to any other cursor.
//   - the media server's admin API: the per-uploader list
//     (GET /admin/api/user/{pk}, every status except deleted, keyed by who
//     uploaded, so it can list a file someone else owns, with each file's
//     `type`) and the per-file read (GET /admin/api/blob/{sha256}). Both need
//     the Bearer secret.
//   - moderation-service: the recorded decision (GET /check-result/{sha256})
//     and the write (POST /api/v1/moderate), which changes the file's status
//     on the media server the way its /admin/moderate does. A DELETE soft-
//     deletes the file and takes it off every uploader list. Its relay
//     notifier keeps funnelcake's quarantine set: a QUARANTINE adds the
//     file's events to it, and a SAFE or AGE_RESTRICTED takes them out. Any
//     QUARANTINE does this, whoever sends it: age review, a moderator, or the
//     moderation pipeline's own automatic quarantines.
//
// Hashes and pubkeys here are synthetic.

export type BlobStatus = 'active' | 'pending' | 'age_restricted' | 'restricted' | 'banned' | 'deleted';

export interface WorldBlob {
  sha256: string;
  owner: string;
  status: BlobStatus;
  // The MIME type the media server recorded at upload. null leaves the field
  // out of the list row.
  type: string | null;
}

interface WorldEvent {
  id: string;
  pubkey: string;
  kind: number;
  created_at: number;
  content: string;
  tags: string[][];
  sha256?: string;
}

const MEDIA_STATUS_AFTER: Record<string, { blob: BlobStatus; record: string }> = {
  DELETE: { blob: 'deleted', record: 'delete' },
  QUARANTINE: { blob: 'restricted', record: 'quarantine' },
  AGE_RESTRICTED: { blob: 'age_restricted', record: 'age_restricted' },
  SAFE: { blob: 'active', record: 'safe' },
};

// A synthetic 64-hex hash: one hex digit, then the index.
export function fakeHash(prefix: string, index: number): string {
  return prefix + index.toString(16).padStart(63, '0');
}

export interface BulkWorldOptions {
  cdnDomain?: string;
  funnelcakeBase?: string;
  secret?: string;
}

export function createBulkWorld(options: BulkWorldOptions = {}) {
  const cdnDomain = options.cdnDomain ?? 'media.test';
  const funnelcakeBase = options.funnelcakeBase ?? 'https://relay.test';
  const secret = options.secret ?? 'test-blossom-secret';

  const events = new Map<string, WorldEvent>();
  const bannedEvents = new Set<string>();
  const quarantinedEvents = new Set<string>();
  const bannedPubkeys = new Set<string>();
  const suspendedPubkeys = new Set<string>();
  const blobs = new Map<string, WorldBlob>();
  const uploaderLists = new Map<string, string[]>();
  const records = new Map<string, string>();
  const writes: Array<{ sha256: string; action: string }> = [];
  // Every write sent to moderation-service, including one it answered 500 to
  // (see writeFailures); `writes` holds only those it applied.
  const writeAttempts: Array<{ sha256: string; action: string }> = [];
  const listReads: string[] = [];
  // Files whose per-file read comes back without an owner.
  const ownerless = new Set<string>();
  // Files the per-uploader list leaves out of its answer while still answering
  // 200, as blossom does for a row whose record read errors.
  const listOmits = new Set<string>();
  // A status the media server's cache still serves for a file after it
  // changed (blossom caches per POP for up to 5 minutes): both the list and
  // the per-file read report it.
  const staleStatus = new Map<string, BlobStatus>();
  // A status only the list still shows: it answered from before a change the
  // per-file read, made after it, already sees.
  const listLag = new Map<string, BlobStatus>();
  // An owner only the list shows: a stale row, which the per-file read
  // contradicts.
  const listOwner = new Map<string, string>();
  // Files whose recorded-decision read answers with this HTTP status.
  const recordReadFailures = new Map<string, number>();
  // Files whose moderation-service write answers 500.
  const writeFailures = new Set<string>();
  // Set to make the per-uploader list fail: an HTTP status, a hang past any
  // timeout, or a body that is not the expected JSON array.
  let listFailure: number | 'hang' | 'not-json' | 'not-array' | 'bad-row' | null = null;
  // Called before each per-uploader list read is answered, with how many
  // reads came before it, so a test can change the world mid-job.
  let beforeListRead: ((readsBefore: number) => void) | null = null;

  function hiddenAccount(pubkey: string): boolean {
    return bannedPubkeys.has(pubkey) || suspendedPubkeys.has(pubkey);
  }

  function visibleEventsOf(pubkey: string): WorldEvent[] {
    if (hiddenAccount(pubkey)) return [];
    return [...events.values()]
      .filter((e) => e.pubkey === pubkey && !bannedEvents.has(e.id) && !quarantinedEvents.has(e.id))
      .sort((a, b) => b.created_at - a.created_at);
  }

  function servedStatus(blob: WorldBlob): BlobStatus {
    return staleStatus.get(blob.sha256) ?? blob.status;
  }

  function listUnder(pubkey: string, sha256: string) {
    const list = uploaderLists.get(pubkey) ?? [];
    if (!list.includes(sha256)) list.push(sha256);
    uploaderLists.set(pubkey, list);
  }

  const world = {
    events, bannedEvents, quarantinedEvents, bannedPubkeys, suspendedPubkeys, blobs, uploaderLists, records, writes, listReads,
    ownerless, listOmits, staleStatus, listLag, listOwner, recordReadFailures, writeFailures,

    failList(failure: typeof listFailure) { listFailure = failure; },
    onListRead(hook: typeof beforeListRead) { beforeListRead = hook; },

    // A file on the media server. Listed under its owner unless `listedUnder`
    // says otherwise (a re-upload of someone else's file is listed under the
    // re-uploader but owned by the first uploader; a failed list write leaves
    // it under nobody).
    addBlob(blob: { sha256: string; owner: string; status?: BlobStatus; type?: string | null }, listedUnder: string[] = [blob.owner]) {
      blobs.set(blob.sha256, {
        sha256: blob.sha256, owner: blob.owner, status: blob.status ?? 'active',
        type: blob.type === undefined ? 'video/mp4' : blob.type,
      });
      for (const pubkey of listedUnder) listUnder(pubkey, blob.sha256);
    },

    // A video event by `pubkey` whose imeta points at `sha256`.
    addVideo(pubkey: string, id: string, sha256: string, createdAt: number) {
      events.set(id, {
        id, pubkey, kind: 34236, created_at: createdAt, content: '',
        tags: [['d', id], ['imeta', `url https://${cdnDomain}/${sha256}`, `x ${sha256}`]], sha256,
      });
    },

    // An account with `count` videos, each its own file, owned by and listed
    // under the account. `prefix` (one hex digit) keeps accounts' hashes apart;
    // hashes sort in creation order.
    addAccountVideos(pubkey: string, count: number, prefix = 'f') {
      const hashes: string[] = [];
      for (let i = 0; i < count; i++) {
        const sha256 = fakeHash(prefix, i);
        world.addBlob({ sha256, owner: pubkey });
        world.addVideo(pubkey, `${prefix}-event-${i}`, sha256, 1_000_000 + i);
        hashes.push(sha256);
      }
      return hashes;
    },

    // A moderation-service decision on a file, as /api/v1/moderate applies it.
    // Tests call it directly for a decision some other sender made (the
    // moderation pipeline's automatic quarantine, say).
    moderate(sha256: string, action: string) {
      writes.push({ sha256, action });
      const after = MEDIA_STATUS_AFTER[action];
      records.set(sha256, after.record);
      const blob = blobs.get(sha256);
      if (blob) {
        blob.status = after.blob;
        if (action === 'DELETE') {
          for (const [pubkey, list] of uploaderLists) uploaderLists.set(pubkey, list.filter((h) => h !== sha256));
        }
      }
      const eventIds = [...events.values()].filter((e) => e.sha256 === sha256).map((e) => e.id);
      if (action === 'QUARANTINE') eventIds.forEach((id) => quarantinedEvents.add(id));
      if (action === 'SAFE' || action === 'AGE_RESTRICTED') eventIds.forEach((id) => quarantinedEvents.delete(id));
    },

    statusOf(sha256: string): BlobStatus | undefined { return blobs.get(sha256)?.status; },
    writesFor(sha256: string): string[] { return writes.filter((w) => w.sha256 === sha256).map((w) => w.action); },
    writeAttemptsFor(sha256: string): string[] { return writeAttempts.filter((w) => w.sha256 === sha256).map((w) => w.action); },

    // NIP-86 banevent, as funnelcake applies it: hidden from REQ and from the
    // public video list at once.
    async banEvent(eventId: string): Promise<{ success: boolean }> {
      bannedEvents.add(eventId);
      return { success: true };
    },

    async fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
      const url = new URL(String(input instanceof Request ? input.url : input));
      const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));

      if (url.origin === funnelcakeBase && /^\/api\/v2\/users\/[0-9a-f]{64}\/videos$/.test(url.pathname)) {
        const pubkey = url.pathname.split('/')[4];
        const limit = Math.min(Number(url.searchParams.get('limit') ?? '25'), 100);
        const cursor = url.searchParams.get('cursor');
        let offset = 0;
        if (cursor !== null) {
          const match = /^o:(\d+)$/.exec(cursor);
          if (!match) return new Response(JSON.stringify({ error: 'invalid cursor' }), { status: 400 });
          offset = Number(match[1]);
        }
        const visible = visibleEventsOf(pubkey).filter((e) => e.kind === 34235 || e.kind === 34236);
        const page = visible.slice(offset, offset + limit);
        const next = offset + limit < visible.length ? `o:${offset + limit}` : null;
        return new Response(JSON.stringify({
          data: page.map((e) => ({ id: e.id, pubkey: e.pubkey, sha256: e.sha256 })),
          pagination: { next_cursor: next, has_more: next !== null },
        }), { status: 200 });
      }

      if (url.host === cdnDomain && url.pathname.startsWith('/admin/api/')) {
        if (headers.get('Authorization') !== `Bearer ${secret}`) return new Response('unauthorized', { status: 401 });

        if (url.pathname.startsWith('/admin/api/user/')) {
          const pubkey = url.pathname.slice('/admin/api/user/'.length);
          beforeListRead?.(listReads.length);
          listReads.push(pubkey);
          if (typeof listFailure === 'number') return new Response('err', { status: listFailure });
          if (listFailure === 'hang') {
            return new Promise<Response>((_resolve, reject) => {
              if (init?.signal?.aborted) reject(init.signal.reason);
              init?.signal?.addEventListener('abort', () => reject(init.signal!.reason));
            });
          }
          if (listFailure === 'not-json') return new Response('<html>oops</html>', { status: 200 });
          if (listFailure === 'not-array') return new Response(JSON.stringify({ blobs: [] }), { status: 200 });
          const rows: Array<Record<string, unknown>> = (uploaderLists.get(pubkey.toLowerCase()) ?? [])
            .filter((sha256) => !listOmits.has(sha256))
            .map((sha256) => blobs.get(sha256))
            .filter((b): b is WorldBlob => b !== undefined)
            .map((b) => ({
              sha256: b.sha256, size: 1, ...(b.type === null ? {} : { type: b.type }), uploaded: 't', owner: listOwner.get(b.sha256) ?? b.owner,
              status: listLag.get(b.sha256) ?? servedStatus(b),
            }));
          if (listFailure === 'bad-row') rows.push({ sha256: 'not-a-hash', type: 'video/mp4' });
          return new Response(JSON.stringify(rows), { status: 200 });
        }

        if (url.pathname.startsWith('/admin/api/blob/')) {
          const blob = blobs.get(url.pathname.slice('/admin/api/blob/'.length));
          if (!blob) return new Response(JSON.stringify({ error: 'Blob not found' }), { status: 404 });
          const owner = ownerless.has(blob.sha256) ? {} : { owner: blob.owner };
          const type = blob.type === null ? {} : { type: blob.type };
          return new Response(JSON.stringify({ sha256: blob.sha256, size: 1, ...type, uploaded: 't', ...owner, status: servedStatus(blob) }), { status: 200 });
        }
      }

      return new Response('not found', { status: 404 });
    },

    // The MODERATION_API service binding.
    moderationApi: {
      fetch: vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(String(input));
        if (url.pathname.startsWith('/check-result/')) {
          const sha256 = url.pathname.slice('/check-result/'.length);
          const failure = recordReadFailures.get(sha256);
          if (failure !== undefined) return new Response('err', { status: failure });
          return new Response(JSON.stringify({ sha256, status: records.get(sha256) ?? 'unknown' }), { status: 200 });
        }
        if (url.pathname === '/api/v1/moderate' && init?.method === 'POST') {
          const { sha256, action } = JSON.parse(String(init.body)) as { sha256: string; action: string };
          writeAttempts.push({ sha256, action });
          if (writeFailures.has(sha256)) return new Response('err', { status: 500 });
          world.moderate(sha256, action);
          return new Response(JSON.stringify({ success: true }), { status: 200 });
        }
        return new Response('not found', { status: 404 });
      }),
    } as unknown as Fetcher,

    // A WebSocket stand-in that answers REQ {authors, limit, until} from the
    // same state, newest first.
    webSocket: function FakeRelaySocket() {
      const listeners = new Map<string, Array<(value?: unknown) => void>>();
      const emit = (type: string, value?: unknown) => listeners.get(type)?.forEach((h) => h(value));
      const socket = {
        addEventListener: (type: string, handler: (value?: unknown) => void) => {
          listeners.set(type, [...(listeners.get(type) ?? []), handler]);
        },
        send: (payload: string) => {
          const data = JSON.parse(payload);
          if (data[0] !== 'REQ') return;
          const [, sub, filter] = data as [string, string, { authors: string[]; limit?: number; until?: number }];
          const until = filter.until ?? Infinity;
          const page = filter.authors
            .flatMap((pubkey) => visibleEventsOf(pubkey))
            .filter((e) => e.created_at <= until)
            .sort((a, b) => b.created_at - a.created_at)
            .slice(0, filter.limit ?? 500);
          queueMicrotask(() => {
            for (const e of page) {
              emit('message', { data: JSON.stringify(['EVENT', sub, { id: e.id, pubkey: e.pubkey, kind: e.kind, created_at: e.created_at, content: e.content, tags: e.tags }]) });
            }
            emit('message', { data: JSON.stringify(['EOSE', sub]) });
          });
        },
        close: () => {},
      };
      queueMicrotask(() => emit('open'));
      return socket;
    } as unknown as typeof WebSocket,

    install() {
      vi.spyOn(globalThis, 'fetch').mockImplementation(world.fetch as typeof fetch);
      vi.spyOn(globalThis, 'WebSocket').mockImplementation(world.webSocket);
    },
  };
  return world;
}

export type BulkWorld = ReturnType<typeof createBulkWorld>;
