import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  runBulkModeration,
  handleBulkModerateEnqueue,
  processBulkJob,
  handleBulkJobStatus,
  queryRelayEvents,
  type BulkModerateEnv,
} from './bulk-moderate';
import type { BulkJob, BulkJobMessage, BulkEnqueueResponse } from '../../shared/bulk-moderation';

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

// Functional in-memory D1 mock for the bulk_jobs table: supports the INSERT,
// positional-SET UPDATE, and SELECT-by-job_id statements the async path uses.
function makeJobDb() {
  const rows = new Map<string, Record<string, unknown>>();
  const db = {
    prepare(sql: string) {
      let binds: unknown[] = [];
      const stmt = {
        bind(...args: unknown[]) { binds = args; return stmt; },
        async run() {
          if (/^\s*INSERT INTO bulk_jobs/i.test(sql)) {
            const [job_id, pubkey, action, status, events_processed, media_processed, failures, created_at, updated_at] = binds;
            rows.set(job_id as string, { job_id, pubkey, action, status, events_processed, media_processed, failures, created_at, updated_at });
          } else if (/^\s*UPDATE bulk_jobs/i.test(sql)) {
            const cols = sql.match(/SET (.+) WHERE/i)![1].split(',').map((c) => c.trim().split('=')[0].trim());
            const jobId = binds[binds.length - 1] as string;
            const row = rows.get(jobId);
            if (row) cols.forEach((c, i) => { row[c] = binds[i]; });
          } else if (/^\s*DELETE FROM bulk_jobs/i.test(sql)) {
            rows.delete(binds[0] as string);
          }
          return { success: true };
        },
        async first() { return rows.get(binds[0] as string) ?? null; },
      };
      return stmt;
    },
    batch: async () => [],
  };
  return { db: db as unknown as D1Database, rows };
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

describe('runBulkModeration', () => {
  let mockEnv: BulkModerateEnv;

  beforeEach(() => {
    vi.restoreAllMocks();
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
    const { banEvent } = await import('./nip86');
    vi.mocked(banEvent).mockResolvedValueOnce({ success: false, error: 'relay refused' });
    mockRelay([{ id: 'e'.repeat(64), kind: 1, content: '', tags: [] }]);

    const result = await runBulkModeration(mockEnv, 'a'.repeat(64), 'delete-all', 'r');
    expect(result.success).toBe(false);
    expect(result.eventsProcessed).toBe(0);
    expect(result.failures[0]).toContain('relay refused');
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
    expect(sent[0]).toMatchObject({ jobId: body.jobId, pubkey: 'a'.repeat(64), action: 'age-restrict-all' });
  });

  it('enqueue validates the action/pubkey and does NOT enqueue on a bad request', async () => {
    const bad = await handleBulkModerateEnqueue(enqueueReq({ pubkey: 'short', action: 'age-restrict-all' }), mockEnv, {});
    expect(bad.status).toBe(400);
    const badAction = await handleBulkModerateEnqueue(enqueueReq({ pubkey: 'a'.repeat(64), action: 'nope' }), mockEnv, {});
    expect(badAction.status).toBe(400);
    expect(sent).toHaveLength(0);
  });

  it('processBulkJob runs the work and writes status=done with counts', async () => {
    const jobId = 'job-done-1';
    jobDb.rows.set(jobId, { job_id: jobId, pubkey: 'a'.repeat(64), action: 'age-restrict-all', status: 'pending', events_processed: 0, media_processed: 0, failures: '[]', created_at: 't', updated_at: 't' });

    await processBulkJob({ jobId, pubkey: 'a'.repeat(64), action: 'age-restrict-all' }, mockEnv);

    const row = jobDb.rows.get(jobId)!;
    expect(row.status).toBe('done');
    expect(row.media_processed).toBe(2); // hashA + hashB, both from REST
    expect(moderationActionFor(mockEnv, hashA)).toBe('QUARANTINE');
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
    const { banEvent } = await import('./nip86');
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
