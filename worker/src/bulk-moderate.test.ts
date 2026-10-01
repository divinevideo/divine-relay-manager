import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  runBulkModeration,
  handleBulkModerateEnqueue,
  processBulkJob,
  handleBulkJobStatus,
  queryRelayEvents,
  queryUserVideosPage,
  queryRelayEventsPage,
  handleBulkKindCounts,
  VIDEO_MAX_PAGES,
  type BulkModerateEnv,
} from './bulk-moderate';
import type { BulkJob, BulkJobMessage, BulkEnqueueResponse } from '../../shared/bulk-moderation';
import { banEvent, getAdminPubkey } from './nip86';
import { syncZendeskAfterAction } from './zendesk-sync';

vi.mock('./nip86', () => ({
  getAdminPubkey: vi.fn().mockResolvedValue('moderator-pubkey'),
  banEvent: vi.fn().mockResolvedValue({ success: true }),
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
    if (url.pathname.includes('/api/v2/users/') && url.pathname.includes('/videos')) {
      // funnelcake v2 envelope is { data: [...], pagination: { next_cursor } }
      // (PaginatedResponse<T> in funnelcake's handlers.rs). The cursor MUST live
      // under `pagination` -- emitting it top-level would let a wrong-path parse
      // pass the test while silently capping enumeration at one page in prod.
      // Cursor here is the numeric offset so the mock pages like the cursor API.
      const limit = Number(url.searchParams.get('limit') ?? '100');
      const offset = url.searchParams.get('cursor') ? Number(url.searchParams.get('cursor')) : 0;
      const page = videos.slice(offset, offset + limit);
      const next = offset + limit < videos.length ? String(offset + limit) : null;
      return new Response(JSON.stringify({ data: page, pagination: { next_cursor: next, has_more: next !== null } }), { status: 200 });
    }
    return new Response('not found', { status: 404 });
  }) as typeof fetch);
}

// Functional in-memory D1 mock for the bulk_jobs table: supports the INSERT,
// positional-SET UPDATE, and SELECT-by-job_id statements the async path uses.
// Honors a `status IN (...)` / `status = '...'` guard in the UPDATE WHERE clause
// and reports meta.changes, so the consumer's sticky-status guards are exercised.
function makeJobDb() {
  const rows = new Map<string, Record<string, unknown>>();
  // Statements passed to DB.batch (the per-chunk decision-log writes).
  const batched: Array<{ sql: string; binds: unknown[] }> = [];
  const db = {
    prepare(sql: string) {
      let binds: unknown[] = [];
      const stmt = {
        sql,
        get binds() { return binds; },
        bind(...args: unknown[]) { binds = args; return stmt; },
        async run() {
          if (/^\s*INSERT INTO bulk_jobs/i.test(sql)) {
            const [job_id, pubkey, action, status, events_processed, media_processed, failures, failures_dropped, version, created_at, updated_at, kind] = binds;
            rows.set(job_id as string, { job_id, pubkey, action, status, events_processed, media_processed, failures, failures_dropped, version, created_at, updated_at, kind: kind ?? null });
            return { success: true, meta: { changes: 1 } };
          }
          if (/^\s*UPDATE bulk_jobs/i.test(sql)) {
            const jobId = binds[binds.length - 1] as string;
            const row = rows.get(jobId);
            let changes = 0;
            if (row) {
              const where = sql.slice(sql.search(/WHERE/i));
              const inMatch = where.match(/status IN \(([^)]+)\)/i);
              const eqMatch = where.match(/status\s*=\s*'(\w+)'/i);
              let statusOk = true;
              if (inMatch) statusOk = inMatch[1].split(',').map((s) => s.trim().replace(/'/g, '')).includes(row.status as string);
              else if (eqMatch) statusOk = row.status === eqMatch[1];
              const versionOk = !/version\s*=\s*\?/i.test(where)
                || Number(row.version ?? 0) === Number(binds[binds.length - 2]);
              if (statusOk && versionOk) {
                if (/version\s*=\s*version\s*\+\s*1/i.test(sql)) {
                  row.status = binds[0];
                  row.updated_at = binds[1];
                  row.version = Number(row.version ?? 0) + 1;
                } else {
                  const cols = sql.match(/SET (.+) WHERE/i)![1].split(',').map((c) => c.trim().split('=')[0].trim());
                  cols.forEach((c, i) => { row[c] = binds[i]; });
                }
                changes = 1;
              }
            }
            return { success: true, meta: { changes } };
          }
          if (/^\s*DELETE FROM bulk_jobs/i.test(sql)) {
            const existed = rows.delete(binds[0] as string);
            return { success: true, meta: { changes: existed ? 1 : 0 } };
          }
          return { success: true, meta: { changes: 0 } }; // CREATE TABLE / ALTER TABLE
        },
        async first() { return rows.get(binds[0] as string) ?? null; },
      };
      return stmt;
    },
    batch: async (stmts: Array<{ sql: string; binds: unknown[] }>) => {
      batched.push(...stmts.map((st) => ({ sql: st.sql, binds: st.binds })));
      return [];
    },
  };
  return { db: db as unknown as D1Database, rows, batched };
}

function baseEnv(): BulkModerateEnv {
  return {
    NOSTR_NSEC: 'nsec1vl029mgpspedva04g90vltkh6fvh240zqtv9k0t9af8935ke9laqsnlfe5',
    RELAY_URL: 'wss://relay.test',
    MODERATION_API: {
      fetch: vi.fn().mockResolvedValue(new Response(null, { status: 200 })),
    } as unknown as Fetcher,
    DB: {
      prepare: vi.fn().mockReturnValue({ bind: vi.fn().mockReturnThis() }),
      batch: vi.fn().mockResolvedValue([]),
    } as unknown as D1Database,
  };
}

function moderationActionFor(env: BulkModerateEnv, sha256: string): string | undefined {
  const fetchMock = vi.mocked((env.MODERATION_API as unknown as { fetch: ReturnType<typeof vi.fn> }).fetch);
  for (const call of fetchMock.mock.calls) {
    const body = JSON.parse((call[1] as RequestInit).body as string);
    if (body.sha256 === sha256) return body.action;
  }
  return undefined;
}

describe('queryUserVideosPage', () => {
  beforeEach(() => { vi.restoreAllMocks(); });
  it('parses the v2 envelope and returns the cursor', async () => {
    mockUserVideos([{ sha256: 'a'.repeat(64) }, { sha256: 'b'.repeat(64) }]);
    const page = await queryUserVideosPage('a'.repeat(64), { RELAY_URL: 'wss://relay.test' });
    expect(page.hashes).toEqual(['a'.repeat(64), 'b'.repeat(64)]);
    expect(page.nextCursor).toBeNull(); // 2 < limit 100 -> last page
  });
  it('returns a non-null cursor when more pages remain', async () => {
    mockUserVideos(Array.from({ length: 150 }, (_, i) => ({ sha256: i.toString(16).padStart(64, '0') })));
    const page = await queryUserVideosPage('a'.repeat(64), { RELAY_URL: 'wss://relay.test' });
    expect(page.hashes).toHaveLength(100);
    expect(page.nextCursor).toBe('100');
  });
});

describe('queryRelayEventsPage', () => {
  beforeEach(() => { vi.restoreAllMocks(); });
  it('defers the boundary second on a full multi-second page (no silent skip)', async () => {
    // 250 events, distinct descending seconds. A full page cuts at the oldest
    // second, which may have more events that did not fit -> defer it entirely:
    // process the 199 strictly-newer events and re-fetch from `oldest` INCLUSIVE
    // next chunk. Never processes or skips a partial second at the cut boundary.
    const all = Array.from({ length: 250 }, (_, i) => ({ id: `e${i}`, kind: 1, content: '', tags: [] as string[][], created_at: 250 - i }));
    mockPaginatedRelay(all);
    const page = await queryRelayEventsPage('a'.repeat(64), { RELAY_URL: 'wss://relay.test' });
    const boundary = all[199].created_at;                   // the cut (oldest) second
    expect(page.events).toHaveLength(199);                  // boundary second deferred
    expect(page.events.every((e) => Number(e.id.slice(1)) < 199)).toBe(true);
    expect(page.complete).toBe(false);                      // more remain
    expect(page.saturated).toBe(false);                     // multi-second, no single-second overflow
    expect(page.nextUntil).toBe(boundary);                  // inclusive: boundary second re-fetched next chunk
  });
  it('surfaces saturation when a full page is all one second (cannot subdivide)', async () => {
    // >EVENT_CHUNK_SIZE events at a single created_at: an `until` cursor cannot
    // subdivide a second, so we process this page, step strictly past, and flag
    // saturation so the consumer records the unavoidable gap instead of a silent
    // success.
    const all = Array.from({ length: 600 }, (_, i) => ({ id: `e${i}`, kind: 1, content: '', tags: [] as string[][], created_at: 1000 }));
    mockPaginatedRelay(all);
    const page = await queryRelayEventsPage('a'.repeat(64), { RELAY_URL: 'wss://relay.test' });
    expect(page.events).toHaveLength(200);                  // EVENT_CHUNK_SIZE, all at second 1000
    expect(page.saturated).toBe(true);                      // surfaced, not silent
    expect(page.complete).toBe(false);
    expect(page.nextUntil).toBe(999);                       // strictly past the saturated second
  });
  it('signals completion on a short final page', async () => {
    const all = Array.from({ length: 50 }, (_, i) => ({ id: `e${i}`, kind: 1, content: '', tags: [] as string[][], created_at: 50 - i }));
    mockPaginatedRelay(all);
    const page = await queryRelayEventsPage('a'.repeat(64), { RELAY_URL: 'wss://relay.test' });
    expect(page.events).toHaveLength(50);
    expect(page.complete).toBe(true);
    expect(page.saturated).toBe(false);
    expect(page.nextUntil).toBeNull();
  });
});

describe('runBulkModeration', () => {
  let mockEnv: BulkModerateEnv;

  beforeEach(() => {
    vi.restoreAllMocks();
    vi.mocked(getAdminPubkey).mockResolvedValue('moderator-pubkey');
    vi.mocked(banEvent).mockResolvedValue({ success: true });
    mockUserVideos([]); // default: no videos unless a test provides them
    mockEnv = baseEnv();
  });

  it('age-restrict-all sends QUARANTINE (reversible withhold) for media', async () => {
    mockUserVideos([{ sha256: hashA }]); // media hashes come from the REST API now
    const result = await runBulkModeration(mockEnv, 'a'.repeat(64), 'age-restrict-all', 'r');
    expect(result.success).toBe(true);
    // NOT 'AGE_RESTRICTED' (which would serve bytes to any signed-in viewer).
    expect(moderationActionFor(mockEnv, hashA)).toBe('QUARANTINE');
  });

  it('age-restrict-all QUARANTINEs EVERY video the REST API returns, not 1/kind (funnelcake#471)', async () => {
    // The WebSocket REQ dedup bug surfaced ~1 video/kind; the REST endpoint
    // returns all of them. Three same-kind videos must ALL be withheld -- this
    // is the correctness fix and the guard against regressing to WS extraction.
    mockUserVideos([{ sha256: hashA }, { sha256: hashB }, { sha256: hashC }]);
    const result = await runBulkModeration(mockEnv, 'a'.repeat(64), 'age-restrict-all', 'r');
    expect(result.mediaProcessed).toBe(3);
    expect(moderationActionFor(mockEnv, hashA)).toBe('QUARANTINE');
    expect(moderationActionFor(mockEnv, hashB)).toBe('QUARANTINE');
    expect(moderationActionFor(mockEnv, hashC)).toBe('QUARANTINE');
  });

  it('pages through ALL videos beyond the funnelcake per-page limit, not just the first page', async () => {
    // 250 videos = 3 pages (100/100/50). funnelcake caps a page at 100 (default 25),
    // so without offset paging only the first page would be withheld and the rest
    // would stay live -- the exact under-enforcement this guards against.
    const many = Array.from({ length: 250 }, (_, i) => ({ sha256: i.toString(16).padStart(64, '0') }));
    mockUserVideos(many);
    const result = await runBulkModeration(mockEnv, 'a'.repeat(64), 'age-restrict-all', 'r');
    expect(result.mediaProcessed).toBe(250);
  });

  it('un-age-restrict-all sends SAFE (restore) for media', async () => {
    mockUserVideos([{ sha256: hashA }]);
    await runBulkModeration(mockEnv, 'a'.repeat(64), 'un-age-restrict-all', 'r');
    expect(moderationActionFor(mockEnv, hashA)).toBe('SAFE');
  });

  it('delete-all bans events from the relay (WS) and DELETEs media hashes from the REST API', async () => {
    // Events still come from the WebSocket (delete needs event IDs); media
    // hashes come from REST. The WS event's x-tag (hashB) must NOT be the media
    // source -- only the REST list (hashA) is.
    mockRelay([{ id: 'e'.repeat(64), kind: 34235, content: '', tags: [['x', hashB]] }]);
    mockUserVideos([{ sha256: hashA }]);
    const result = await runBulkModeration(mockEnv, 'a'.repeat(64), 'delete-all', 'r');
    expect(result.eventsProcessed).toBe(1);
    expect(result.mediaProcessed).toBe(1);
    expect(moderationActionFor(mockEnv, hashA)).toBe('DELETE'); // from REST
    expect(moderationActionFor(mockEnv, hashB)).toBeUndefined(); // NOT from the WS x-tag
  });

  it('marks bulk delete as failed when relay deletion returns success false', async () => {
    vi.mocked(banEvent).mockResolvedValueOnce({ success: false, error: 'relay refused' });
    mockRelay([{ id: 'e'.repeat(64), kind: 1, content: '', tags: [] }]);

    const result = await runBulkModeration(mockEnv, 'a'.repeat(64), 'delete-all', 'r');
    expect(result.success).toBe(false);
    expect(result.eventsProcessed).toBe(0);
    expect(result.failures[0]).toContain('relay refused');
  });

  it('delete-all counts an event as processed on banevent success alone (no kind-5)', async () => {
    // Admin deletion is NIP-86 banevent only; there is no kind-5 publish, so a
    // delete that bans successfully is processed with no failures.
    mockRelay([{ id: 'e'.repeat(64), kind: 1, content: '', tags: [] }]);
    mockUserVideos([]);

    const result = await runBulkModeration(mockEnv, 'a'.repeat(64), 'delete-all', 'r');
    expect(result.eventsProcessed).toBe(1);
    expect(result.failures).toEqual([]);
    expect(result.success).toBe(true);
    expect(vi.mocked(banEvent)).toHaveBeenCalledWith('e'.repeat(64), 'r', mockEnv, 'delete_event');
  });

  it('a failing decision-log batch (non-critical) does not abort an otherwise-successful delete-all', async () => {
    // The relay deletes already happened; a D1 audit failure must log-and-continue,
    // not throw and mislabel a completed destructive run as failed (AGENTS.md).
    mockRelay([{ id: 'e'.repeat(64), kind: 1, content: '', tags: [] }]);
    mockUserVideos([{ sha256: hashA }]);
    (mockEnv.DB as unknown as { batch: ReturnType<typeof vi.fn> }).batch = vi.fn().mockRejectedValue(new Error('d1 down'));

    const result = await runBulkModeration(mockEnv, 'a'.repeat(64), 'delete-all', 'r');
    expect(result.eventsProcessed).toBe(1); // event still deleted
    expect(result.mediaProcessed).toBe(1);
    expect(result.failures).toEqual([]); // audit failure not surfaced as a moderation failure
  });
});

describe('async bulk job model', () => {
  let mockEnv: BulkModerateEnv;
  let jobDb: ReturnType<typeof makeJobDb>;
  let sent: BulkJobMessage[];

  beforeEach(() => {
    vi.restoreAllMocks();
    mockUserVideos([{ sha256: hashA }, { sha256: hashB }]);
    jobDb = makeJobDb();
    sent = [];
    mockEnv = {
      ...baseEnv(),
      DB: jobDb.db,
      BULK_QUEUE: { send: vi.fn(async (m: BulkJobMessage) => { sent.push(m); }) } as unknown as Queue<BulkJobMessage>,
    };
  });

  function enqueueReq(body: object): Request {
    return new Request('https://test/api/bulk-moderate', { method: 'POST', body: JSON.stringify(body) });
  }

  it('enqueue inserts a pending job, sends a queue message, and returns the jobId', async () => {
    const res = await handleBulkModerateEnqueue(enqueueReq({ pubkey: 'a'.repeat(64), action: 'age-restrict-all' }), mockEnv, {});
    expect(res.status).toBe(200);
    const body = await res.json() as BulkEnqueueResponse;
    expect(body.jobId).toMatch(/^[0-9a-f-]{36}$/);

    expect(jobDb.rows.get(body.jobId)?.status).toBe('pending'); // row created, not yet run
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ jobId: body.jobId, pubkey: 'a'.repeat(64), action: 'age-restrict-all', version: 0 });
  });

  it('enqueue validates the action/pubkey and does NOT enqueue on a bad request', async () => {
    const bad = await handleBulkModerateEnqueue(enqueueReq({ pubkey: 'short', action: 'age-restrict-all' }), mockEnv, {});
    expect(bad.status).toBe(400);
    const badAction = await handleBulkModerateEnqueue(enqueueReq({ pubkey: 'a'.repeat(64), action: 'nope' }), mockEnv, {});
    expect(badAction.status).toBe(400);
    expect(sent).toHaveLength(0);
  });

  it('enqueue returns 400 (not 500) on malformed or non-object JSON body', async () => {
    const notJson = new Request('https://test/api/bulk-moderate', { method: 'POST', body: 'not json' });
    expect((await handleBulkModerateEnqueue(notJson, mockEnv, {})).status).toBe(400);
    const arrayBody = new Request('https://test/api/bulk-moderate', { method: 'POST', body: JSON.stringify([]) });
    expect((await handleBulkModerateEnqueue(arrayBody, mockEnv, {})).status).toBe(400);
    expect(sent).toHaveLength(0);
  });

  it('a redelivered message for a terminal job is a no-op (status stays sticky, no re-enqueue)', async () => {
    const jobId = 'job-dup-1';
    jobDb.rows.set(jobId, { job_id: jobId, pubkey: 'a'.repeat(64), action: 'age-restrict-all', status: 'done', events_processed: 0, media_processed: 2, failures: '[]', failures_dropped: 0, created_at: 't', updated_at: 't' });

    await processBulkJob({ jobId, pubkey: 'a'.repeat(64), action: 'age-restrict-all', phase: 'media' }, mockEnv);

    expect(jobDb.rows.get(jobId)!.status).toBe('done'); // not flipped back to running
    expect(sent).toHaveLength(0);                       // no forked continuation
  });

  it('media phase fails closed past the page bound even when the cursor keeps advancing', async () => {
    // A cursor that advances forever (A->B->C...) while moderation may be failing
    // must terminate on PAGES fetched, not on successful moderations. Arriving at
    // the last allowed page with more still to come throws.
    vi.spyOn(globalThis, 'fetch').mockImplementation((async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.pathname.includes('/api/v2/users/') && url.pathname.includes('/videos')) {
        const cursor = url.searchParams.get('cursor') ?? '0';
        const nextCursor = `c${Number(cursor.replace('c', '')) + 1}`; // always advances
        return new Response(JSON.stringify({ data: [{ sha256: hashA }], pagination: { next_cursor: nextCursor, has_more: true } }), { status: 200 });
      }
      return new Response('not found', { status: 404 });
    }) as typeof fetch);
    const jobId = 'job-runaway-1';
    jobDb.rows.set(jobId, { job_id: jobId, pubkey: 'a'.repeat(64), action: 'age-restrict-all', status: 'running', events_processed: 0, media_processed: 0, failures: '[]', failures_dropped: 0, created_at: 't', updated_at: 't' });

    // Start one page below the bound so a single chunk trips it.
    await processBulkJob({ jobId, pubkey: 'a'.repeat(64), action: 'age-restrict-all', phase: 'media', cursor: 'c0', mediaPage: VIDEO_MAX_PAGES - 1 }, mockEnv);

    const row = jobDb.rows.get(jobId)!;
    expect(row.status).toBe('failed');
    expect(JSON.parse(row.failures as string).some((f: string) => /exceeded .* pages/.test(f))).toBe(true);
    expect(sent).toHaveLength(0); // did not enqueue another runaway chunk
  });

  it('cumulative dropped-failure count survives across chunks and a clean final chunk', async () => {
    // 250 videos that all fail to moderate => 250 failures across 3 chunks. The
    // stored list caps at 50; the overflow must accumulate in its own count and a
    // final clean (empty) page must not erase it.
    const many = Array.from({ length: 250 }, (_, i) => ({ sha256: i.toString(16).padStart(64, '0') }));
    mockUserVideos(many);
    (mockEnv.MODERATION_API as unknown as { fetch: ReturnType<typeof vi.fn> }).fetch =
      vi.fn().mockResolvedValue(new Response('nope', { status: 500 })); // every moderate call fails
    const jobId = 'job-overflow-1';
    jobDb.rows.set(jobId, { job_id: jobId, pubkey: 'a'.repeat(64), action: 'age-restrict-all', status: 'pending', events_processed: 0, media_processed: 0, failures: '[]', failures_dropped: 0, created_at: 't', updated_at: 't' });

    let msg: BulkJobMessage | undefined = { jobId, pubkey: 'a'.repeat(64), action: 'age-restrict-all' };
    let iterations = 0;
    while (msg && iterations++ < 10) { sent.length = 0; await processBulkJob(msg, mockEnv); msg = sent[0]; }

    const res = await handleBulkJobStatus(jobId, mockEnv, {});
    const job = await res.json() as BulkJob;
    expect(job.status).toBe('done');
    expect(job.failures).toHaveLength(51);                       // 50 stored + 1 marker
    expect(job.failures[50]).toBe('+200 more');                  // 250 total - 50 stored, not erased
  });

  it('media-only job chunks across multiple messages until done', async () => {
    // 250 videos => pages of 100/100/50 across 3 messages. Proves chunking: the
    // all-in-one consumer would finish in a single message.
    const many = Array.from({ length: 250 }, (_, i) => ({ sha256: i.toString(16).padStart(64, '0') }));
    mockUserVideos(many);
    const jobId = 'job-chunk-1';
    jobDb.rows.set(jobId, { job_id: jobId, pubkey: 'a'.repeat(64), action: 'age-restrict-all', status: 'pending', events_processed: 0, media_processed: 0, failures: '[]', created_at: 't', updated_at: 't' });

    let msg: BulkJobMessage | undefined = { jobId, pubkey: 'a'.repeat(64), action: 'age-restrict-all' };
    let iterations = 0;
    while (msg && iterations++ < 10) { sent.length = 0; await processBulkJob(msg, mockEnv); msg = sent[0]; }

    expect(iterations).toBe(3); // chunked across 3 messages
    const row = jobDb.rows.get(jobId)!;
    expect(row.status).toBe('done');
    expect(row.media_processed).toBe(250);
    expect(moderationActionFor(mockEnv, '0'.padStart(64, '0'))).toBe('QUARANTINE');
  });

  it('delete-all transitions events -> media across messages and finishes', async () => {
    vi.mocked(banEvent).mockResolvedValue({ success: true });
    vi.mocked(banEvent).mockClear();
    mockPaginatedRelay(Array.from({ length: 30 }, (_, i) => ({ id: `e${i}`, kind: 1, content: '', tags: [] as string[][], created_at: 30 - i })));
    mockUserVideos([{ sha256: 'a'.repeat(64) }]);
    const jobId = 'job-del-1';
    jobDb.rows.set(jobId, { job_id: jobId, pubkey: 'a'.repeat(64), action: 'delete-all', status: 'pending', events_processed: 0, media_processed: 0, failures: '[]', created_at: 't', updated_at: 't' });

    await processBulkJob({ jobId, pubkey: 'a'.repeat(64), action: 'delete-all' }, mockEnv);
    expect(vi.mocked(banEvent)).toHaveBeenCalledTimes(20);
    expect(sent[0]?.eventIds).toHaveLength(10);

    let msg: BulkJobMessage | undefined = sent[0];
    let iterations = 1;
    while (msg && iterations++ < 10) { sent.length = 0; await processBulkJob(msg, mockEnv); msg = sent[0]; }

    expect(iterations).toBe(3); // two bounded event batches -> media chunk
    const row = jobDb.rows.get(jobId)!;
    expect(row.status).toBe('done');
    expect(row.events_processed).toBe(30);
    expect(row.media_processed).toBe(1);
  });

  it('stops between concurrency waves when the event budget is exhausted', async () => {
    let now = 1_000;
    const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => now);
    vi.mocked(banEvent).mockImplementation(async () => {
      now += 5 * 60 * 1000;
      return { success: true };
    });
    vi.mocked(banEvent).mockClear();
    mockPaginatedRelay(Array.from({ length: 30 }, (_, i) => ({ id: `budget-${i}`, kind: 1, content: '', tags: [] as string[][], created_at: 30 - i })));
    const jobId = 'job-event-budget';
    jobDb.rows.set(jobId, { job_id: jobId, pubkey: 'a'.repeat(64), action: 'delete-all', status: 'pending', events_processed: 0, media_processed: 0, failures: '[]', failures_dropped: 0, version: 0, created_at: 't', updated_at: 't' });

    try {
      await processBulkJob({ jobId, pubkey: 'a'.repeat(64), action: 'delete-all' }, mockEnv);
    } finally {
      nowSpy.mockRestore();
    }

    expect(vi.mocked(banEvent)).toHaveBeenCalledTimes(5);
    expect(sent[0]?.eventIds).toHaveLength(25);
    expect(jobDb.rows.get(jobId)?.events_processed).toBe(5);
  });

  it('processBulkJob runs the work and writes status=done with counts', async () => {
    const jobId = 'job-done-1';
    jobDb.rows.set(jobId, { job_id: jobId, pubkey: 'a'.repeat(64), action: 'age-restrict-all', status: 'pending', events_processed: 0, media_processed: 0, failures: '[]', created_at: 't', updated_at: 't' });

    await processBulkJob({ jobId, pubkey: 'a'.repeat(64), action: 'age-restrict-all' }, mockEnv);

    const row = jobDb.rows.get(jobId)!;
    expect(row.status).toBe('done');
    expect(row.media_processed).toBe(2); // hashA + hashB, both from REST
    // Parity with the synchronous path: media-only actions count one event per
    // video so the UI's "across N events" stays meaningful (not 0).
    expect(row.events_processed).toBe(2);
    expect(moderationActionFor(mockEnv, hashA)).toBe('QUARANTINE');
  });

  it('delete-all surfaces saturation when one second holds more events than a chunk', async () => {
    // 250 events all at one created_at: a chunk takes 200, the rest at that second
    // cannot be reached by an `until` cursor. The job must complete but RECORD the
    // gap, not silently report success on a partial destructive delete.
    vi.mocked(banEvent).mockResolvedValue({ success: true });
    mockPaginatedRelay(Array.from({ length: 250 }, (_, i) => ({ id: `e${i}`, kind: 1, content: '', tags: [] as string[][], created_at: 1000 })));
    mockUserVideos([{ sha256: hashA }]);
    const jobId = 'job-sat-1';
    jobDb.rows.set(jobId, { job_id: jobId, pubkey: 'a'.repeat(64), action: 'delete-all', status: 'pending', events_processed: 0, media_processed: 0, failures: '[]', created_at: 't', updated_at: 't' });

    let msg: BulkJobMessage | undefined = { jobId, pubkey: 'a'.repeat(64), action: 'delete-all' };
    let iterations = 0;
    while (msg && iterations++ < 20) { sent.length = 0; await processBulkJob(msg, mockEnv); msg = sent[0]; }

    const row = jobDb.rows.get(jobId)!;
    expect(row.status).toBe('done');
    expect(row.events_processed).toBe(200);                 // one chunk's worth; the rest unreachable
    expect(iterations).toBe(12);                            // ten event batches + empty cursor check + media
    expect(JSON.parse(row.failures as string).some((f: string) => /share one timestamp/.test(f))).toBe(true);
  });

  it('claims each chunk version once so duplicate deliveries cannot fork progress', async () => {
    vi.mocked(banEvent).mockResolvedValue({ success: true });
    vi.mocked(banEvent).mockClear();
    mockPaginatedRelay(Array.from({ length: 2 }, (_, i) => ({ id: `dup${i}`, kind: 1, content: '', tags: [] as string[][], created_at: 2 - i })));
    const jobId = 'job-duplicate-chunk';
    jobDb.rows.set(jobId, { job_id: jobId, pubkey: 'a'.repeat(64), action: 'delete-all', status: 'pending', events_processed: 0, media_processed: 0, failures: '[]', failures_dropped: 0, version: 0, created_at: 't', updated_at: 't' });
    const message: BulkJobMessage = { jobId, pubkey: 'a'.repeat(64), action: 'delete-all', version: 0 };

    await processBulkJob(message, mockEnv);
    const firstContinuation = sent[0];
    await processBulkJob(message, mockEnv);

    expect(vi.mocked(banEvent)).toHaveBeenCalledTimes(2);
    expect(sent).toEqual([firstContinuation]);
    expect(jobDb.rows.get(jobId)?.version).toBe(1);
    expect(firstContinuation.version).toBe(1);
  });

  it('does not fail a job when the delivery never acquired its version claim', async () => {
    const jobId = 'job-unclaimed-error';
    jobDb.rows.set(jobId, { job_id: jobId, pubkey: 'a'.repeat(64), action: 'delete-all', status: 'pending', events_processed: 0, media_processed: 0, failures: '[]', failures_dropped: 0, version: 0, created_at: 't', updated_at: 't' });
    const prepare = jobDb.db.prepare.bind(jobDb.db);
    const db = {
      prepare(sql: string) {
        const statement = prepare(sql);
        if (/UPDATE bulk_jobs SET status = \?, updated_at = \?, version = version \+ 1/i.test(sql)) {
          return {
            bind: (..._args: unknown[]) => ({
              run: async () => { throw new Error('claim transport failed'); },
            }),
          };
        }
        return statement;
      },
    } as unknown as D1Database;
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await processBulkJob(
      { jobId, pubkey: 'a'.repeat(64), action: 'delete-all', version: 0 },
      { ...mockEnv, DB: db },
    );

    expect(jobDb.rows.get(jobId)?.status).toBe('pending');
    expect(jobDb.rows.get(jobId)?.version).toBe(0);
    expect(errorSpy).toHaveBeenCalledWith('[bulk-job] failed before claiming chunk', jobId, expect.any(Error));
  });

  it('media phase fails closed when the funnelcake cursor never advances (repeats)', async () => {
    // A cursor that returns the same value forever would re-enqueue indefinitely
    // and never be stale-healed (each chunk refreshes updated_at). It must fail
    // closed, not churn the queue.
    vi.spyOn(globalThis, 'fetch').mockImplementation((async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.pathname.includes('/api/v2/users/') && url.pathname.includes('/videos')) {
        return new Response(JSON.stringify({ data: [{ sha256: hashA }], pagination: { next_cursor: 'STUCK', has_more: true } }), { status: 200 });
      }
      return new Response('not found', { status: 404 });
    }) as typeof fetch);
    const jobId = 'job-stuck-1';
    jobDb.rows.set(jobId, { job_id: jobId, pubkey: 'a'.repeat(64), action: 'age-restrict-all', status: 'pending', events_processed: 0, media_processed: 0, failures: '[]', created_at: 't', updated_at: 't' });

    let msg: BulkJobMessage | undefined = { jobId, pubkey: 'a'.repeat(64), action: 'age-restrict-all' };
    let iterations = 0;
    while (msg && iterations++ < 10) { sent.length = 0; await processBulkJob(msg, mockEnv); msg = sent[0]; }

    expect(iterations).toBeLessThan(10);                    // did not loop to the guard
    const row = jobDb.rows.get(jobId)!;
    expect(row.status).toBe('failed');
    expect(JSON.parse(row.failures as string).some((f: string) => /did not advance/.test(f))).toBe(true);
  });

  it('status returns the job as a BulkJob, and 404 when the job is unknown', async () => {
    jobDb.rows.set('job-2', { job_id: 'job-2', pubkey: 'a'.repeat(64), action: 'delete-all', status: 'done', events_processed: 3, media_processed: 5, failures: '["media:x:boom"]', created_at: 't1', updated_at: 't2' });

    const ok = await handleBulkJobStatus('job-2', mockEnv, {});
    expect(ok.status).toBe(200);
    const job = await ok.json() as BulkJob;
    expect(job).toMatchObject({ jobId: 'job-2', status: 'done', eventsProcessed: 3, mediaProcessed: 5, failures: ['media:x:boom'] });

    const missing = await handleBulkJobStatus('nope', mockEnv, {});
    expect(missing.status).toBe(404);
  });

  it('age-restrict-all fails closed when the videos REST call errors (no false success)', async () => {
    // A failed enumeration must NOT report a successful withhold; queryUserMediaHashes
    // throws so the job fails rather than reporting success.
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('err', { status: 500 }));
    await expect(runBulkModeration(mockEnv, 'a'.repeat(64), 'age-restrict-all', 'r')).rejects.toThrow(/Video query failed: 500/);
    expect(vi.mocked((mockEnv.MODERATION_API as unknown as { fetch: ReturnType<typeof vi.fn> }).fetch)).not.toHaveBeenCalled();
  });

  it('delete-all fails closed when the videos REST call errors (no events banned)', async () => {
    vi.mocked(banEvent).mockClear(); // call history accumulates across tests
    mockRelay([{ id: 'e'.repeat(64), kind: 34235, content: '', tags: [] }]);
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('err', { status: 500 }));
    await expect(runBulkModeration(mockEnv, 'a'.repeat(64), 'delete-all', 'r')).rejects.toThrow(/Video query failed: 500/);
    expect(vi.mocked(banEvent)).not.toHaveBeenCalled();
  });

  it('processBulkJob records status=failed (not stranded) when the run throws', async () => {
    const jobId = 'job-fail-1';
    jobDb.rows.set(jobId, { job_id: jobId, pubkey: 'a'.repeat(64), action: 'age-restrict-all', status: 'pending', events_processed: 0, media_processed: 0, failures: '[]', created_at: 't', updated_at: 't' });
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('err', { status: 500 })); // enumeration throws

    await processBulkJob({ jobId, pubkey: 'a'.repeat(64), action: 'age-restrict-all' }, mockEnv);

    const row = jobDb.rows.get(jobId)!;
    expect(row.status).toBe('failed');
    expect(JSON.parse(row.failures as string)[0]).toMatch(/Video query failed: 500/);
  });

  it('status self-heals a stale running job to failed so the poller never hangs', async () => {
    const old = new Date(Date.now() - 31 * 60 * 1000).toISOString();
    jobDb.rows.set('job-stale', { job_id: 'job-stale', pubkey: 'a'.repeat(64), action: 'delete-all', status: 'running', events_processed: 0, media_processed: 0, failures: '[]', created_at: old, updated_at: old });

    const res = await handleBulkJobStatus('job-stale', mockEnv, {});
    const job = await res.json() as BulkJob;
    expect(job.status).toBe('failed');
    expect(job.failures[0]).toMatch(/abandoned/);
    expect(jobDb.rows.get('job-stale')!.status).toBe('failed'); // healed in the row, not just the response
  });

  it('status does NOT heal a recently-updated running job', async () => {
    const now = new Date().toISOString();
    jobDb.rows.set('job-live', { job_id: 'job-live', pubkey: 'a'.repeat(64), action: 'delete-all', status: 'running', events_processed: 0, media_processed: 0, failures: '[]', created_at: now, updated_at: now });

    const res = await handleBulkJobStatus('job-live', mockEnv, {});
    expect((await res.json() as BulkJob).status).toBe('running');
  });

  it('enqueue rolls back the pending row and 500s when the queue send fails', async () => {
    (mockEnv.BULK_QUEUE as unknown as { send: ReturnType<typeof vi.fn> }).send = vi.fn().mockRejectedValue(new Error('queue down'));

    const res = await handleBulkModerateEnqueue(enqueueReq({ pubkey: 'a'.repeat(64), action: 'age-restrict-all' }), mockEnv, {});
    expect(res.status).toBe(500);
    expect([...jobDb.rows.values()].some((r) => r.status === 'pending')).toBe(false); // no orphan row
  });
});

describe('kind-scoped delete job', () => {
  const PUBKEY = 'a'.repeat(64);
  const MODERATOR = 'd'.repeat(64);
  const REPORT_ID = 'e'.repeat(64);
  let mockEnv: BulkModerateEnv;
  let jobDb: ReturnType<typeof makeJobDb>;
  let sent: BulkJobMessage[];

  beforeEach(() => {
    vi.restoreAllMocks();
    vi.mocked(getAdminPubkey).mockResolvedValue('moderator-pubkey');
    vi.mocked(banEvent).mockReset().mockResolvedValue({ success: true });
    vi.mocked(syncZendeskAfterAction).mockClear();
    mockUserVideos([{ sha256: hashA }]);
    jobDb = makeJobDb();
    sent = [];
    mockEnv = {
      ...baseEnv(),
      DB: jobDb.db,
      BULK_QUEUE: { send: vi.fn(async (m: BulkJobMessage) => { sent.push(m); }) } as unknown as Queue<BulkJobMessage>,
    };
  });

  function enqueueReq(body: object): Request {
    return new Request('https://test/api/bulk-moderate', { method: 'POST', body: JSON.stringify(body) });
  }

  async function drain(first: BulkJobMessage, max = 20): Promise<{ iterations: number; messages: BulkJobMessage[] }> {
    const messages: BulkJobMessage[] = [];
    let msg: BulkJobMessage | undefined = first;
    let iterations = 0;
    while (msg && iterations++ < max) {
      sent.length = 0;
      await processBulkJob(msg, mockEnv);
      msg = sent[0];
      if (msg) messages.push(msg);
    }
    return { iterations, messages };
  }

  // 30 kind-1 notes interleaved with 30 kind-7 reactions, one per second.
  function mixedEvents() {
    return Array.from({ length: 60 }, (_, i) => ({
      id: `${i % 2 === 0 ? 'note' : 'react'}${i}`,
      kind: i % 2 === 0 ? 1 : 7,
      content: '',
      tags: [] as string[][],
      created_at: 60 - i,
    }));
  }

  it('enqueue stores the kind on the job row and the queue message', async () => {
    const res = await handleBulkModerateEnqueue(enqueueReq({ pubkey: PUBKEY, action: 'delete-kind', kind: 34236 }), mockEnv, {});
    expect(res.status).toBe(200);
    const { jobId } = await res.json() as BulkEnqueueResponse;
    expect(jobDb.rows.get(jobId)?.kind).toBe(34236);
    expect(sent[0]).toMatchObject({ kindJobId: jobId, action: 'delete-kind', kind: 34236 });
  });

  it('enqueue accepts kind 0', async () => {
    const res = await handleBulkModerateEnqueue(enqueueReq({ pubkey: PUBKEY, action: 'delete-kind', kind: 0 }), mockEnv, {});
    expect(res.status).toBe(200);
    expect(sent[0].kind).toBe(0);
  });

  it.each([
    ['negative', -1],
    ['fractional', 1.5],
    ['string', '1'],
    ['null', null],
    ['unsafe integer', 2 ** 53],
    ['object', { kind: 1 }],
  ])('enqueue rejects a %s kind with a 400 and enqueues nothing', async (_label, kind) => {
    const res = await handleBulkModerateEnqueue(enqueueReq({ pubkey: PUBKEY, action: 'delete-kind', kind }), mockEnv, {});
    expect(res.status).toBe(400);
    expect(sent).toHaveLength(0);
    expect(jobDb.rows.size).toBe(0);
  });

  it('enqueue rejects a kind on a non-delete action instead of widening it to every video', async () => {
    const res = await handleBulkModerateEnqueue(enqueueReq({ pubkey: PUBKEY, action: 'age-restrict-all', kind: 1 }), mockEnv, {});
    expect(res.status).toBe(400);
    expect(sent).toHaveLength(0);
  });

  // A kind-scoped delete is its own action so a worker without it refuses the
  // request at enqueue. delete-all keeps no kind field at all.
  it('enqueue rejects a kind on delete-all', async () => {
    const res = await handleBulkModerateEnqueue(enqueueReq({ pubkey: PUBKEY, action: 'delete-all', kind: 1 }), mockEnv, {});
    expect(res.status).toBe(400);
    expect(sent).toHaveLength(0);
    expect(jobDb.rows.size).toBe(0);
  });

  it('enqueue rejects delete-kind without a kind', async () => {
    const res = await handleBulkModerateEnqueue(enqueueReq({ pubkey: PUBKEY, action: 'delete-kind' }), mockEnv, {});
    expect(res.status).toBe(400);
    expect(sent).toHaveLength(0);
    expect(jobDb.rows.size).toBe(0);
  });

  it('enqueue rejects an unknown action', async () => {
    const res = await handleBulkModerateEnqueue(enqueueReq({ pubkey: PUBKEY, action: 'delete-some', kind: 1 }), mockEnv, {});
    expect(res.status).toBe(400);
    expect(sent).toHaveLength(0);
  });

  it('fails a delete-kind message that lost its kind instead of deleting every event', async () => {
    mockPaginatedRelay(mixedEvents());
    const jobId = 'job-kindless';
    jobDb.rows.set(jobId, { job_id: jobId, pubkey: PUBKEY, action: 'delete-kind', status: 'pending', events_processed: 0, media_processed: 0, failures: '[]', failures_dropped: 0, version: 0, created_at: 't', updated_at: 't', kind: 1 });

    await drain({ kindJobId: jobId, pubkey: PUBKEY, action: 'delete-kind', version: 0 });

    expect(vi.mocked(banEvent)).not.toHaveBeenCalled();
    const row = jobDb.rows.get(jobId)!;
    expect(row.status).toBe('failed');
    expect(JSON.parse(row.failures as string).some((f: string) => /delete-kind .*without a kind/.test(f))).toBe(true);
  });

  it('fails a delete-kind message routed to the media phase instead of touching media', async () => {
    const jobId = 'job-kind-media';
    jobDb.rows.set(jobId, { job_id: jobId, pubkey: PUBKEY, action: 'delete-kind', status: 'running', events_processed: 0, media_processed: 0, failures: '[]', failures_dropped: 0, version: 0, created_at: 't', updated_at: 't', kind: 1 });

    await drain({ kindJobId: jobId, pubkey: PUBKEY, action: 'delete-kind', kind: 1, phase: 'media', version: 0 });

    const moderateFetch = (mockEnv.MODERATION_API as unknown as { fetch: ReturnType<typeof vi.fn> }).fetch;
    expect(moderateFetch).not.toHaveBeenCalled();
    const row = jobDb.rows.get(jobId)!;
    expect(row.status).toBe('failed');
    expect(JSON.parse(row.failures as string).some((f: string) => /delete-kind has no media phase/.test(f))).toBe(true);
  });

  it('delete-all without a kind is unchanged: no kind on the row, the message, or the relay filter', async () => {
    const res = await handleBulkModerateEnqueue(enqueueReq({ pubkey: PUBKEY, action: 'delete-all' }), mockEnv, {});
    const { jobId } = await res.json() as BulkEnqueueResponse;
    expect(jobDb.rows.get(jobId)?.kind).toBeNull();
    expect('kind' in sent[0]).toBe(false);

    const { filters } = mockPaginatedRelay(mixedEvents());
    const { messages } = await drain(sent[0]);
    expect(filters.every((f) => !('kinds' in f))).toBe(true);
    expect(messages.every((m) => !('kind' in m))).toBe(true);
    const row = jobDb.rows.get(jobId)!;
    expect(row.status).toBe('done');
    expect(row.events_processed).toBe(60);        // every kind
    expect(row.media_processed).toBe(1);          // media phase still runs
    expect(vi.mocked(syncZendeskAfterAction)).toHaveBeenCalledWith(mockEnv, 'delete_event', 'pubkey', PUBKEY, 'moderator-pubkey');
  });

  // A consumer from before delete-kind looks a job up by msg.jobId. delete-kind
  // messages never carry one, so that lookup fails inside its try before any
  // relay or media call. delete-all keeps today's shape for jobs already queued.
  it('carries a delete-kind job id as kindJobId, never jobId, on every message', async () => {
    mockPaginatedRelay(mixedEvents());
    const res = await handleBulkModerateEnqueue(enqueueReq({ pubkey: PUBKEY, action: 'delete-kind', kind: 1 }), mockEnv, {});
    const { jobId } = await res.json() as BulkEnqueueResponse;
    const first = sent[0];

    const { messages } = await drain(first);

    expect(messages.length).toBeGreaterThan(0);
    for (const m of [first, ...messages]) {
      expect('jobId' in m).toBe(false);
      expect(m.kindJobId).toBe(jobId);
    }
  });

  it('keeps the jobId shape for delete-all on every message', async () => {
    mockPaginatedRelay(mixedEvents());
    const res = await handleBulkModerateEnqueue(enqueueReq({ pubkey: PUBKEY, action: 'delete-all' }), mockEnv, {});
    const { jobId } = await res.json() as BulkEnqueueResponse;
    const first = sent[0];

    const { messages } = await drain(first);

    expect(messages.some((m) => m.phase === 'media')).toBe(true);
    for (const m of [first, ...messages]) {
      expect('kindJobId' in m).toBe(false);
      expect(m.jobId).toBe(jobId);
    }
  });

  it('drains a delete-all job queued by the worker from before this change', async () => {
    // Exactly what c190582's enqueue sends, against a row from its schema (no kind column).
    mockPaginatedRelay(mixedEvents());
    const jobId = 'pre-deploy-job';
    jobDb.rows.set(jobId, { job_id: jobId, pubkey: PUBKEY, action: 'delete-all', status: 'pending', events_processed: 0, media_processed: 0, failures: '[]', failures_dropped: 0, version: 0, created_at: 't', updated_at: 't' });

    await drain({ jobId, pubkey: PUBKEY, action: 'delete-all', reason: 'Bulk delete-all by moderator', version: 0 });

    const row = jobDb.rows.get(jobId)!;
    expect(row.status).toBe('done');
    expect(row.events_processed).toBe(60);
    expect(row.media_processed).toBe(1);
  });

  it('resumes a delete-all continuation queued by the worker from before this change', async () => {
    mockPaginatedRelay(mixedEvents());
    const jobId = 'pre-deploy-continuation';
    jobDb.rows.set(jobId, { job_id: jobId, pubkey: PUBKEY, action: 'delete-all', status: 'running', events_processed: 20, media_processed: 0, failures: '[]', failures_dropped: 0, version: 1, created_at: 't', updated_at: 't' });

    await drain({
      jobId, pubkey: PUBKEY, action: 'delete-all', reason: 'Bulk delete-all by moderator',
      phase: 'events', eventIds: ['note0', 'react1'], version: 1,
    });

    const row = jobDb.rows.get(jobId)!;
    expect(row.status).toBe('done');
    expect(vi.mocked(banEvent).mock.calls.map((c) => c[0])).toEqual(expect.arrayContaining(['note0', 'react1']));
    expect(row.media_processed).toBe(1);
  });

  it('deletes only events of the kind, across pages, carrying the kind on every continuation', async () => {
    const { filters } = mockPaginatedRelay(mixedEvents());
    const res = await handleBulkModerateEnqueue(enqueueReq({ pubkey: PUBKEY, action: 'delete-kind', kind: 1 }), mockEnv, {});
    const { jobId } = await res.json() as BulkEnqueueResponse;

    const { messages } = await drain(sent[0]);

    expect(filters.length).toBeGreaterThan(0);
    expect(filters.every((f) => JSON.stringify(f.kinds) === '[1]')).toBe(true);
    expect(messages.length).toBeGreaterThan(0);               // more than one chunk
    expect(messages.every((m) => m.kind === 1)).toBe(true);   // resumable with the kind
    const banned = vi.mocked(banEvent).mock.calls.map((c) => c[0]);
    expect(banned).toHaveLength(30);
    expect(banned.every((id) => id.startsWith('note'))).toBe(true);
    const row = jobDb.rows.get(jobId)!;
    expect(row.status).toBe('done');
    expect(row.events_processed).toBe(30);
    expect(JSON.parse(row.failures as string)).toEqual([]);
  });

  it('pages a kind past one relay page using the until cursor', async () => {
    // 450 kind-1 events (more than two relay pages) interleaved with 450 kind-7
    // events, all at distinct seconds.
    const many = Array.from({ length: 900 }, (_, i) => ({ id: `n${i}`, kind: i % 2 === 0 ? 1 : 7, content: '', tags: [] as string[][], created_at: 900 - i }));
    const { filters } = mockPaginatedRelay(many);
    const jobId = 'job-kind-pages';
    jobDb.rows.set(jobId, { job_id: jobId, pubkey: PUBKEY, action: 'delete-kind', status: 'pending', events_processed: 0, media_processed: 0, failures: '[]', failures_dropped: 0, version: 0, created_at: 't', updated_at: 't', kind: 1 });

    await drain({ kindJobId: jobId, pubkey: PUBKEY, action: 'delete-kind', kind: 1, version: 0 }, 60);

    expect(filters.some((f) => typeof f.until === 'number')).toBe(true);
    expect(filters.every((f) => JSON.stringify(f.kinds) === '[1]')).toBe(true);
    expect(jobDb.rows.get(jobId)!.events_processed).toBe(450);
    expect(jobDb.rows.get(jobId)!.status).toBe('done');
  });

  it('does not touch media or resolve account-level tickets for a kind-scoped delete', async () => {
    mockPaginatedRelay(mixedEvents());
    const res = await handleBulkModerateEnqueue(enqueueReq({ pubkey: PUBKEY, action: 'delete-kind', kind: 7 }), mockEnv, {});
    const { jobId } = await res.json() as BulkEnqueueResponse;

    const { messages } = await drain(sent[0]);

    expect(messages.every((m) => m.phase !== 'media')).toBe(true);
    const fetchCalls = vi.mocked(globalThis.fetch).mock.calls.map((c) => String(c[0]));
    expect(fetchCalls.some((u) => u.includes('/videos'))).toBe(false);
    const moderateFetch = (mockEnv.MODERATION_API as unknown as { fetch: ReturnType<typeof vi.fn> }).fetch;
    expect(moderateFetch).not.toHaveBeenCalled();
    expect(vi.mocked(syncZendeskAfterAction)).not.toHaveBeenCalledWith(mockEnv, 'delete_event', 'pubkey', PUBKEY, expect.anything());
    const row = jobDb.rows.get(jobId)!;
    expect(row.status).toBe('done');
    expect(row.events_processed).toBe(30);
    expect(row.media_processed).toBe(0);
  });

  it('records a cut-short listing as a failure, so the job never reads as complete', async () => {
    // A full page with no usable created_at: the cursor cannot advance.
    const noTimes = Array.from({ length: 200 }, (_, i) => ({ id: `x${i}`, kind: 1, content: '', tags: [] as string[][] }));
    vi.spyOn(globalThis, 'WebSocket').mockImplementation((function () {
      const listeners = new Map<string, Array<(value?: unknown) => void>>();
      const emit = (type: string, value?: unknown) => listeners.get(type)?.forEach((h) => h(value));
      queueMicrotask(() => emit('open'));
      return {
        addEventListener: (t: string, h: (value?: unknown) => void) => listeners.set(t, [...(listeners.get(t) || []), h]),
        send: (payload: string) => {
          const data = JSON.parse(payload);
          if (data[0] !== 'REQ') return;
          queueMicrotask(() => {
            for (const ev of noTimes) emit('message', { data: JSON.stringify(['EVENT', data[1], ev]) });
            emit('message', { data: JSON.stringify(['EOSE', data[1]]) });
          });
        },
        close: vi.fn(),
      };
    } as unknown as typeof WebSocket));
    const jobId = 'job-kind-cut';
    jobDb.rows.set(jobId, { job_id: jobId, pubkey: PUBKEY, action: 'delete-kind', status: 'pending', events_processed: 0, media_processed: 0, failures: '[]', failures_dropped: 0, version: 0, created_at: 't', updated_at: 't', kind: 1 });

    await drain({ kindJobId: jobId, pubkey: PUBKEY, action: 'delete-kind', kind: 1, version: 0 }, 30);

    const res = await handleBulkJobStatus(jobId, mockEnv, {});
    const job = await res.json() as BulkJob;
    expect(job.status).toBe('done');
    expect(job.failures.some((f) => /could not be fully paginated/.test(f))).toBe(true);
  });

  it('status reports the kind for a kind-scoped job and omits it otherwise', async () => {
    jobDb.rows.set('job-k', { job_id: 'job-k', pubkey: PUBKEY, action: 'delete-kind', status: 'running', events_processed: 1, media_processed: 0, failures: '[]', failures_dropped: 0, version: 1, created_at: 't', updated_at: new Date().toISOString(), kind: 22 });
    jobDb.rows.set('job-all', { job_id: 'job-all', pubkey: PUBKEY, action: 'delete-all', status: 'running', events_processed: 1, media_processed: 0, failures: '[]', failures_dropped: 0, version: 1, created_at: 't', updated_at: new Date().toISOString(), kind: null });

    const kindJob = await (await handleBulkJobStatus('job-k', mockEnv, {})).json() as BulkJob;
    const allJob = await (await handleBulkJobStatus('job-all', mockEnv, {})).json() as BulkJob;

    expect(kindJob.kind).toBe(22);
    expect('kind' in allJob).toBe(false);
  });

  it('attributes decision rows to the requesting moderator and report', async () => {
    mockPaginatedRelay(mixedEvents().slice(0, 4));
    await handleBulkModerateEnqueue(enqueueReq({
      pubkey: PUBKEY, action: 'delete-kind', kind: 1, reason: 'spam', moderatorPubkey: MODERATOR, reportId: REPORT_ID,
    }), mockEnv, {});

    await drain(sent[0]);

    const decisionRows = jobDb.batched.filter((b) => /INSERT INTO moderation_decisions/.test(b.sql));
    expect(decisionRows).toHaveLength(2);
    for (const row of decisionRows) {
      expect(row.sql).toMatch(/report_id/);
      expect(row.binds).toEqual(['event', expect.stringMatching(/^note/), 'delete_event', 'spam', MODERATOR, REPORT_ID]);
    }
  });

  it('carries the moderator and report on every continuation', async () => {
    mockPaginatedRelay(mixedEvents());
    await handleBulkModerateEnqueue(enqueueReq({
      pubkey: PUBKEY, action: 'delete-kind', kind: 1, moderatorPubkey: MODERATOR, reportId: REPORT_ID,
    }), mockEnv, {});

    const { messages } = await drain(sent[0]);

    expect(messages.length).toBeGreaterThan(0);
    expect(messages.every((m) => m.moderatorPubkey === MODERATOR && m.reportId === REPORT_ID)).toBe(true);
    const decisionRows = jobDb.batched.filter((b) => /INSERT INTO moderation_decisions/.test(b.sql));
    expect(decisionRows).toHaveLength(30);
    expect(decisionRows.every((r) => r.binds[4] === MODERATOR && r.binds[5] === REPORT_ID)).toBe(true);
  });

  it('falls back to the worker signer with no report when the caller names no moderator', async () => {
    mockPaginatedRelay(mixedEvents().slice(0, 2));
    await handleBulkModerateEnqueue(enqueueReq({ pubkey: PUBKEY, action: 'delete-all' }), mockEnv, {});

    await drain(sent[0]);

    const decisionRows = jobDb.batched.filter((b) => /INSERT INTO moderation_decisions/.test(b.sql));
    expect(decisionRows.length).toBeGreaterThan(0);
    expect(decisionRows.every((r) => r.binds[4] === 'moderator-pubkey' && r.binds[5] === null)).toBe(true);
  });

  it.each([
    ['moderatorPubkey', { moderatorPubkey: 'not-hex' }],
    ['reportId', { reportId: 'not-hex' }],
  ])('enqueue rejects a malformed %s with a 400', async (_label, extra) => {
    const res = await handleBulkModerateEnqueue(enqueueReq({ pubkey: PUBKEY, action: 'delete-kind', kind: 1, ...extra }), mockEnv, {});
    expect(res.status).toBe(400);
    expect(sent).toHaveLength(0);
  });
});

describe('handleBulkKindCounts', () => {
  const PUBKEY = 'a'.repeat(64);
  beforeEach(() => vi.restoreAllMocks());

  it('counts every event by kind across pages and says the listing is complete', async () => {
    // 1200 events over three relay pages: 800 kind 1, 400 kind 7.
    const all = Array.from({ length: 1200 }, (_, i) => ({ id: `e${i}`, kind: i % 3 === 0 ? 7 : 1, content: '', tags: [] as string[][], created_at: 1200 - i }));
    const { filters } = mockPaginatedRelay(all);

    const res = await handleBulkKindCounts(PUBKEY, { RELAY_URL: 'wss://relay.test' }, {});

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ counts: { 1: 800, 7: 400 }, complete: true });
    expect(filters.length).toBeGreaterThan(1);
  });

  it('says the listing is incomplete when the relay cannot be fully paginated', async () => {
    const all = Array.from({ length: 600 }, (_, i) => ({ id: `e${i}`, kind: 1, content: '', tags: [] as string[][], created_at: 1000 }));
    mockPaginatedRelay(all);

    const res = await handleBulkKindCounts(PUBKEY, { RELAY_URL: 'wss://relay.test' }, {});

    const body = await res.json() as { counts: Record<string, number>; complete: boolean };
    expect(body.complete).toBe(false);
    expect(body.counts[1]).toBe(500);
  });

  it('returns 400 for a missing or malformed pubkey', async () => {
    expect((await handleBulkKindCounts(null, { RELAY_URL: 'wss://relay.test' }, {})).status).toBe(400);
    expect((await handleBulkKindCounts('xyz', { RELAY_URL: 'wss://relay.test' }, {})).status).toBe(400);
  });

  it('returns 502 when the relay listing fails, not an empty count', async () => {
    vi.spyOn(globalThis, 'WebSocket').mockImplementation((function () {
      const listeners = new Map<string, Array<(value?: unknown) => void>>();
      queueMicrotask(() => listeners.get('error')?.forEach((h) => h()));
      return {
        addEventListener: (t: string, h: (value?: unknown) => void) => listeners.set(t, [...(listeners.get(t) || []), h]),
        send: vi.fn(),
        close: vi.fn(),
      };
    } as unknown as typeof WebSocket));
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const res = await handleBulkKindCounts(PUBKEY, { RELAY_URL: 'wss://relay.test' }, {});

    expect(res.status).toBe(502);
    expect(await res.json()).not.toHaveProperty('counts');
  });
});

// Paginating mock relay: responds to each REQ with up to `limit` events whose
// created_at <= filter.until (descending), then EOSE for that sub. Models a
// relay that supports until-cursoring, and honors a `kinds` filter. Returns the
// REQ filters it received so a test can assert what was asked for.
function mockPaginatedRelay(all: Array<{ id: string; kind: number; content: string; tags: string[][]; created_at: number }>) {
  const sorted = [...all].sort((a, b) => b.created_at - a.created_at);
  const filters: Array<Record<string, unknown>> = [];
  vi.spyOn(globalThis, 'WebSocket').mockImplementation((function () {
    const listeners = new Map<string, Array<(value?: unknown) => void>>();
    const emit = (type: string, value?: unknown) => listeners.get(type)?.forEach((h) => h(value));
    const sock = {
      addEventListener: (t: string, h: (value?: unknown) => void) => listeners.set(t, [...(listeners.get(t) || []), h]),
      send: (payload: string) => {
        const data = JSON.parse(payload);
        if (data[0] !== 'REQ') return; // ignore CLOSE
        const sub = data[1];
        filters.push(data[2]);
        const until = data[2].until ?? Infinity;
        const limit = data[2].limit ?? 500;
        const kinds = data[2].kinds as number[] | undefined;
        const page = sorted
          .filter((e) => e.created_at <= until && (!kinds || kinds.includes(e.kind)))
          .slice(0, limit);
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
  return { filters };
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
