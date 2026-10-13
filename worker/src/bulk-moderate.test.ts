import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  runBulkModeration,
  handleBulkModerateEnqueue,
  processBulkJob,
  handleBulkJobStatus,
  queryRelayEvents,
  queryUserVideosPage,
  queryRelayEventsPage,
  handleBulkKindCounts,
  KIND_COUNT_BUDGET_MS,
  VIDEO_MAX_PAGES,
  type BulkModerateEnv,
} from './bulk-moderate';
import { KIND_COUNTS_REQUEST_TIMEOUT_MS, sameSecondGapWarning, type BulkJob, type BulkJobMessage, type BulkEnqueueResponse } from '../../shared/bulk-moderation';
import { banEvent, getAdminPubkey } from './nip86';
import { syncZendeskAfterAction } from './zendesk-sync';
import { BAN_REFUSED, drainJob, relayFake, type RelayEvent } from './test-helpers/relay-fake';

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

// Current status per blob, as the two status reads report it before a bulk
// action changes anything (#291). Unset means a blob blossom serves as active
// and moderation-service has no decision for, i.e. nothing stronger to protect.
// A number makes that read fail with the HTTP status.
const blossomStatus = new Map<string, string | number>();
const moderationStatus = new Map<string, string | number>();
beforeEach(() => {
  blossomStatus.clear();
  moderationStatus.clear();
});

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
    if (url.pathname.startsWith('/admin/api/blob/')) {
      const sha256 = url.pathname.slice('/admin/api/blob/'.length);
      const status = blossomStatus.get(sha256) ?? 'active';
      if (typeof status === 'number') return new Response('err', { status });
      return new Response(JSON.stringify({ sha256, status }), { status: 200 });
    }
    return new Response('not found', { status: 404 });
  }) as typeof fetch);
}

// Functional in-memory D1 mock for the bulk_jobs table: supports the INSERT,
// positional-SET UPDATE, and SELECT-by-job_id statements the async path uses.
// Honors a `status IN (...)` / `status = '...'` guard in the UPDATE WHERE clause
// and reports meta.changes, so the consumer's sticky-status guards are exercised.
// `ageReview` answers the consumer's open-case lookup on age_review_cases: an
// open case exists only for `openCaseFor`, so a lookup bound to the wrong
// pubkey finds nothing. The query itself is pinned against real SQLite in
// test/age-review-lookup.d1.test.ts.
function makeJobDb(ageReview: { openCaseFor?: string; lookupThrows?: boolean } = {}) {
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
        async first() {
          if (/age_review_cases/i.test(sql)) {
            if (ageReview.lookupThrows) throw new Error('D1 unavailable');
            return binds[0] === ageReview.openCaseFor ? { id: 'case-open', pubkey: binds[0], state: 'open_reported' } : null;
          }
          return rows.get(binds[0] as string) ?? null;
        },
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
      fetch: vi.fn(async (input: RequestInfo | URL) => {
        const url = new URL(String(input));
        if (url.pathname.startsWith('/check-result/')) {
          const sha256 = url.pathname.slice('/check-result/'.length);
          const status = moderationStatus.get(sha256) ?? 'unknown';
          if (typeof status === 'number') return new Response('err', { status });
          return new Response(JSON.stringify({ sha256, status }), { status: 200 });
        }
        return new Response(null, { status: 200 });
      }),
    } as unknown as Fetcher,
    BLOSSOM_WEBHOOK_SECRET: 'test-blossom-secret',
    CDN_DOMAIN: 'media.test',
    DB: {
      prepare: vi.fn().mockReturnValue({ bind: vi.fn().mockReturnThis() }),
      batch: vi.fn().mockResolvedValue([]),
    } as unknown as D1Database,
  };
}

// The action sent for a blob, from EVERY call for it: a second call (say a
// trailing SAFE after the gate) shows up as `MULTIPLE:...` instead of hiding
// behind the first match.
function moderationActionFor(env: BulkModerateEnv, sha256: string): string | undefined {
  const fetchMock = vi.mocked((env.MODERATION_API as unknown as { fetch: ReturnType<typeof vi.fn> }).fetch);
  const actions = fetchMock.mock.calls
    .filter((call) => typeof (call[1] as RequestInit | undefined)?.body === 'string') // writes, not status reads
    .map((call) => JSON.parse((call[1] as RequestInit).body as string))
    .filter((body) => body.sha256 === sha256)
    .map((body) => body.action as string);
  if (actions.length > 1) return `MULTIPLE:${actions.join(',')}`;
  return actions[0];
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
    const all = Array.from({ length: 250 }, (_, i) => ({ id: `e${i}`, kind: 1, created_at: 250 - i }));
    relayFake(all);
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
    const all = Array.from({ length: 600 }, (_, i) => ({ id: `e${i}`, kind: 1, created_at: 1000 }));
    relayFake(all);
    const page = await queryRelayEventsPage('a'.repeat(64), { RELAY_URL: 'wss://relay.test' });
    expect(page.events).toHaveLength(200);                  // EVENT_CHUNK_SIZE, all at second 1000
    expect(page.saturated).toBe(true);                      // surfaced, not silent
    expect(page.complete).toBe(false);
    expect(page.nextUntil).toBe(999);                       // strictly past the saturated second
  });
  it('keeps out-of-scope events off a full page while still paging by them', async () => {
    // A relay ignoring `authors`: every 10th event is someone else's.
    const all = Array.from({ length: 250 }, (_, i) => ({
      id: `e${i}`, kind: 1, created_at: 250 - i,
      ...(i % 10 === 0 ? { pubkey: 'b'.repeat(64) } : {}),
    }));
    relayFake(all, { ignore: { authors: true } });
    const page = await queryRelayEventsPage('a'.repeat(64), { RELAY_URL: 'wss://relay.test' });
    expect(page.nextUntil).toBe(all[199].created_at);              // pagination still uses the whole page
    expect(page.outOfScope).toBe(20);
    expect(page.events).toHaveLength(199 - 20);                     // boundary deferred, others dropped
    expect(page.events.some((e) => Number(e.id.slice(1)) % 10 === 0)).toBe(false);
  });
  // A replaceable or addressable kind lists only the newest unbanned version of
  // each coordinate, so a short page of it says nothing about older versions.
  // A replaceable kind has one coordinate per author, so its page holds one.
  it.each([
    ['replaceable (0)', 0],
    ['replaceable (3)', 3],
    ['replaceable (10002)', 10002],
  ])('treats a short non-empty page of a %s kind as non-final, stepping below its event', async (_label, kind) => {
    relayFake([{ id: 'n', kind, created_at: 50 }, { id: 'o', kind, created_at: 40 }]);
    const page = await queryRelayEventsPage('a'.repeat(64), { RELAY_URL: 'wss://relay.test' }, 100, kind);
    expect(page.events.map((e) => e.id)).toEqual(['n']);
    expect(page.complete).toBe(false);
    expect(page.nextUntil).toBe(49);
  });
  it.each([
    ['addressable (30023)', 30023],
    ['addressable (39999)', 39999],
  ])('treats a short non-empty page of a %s kind as non-final, stepping below its oldest event', async (_label, kind) => {
    relayFake([{ id: 'n', kind, created_at: 50, d: 'x' }, { id: 'o', kind, created_at: 40, d: 'y' }]);
    const page = await queryRelayEventsPage('a'.repeat(64), { RELAY_URL: 'wss://relay.test' }, 100, kind);
    expect(page.events).toHaveLength(2);
    expect(page.complete).toBe(false);
    expect(page.nextUntil).toBe(39);
  });
  it.each([
    ['regular (1)', 1],
    ['ephemeral-adjacent (9999)', 9999],
    ['ephemeral (20000)', 20000],
    ['after addressable (40000)', 40000],
  ])('keeps a short page of a %s kind final', async (_label, kind) => {
    relayFake([{ id: 'n', kind, created_at: 50 }]);
    const page = await queryRelayEventsPage('a'.repeat(64), { RELAY_URL: 'wss://relay.test' }, 100, kind);
    expect(page.complete).toBe(true);
    expect(page.nextUntil).toBeNull();
  });
  it('ends a replaceable kind\'s walk on an empty page', async () => {
    relayFake([]);
    const page = await queryRelayEventsPage('a'.repeat(64), { RELAY_URL: 'wss://relay.test' }, 100, 0);
    expect(page.complete).toBe(true);
    expect(page.nextUntil).toBeNull();
  });
  it('signals completion on a short final page', async () => {
    const all = Array.from({ length: 50 }, (_, i) => ({ id: `e${i}`, kind: 1, created_at: 50 - i }));
    relayFake(all);
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

  it('age-gate-all sends AGE_RESTRICTED (18+ gate) for EVERY video, not QUARANTINE (#290)', async () => {
    // The Users-page "Age Restrict All" button: viewers who pass the age gate
    // still see the videos. Must not reuse the age-review withhold.
    mockUserVideos([{ sha256: hashA }, { sha256: hashB }]);
    const result = await runBulkModeration(mockEnv, 'a'.repeat(64), 'age-gate-all', 'r');
    expect(result.success).toBe(true);
    expect(result.mediaProcessed).toBe(2);
    expect(moderationActionFor(mockEnv, hashA)).toBe('AGE_RESTRICTED');
    expect(moderationActionFor(mockEnv, hashB)).toBe('AGE_RESTRICTED');
  });

  it('un-age-restrict-all sends SAFE (restore) for hidden media', async () => {
    mockUserVideos([{ sha256: hashA }]);
    blossomStatus.set(hashA, 'restricted');
    moderationStatus.set(hashA, 'quarantine');
    await runBulkModeration(mockEnv, 'a'.repeat(64), 'un-age-restrict-all', 'r');
    expect(moderationActionFor(mockEnv, hashA)).toBe('SAFE');
  });

  // The synchronous delete-all (age review) must ban only the account's own
  // events, whatever the relay sends.
  it('delete-all does not ban events of another author the relay returns, and records them', async () => {
    relayFake([
      { id: 'mine', kind: 1, created_at: 2 },
      { id: 'theirs', kind: 1, created_at: 1, pubkey: 'b'.repeat(64) },
    ], { ignore: { authors: true } });
    vi.mocked(banEvent).mockClear();

    const result = await runBulkModeration(mockEnv, 'a'.repeat(64), 'delete-all', 'r');

    expect(vi.mocked(banEvent).mock.calls.map((c) => c[0])).toEqual(['mine']);
    expect(result.eventsProcessed).toBe(1);
    expect(result.failures).toContain(
      `enumeration:${'a'.repeat(64)}:relay returned 1 event(s) outside the requested author or kind; ignored them`,
    );
  });

  it('delete-all bans events from the relay (WS) and DELETEs media hashes from the REST API', async () => {
    // Events still come from the WebSocket (delete needs event IDs); media
    // hashes come from REST. The WS event's x-tag (hashB) must NOT be the media
    // source -- only the REST list (hashA) is.
    relayFake([{ id: 'e'.repeat(64), kind: 34235, tags: [['x', hashB]] }]);
    mockUserVideos([{ sha256: hashA }]);
    const result = await runBulkModeration(mockEnv, 'a'.repeat(64), 'delete-all', 'r');
    expect(result.eventsProcessed).toBe(1);
    expect(result.mediaProcessed).toBe(1);
    expect(moderationActionFor(mockEnv, hashA)).toBe('DELETE'); // from REST
    expect(moderationActionFor(mockEnv, hashB)).toBeUndefined(); // NOT from the WS x-tag
  });

  it('marks bulk delete as failed when relay deletion returns success false', async () => {
    relayFake([{ id: 'e'.repeat(64), kind: 1 }], { ban: () => BAN_REFUSED });

    const result = await runBulkModeration(mockEnv, 'a'.repeat(64), 'delete-all', 'r');
    expect(result.success).toBe(false);
    expect(result.eventsProcessed).toBe(0);
    expect(result.failures[0]).toContain('relay refused');
  });

  it('delete-all counts an event as processed on banevent success alone (no kind-5)', async () => {
    // Admin deletion is NIP-86 banevent only; there is no kind-5 publish, so a
    // delete that bans successfully is processed with no failures.
    relayFake([{ id: 'e'.repeat(64), kind: 1 }]);
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
    relayFake([{ id: 'e'.repeat(64), kind: 1 }]);
    mockUserVideos([{ sha256: hashA }]);
    (mockEnv.DB as unknown as { batch: ReturnType<typeof vi.fn> }).batch = vi.fn().mockRejectedValue(new Error('d1 down'));

    const result = await runBulkModeration(mockEnv, 'a'.repeat(64), 'delete-all', 'r');
    expect(result.eventsProcessed).toBe(1); // event still deleted
    expect(result.mediaProcessed).toBe(1);
    expect(result.failures).toEqual([]); // audit failure not surfaced as a moderation failure
  });
});

describe('bulk actions never weaken a stronger decision (#291)', () => {
  // Every bulk action reads each blob's current status from BOTH blossom (what
  // viewers are served; its admin UI never tells moderation-service) and
  // moderation-service (the recorded decision; blossom's own read can be up to
  // 5 minutes stale in another POP), then changes it, leaves it alone, or fails
  // naming both (decideMediaChange). A moderator-blocked video stays in
  // funnelcake's public list, so without this Age Restrict All turned Banned
  // into AgeRestricted.
  let mockEnv: BulkModerateEnv;

  beforeEach(() => {
    vi.restoreAllMocks();
    vi.mocked(getAdminPubkey).mockResolvedValue('moderator-pubkey');
    vi.mocked(banEvent).mockResolvedValue({ success: true });
    mockUserVideos([{ sha256: hashA }, { sha256: hashB }, { sha256: hashC }]);
    mockEnv = baseEnv();
  });

  it('Age Restrict All gates an open file and quietly leaves a blocked one alone', async () => {
    blossomStatus.set(hashB, 'banned');
    moderationStatus.set(hashB, 'permanent_ban');
    const result = await runBulkModeration(mockEnv, 'a'.repeat(64), 'age-gate-all', 'r');
    expect(moderationActionFor(mockEnv, hashA)).toBe('AGE_RESTRICTED');
    expect(moderationActionFor(mockEnv, hashB)).toBeUndefined();
    // A stronger decision left in place on purpose is not a failure, but it is
    // counted so the moderator can see it.
    expect(result).toMatchObject({ success: true, failures: [], mediaProcessed: 2, mediaSkipped: 1 });
  });

  it('Age Restrict All quietly leaves alone a file blossom already serves more strictly than moderation-service records', async () => {
    // Gated or blocked in blossom's admin UI, which never tells moderation-service.
    // What viewers get is already at least as strict, so nothing is exposed.
    blossomStatus.set(hashB, 'age_restricted');
    blossomStatus.set(hashC, 'banned');
    const result = await runBulkModeration(mockEnv, 'a'.repeat(64), 'age-gate-all', 'r');
    expect(moderationActionFor(mockEnv, hashB)).toBeUndefined();
    expect(moderationActionFor(mockEnv, hashC)).toBeUndefined();
    expect(result).toMatchObject({ success: true, failures: [], mediaSkipped: 2 });
  });

  it.each([
    ['age-gate-all', 'quarantine'],
    ['age-gate-all', 'permanent_ban'],
    ['age-gate-all', 'delete'],
    ['age-restrict-all', 'permanent_ban'],
    ['age-restrict-all', 'delete'],
    ['delete-all', 'permanent_ban'],
  ] as const)('%s fails, naming both statuses, when blossom serves a file that moderation-service records as %s', async (action, recorded) => {
    // Either the block just landed and blossom's read is stale, or someone
    // unblocked it in blossom's admin UI and the record is stale. Acting could
    // undo a fresh block; skipping quietly could leave a minor's video public.
    // A person has to look.
    relayFake([]);
    moderationStatus.set(hashA, recorded);
    const result = await runBulkModeration(mockEnv, 'a'.repeat(64), action, 'r');
    expect(moderationActionFor(mockEnv, hashA)).toBeUndefined();
    expect(result.success).toBe(false);
    expect(result.failures).toEqual([
      expect.stringMatching(new RegExp(`^media:${hashA}:.*blossom active.*moderation-service ${recorded}`)),
    ]);
    expect(result.mediaSkipped).toBe(0);
  });

  it.each([
    ['age-gate-all', 'age_restricted', 'quarantine'],
    ['age-gate-all', 'age_restricted', 'permanent_ban'],
    ['age-gate-all', 'age_restricted', 'delete'],
    ['un-age-restrict-all', 'active', 'age_restricted'],
    ['un-age-restrict-all', 'active', 'quarantine'],
    ['un-age-restrict-all', 'active', 'permanent_ban'],
    ['un-age-restrict-all', 'age_restricted', 'quarantine'],
  ] as const)('%s fails, naming both, when blossom serves a file as %s that moderation-service records as %s', async (action, blossom, recorded) => {
    // The action would leave this file alone, but viewers are being served it
    // more openly than the record says. That is an exposure a moderator has to
    // see, whichever action surfaced it.
    mockUserVideos([{ sha256: hashA }]);
    blossomStatus.set(hashA, blossom);
    moderationStatus.set(hashA, recorded);
    const result = await runBulkModeration(mockEnv, 'a'.repeat(64), action, 'r');
    expect(moderationActionFor(mockEnv, hashA)).toBeUndefined();
    expect(result.failures).toEqual([
      expect.stringMatching(new RegExp(`^media:${hashA}:.*blossom ${blossom}.*moderation-service ${recorded}`)),
    ]);
    expect(result.mediaSkipped).toBe(0);
  });

  it('re-running Age Restrict All on an account that is already 18+ is a quiet skip, not a failure', async () => {
    for (const hash of [hashA, hashB, hashC]) {
      blossomStatus.set(hash, 'age_restricted');
      moderationStatus.set(hash, 'age_restricted');
    }
    const result = await runBulkModeration(mockEnv, 'a'.repeat(64), 'age-gate-all', 'r');
    expect(result).toMatchObject({ success: true, failures: [], mediaProcessed: 0, mediaSkipped: 3 });
  });

  it("age review's hide leaves alone a file blossom hides that the record has as blocked (only the owner can see it)", async () => {
    mockUserVideos([{ sha256: hashA }]);
    blossomStatus.set(hashA, 'restricted');
    moderationStatus.set(hashA, 'permanent_ban');
    const result = await runBulkModeration(mockEnv, 'a'.repeat(64), 'age-restrict-all', 'r');
    expect(moderationActionFor(mockEnv, hashA)).toBeUndefined();
    expect(result).toMatchObject({ success: true, failures: [], mediaSkipped: 1 });
  });

  it.each([
    ['restricted (hidden)', 'restricted'],
    ['deleted', 'deleted'],
    ['already age_restricted', 'age_restricted'],
  ])('Age Restrict All leaves alone a file blossom has as %s', async (_label, blossom) => {
    blossomStatus.set(hashA, blossom);
    const result = await runBulkModeration(mockEnv, 'a'.repeat(64), 'age-gate-all', 'r');
    expect(moderationActionFor(mockEnv, hashA)).toBeUndefined();
    expect(moderationActionFor(mockEnv, hashB)).toBe('AGE_RESTRICTED');
    expect(result).toMatchObject({ success: true, failures: [], mediaSkipped: 1 });
  });

  it('Age Restrict All acts on pending, safe and review files', async () => {
    blossomStatus.set(hashA, 'pending');
    moderationStatus.set(hashB, 'safe');
    moderationStatus.set(hashC, 'review');
    await runBulkModeration(mockEnv, 'a'.repeat(64), 'age-gate-all', 'r');
    expect(moderationActionFor(mockEnv, hashA)).toBe('AGE_RESTRICTED');
    expect(moderationActionFor(mockEnv, hashB)).toBe('AGE_RESTRICTED');
    expect(moderationActionFor(mockEnv, hashC)).toBe('AGE_RESTRICTED');
  });

  it("age review's hide tightens an 18+ file and leaves blocked and deleted files alone", async () => {
    blossomStatus.set(hashA, 'age_restricted');
    moderationStatus.set(hashA, 'age_restricted');
    blossomStatus.set(hashB, 'banned');
    moderationStatus.set(hashB, 'permanent_ban');
    blossomStatus.set(hashC, 'deleted');
    moderationStatus.set(hashC, 'delete');
    const result = await runBulkModeration(mockEnv, 'a'.repeat(64), 'age-restrict-all', 'r');
    expect(moderationActionFor(mockEnv, hashA)).toBe('QUARANTINE');
    expect(moderationActionFor(mockEnv, hashB)).toBeUndefined();
    expect(moderationActionFor(mockEnv, hashC)).toBeUndefined();
    expect(result).toMatchObject({ success: true, failures: [], mediaSkipped: 2 });
  });

  it("age review's un-hide restores only hidden files and quietly leaves blocked and 18+ ones", async () => {
    blossomStatus.set(hashA, 'restricted');
    moderationStatus.set(hashA, 'quarantine');
    blossomStatus.set(hashB, 'banned');
    moderationStatus.set(hashB, 'quarantine'); // stale record; blossom is banned
    blossomStatus.set(hashC, 'age_restricted');
    moderationStatus.set(hashC, 'age_restricted'); // both agree: 18+, not hidden
    const result = await runBulkModeration(mockEnv, 'a'.repeat(64), 'un-age-restrict-all', 'r');
    expect(moderationActionFor(mockEnv, hashA)).toBe('SAFE');
    expect(moderationActionFor(mockEnv, hashB)).toBeUndefined();
    expect(moderationActionFor(mockEnv, hashC)).toBeUndefined();
    // Skips, not failures: a failure here would fail the case's clear step on
    // every retry for any account with a blocked or 18+ video.
    expect(result).toMatchObject({ success: true, failures: [], mediaProcessed: 1, mediaSkipped: 2 });
  });

  it.each([
    ['age-restrict-all', 'quarantine', 'QUARANTINE'],
    ['age-gate-all', 'age_restricted', 'AGE_RESTRICTED'],
    ['delete-all', 'delete', 'DELETE'],
  ] as const)('%s re-sends when moderation-service already records %s but blossom still serves the file', async (action, recorded, sent) => {
    // moderation-service records an action even when its call to blossom fails
    // (it returns 502). Re-sending cannot weaken anything: blossom's own status
    // already passed the check. Refusing would fail on every retry and leave
    // the file public.
    relayFake([]);
    mockUserVideos([{ sha256: hashA }]);
    moderationStatus.set(hashA, recorded);
    const result = await runBulkModeration(mockEnv, 'a'.repeat(64), action, 'r');
    expect(moderationActionFor(mockEnv, hashA)).toBe(sent);
    expect(result).toMatchObject({ success: true, failures: [] });
  });

  it.each([
    ['unknown'],
    ['safe'],
    ['age_restricted'],
  ])("age review's un-hide leaves alone a file hidden in blossom whose record is %s (not age review's to undo)", async (recorded) => {
    // Hidden in blossom's admin UI or by some other path that never reached
    // moderation-service. Un-hiding only what age review hid is #295.
    mockUserVideos([{ sha256: hashA }]);
    blossomStatus.set(hashA, 'restricted');
    moderationStatus.set(hashA, recorded);
    const result = await runBulkModeration(mockEnv, 'a'.repeat(64), 'un-age-restrict-all', 'r');
    expect(moderationActionFor(mockEnv, hashA)).toBeUndefined();
    expect(result).toMatchObject({ success: true, failures: [], mediaSkipped: 1 });
  });

  it.each([
    ['permanent_ban'],
    ['delete'],
  ])("age review's un-hide fails, naming both, when blossom shows hidden but the record is %s", async (recorded) => {
    mockUserVideos([{ sha256: hashA }]);
    blossomStatus.set(hashA, 'restricted');
    moderationStatus.set(hashA, recorded);
    const result = await runBulkModeration(mockEnv, 'a'.repeat(64), 'un-age-restrict-all', 'r');
    expect(moderationActionFor(mockEnv, hashA)).toBeUndefined();
    expect(result.failures).toEqual([
      expect.stringMatching(new RegExp(`^media:${hashA}:.*blossom restricted.*moderation-service ${recorded}`)),
    ]);
  });

  it("age review's un-hide leaves an open file alone (nothing to undo)", async () => {
    mockUserVideos([{ sha256: hashA }]);
    moderationStatus.set(hashA, 'review'); // open in both
    const result = await runBulkModeration(mockEnv, 'a'.repeat(64), 'un-age-restrict-all', 'r');
    expect(moderationActionFor(mockEnv, hashA)).toBeUndefined();
    expect(result).toMatchObject({ success: true, mediaSkipped: 1 });
  });

  it("Delete All's media phase leaves a blocked file alone (keeps the evidence)", async () => {
    relayFake([]);
    blossomStatus.set(hashA, 'banned');
    moderationStatus.set(hashA, 'permanent_ban');
    blossomStatus.set(hashB, 'restricted');
    moderationStatus.set(hashB, 'quarantine');
    blossomStatus.set(hashC, 'age_restricted');
    moderationStatus.set(hashC, 'age_restricted');
    await runBulkModeration(mockEnv, 'a'.repeat(64), 'delete-all', 'r');
    expect(moderationActionFor(mockEnv, hashA)).toBeUndefined();
    expect(moderationActionFor(mockEnv, hashB)).toBe('DELETE');
    expect(moderationActionFor(mockEnv, hashC)).toBe('DELETE');
  });

  it('Delete All leaves an already-deleted file alone', async () => {
    relayFake([]);
    mockUserVideos([{ sha256: hashA }]);
    blossomStatus.set(hashA, 'deleted');
    moderationStatus.set(hashA, 'delete');
    const result = await runBulkModeration(mockEnv, 'a'.repeat(64), 'delete-all', 'r');
    expect(moderationActionFor(mockEnv, hashA)).toBeUndefined();
    expect(result.mediaSkipped).toBe(1);
  });

  it.each([
    ['blossom read fails', () => { blossomStatus.set(hashA, 500); }],
    ['moderation-service read fails', () => { moderationStatus.set(hashA, 503); }],
    ['blossom reports a status this code does not know', () => { blossomStatus.set(hashA, 'quarantined'); }],
    ['moderation-service reports a status this code does not know', () => { moderationStatus.set(hashA, 'flagged'); }],
  ])('skips a file and records a failure when %s', async (_label, arrange) => {
    arrange();
    const result = await runBulkModeration(mockEnv, 'a'.repeat(64), 'age-gate-all', 'r');
    expect(moderationActionFor(mockEnv, hashA)).toBeUndefined();
    expect(moderationActionFor(mockEnv, hashB)).toBe('AGE_RESTRICTED');
    expect(result.success).toBe(false);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]).toMatch(new RegExp(`^media:${hashA}:.*current status`));
  });

  it('skips every file and records failures when the blossom key is not configured', async () => {
    mockEnv = { ...mockEnv, BLOSSOM_WEBHOOK_SECRET: undefined };
    const result = await runBulkModeration(mockEnv, 'a'.repeat(64), 'age-gate-all', 'r');
    expect(moderationActionFor(mockEnv, hashA)).toBeUndefined();
    expect(result.failures).toHaveLength(3);
  });

  it("reads blossom's admin status for the blob with the webhook key", async () => {
    await runBulkModeration(mockEnv, 'a'.repeat(64), 'age-gate-all', 'r');
    const blobReads = vi.mocked(globalThis.fetch).mock.calls
      .filter((call) => String(call[0]).includes('/admin/api/blob/'));
    expect(blobReads.map((call) => String(call[0]))).toContain(`https://media.test/admin/api/blob/${hashA}`);
    const headers = new Headers((blobReads[0][1] as RequestInit).headers);
    expect(headers.get('Authorization')).toBe('Bearer test-blossom-secret');
  });

  it('queued Age Restrict All chunks skip a blocked file too', async () => {
    const jobDb = makeJobDb();
    mockEnv = {
      ...mockEnv,
      DB: jobDb.db,
      BULK_QUEUE: { send: vi.fn(async () => {}) } as unknown as Queue<BulkJobMessage>,
    };
    blossomStatus.set(hashB, 'banned');
    const jobId = 'job-gate-skip-1';
    jobDb.rows.set(jobId, { job_id: jobId, pubkey: 'a'.repeat(64), action: 'age-gate-all', status: 'running', events_processed: 0, media_processed: 0, failures: '[]', failures_dropped: 0, created_at: 't', updated_at: 't' });
    await processBulkJob({ jobId, pubkey: 'a'.repeat(64), action: 'age-gate-all', phase: 'media' }, mockEnv);
    expect(moderationActionFor(mockEnv, hashA)).toBe('AGE_RESTRICTED');
    expect(moderationActionFor(mockEnv, hashB)).toBeUndefined();
    // media_processed counts files actually changed (hashA and hashC); the
    // blocked file left alone is counted separately.
    expect(jobDb.rows.get(jobId)).toMatchObject({ status: 'done', media_processed: 2, media_skipped: 1, failures: '[]' });
    const status = await handleBulkJobStatus(jobId, mockEnv, {});
    expect(await status.json()).toMatchObject({ mediaProcessed: 2, mediaSkipped: 1 });
  });

  it('queued skips add up across chunks', async () => {
    const jobDb = makeJobDb();
    mockEnv = {
      ...mockEnv,
      DB: jobDb.db,
      BULK_QUEUE: { send: vi.fn(async () => {}) } as unknown as Queue<BulkJobMessage>,
    };
    blossomStatus.set(hashA, 'banned');
    const jobId = 'job-gate-skip-2';
    jobDb.rows.set(jobId, { job_id: jobId, pubkey: 'a'.repeat(64), action: 'age-gate-all', status: 'running', events_processed: 0, media_processed: 4, media_skipped: 2, failures: '[]', failures_dropped: 0, created_at: 't', updated_at: 't' });
    await processBulkJob({ jobId, pubkey: 'a'.repeat(64), action: 'age-gate-all', phase: 'media' }, mockEnv);
    expect(jobDb.rows.get(jobId)).toMatchObject({ media_processed: 6, media_skipped: 3 });
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

  it('enqueue accepts age-gate-all (#290)', async () => {
    const res = await handleBulkModerateEnqueue(enqueueReq({ pubkey: 'a'.repeat(64), action: 'age-gate-all' }), mockEnv, {});
    expect(res.status).toBe(200);
    expect(sent[0]).toMatchObject({ action: 'age-gate-all' });
  });

  it('queued age-gate-all media chunks send AGE_RESTRICTED (#290)', async () => {
    const jobId = 'job-gate-1';
    jobDb.rows.set(jobId, { job_id: jobId, pubkey: 'a'.repeat(64), action: 'age-gate-all', status: 'running', events_processed: 0, media_processed: 0, failures: '[]', failures_dropped: 0, created_at: 't', updated_at: 't' });
    await processBulkJob({ jobId, pubkey: 'a'.repeat(64), action: 'age-gate-all', phase: 'media' }, mockEnv);
    expect(moderationActionFor(mockEnv, hashA)).toBe('AGE_RESTRICTED');
    expect(moderationActionFor(mockEnv, hashB)).toBe('AGE_RESTRICTED');
    expect(jobDb.rows.get(jobId)).toMatchObject({ status: 'done', media_processed: 2 });
  });

  it('queued un-age-restrict-all media chunks send SAFE for hidden media', async () => {
    for (const hash of [hashA, hashB]) {
      blossomStatus.set(hash, 'restricted');
      moderationStatus.set(hash, 'quarantine');
    }
    const jobId = 'job-unrestrict-1';
    jobDb.rows.set(jobId, { job_id: jobId, pubkey: 'a'.repeat(64), action: 'un-age-restrict-all', status: 'running', events_processed: 0, media_processed: 0, failures: '[]', failures_dropped: 0, created_at: 't', updated_at: 't' });
    await processBulkJob({ jobId, pubkey: 'a'.repeat(64), action: 'un-age-restrict-all', phase: 'media' }, mockEnv);
    expect(moderationActionFor(mockEnv, hashA)).toBe('SAFE');
    expect(moderationActionFor(mockEnv, hashB)).toBe('SAFE');
  });

  // The enqueue guard runs once. A loosening job still draining when an
  // age-review case opens must stop, or its later chunks would overwrite the
  // case's withhold with the 18+ gate (or SAFE) (#290).
  describe.each([
    ['an open age-review case', { openCaseFor: 'a'.repeat(64) }],
    ['a failed case lookup', { lookupThrows: true }],
  ])('a loosening job that meets %s mid-run', (_label, ageReview) => {
    // Each file starts where the action would change it (open for the 18+
    // gate, hidden for un-hide), so "sends nothing" can only come from the
    // stop. On open files un-hide sends nothing anyway, stop or no stop.
    it.each([
      ['age-gate-all', 'active', 'unknown'],
      ['un-age-restrict-all', 'restricted', 'quarantine'],
    ] as const)('%s stops as failed and sends nothing', async (action, blossom, recorded) => {
      for (const hash of [hashA, hashB]) {
        blossomStatus.set(hash, blossom);
        moderationStatus.set(hash, recorded);
      }
      jobDb = makeJobDb(ageReview);
      mockEnv = { ...mockEnv, DB: jobDb.db };
      const jobId = `job-race-${action}`;
      jobDb.rows.set(jobId, { job_id: jobId, pubkey: 'a'.repeat(64), action, status: 'running', events_processed: 0, media_processed: 0, failures: '[]', failures_dropped: 0, version: 1, created_at: 't', updated_at: 't' });
      await processBulkJob({ jobId, pubkey: 'a'.repeat(64), action, phase: 'media', cursor: '1', mediaPage: 1, version: 1 }, mockEnv);
      expect(moderationActionFor(mockEnv, hashA)).toBeUndefined();
      expect(moderationActionFor(mockEnv, hashB)).toBeUndefined();
      expect(sent).toHaveLength(0);
      const row = jobDb.rows.get(jobId)!;
      expect(row.status).toBe('failed');
      expect(String(row.failures)).toMatch(/^\["job:stopped: .*age.review/);
    });
  });

  it('a loosening job still runs when the open age-review case is on a different account', async () => {
    jobDb = makeJobDb({ openCaseFor: 'b'.repeat(64) });
    mockEnv = { ...mockEnv, DB: jobDb.db };
    const jobId = 'job-gate-other-case';
    jobDb.rows.set(jobId, { job_id: jobId, pubkey: 'a'.repeat(64), action: 'age-gate-all', status: 'running', events_processed: 0, media_processed: 0, failures: '[]', failures_dropped: 0, created_at: 't', updated_at: 't' });
    await processBulkJob({ jobId, pubkey: 'a'.repeat(64), action: 'age-gate-all', phase: 'media' }, mockEnv);
    expect(moderationActionFor(mockEnv, hashA)).toBe('AGE_RESTRICTED');
    expect(jobDb.rows.get(jobId)?.status).toBe('done');
  });

  it('a withhold job (age-restrict-all) still runs when an age-review case is open', async () => {
    jobDb = makeJobDb({ openCaseFor: 'a'.repeat(64) });
    mockEnv = { ...mockEnv, DB: jobDb.db };
    const jobId = 'job-withhold-open-case';
    jobDb.rows.set(jobId, { job_id: jobId, pubkey: 'a'.repeat(64), action: 'age-restrict-all', status: 'running', events_processed: 0, media_processed: 0, failures: '[]', failures_dropped: 0, created_at: 't', updated_at: 't' });
    await processBulkJob({ jobId, pubkey: 'a'.repeat(64), action: 'age-restrict-all', phase: 'media' }, mockEnv);
    expect(moderationActionFor(mockEnv, hashA)).toBe('QUARANTINE');
    expect(jobDb.rows.get(jobId)?.status).toBe('done');
  });

  it('queued age-restrict-all media chunks still send QUARANTINE (the withhold is not repointed at the 18+ gate) (#290)', async () => {
    const jobId = 'job-withhold-1';
    jobDb.rows.set(jobId, { job_id: jobId, pubkey: 'a'.repeat(64), action: 'age-restrict-all', status: 'running', events_processed: 0, media_processed: 0, failures: '[]', failures_dropped: 0, created_at: 't', updated_at: 't' });
    await processBulkJob({ jobId, pubkey: 'a'.repeat(64), action: 'age-restrict-all', phase: 'media' }, mockEnv);
    expect(moderationActionFor(mockEnv, hashA)).toBe('QUARANTINE');
    expect(moderationActionFor(mockEnv, hashB)).toBe('QUARANTINE');
  });

  it('enqueue validates the action/pubkey and does NOT enqueue on a bad request', async () => {
    const bad = await handleBulkModerateEnqueue(enqueueReq({ pubkey: 'short', action: 'age-restrict-all' }), mockEnv, {});
    expect(bad.status).toBe(400);
    const badAction = await handleBulkModerateEnqueue(enqueueReq({ pubkey: 'a'.repeat(64), action: 'nope' }), mockEnv, {});
    expect(badAction.status).toBe(400);
    // An array stringifies to a matching hex string, and would slip past the
    // age-review guard's string check in index.ts.
    const arrayPubkey = await handleBulkModerateEnqueue(enqueueReq({ pubkey: ['a'.repeat(64)], action: 'age-gate-all' }), mockEnv, {});
    expect(arrayPubkey.status).toBe(400);
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

    await drainJob(mockEnv, sent, { jobId, pubkey: 'a'.repeat(64), action: 'age-restrict-all' }, 10);

    const res = await handleBulkJobStatus(jobId, mockEnv, {});
    const job = await res.json() as BulkJob;
    expect(job.status).toBe('done');
    expect(job.failures).toHaveLength(51);                       // 50 stored + 1 marker
    expect(job.failures[50]).toBe('+200 more');                  // 250 total - 50 stored, not erased
  });

  it('stores a failure once when one chunk produces it twice', async () => {
    // Two videos backed by one blob: the page lists its hash twice, and both
    // moderate calls fail the same way.
    mockUserVideos([{ sha256: hashA }, { sha256: hashA }]);
    // The status reads answer (an open blob); only the writes fail.
    const moderation = mockEnv.MODERATION_API as unknown as { fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> };
    const readStatus = moderation.fetch;
    moderation.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => (
      init?.body ? new Response('nope', { status: 500 }) : readStatus(input, init)
    ));
    const jobId = 'job-repeat-1';
    jobDb.rows.set(jobId, { job_id: jobId, pubkey: 'a'.repeat(64), action: 'age-restrict-all', status: 'pending', events_processed: 0, media_processed: 0, failures: '[]', failures_dropped: 0, created_at: 't', updated_at: 't' });

    await processBulkJob({ jobId, pubkey: 'a'.repeat(64), action: 'age-restrict-all' }, mockEnv);

    expect(JSON.parse(jobDb.rows.get(jobId)!.failures as string)).toEqual([`media:${hashA}:Moderation service returned 500`]);
  });

  it('media-only job chunks across multiple messages until done', async () => {
    // 250 videos => pages of 100/100/50 across 3 messages. Proves chunking: the
    // all-in-one consumer would finish in a single message.
    const many = Array.from({ length: 250 }, (_, i) => ({ sha256: i.toString(16).padStart(64, '0') }));
    mockUserVideos(many);
    const jobId = 'job-chunk-1';
    jobDb.rows.set(jobId, { job_id: jobId, pubkey: 'a'.repeat(64), action: 'age-restrict-all', status: 'pending', events_processed: 0, media_processed: 0, failures: '[]', created_at: 't', updated_at: 't' });

    const { chunks } = await drainJob(mockEnv, sent, { jobId, pubkey: 'a'.repeat(64), action: 'age-restrict-all' }, 10);

    expect(chunks).toBe(3); // chunked across 3 messages
    const row = jobDb.rows.get(jobId)!;
    expect(row.status).toBe('done');
    expect(row.media_processed).toBe(250);
    expect(moderationActionFor(mockEnv, '0'.padStart(64, '0'))).toBe('QUARANTINE');
  });

  it('delete-all transitions events -> media across messages and finishes', async () => {
    vi.mocked(banEvent).mockClear();
    relayFake(Array.from({ length: 30 }, (_, i) => ({ id: `e${i}`, kind: 1, created_at: 30 - i })));
    mockUserVideos([{ sha256: 'a'.repeat(64) }]);
    const jobId = 'job-del-1';
    jobDb.rows.set(jobId, { job_id: jobId, pubkey: 'a'.repeat(64), action: 'delete-all', status: 'pending', events_processed: 0, media_processed: 0, failures: '[]', created_at: 't', updated_at: 't' });

    await processBulkJob({ jobId, pubkey: 'a'.repeat(64), action: 'delete-all' }, mockEnv);
    expect(vi.mocked(banEvent)).toHaveBeenCalledTimes(20);
    expect(sent[0]?.eventIds).toHaveLength(10);

    const { chunks } = await drainJob(mockEnv, sent, sent[0], 10);

    expect(1 + chunks).toBe(3); // two bounded event batches -> media chunk
    const row = jobDb.rows.get(jobId)!;
    expect(row.status).toBe('done');
    expect(row.events_processed).toBe(30);
    expect(row.media_processed).toBe(1);
  });

  it('bans with the moderator\'s reason in every chunk, not only the first', async () => {
    vi.mocked(banEvent).mockClear();
    relayFake(Array.from({ length: 30 }, (_, i) => ({ id: `r${i}`, kind: 1, created_at: 30 - i })));
    mockUserVideos([]);
    const jobId = 'job-reason';
    jobDb.rows.set(jobId, { job_id: jobId, pubkey: 'a'.repeat(64), action: 'delete-all', status: 'pending', events_processed: 0, media_processed: 0, failures: '[]', failures_dropped: 0, version: 0, created_at: 't', updated_at: 't' });

    const { chunks } = await drainJob(mockEnv, sent, { jobId, pubkey: 'a'.repeat(64), action: 'delete-all', reason: 'spam wave' }, 10);

    expect(chunks).toBe(3);
    expect(vi.mocked(banEvent)).toHaveBeenCalledTimes(30);
    expect(vi.mocked(banEvent).mock.calls.every((c) => c[1] === 'spam wave')).toBe(true);
  });

  it('ends the events phase on a page it cannot page past, instead of walking on with no cursor', async () => {
    // A full page with no created_at to step from, and only 5 of its events in
    // scope, so this one chunk handles them all and leaves no ids behind.
    relayFake(Array.from({ length: 200 }, (_, i) => ({
      id: `nocursor-${i}`, kind: 1, ...(i < 5 ? {} : { pubkey: 'b'.repeat(64) }),
    })), { ignore: { authors: true } });
    const jobId = 'job-no-cursor';
    jobDb.rows.set(jobId, { job_id: jobId, pubkey: 'a'.repeat(64), action: 'delete-all', status: 'pending', events_processed: 0, media_processed: 0, failures: '[]', failures_dropped: 0, version: 0, created_at: 't', updated_at: 't' });

    await processBulkJob({ jobId, pubkey: 'a'.repeat(64), action: 'delete-all' }, mockEnv);

    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ phase: 'media' });
    expect(sent[0].cursor).toBeUndefined();
    expect(JSON.parse(jobDb.rows.get(jobId)!.failures as string)).toContain(
      `enumeration:${'a'.repeat(64)}:relay could not be fully paginated; some events may be unprocessed`,
    );
  });

  it('stops between concurrency waves when the event budget is exhausted', async () => {
    let now = 1_000;
    const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => now);
    vi.mocked(banEvent).mockClear();
    relayFake(Array.from({ length: 30 }, (_, i) => ({ id: `budget-${i}`, kind: 1, created_at: 30 - i })), {
      ban: () => { now += 5 * 60 * 1000; return { success: true }; },
    });
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
    relayFake(Array.from({ length: 250 }, (_, i) => ({ id: `e${i}`, kind: 1, created_at: 1000 })));
    mockUserVideos([{ sha256: hashA }]);
    const jobId = 'job-sat-1';
    jobDb.rows.set(jobId, { job_id: jobId, pubkey: 'a'.repeat(64), action: 'delete-all', status: 'pending', events_processed: 0, media_processed: 0, failures: '[]', created_at: 't', updated_at: 't' });

    const { chunks } = await drainJob(mockEnv, sent, { jobId, pubkey: 'a'.repeat(64), action: 'delete-all' });

    const row = jobDb.rows.get(jobId)!;
    expect(row.status).toBe('done');
    expect(row.events_processed).toBe(200);                 // one chunk's worth; the rest unreachable
    expect(chunks).toBe(12);                            // ten event batches + empty cursor check + media
    expect(JSON.parse(row.failures as string).some((f: string) => /share one timestamp/.test(f))).toBe(true);
  });

  it('claims each chunk version once so duplicate deliveries cannot fork progress', async () => {
    vi.mocked(banEvent).mockClear();
    relayFake(Array.from({ length: 2 }, (_, i) => ({ id: `dup${i}`, kind: 1, created_at: 2 - i })));
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

    const { terminated } = await drainJob(mockEnv, sent, { jobId, pubkey: 'a'.repeat(64), action: 'age-restrict-all' }, 10);

    expect(terminated).toBe(true);                          // did not loop to the guard
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
    relayFake([{ id: 'e'.repeat(64), kind: 34235 }]);
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

  // The reason a job failed must survive a full failure list: it is the one
  // entry that says why the job stopped.
  it('keeps the reason a job failed when its failure list is already full', async () => {
    const jobId = 'job-fail-full';
    const full = Array.from({ length: 50 }, (_, i) => `event:${i}:boom`);
    jobDb.rows.set(jobId, { job_id: jobId, pubkey: 'a'.repeat(64), action: 'age-restrict-all', status: 'running', events_processed: 0, media_processed: 0, failures: JSON.stringify(full), failures_dropped: 3, version: 2, created_at: 't', updated_at: 't' });
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('err', { status: 500 }));

    await processBulkJob({ jobId, pubkey: 'a'.repeat(64), action: 'age-restrict-all', phase: 'media', version: 2 }, mockEnv);

    const job = await (await handleBulkJobStatus(jobId, mockEnv, {})).json() as BulkJob;
    expect(job.status).toBe('failed');
    expect(job.failures).toHaveLength(51);                              // 50 stored + "+N more"
    expect(job.failures.some((f) => /^job:.*Video query failed: 500/.test(f))).toBe(true);
    expect(job.failures[50]).toBe('+4 more');                           // the displaced entry is counted
  });

  it('keeps the abandonment reason when a stale job\'s failure list is already full', async () => {
    const old = new Date(Date.now() - 31 * 60 * 1000).toISOString();
    const full = Array.from({ length: 50 }, (_, i) => `event:${i}:boom`);
    jobDb.rows.set('job-stale-full', { job_id: 'job-stale-full', pubkey: 'a'.repeat(64), action: 'delete-kind', status: 'running', events_processed: 0, media_processed: 0, failures: JSON.stringify(full), failures_dropped: 0, version: 2, created_at: old, updated_at: old, kind: 1 });

    const job = await (await handleBulkJobStatus('job-stale-full', mockEnv, {})).json() as BulkJob;

    expect(job.status).toBe('failed');
    expect(job.failures.some((f) => /^job:abandoned/.test(f))).toBe(true);
    expect(job.failures[50]).toBe('+1 more');
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

  it('enqueue returns a clear 500 and sends nothing when D1 is not bound', async () => {
    const res = await handleBulkModerateEnqueue(enqueueReq({ pubkey: 'a'.repeat(64), action: 'delete-all' }), { ...mockEnv, DB: undefined }, {});
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'bulk_jobs storage (D1) is not bound' });
    expect(sent).toHaveLength(0);
  });

  it('enqueue returns a clear 500 and sends nothing when writing the job row throws', async () => {
    const prepare = jobDb.db.prepare.bind(jobDb.db);
    const db = {
      ...jobDb.db,
      prepare(sql: string) {
        const statement = prepare(sql);
        if (/^\s*INSERT INTO bulk_jobs/i.test(sql)) {
          return { bind: () => ({ run: async () => { throw new Error('D1_ERROR: database is locked'); } }) };
        }
        return statement;
      },
    } as unknown as D1Database;
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const res = await handleBulkModerateEnqueue(enqueueReq({ pubkey: 'a'.repeat(64), action: 'delete-kind', kind: 1 }), { ...mockEnv, DB: db }, {});

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Failed to record the bulk moderation job' });
    expect(sent).toHaveLength(0);
    expect(errorSpy).toHaveBeenCalledWith('[bulk-moderate] job insert failed', expect.any(Error));
  });

  it('status heals a stale delete-kind job to failed and still reports its kind', async () => {
    const old = new Date(Date.now() - 31 * 60 * 1000).toISOString();
    jobDb.rows.set('job-stale-kind', { job_id: 'job-stale-kind', pubkey: 'a'.repeat(64), action: 'delete-kind', status: 'running', events_processed: 4, media_processed: 0, failures: '[]', failures_dropped: 0, version: 3, created_at: old, updated_at: old, kind: 34236 });

    const job = await (await handleBulkJobStatus('job-stale-kind', mockEnv, {})).json() as BulkJob;

    expect(job).toMatchObject({ status: 'failed', action: 'delete-kind', kind: 34236, eventsProcessed: 4 });
    expect(job.failures[0]).toMatch(/abandoned/);
    expect(jobDb.rows.get('job-stale-kind')!.status).toBe('failed');
  });

  // A relay connection that drops mid-walk must fail the job with what it got
  // through, never finish it as if the listing had ended.
  it.each([
    ['socket error', 'error', 'job:Relay query failed'],
    ['close before EOSE', 'close', 'job:Relay query closed before EOSE'],
  ] as const)('a delete-kind job fails, keeping its progress, when a later relay page hits a %s', async (_label, how, expected) => {
    // Page 1: a full multi-second page of 200; page 2 (the cursor continuation) drops.
    relayFake(Array.from({ length: 200 }, (_, i) => ({ id: `w${i}`, kind: 1, created_at: 1000 - i })), {
      socket: (reqIndex) => (reqIndex > 0 ? how : undefined),
    });
    const res = await handleBulkModerateEnqueue(enqueueReq({ pubkey: 'a'.repeat(64), action: 'delete-kind', kind: 1 }), mockEnv, {});
    const { jobId } = await res.json() as BulkEnqueueResponse;

    await drainJob(mockEnv, sent, sent[0], 30);

    const job = await (await handleBulkJobStatus(jobId, mockEnv, {})).json() as BulkJob;
    expect(job.status).toBe('failed');
    expect(job.eventsProcessed).toBe(199);                          // page 1, boundary second deferred
    expect(job.failures).toEqual([expected]);
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

  const drain = (first: BulkJobMessage, max?: number) => drainJob(mockEnv, sent, first, max);

  // 30 kind-1 notes interleaved with 30 kind-7 reactions, one per second.
  function mixedEvents(): RelayEvent[] {
    return Array.from({ length: 60 }, (_, i) => ({
      id: `${i % 2 === 0 ? 'note' : 'react'}${i}`,
      kind: i % 2 === 0 ? 1 : 7,
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
    ['above the NIP-01 range', 65536],
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

  it('enqueue accepts the top of the NIP-01 kind range', async () => {
    const res = await handleBulkModerateEnqueue(enqueueReq({ pubkey: PUBKEY, action: 'delete-kind', kind: 65535 }), mockEnv, {});
    expect(res.status).toBe(200);
  });

  // The claimed row, not the queue message, says what a chunk may touch.
  it.each([
    ['action', { action: 'delete-all' }],
    ['pubkey', { pubkey: 'b'.repeat(64) }],
    ['kind', { kind: 7 }],
  ])('fails closed when the message %s disagrees with its job row', async (_label, override) => {
    const ws = vi.spyOn(globalThis, 'WebSocket');
    const jobId = 'job-mismatch';
    jobDb.rows.set(jobId, { job_id: jobId, pubkey: PUBKEY, action: 'delete-kind', status: 'pending', events_processed: 0, media_processed: 0, failures: '[]', failures_dropped: 0, version: 0, created_at: 't', updated_at: 't', kind: 1 });
    const msg = { kindJobId: jobId, jobId: jobId, pubkey: PUBKEY, action: 'delete-kind', kind: 1, version: 0, ...override } as unknown as BulkJobMessage;
    // A delete-all action reads its id from jobId; carry both so the row is found either way.

    await processBulkJob(msg, mockEnv);

    expect(ws).not.toHaveBeenCalled();
    expect(vi.mocked(banEvent)).not.toHaveBeenCalled();
    const row = jobDb.rows.get(jobId)!;
    expect(row.status).toBe('failed');
    expect(JSON.parse(row.failures as string)).toEqual([
      'job:message does not match its job row (action, pubkey or kind); refusing to act on it',
    ]);
  });

  it('a delete-all row still accepts its own kindless messages', async () => {
    relayFake(mixedEvents().slice(0, 2));
    const jobId = 'job-all-ok';
    jobDb.rows.set(jobId, { job_id: jobId, pubkey: PUBKEY, action: 'delete-all', status: 'pending', events_processed: 0, media_processed: 0, failures: '[]', failures_dropped: 0, version: 0, created_at: 't', updated_at: 't', kind: null });

    await drain({ jobId, pubkey: PUBKEY, action: 'delete-all', version: 0 });

    expect(jobDb.rows.get(jobId)!.status).toBe('done');
    expect(vi.mocked(banEvent)).toHaveBeenCalledTimes(2);
  });

  it('drops events outside the requested author or kind before banning, and records it', async () => {
    relayFake([
      { id: 'mine', kind: 1, created_at: 3 },
      { id: 'other-kind', kind: 7, created_at: 2 },
      { id: 'other-author', kind: 1, created_at: 1, pubkey: 'b'.repeat(64) },
    ], { ignore: { authors: true, kinds: true } });
    const res = await handleBulkModerateEnqueue(enqueueReq({ pubkey: PUBKEY, action: 'delete-kind', kind: 1 }), mockEnv, {});
    const { jobId } = await res.json() as BulkEnqueueResponse;

    await drain(sent[0]);

    expect(vi.mocked(banEvent).mock.calls.map((c) => c[0])).toEqual(['mine']);
    const row = jobDb.rows.get(jobId)!;
    expect(row.events_processed).toBe(1);
    expect(JSON.parse(row.failures as string)).toContain(
      `enumeration:${PUBKEY}:relay returned 2 event(s) outside the requested author or kind; ignored them`,
    );
  });

  it('fails a delete-kind job whose row and message both lost the kind, instead of deleting every event', async () => {
    relayFake(mixedEvents());
    const jobId = 'job-kindless';
    jobDb.rows.set(jobId, { job_id: jobId, pubkey: PUBKEY, action: 'delete-kind', status: 'pending', events_processed: 0, media_processed: 0, failures: '[]', failures_dropped: 0, version: 0, created_at: 't', updated_at: 't', kind: null });

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
    const fetchCalls = vi.mocked(globalThis.fetch).mock.calls.map((c) => String(c[0]));
    expect(fetchCalls.filter((u) => u.includes('/admin/api/blob/') || u.includes('/videos'))).toEqual([]);
    const row = jobDb.rows.get(jobId)!;
    expect(row.status).toBe('failed');
    expect(JSON.parse(row.failures as string).some((f: string) => /delete-kind has no media phase/.test(f))).toBe(true);
  });

  it('delete-all without a kind is unchanged: no kind on the row, the message, or the relay filter', async () => {
    const res = await handleBulkModerateEnqueue(enqueueReq({ pubkey: PUBKEY, action: 'delete-all' }), mockEnv, {});
    const { jobId } = await res.json() as BulkEnqueueResponse;
    expect(jobDb.rows.get(jobId)?.kind).toBeNull();
    expect('kind' in sent[0]).toBe(false);
    expect('sweepUntil' in sent[0]).toBe(false);

    const { reqs } = relayFake(mixedEvents());
    const { messages } = await drain(sent[0]);
    expect(reqs.every((f) => !('kinds' in f))).toBe(true);
    expect(messages.every((m) => !('kind' in m))).toBe(true);
    expect(messages.every((m) => !('sweep' in m) && !('sweepDeleted' in m) && !('sweepUntil' in m))).toBe(true); // no sweeps
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
    relayFake(mixedEvents());
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
    relayFake(mixedEvents());
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
    relayFake(mixedEvents());
    const jobId = 'pre-deploy-job';
    jobDb.rows.set(jobId, { job_id: jobId, pubkey: PUBKEY, action: 'delete-all', status: 'pending', events_processed: 0, media_processed: 0, failures: '[]', failures_dropped: 0, version: 0, created_at: 't', updated_at: 't' });

    await drain({ jobId, pubkey: PUBKEY, action: 'delete-all', reason: 'Bulk delete-all by moderator', version: 0 });

    const row = jobDb.rows.get(jobId)!;
    expect(row.status).toBe('done');
    expect(row.events_processed).toBe(60);
    expect(row.media_processed).toBe(1);
  });

  it('resumes a delete-all continuation queued by the worker from before this change', async () => {
    relayFake(mixedEvents());
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

  // Replaceable and addressable kinds keep older versions; banning the newest
  // makes the previous one visible, so one cursor walk leaves events up.
  it('walks a replaceable kind\'s versions within one sweep, then confirms with an empty one', async () => {
    const { reqs } = relayFake([
      { id: 'p3', kind: 0, created_at: 30 }, { id: 'p2', kind: 0, created_at: 20 }, { id: 'p1', kind: 0, created_at: 10 },
      { id: 'a2', kind: 30023, created_at: 25, d: 'article' }, { id: 'a1', kind: 30023, created_at: 15, d: 'article' },
    ]);
    const res = await handleBulkModerateEnqueue(enqueueReq({ pubkey: PUBKEY, action: 'delete-kind', kind: 0 }), mockEnv, {});
    const { jobId } = await res.json() as BulkEnqueueResponse;

    const { messages } = await drain(sent[0]);

    expect(vi.mocked(banEvent).mock.calls.map((c) => c[0])).toEqual(['p3', 'p2', 'p1']);
    const row = jobDb.rows.get(jobId)!;
    expect(row.status).toBe('done');
    expect(row.events_processed).toBe(3);
    expect(JSON.parse(row.failures as string)).toEqual([]);
    // Sweep 0 walks down the history (until 29, 19, 9) to an empty page; sweep 1 confirms.
    expect(reqs.map((f) => f.until)).toEqual([expect.any(Number), 29, 19, 9, expect.any(Number)]);
    expect(messages.map((m) => m.sweep)).toEqual([0, 0, 0, 1]);
  });

  // One ceiling for the whole job, fixed at enqueue: start + 300s, past
  // funnelcake's 60s future-skew allowance.
  it('starts every sweep from one ceiling fixed at enqueue, carried on every message', async () => {
    const { reqs } = relayFake([{ id: 'p2', kind: 0, created_at: 20 }, { id: 'p1', kind: 0, created_at: 10 }]);
    let clock = 1_900_000_000_000;
    const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => (clock += 7_000)); // time moves on
    let messages: BulkJobMessage[] = [];
    let first: BulkJobMessage;
    let ceiling = 0;
    try {
      ceiling = Math.floor((clock + 7_000) / 1000) + 300;
      await handleBulkModerateEnqueue(enqueueReq({ pubkey: PUBKEY, action: 'delete-kind', kind: 0 }), mockEnv, {});
      first = sent[0];
      ({ messages } = await drain(first));
    } finally {
      nowSpy.mockRestore();
    }

    expect(reqs.map((f) => f.until)).toEqual([ceiling, 19, 9, ceiling]);
    expect([first!, ...messages].every((m) => m.sweepUntil === ceiling)).toBe(true);
  });

  it('bans an event stamped inside the relay\'s future-skew window', async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    relayFake([
      { id: 'future', kind: 1, created_at: nowSec + 30 },
      { id: 'past', kind: 1, created_at: nowSec - 10 },
    ]);
    const res = await handleBulkModerateEnqueue(enqueueReq({ pubkey: PUBKEY, action: 'delete-kind', kind: 1 }), mockEnv, {});
    const { jobId } = await res.json() as BulkEnqueueResponse;

    await drain(sent[0]);

    expect(vi.mocked(banEvent).mock.calls.map((c) => c[0]).sort()).toEqual(['future', 'past']);
    expect(jobDb.rows.get(jobId)!.status).toBe('done');
  });

  it('does not let an account posting during the job extend it past the ceiling', async () => {
    let clock = 1_900_000_000_000;
    const startSec = Math.floor(clock / 1000);
    const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => clock);
    let posts = 0;
    // Before every page the account posts again, stamped "now", and 400s pass.
    const { reqs } = relayFake([], {
      onReq: (store) => {
        store.push({ id: `post${posts++}`, kind: 1, created_at: Math.floor(clock / 1000) });
        clock += 400_000;
      },
    });
    let jobId = '';
    try {
      const res = await handleBulkModerateEnqueue(enqueueReq({ pubkey: PUBKEY, action: 'delete-kind', kind: 1 }), mockEnv, {});
      ({ jobId } = await res.json() as BulkEnqueueResponse);
      await drain(sent[0], 60);
    } finally {
      nowSpy.mockRestore();
    }

    // post0 (at the start) is inside the ceiling; every later post is after it.
    expect(vi.mocked(banEvent).mock.calls.map((c) => c[0])).toEqual(['post0']);
    expect(reqs.map((f) => f.until)).toEqual([startSec + 300, startSec + 300]);
    const row = jobDb.rows.get(jobId)!;
    expect(row.status).toBe('done');
    expect(JSON.parse(row.failures as string)).toEqual([]);
  });

  // The fallback is computed once and carried forward like an enqueue-time
  // ceiling: re-reading "now" for each sweep is what the ceiling exists to stop.
  it('falls back to one ceiling of now + 300s for a message without one, and carries it on', async () => {
    const { reqs } = relayFake([{ id: 'p2', kind: 0, created_at: 20 }, { id: 'p1', kind: 0, created_at: 10 }]);
    const jobId = 'job-no-ceiling';
    jobDb.rows.set(jobId, { job_id: jobId, pubkey: PUBKEY, action: 'delete-kind', status: 'pending', events_processed: 0, media_processed: 0, failures: '[]', failures_dropped: 0, version: 0, created_at: 't', updated_at: 't', kind: 0 });
    let clock = 1_900_000_000_000;
    const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => (clock += 7_000)); // time moves on
    let messages: BulkJobMessage[] = [];
    try {
      ({ messages } = await drain({ kindJobId: jobId, pubkey: PUBKEY, action: 'delete-kind', kind: 0, version: 0 }));
    } finally {
      nowSpy.mockRestore();
    }

    const ceiling = reqs[0].until as number;
    expect(ceiling).toBeGreaterThanOrEqual(1_900_000_000 + 300);
    expect(reqs.map((f) => f.until)).toEqual([ceiling, 19, 9, ceiling]);   // two sweeps, one ceiling
    expect(messages.length).toBeGreaterThan(0);
    expect(messages.every((m) => m.sweepUntil === ceiling)).toBe(true);
    expect(jobDb.rows.get(jobId)!.status).toBe('done');
  });

  it('deletes a 25-version history in one clean run', async () => {
    relayFake(Array.from({ length: 25 }, (_, i) => ({ id: `v${i}`, kind: 0, created_at: 100 - i })));
    const res = await handleBulkModerateEnqueue(enqueueReq({ pubkey: PUBKEY, action: 'delete-kind', kind: 0 }), mockEnv, {});
    const { jobId } = await res.json() as BulkEnqueueResponse;

    const { messages } = await drain(sent[0], 80);

    const row = jobDb.rows.get(jobId)!;
    expect(row.status).toBe('done');
    expect(row.events_processed).toBe(25);
    expect(JSON.parse(row.failures as string)).toEqual([]);
    expect(Math.max(...messages.map((m) => m.sweep ?? 0))).toBe(1);   // one walking sweep + one confirming
  });

  it('stops at the sweep bound when bans do not take effect, so the job never reads as clean', async () => {
    relayFake([{ id: 'v1', kind: 0, created_at: 20 }, { id: 'v0', kind: 0, created_at: 10 }], { bansTakeEffect: false });
    const res = await handleBulkModerateEnqueue(enqueueReq({ pubkey: PUBKEY, action: 'delete-kind', kind: 0 }), mockEnv, {});
    const { jobId } = await res.json() as BulkEnqueueResponse;

    await drain(sent[0], 200);

    const row = jobDb.rows.get(jobId)!;
    expect(row.status).toBe('done');
    expect(row.events_processed).toBe(40);                           // 2 per sweep x 20 sweeps
    expect(JSON.parse(row.failures as string)).toEqual([
      `enumeration:${PUBKEY}:still finding events after 20 sweeps; older versions may remain`,
    ]);
  });

  it('finishes a regular kind after one confirming empty sweep', async () => {
    const { reqs } = relayFake(mixedEvents());
    const res = await handleBulkModerateEnqueue(enqueueReq({ pubkey: PUBKEY, action: 'delete-kind', kind: 1 }), mockEnv, {});
    const { jobId } = await res.json() as BulkEnqueueResponse;

    const { messages } = await drain(sent[0]);

    expect(vi.mocked(banEvent)).toHaveBeenCalledTimes(30);
    expect(reqs).toHaveLength(2);                                 // the sweep, then the empty confirmation
    // The eventIds continuation carries the sweep's number and running total.
    expect(messages.map((m) => [m.sweep, m.sweepDeleted])).toEqual([[0, 20], [1, 0]]);
    expect(jobDb.rows.get(jobId)!.status).toBe('done');
    expect(JSON.parse(jobDb.rows.get(jobId)!.failures as string)).toEqual([]);
  });

  it('sweeps again when a sweep deleted events in earlier chunks but its last page was empty', async () => {
    // 200 events in one second: a saturated page, then a cursor page past that
    // second that comes back empty. The sweep still deleted 200.
    const { reqs } = relayFake(Array.from({ length: 200 }, (_, i) => ({ id: `s${i}`, kind: 1, created_at: 1000 })));
    const res = await handleBulkModerateEnqueue(enqueueReq({ pubkey: PUBKEY, action: 'delete-kind', kind: 1 }), mockEnv, {});
    const { jobId } = await res.json() as BulkEnqueueResponse;

    const { messages } = await drain(sent[0], 30);

    const cursorPage = messages.find((m) => m.cursor === '999' && !m.eventIds);
    expect(cursorPage).toMatchObject({ sweep: 0, sweepDeleted: 200 });
    expect(reqs.map((f) => f.until)).toEqual([expect.any(Number), 999, expect.any(Number)]);
    expect(reqs[2].until).toBeGreaterThan(1000);                 // a fresh sweep, not a continuation
    expect(jobDb.rows.get(jobId)!.events_processed).toBe(200);
  });

  // A ban that fails every time is hit again on every sweep. It is one failure,
  // and the moderator should read it as one.
  it('stores a failure that repeats across sweeps once', async () => {
    relayFake([
      { id: 'good1', kind: 1, created_at: 3 },
      { id: 'bad', kind: 1, created_at: 2 },
      { id: 'good2', kind: 1, created_at: 1 },
    ], { ban: (id) => (id === 'bad' ? { success: false, error: 'nope' } : { success: true }) });
    const res = await handleBulkModerateEnqueue(enqueueReq({ pubkey: PUBKEY, action: 'delete-kind', kind: 1 }), mockEnv, {});
    const { jobId } = await res.json() as BulkEnqueueResponse;

    await drain(sent[0]);

    expect(vi.mocked(banEvent).mock.calls.filter((c) => c[0] === 'bad')).toHaveLength(2); // hit on both sweeps
    const job = await (await handleBulkJobStatus(jobId, mockEnv, {})).json() as BulkJob;
    expect(job.status).toBe('done');
    expect(job.eventsProcessed).toBe(2);
    expect(job.failures).toEqual(['event:bad:nope']);
  });

  it('does not sweep again after a sweep that banned nothing, even if bans failed', async () => {
    const { reqs } = relayFake([{ id: 'p1', kind: 0, created_at: 10 }], { ban: () => ({ success: false, error: 'relay said no' }) });
    const res = await handleBulkModerateEnqueue(enqueueReq({ pubkey: PUBKEY, action: 'delete-kind', kind: 0 }), mockEnv, {});
    const { jobId } = await res.json() as BulkEnqueueResponse;

    await drain(sent[0]);

    // A failed ban leaves the event listed; another sweep would only fail again.
    // The one sweep walks below it (until 9) to an empty page, and no sweep follows.
    expect(reqs.map((f) => f.until)).toEqual([expect.any(Number), 9]);
    const row = jobDb.rows.get(jobId)!;
    expect(row.status).toBe('done');
    expect(JSON.parse(row.failures as string)).toEqual(['event:p1:relay said no']);
  });

  it('deletes only events of the kind, across pages, carrying the kind on every continuation', async () => {
    const { reqs } = relayFake(mixedEvents());
    const res = await handleBulkModerateEnqueue(enqueueReq({ pubkey: PUBKEY, action: 'delete-kind', kind: 1 }), mockEnv, {});
    const { jobId } = await res.json() as BulkEnqueueResponse;

    const { messages } = await drain(sent[0]);

    expect(reqs.length).toBeGreaterThan(0);
    expect(reqs.every((f) => JSON.stringify(f.kinds) === '[1]')).toBe(true);
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
    const many = Array.from({ length: 900 }, (_, i) => ({ id: `n${i}`, kind: i % 2 === 0 ? 1 : 7, created_at: 900 - i }));
    const { reqs } = relayFake(many);
    const jobId = 'job-kind-pages';
    jobDb.rows.set(jobId, { job_id: jobId, pubkey: PUBKEY, action: 'delete-kind', status: 'pending', events_processed: 0, media_processed: 0, failures: '[]', failures_dropped: 0, version: 0, created_at: 't', updated_at: 't', kind: 1 });

    await drain({ kindJobId: jobId, pubkey: PUBKEY, action: 'delete-kind', kind: 1, version: 0 }, 60);

    expect(reqs.some((f) => typeof f.until === 'number')).toBe(true);
    expect(reqs.every((f) => JSON.stringify(f.kinds) === '[1]')).toBe(true);
    expect(jobDb.rows.get(jobId)!.events_processed).toBe(450);
    expect(jobDb.rows.get(jobId)!.status).toBe('done');
  });

  it('does not touch media or resolve account-level tickets for a kind-scoped delete', async () => {
    relayFake(mixedEvents());
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

  // delete-kind only deletes, so it is not one of LOOSENS_AGE_REVIEW_HOLD's
  // loosening actions: like delete-all, a case opening mid-run, or a lookup
  // that fails, does not stop it (the enqueue guard already refused it on an
  // open case).
  it.each([
    ['an open age-review case', { openCaseFor: PUBKEY }],
    ['a failed case lookup', { lookupThrows: true }],
  ])('a kind-scoped delete keeps running when it meets %s mid-run', async (_label, ageReview) => {
    jobDb = makeJobDb(ageReview);
    mockEnv = { ...mockEnv, DB: jobDb.db };
    relayFake(mixedEvents());
    const jobId = 'job-kind-midrun';
    jobDb.rows.set(jobId, { job_id: jobId, pubkey: PUBKEY, action: 'delete-kind', status: 'running', events_processed: 0, media_processed: 0, failures: '[]', failures_dropped: 0, version: 1, created_at: 't', updated_at: 't', kind: 7 });

    await drain({ kindJobId: jobId, pubkey: PUBKEY, action: 'delete-kind', kind: 7, version: 1 });

    expect(jobDb.rows.get(jobId)!).toMatchObject({ status: 'done', events_processed: 30, failures: '[]' });
  });

  // #291 reads each blob's status before a media change. A kind-scoped delete
  // makes no media call at all, read or write, whatever state the account's
  // videos are in.
  it.each([
    ['open', 'active', 'unknown'],
    ['age-gated', 'age_restricted', 'age_restricted'],
    ['hidden', 'restricted', 'quarantine'],
    ['blocked', 'banned', 'permanent_ban'],
  ])('makes no media read or write for a kind-scoped delete when the account\'s video is %s', async (_label, blossom, recorded) => {
    blossomStatus.set(hashA, blossom);
    moderationStatus.set(hashA, recorded);
    relayFake(mixedEvents());
    const res = await handleBulkModerateEnqueue(enqueueReq({ pubkey: PUBKEY, action: 'delete-kind', kind: 7 }), mockEnv, {});
    const { jobId } = await res.json() as BulkEnqueueResponse;

    await drain(sent[0]);

    const fetchCalls = vi.mocked(globalThis.fetch).mock.calls.map((c) => String(c[0]));
    expect(fetchCalls.filter((u) => u.includes('/admin/api/blob/') || u.includes('/videos'))).toEqual([]);
    expect((mockEnv.MODERATION_API as unknown as { fetch: ReturnType<typeof vi.fn> }).fetch).not.toHaveBeenCalled();
    expect(jobDb.rows.get(jobId)!).toMatchObject({ status: 'done', events_processed: 30, media_processed: 0 });
  });

  it('records a cut-short listing as a gap, until a confirming sweep finds nothing left', async () => {
    // A full page with no usable created_at: the cursor cannot advance.
    relayFake(Array.from({ length: 200 }, (_, i) => ({ id: `x${i}`, kind: 1 })));
    const jobId = 'job-kind-cut';
    jobDb.rows.set(jobId, { job_id: jobId, pubkey: PUBKEY, action: 'delete-kind', status: 'pending', events_processed: 0, media_processed: 0, failures: '[]', failures_dropped: 0, version: 0, created_at: 't', updated_at: 't', kind: 1 });

    // The first chunk cannot page past its full, untimed page: it records the gap.
    sent.length = 0;
    await processBulkJob({ kindJobId: jobId, pubkey: PUBKEY, action: 'delete-kind', kind: 1, version: 0 }, mockEnv);
    expect(JSON.parse(jobDb.rows.get(jobId)!.failures as string).some((f: string) => /could not be fully paginated/.test(f))).toBe(true);

    await drain(sent[0], 30);

    // Every event was deleted and the final sweep, read from the ceiling, found
    // nothing: the gap is disproved and the job ends clean.
    const job = await (await handleBulkJobStatus(jobId, mockEnv, {})).json() as BulkJob;
    expect(job.status).toBe('done');
    expect(job.eventsProcessed).toBe(200);
    expect(job.failures).toEqual([]);
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
    relayFake(mixedEvents().slice(0, 4));
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
    relayFake(mixedEvents());
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
    relayFake(mixedEvents().slice(0, 2));
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

  // A large account must answer before the client's 30s request timeout, as a
  // lower bound the dialog already shows ("at least N"), not as an error.
  // The budget is a real bound: a page that could not finish inside it (its own
  // 10s timeout) is never started, so the answer beats the client's 30s abort.
  describe('time budget', () => {
    const all = Array.from({ length: 1200 }, (_, i) => ({ id: `e${i}`, kind: 1, created_at: 1200 - i }));

    beforeEach(() => { vi.useFakeTimers(); });
    afterEach(() => { vi.useRealTimers(); });

    it('does not start a page that could not finish inside the budget', async () => {
      const { reqs } = relayFake(all, { delayMs: 1_000 });

      const pending = handleBulkKindCounts(PUBKEY, { RELAY_URL: 'wss://relay.test' }, {}, 10_500);
      await vi.advanceTimersByTimeAsync(1_000);

      // After page 1 at t=1s, page 2 would need until t=11s: past the 10.5s budget.
      expect(await (await pending).json()).toEqual({ counts: { 1: 500 }, complete: false });
      expect(reqs).toHaveLength(1);
    });

    it('does not start a page that would end exactly at the budget', async () => {
      const { reqs } = relayFake(all, { delayMs: 1_000 });

      const pending = handleBulkKindCounts(PUBKEY, { RELAY_URL: 'wss://relay.test' }, {}, 11_000);
      await vi.advanceTimersByTimeAsync(1_000);

      // Page 2 would start at 1s and could run to 1s + 10s = 11s: exactly the
      // budget, which leaves no room to answer before it. It is not started.
      expect(await (await pending).json()).toEqual({ counts: { 1: 500 }, complete: false });
      expect(reqs).toHaveLength(1);
    });

    it('starts the next page when it can still finish inside the budget', async () => {
      const { reqs } = relayFake(all, { delayMs: 1_000 });

      const pending = handleBulkKindCounts(PUBKEY, { RELAY_URL: 'wss://relay.test' }, {}, 11_500);
      await vi.advanceTimersByTimeAsync(2_000);

      // Page 2 fits (1s + 10s < 11.5s); page 3 would not (2s + 10s >= 11.5s).
      // Page 2 restarts at page 1's oldest second (inclusive), so one event
      // repeats and is deduped: 500 + 499.
      expect(await (await pending).json()).toEqual({ counts: { 1: 999 }, complete: false });
      expect(reqs).toHaveLength(2);
    });

    it('keeps the counts it has when a later page times out', async () => {
      relayFake(all, { delayMs: 0, socket: (reqIndex) => (reqIndex >= 1 ? 'stall' : undefined) });

      const pending = handleBulkKindCounts(PUBKEY, { RELAY_URL: 'wss://relay.test' }, {}, 60_000);
      await vi.advanceTimersByTimeAsync(10_001);

      const res = await pending;
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ counts: { 1: 500 }, complete: false });
    });

    it('times out a connection that never opens', async () => {
      relayFake(all, { connect: 'never' });
      vi.spyOn(console, 'error').mockImplementation(() => {});

      const pending = handleBulkKindCounts(PUBKEY, { RELAY_URL: 'wss://relay.test' }, {}, 60_000);
      await vi.advanceTimersByTimeAsync(10_001);
      const settled = await Promise.race([pending, Promise.resolve('still pending' as const)]);

      expect(settled).not.toBe('still pending');
      expect((settled as Response).status).toBe(502);
    });
  });

  it('pages a large account fully when it finishes inside the budget', async () => {
    const all = Array.from({ length: 1200 }, (_, i) => ({ id: `e${i}`, kind: 1, created_at: 1200 - i }));
    relayFake(all);

    const res = await handleBulkKindCounts(PUBKEY, { RELAY_URL: 'wss://relay.test' }, {}, 60_000);

    expect(await res.json()).toEqual({ counts: { 1: 1200 }, complete: true });
  });

  it('defaults to a 20s budget, under the client\'s request timeout', () => {
    expect(KIND_COUNT_BUDGET_MS).toBe(20_000);
    expect(KIND_COUNT_BUDGET_MS).toBeLessThan(KIND_COUNTS_REQUEST_TIMEOUT_MS);
  });

  it('does not count events of another author the relay returns', async () => {
    relayFake([
      { id: 'mine', kind: 1, created_at: 2 },
      { id: 'theirs', kind: 7, created_at: 1, pubkey: 'b'.repeat(64) },
    ], { ignore: { authors: true } });
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    const res = await handleBulkKindCounts(PUBKEY, { RELAY_URL: 'wss://relay.test' }, {});

    expect(await res.json()).toEqual({ counts: { 1: 1 }, complete: true });
  });

  it('counts every event by kind across pages and says the listing is complete', async () => {
    // 1200 events over three relay pages: 800 kind 1, 400 kind 7.
    const all = Array.from({ length: 1200 }, (_, i) => ({ id: `e${i}`, kind: i % 3 === 0 ? 7 : 1, created_at: 1200 - i }));
    const { reqs } = relayFake(all);

    const res = await handleBulkKindCounts(PUBKEY, { RELAY_URL: 'wss://relay.test' }, {});

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ counts: { 1: 800, 7: 400 }, complete: true });
    expect(reqs.length).toBeGreaterThan(1);
  });

  it('says the listing is incomplete when the relay cannot be fully paginated', async () => {
    const all = Array.from({ length: 600 }, (_, i) => ({ id: `e${i}`, kind: 1, created_at: 1000 }));
    relayFake(all);

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
    relayFake([], { connect: 'error' });
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const res = await handleBulkKindCounts(PUBKEY, { RELAY_URL: 'wss://relay.test' }, {});

    expect(res.status).toBe(502);
    // The dialog adds its own "Could not count..." lead-in; the worker sends only the cause.
    expect(await res.json()).toEqual({ error: 'Relay query failed' });
  });
});

describe('delete-kind against a hostile relay', () => {
  const P = 'a'.repeat(64);
  const OTHER = 'b'.repeat(64);
  const now = () => Math.floor(Date.now() / 1000);
  let jobDb: ReturnType<typeof makeJobDb>;
  let sent: BulkJobMessage[];
  let env: BulkModerateEnv;

  beforeEach(() => {
    vi.restoreAllMocks();
    vi.mocked(getAdminPubkey).mockResolvedValue('moderator-pubkey');
    vi.mocked(banEvent).mockReset().mockResolvedValue({ success: true });
    jobDb = makeJobDb();
    sent = [];
    env = { ...baseEnv(), DB: jobDb.db, BULK_QUEUE: { send: vi.fn(async (m: BulkJobMessage) => { sent.push(m); }) } as unknown as Queue<BulkJobMessage> };
  });

  // `kind` null runs a delete-all job instead.
  async function runJob(kind: number | null, maxIter = 200) {
    const body = kind === null ? { pubkey: P, action: 'delete-all' } : { pubkey: P, action: 'delete-kind', kind };
    const res = await handleBulkModerateEnqueue(new Request('https://t/api/bulk-moderate', {
      method: 'POST', body: JSON.stringify(body),
    }), env, {});
    const { jobId } = await res.json() as BulkEnqueueResponse;
    const { chunks, terminated } = await drainJob(env, sent, sent[0], maxIter);
    const job = await (await handleBulkJobStatus(jobId, env, {})).json() as BulkJob;
    return { job, chunks, terminated };
  }

  // The walk ends only because each page's next `until` is below the one asked.
  // A relay that answers above `until` would repeat the page forever, each
  // chunk refreshing updated_at so the stale heal never fires.
  describe('the cursor must advance', () => {
    it('fails a versioned walk whose relay ignores `until` and whose one event cannot be banned', async () => {
      relayFake([{ id: 'stuck', kind: 30023, created_at: now() - 1000, d: 'x' }], { ignore: { until: true }, ban: () => BAN_REFUSED });

      const { job, chunks, terminated } = await runJob(30023);

      expect(terminated).toBe(true);
      expect(chunks).toBeLessThanOrEqual(5);
      expect(job.status).toBe('failed');
      expect(job.failures.some((f) => /relay cursor did not advance/.test(f))).toBe(true);
    });

    it('fails a full regular-kind page repeated by a relay that ignores `until`', async () => {
      const t = now() - 1000;
      relayFake(
        Array.from({ length: 250 }, (_, i) => ({ id: `e${String(i).padStart(3, '0')}`, kind: 1, created_at: t - Math.floor(i / 2) })),
        { ignore: { until: true }, ban: () => BAN_REFUSED },
      );

      const { job, chunks, terminated } = await runJob(1);

      expect(terminated).toBe(true);
      expect(chunks).toBeLessThanOrEqual(15);
      expect(job.status).toBe('failed');
      expect(job.failures.some((f) => /relay cursor did not advance/.test(f))).toBe(true);
    });

    it('fails a versioned walk that keeps getting an out-of-scope event from a relay that ignores `until`', async () => {
      const theirs: RelayEvent = { id: 'theirs', pubkey: OTHER, kind: 30023, created_at: now() - 1005, d: 'y' };
      relayFake([{ id: 'mine', kind: 30023, created_at: now() - 1000, d: 'x' }, theirs], {
        ignore: { until: true },
        frames: (events) => (events.some((e) => e.id === 'theirs') ? events : [...events, theirs]),
      });

      const { job, chunks, terminated } = await runJob(30023);

      expect(terminated).toBe(true);
      expect(chunks).toBeLessThanOrEqual(5);
      expect(job.status).toBe('failed');
      expect(job.failures.some((f) => /relay cursor did not advance/.test(f))).toBe(true);
    });

    it('bans and counts each event once when the relay repeats every frame', async () => {
      const t = now() - 10_000;
      relayFake(
        Array.from({ length: 700 }, (_, i) => ({ id: `e${String(i).padStart(4, '0')}`, kind: 1, created_at: t - i })),
        { frames: (events) => [...events, ...events] },
      );

      const { job } = await runJob(1);

      const banCalls = vi.mocked(banEvent).mock.calls.map((c) => c[0]);
      expect(job.status).toBe('done');
      expect(banCalls).toHaveLength(700);
      expect(new Set(banCalls).size).toBe(700);
      expect(job.eventsProcessed).toBe(700);
      expect(jobDb.batched.filter((b) => /INSERT INTO moderation_decisions/.test(b.sql))).toHaveLength(700);
    });

    it('stores a failing ban in a repeated frame once', async () => {
      relayFake([{ id: 'bad', kind: 1, created_at: now() - 1000 }], {
        ban: () => BAN_REFUSED,
        frames: (events) => [...events, ...events],
      });

      const { job } = await runJob(1);

      expect(job.failures).toEqual(['event:bad:relay refused']);
    });

    // Funnelcake answers a failed query with CLOSED. That is the relay's
    // answer, not silence: fail at once, with its reason, not after 10s.
    it('fails a delete-kind job at once, with the relay\'s reason, when a page is CLOSED', async () => {
      relayFake([{ id: 'e', kind: 1, created_at: now() - 1000 }], { socket: () => 'closed' });
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      try {
        const { job } = await runJob(1);                      // no timer advanced: a 10s wait would hang

        expect(job.status).toBe('failed');
        expect(job.failures).toEqual(['job:Relay closed the query: error: could not complete query']);
      } finally {
        vi.useRealTimers();
      }
    });

    it('returns a 502 at once, with the relay\'s reason, when the count listing is CLOSED', async () => {
      relayFake([{ id: 'e', kind: 1, created_at: now() - 1000 }], { socket: () => 'closed' });
      vi.spyOn(console, 'error').mockImplementation(() => {});
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      try {
        const res = await handleBulkKindCounts(P, env, {});   // no timer advanced

        expect(res.status).toBe(502);
        expect(await res.json()).toEqual({ error: 'Relay closed the query: error: could not complete query' });
      } finally {
        vi.useRealTimers();
      }
    });

    it('ignores a CLOSED for another subscription', async () => {
      relayFake([{ id: 'e', kind: 1, created_at: now() - 1000 }], { socket: () => 'closed-other' });

      const { job } = await runJob(1);
      const counts = await handleBulkKindCounts(P, env, {});

      expect(job).toMatchObject({ status: 'done', eventsProcessed: 1, failures: [] });
      expect(counts.status).toBe(200);
    });

    // A gap warning from an earlier sweep ("some may be unprocessed") is
    // disproved by a final sweep that read from the ceiling and found nothing.
    it('ends clean when later sweeps delete everything an earlier sweep warned about', async () => {
      const t = now() - 100;
      const relay = relayFake(Array.from({ length: 450 }, (_, i) => ({ id: `s${String(i).padStart(4, '0')}`, kind: 1, created_at: t })));

      const { job } = await runJob(1);

      expect(relay.query({ authors: [P], kinds: [1] })).toHaveLength(0);
      expect(job.status).toBe('done');
      expect(job.eventsProcessed).toBe(450);
      expect(job.failures).toEqual([]);
    });

    // Only an empty final page disproves a gap. One that still lists events,
    // here one whose ban always fails, is not an empty read.
    it('keeps an earlier gap warning when the final sweep\'s page still lists an event it could not ban', async () => {
      const t = now() - 100;
      relayFake([
        ...Array.from({ length: 250 }, (_, i) => ({ id: `s${String(i).padStart(4, '0')}`, kind: 1, created_at: t })),
        { id: 'stuck', kind: 1, created_at: t - 10 },
      ], { ban: (id) => (id === 'stuck' ? BAN_REFUSED : { success: true }) });

      const { job } = await runJob(1);

      expect(job.status).toBe('done');
      expect(job.eventsProcessed).toBe(250);
      expect(job.failures).toEqual([
        sameSecondGapWarning(P, 200),
        'event:stuck:relay refused',
      ]);
    });

    it('keeps a gap warning recorded on the final sweep itself', async () => {
      const t = now() - 100;
      // Every ban fails: the one sweep is also the last, and its warning stands.
      relayFake(Array.from({ length: 250 }, (_, i) => ({ id: `s${String(i).padStart(4, '0')}`, kind: 1, created_at: t })), { ban: () => BAN_REFUSED });

      const { job } = await runJob(1);

      expect(job.status).toBe('done');
      expect(job.failures.some((f) => /share one timestamp/.test(f))).toBe(true);
    });

    it('keeps earlier ban failures and out-of-scope warnings while dropping the disproved gap warning', async () => {
      const t = now() - 100;
      const store: RelayEvent[] = Array.from({ length: 250 }, (_, i) => ({ id: `s${String(i).padStart(4, '0')}`, kind: 1, created_at: t }));
      let refusedOnce = false;
      let firstPage = true;
      relayFake(store, {
        // Fails once, then works.
        ban: (id) => (id === 's0249' && !refusedOnce ? ((refusedOnce = true), BAN_REFUSED) : { success: true }),
        frames: (events) => {
          if (!firstPage) return events;
          firstPage = false;
          return [...events, { id: 'theirs', pubkey: OTHER, kind: 1, created_at: t }];
        },
      });

      const { job } = await runJob(1);

      expect(job.status).toBe('done');
      expect(job.failures).toEqual([
        'event:s0249:relay refused',
        `enumeration:${P}:relay returned 1 event(s) outside the requested author or kind; ignored them`,
      ]);
    });

    it('keeps earlier gap warnings when the final sweep itself saw out-of-scope events', async () => {
      const t = now() - 100;
      const theirs: RelayEvent = { id: 'theirs', pubkey: OTHER, kind: 1, created_at: t };
      relayFake(
        Array.from({ length: 250 }, (_, i) => ({ id: `s${String(i).padStart(4, '0')}`, kind: 1, created_at: t })),
        { frames: (events) => [...events, theirs] },                 // on every page, the last included
      );

      const { job } = await runJob(1);

      expect(job.status).toBe('done');
      expect(job.failures.some((f) => /share one timestamp/.test(f))).toBe(true);
      expect(job.failures.some((f) => /outside the requested author or kind/.test(f))).toBe(true);
    });

    // The count and the delete must agree on what they look at: the delete
    // never reaches past its ceiling, so the count must not either.
    it('counts only events at or below the ceiling the delete would use', async () => {
      const { reqs } = relayFake([
        { id: 'old', kind: 1, created_at: now() - 1000 },
        { id: 'soon', kind: 1, created_at: now() + 30 },
        { id: 'far', kind: 1, created_at: now() + 3600 },
      ]);

      const res = await handleBulkKindCounts(P, env, {});

      expect(await res.json()).toEqual({ counts: { 1: 2 }, complete: true });
      expect(reqs[0].until).toBeGreaterThanOrEqual(now() + 300 - 1);
      expect(reqs[0].until).toBeLessThanOrEqual(now() + 300);
    });

    // delete-all pages the same way and runs on the same single-consumer queue,
    // so a relay that ignores `until` must not loop it forever either.
    it('fails a delete-all job whose relay ignores `until` and repeats a full page of failing bans', async () => {
      const t = now() - 1000;
      const { reqs } = relayFake(
        Array.from({ length: 250 }, (_, i) => ({ id: `e${String(i).padStart(3, '0')}`, kind: 1, created_at: t - Math.floor(i / 2) })),
        { ignore: { until: true }, ban: () => BAN_REFUSED },
      );
      const moderate = (env.MODERATION_API as unknown as { fetch: ReturnType<typeof vi.fn> }).fetch;

      const { job, chunks, terminated } = await runJob(null);

      expect(terminated).toBe(true);
      expect(chunks).toBeLessThanOrEqual(15);
      expect(job.status).toBe('failed');
      expect(job.failures.some((f) => /relay cursor did not advance/.test(f))).toBe(true);
      expect(moderate).not.toHaveBeenCalled();                        // never reached the media phase
      expect(reqs.every((f) => !('kinds' in f))).toBe(true);
    });

    it('ends a versioned walk at created_at 0 instead of asking for until -1', async () => {
      const { reqs } = relayFake([
        { id: 'v1', kind: 0, created_at: now() - 100 },
        { id: 'v0', kind: 0, created_at: 0 },
      ]);

      const { job } = await runJob(0);

      expect(job.status).toBe('done');
      expect(job.eventsProcessed).toBe(2);
      expect(reqs.every((f) => (f.until as number) >= 0)).toBe(true);
    });
  });
});

describe('queryRelayEvents pagination', () => {
  beforeEach(() => vi.restoreAllMocks());

  // Only the time-budgeted count listing keeps a partial set on a late timeout.
  // The synchronous delete-all path must still fail, not act on part of the account.
  it('still rejects when a later page stalls, with no time budget', async () => {
    vi.useFakeTimers();
    try {
      relayFake(Array.from({ length: 1000 }, (_, i) => ({ id: `e${i}`, kind: 1, created_at: 1000 - i })), {
        socket: (reqIndex) => (reqIndex >= 1 ? 'stall' : undefined),   // page 2 never answers
      });

      const pending = queryRelayEvents('a'.repeat(64), { RELAY_URL: 'wss://relay.test' });
      const outcome = pending.then(() => 'resolved', (e: Error) => e.message);
      await vi.advanceTimersByTimeAsync(10_001);

      expect(await outcome).toBe('Relay query timed out before EOSE');
    } finally {
      vi.useRealTimers();
    }
  });

  it('pages through >500 events via until cursor instead of rejecting', async () => {
    // 1200 events with distinct descending created_at -> 3 pages (500/500/200).
    const all = Array.from({ length: 1200 }, (_, i) => ({ id: `e${i}`, kind: 1, created_at: 1200 - i }));
    relayFake(all);
    const { events, complete } = await queryRelayEvents('a'.repeat(64), { RELAY_URL: 'wss://relay.test' });
    expect(events).toHaveLength(1200); // all collected, deduped across page boundaries; no throw
    expect(complete).toBe(true);
  });

  it('terminates and reports incomplete when >1 page of events share one created_at', async () => {
    // 600 events all at the same second: an inclusive `until` cursor cannot
    // subdivide a second, so it must not loop forever or silently report success.
    const all = Array.from({ length: 600 }, (_, i) => ({ id: `e${i}`, kind: 1, created_at: 1000 }));
    relayFake(all);
    const { events, complete } = await queryRelayEvents('a'.repeat(64), { RELAY_URL: 'wss://relay.test' });
    expect(complete).toBe(false);            // surfaced, not a silent success
    expect(events.length).toBe(500);         // escaped the saturated second after one page
    expect(events.length).toBeLessThan(600); // the excess at that second was not silently claimed as done
  });
});
