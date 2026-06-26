import { getAdminPubkey, banEvent, publishKind5Deletion, type Nip86Env } from './nip86';
import { syncZendeskAfterAction, type ZendeskSyncEnv } from './zendesk-sync';
import {
  VALID_BULK_ACTIONS,
  type BulkAction,
  type BulkModerateResult,
  type BulkJob,
  type BulkJobMessage,
  type BulkJobPhase,
  type BulkEnqueueResponse,
} from '../../shared/bulk-moderation';
import { deriveFunnelcakeApiUrl } from './funnelcake-proxy';

const BULK_ACTION_CONCURRENCY = 5;
// Page through ALL of an author's events via `until` cursoring instead of
// rejecting accounts with more than one page. The old reject left prolific
// accounts entirely un-enforced (the throw was swallowed upstream).
const RELAY_QUERY_PAGE_SIZE = 500;
const RELAY_QUERY_MAX_PAGES = 100; // safety bound (~50k events); logged if hit, never silent
const RELAY_QUERY_TIMEOUT_MS = 10000; // per-page (reset each page)
const EVENT_CHUNK_SIZE = 200; // chunked consumer: ~400 subrequests/chunk (ban + kind-5 per event)

export interface BulkModerateEnv extends Nip86Env, ZendeskSyncEnv {
  DB?: D1Database;
  MODERATION_API?: Fetcher;
  MODERATION_ADMIN_URL?: string;
  SERVICE_API_TOKEN?: string | { get(): Promise<string> };
  // Explicit Funnelcake REST API URL; derived from RELAY_URL when unset.
  FUNNELCAKE_API_URL?: string;
  BULK_QUEUE?: Queue<BulkJobMessage>;
}

interface RelayEventSummary {
  id: string;
  kind: number;
  content: string;
  tags: string[][];
}

function json(data: unknown, status: number, corsHeaders: Record<string, string>): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders },
  });
}

// Per-item chunk helpers, shared by the synchronous runBulkModeration (age-review)
// and the chunked queue consumer (processBulkJob).

async function moderateMediaHashes(
  env: BulkModerateEnv, hashes: string[], mediaAction: string, reason: string,
): Promise<{ processed: number; failures: string[] }> {
  let processed = 0;
  const failures: string[] = [];
  await runWithConcurrency(hashes, BULK_ACTION_CONCURRENCY, async (sha256) => {
    try {
      await callModerateMedia(sha256, mediaAction, reason, env);
      processed++;
    } catch (error) {
      failures.push(`media:${sha256}:${formatError(error)}`);
    }
  });
  return { processed, failures };
}

async function writeDecisionBatch(
  env: BulkModerateEnv, eventIds: string[], reason: string, moderatorPubkey: string,
): Promise<void> {
  if (!env.DB || eventIds.length === 0) return;
  // Non-critical audit write (the relay deletes already happened): log and
  // continue, never abort the run and mislabel a completed destructive run.
  try {
    await env.DB.batch(
      eventIds.map((eventId) => env.DB!.prepare(
        `INSERT INTO moderation_decisions (target_type, target_id, action, reason, moderator_pubkey, created_at) VALUES (?, ?, ?, ?, ?, datetime('now'))`
      ).bind('event', eventId, 'delete_event', reason, moderatorPubkey))
    );
  } catch (error) {
    console.error('[bulk-moderate] decision-log batch insert failed (non-critical):', formatError(error));
  }
}

async function deleteEvents(
  env: BulkModerateEnv, events: RelayEventSummary[], reason: string, moderatorPubkey: string,
): Promise<{ processed: number; successfulEventIds: string[]; failures: string[] }> {
  let processed = 0;
  const successfulEventIds: string[] = [];
  const failures: string[] = [];
  await runWithConcurrency(events, BULK_ACTION_CONCURRENCY, async (event) => {
    try {
      const banResult = await banEvent(event.id, reason, env);
      if (!banResult.success) throw new Error(banResult.error || 'banevent failed');
      const deleteResult = await publishKind5Deletion(event.id, reason, env);
      if (!deleteResult.success) throw new Error(deleteResult.error || 'kind 5 deletion failed');
      processed++;
      successfulEventIds.push(event.id);
    } catch (error) {
      failures.push(`event:${event.id}:${formatError(error)}`);
    }
  });
  await writeDecisionBatch(env, successfulEventIds, reason, moderatorPubkey);
  await runWithConcurrency(successfulEventIds, BULK_ACTION_CONCURRENCY, async (eventId) => {
    await syncZendeskAfterAction(env, 'delete_event', 'event', eventId, moderatorPubkey);
  });
  return { processed, successfulEventIds, failures };
}

// Runs the WHOLE enumerate->action job synchronously, in one invocation. Used by
// the age-review enforcement path, which needs the result inline for the case's
// enforcement-leg status. The moderator-facing UI path uses the chunked queue
// consumer (processBulkJob) instead, which drains any account size.
//
// Scope note: because this runs in one invocation, a very large account can still
// hit the Workers per-invocation subrequest/CPU ceiling and land `failed` here
// (BULK_ACTION_CONCURRENCY changes parallelism, not the total subrequest count).
// That is acceptable for age-review (it fails visibly on the case; the moderator
// re-runs from the chunked Users-page path).
export async function runBulkModeration(
  env: BulkModerateEnv,
  pubkey: string,
  action: BulkAction,
  reason: string,
): Promise<BulkModerateResult> {
  const moderatorPubkey = await getAdminPubkey(env);
  const result: BulkModerateResult = { success: true, eventsProcessed: 0, mediaProcessed: 0, failures: [] };

  if (action === 'delete-all') {
    // Events come from the relay (WebSocket, paginated) for the event IDs;
    // media hashes from the funnelcake REST API (dedup-correct, all videos).
    const [{ events, complete }, mediaHashes] = await Promise.all([
      queryRelayEvents(pubkey, env),
      queryUserMediaHashes(pubkey, env),
    ]);
    if (!complete) {
      result.failures.push(`enumeration:${pubkey}:relay could not be fully paginated; actioned a partial set`);
    }
    const ev = await deleteEvents(env, events, reason, moderatorPubkey);
    result.eventsProcessed = ev.processed;
    result.failures.push(...ev.failures);
    if (ev.successfulEventIds.length > 0) {
      await syncZendeskAfterAction(env, 'delete_event', 'pubkey', pubkey, moderatorPubkey);
    }
    const media = await moderateMediaHashes(env, mediaHashes, 'DELETE', reason);
    result.mediaProcessed = media.processed;
    result.failures.push(...media.failures);
  } else {
    // age-restrict-all / un-age-restrict-all are media-only.
    // QUARANTINE -> RESTRICT -> blossom Restricted (404s to everyone but the owner,
    // reversible). 'AGE_RESTRICTED' would serve full bytes to any signed-in viewer,
    // so it must NOT be used to hide a minor's content. Clear sends 'SAFE'.
    const mediaHashes = await queryUserMediaHashes(pubkey, env);
    result.eventsProcessed = mediaHashes.length; // one video == one event for video kinds
    const mediaAction = action === 'age-restrict-all' ? 'QUARANTINE' : 'SAFE';
    const media = await moderateMediaHashes(env, mediaHashes, mediaAction, reason);
    result.mediaProcessed = media.processed;
    result.failures.push(...media.failures);
  }

  result.success = result.failures.length === 0;
  return result;
}

// On-demand schema, matching the repo's ensureDecisionsTable/ensureZendeskTable
// pattern (no migration runner).
export async function ensureBulkJobsTable(db: D1Database): Promise<void> {
  await db.prepare(
    `CREATE TABLE IF NOT EXISTS bulk_jobs (
      job_id TEXT PRIMARY KEY,
      pubkey TEXT NOT NULL,
      action TEXT NOT NULL,
      status TEXT NOT NULL,
      events_processed INTEGER NOT NULL DEFAULT 0,
      media_processed INTEGER NOT NULL DEFAULT 0,
      failures TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`
  ).run();
}

interface BulkJobRow {
  job_id: string;
  pubkey: string;
  action: string;
  status: string;
  events_processed: number;
  media_processed: number;
  failures: string;
  created_at: string;
  updated_at: string;
}

function rowToBulkJob(row: BulkJobRow): BulkJob {
  let failures: string[] = [];
  try { failures = JSON.parse(row.failures) as string[]; } catch { failures = []; }
  return {
    jobId: row.job_id,
    pubkey: row.pubkey,
    action: row.action as BulkJob['action'],
    status: row.status as BulkJob['status'],
    eventsProcessed: Number(row.events_processed) || 0,
    mediaProcessed: Number(row.media_processed) || 0,
    failures,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// Producer: validate, persist a pending job, enqueue, and return the jobId
// immediately. The actual O(N/5) work runs in the queue consumer (processBulkJob)
// so a large account can never hang the request.
export async function handleBulkModerateEnqueue(
  request: Request,
  env: BulkModerateEnv,
  corsHeaders: Record<string, string>,
): Promise<Response> {
  const body = await request.json() as { pubkey?: string; action?: string; reason?: string };

  if (!body.pubkey || !/^[0-9a-f]{64}$/.test(body.pubkey)) {
    return json({ error: 'Valid 64-char hex pubkey required' }, 400, corsHeaders);
  }
  if (!body.action || !VALID_BULK_ACTIONS.includes(body.action as BulkAction)) {
    return json({ error: `Invalid action. Must be one of: ${VALID_BULK_ACTIONS.join(', ')}` }, 400, corsHeaders);
  }
  if (!env.DB) {
    return json({ error: 'bulk_jobs storage (D1) is not bound' }, 500, corsHeaders);
  }
  if (!env.BULK_QUEUE) {
    return json({ error: 'bulk-moderate queue is not bound' }, 500, corsHeaders);
  }

  const action = body.action as BulkAction;
  const reason = body.reason || `Bulk ${action} by moderator`;
  const jobId = crypto.randomUUID();
  const now = new Date().toISOString();

  await ensureBulkJobsTable(env.DB);
  await env.DB.prepare(
    `INSERT INTO bulk_jobs (job_id, pubkey, action, status, events_processed, media_processed, failures, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(jobId, body.pubkey, action, 'pending', 0, 0, '[]', now, now).run();

  try {
    await env.BULK_QUEUE.send({ jobId, pubkey: body.pubkey, action, reason });
  } catch (error) {
    // Roll back the orphaned pending row so it can't linger unprocessed.
    await env.DB.prepare('DELETE FROM bulk_jobs WHERE job_id = ?').bind(jobId).run().catch(() => {});
    console.error('[bulk-moderate] enqueue failed for', jobId, error);
    return json({ error: 'Failed to enqueue bulk moderation job' }, 500, corsHeaders);
  }

  return json({ success: true, jobId } satisfies BulkEnqueueResponse, 200, corsHeaders);
}

// A job whose row hasn't advanced past pending/running within this window is
// treated as abandoned (e.g. the worker was evicted mid-consume, and with
// max_retries=0 the message is gone). Generous because a large account can run
// for minutes; the per-invocation subrequest/CPU ceiling caps real runtime well
// under this. The frontend poller should also bound its own wait.
const STALE_JOB_MS = 30 * 60 * 1000;

// Consumer: run one job to completion and write its terminal state. Any error is
// recorded as `failed` and swallowed (not rethrown) so the queue does not retry a
// half-applied DESTRUCTIVE job — re-running is a manual operator action.
// TODO(#async-retry): revisit once jobs are idempotent.
const MAX_STORED_FAILURES = 50;

function appendFailures(existing: string[], added: string[]): string[] {
  const merged = existing.filter((f) => !/^\+\d+ more$/.test(f)).concat(added);
  if (merged.length <= MAX_STORED_FAILURES) return merged;
  return merged.slice(0, MAX_STORED_FAILURES).concat(`+${merged.length - MAX_STORED_FAILURES} more`);
}

// Consumer: process ONE chunk of a job, persist incremental progress, then
// re-enqueue the next chunk (carrying a continuation cursor) or finalize. One
// chunk per invocation (max_batch_size=1) keeps any account size under the
// per-invocation subrequest ceiling. The whole body is wrapped so any failure
// lands a terminal `failed` state rather than stranding the row.
export async function processBulkJob(msg: BulkJobMessage, env: BulkModerateEnv): Promise<void> {
  if (!env.DB) throw new Error('bulk_jobs storage (D1) is not bound');
  const db = env.DB;
  try {
    await ensureBulkJobsTable(db);
    const row = await db.prepare('SELECT * FROM bulk_jobs WHERE job_id = ?').bind(msg.jobId).first<BulkJobRow>();
    if (!row) return;                                          // unknown job: nothing to do
    const job = rowToBulkJob(row);
    if (job.status === 'done' || job.status === 'failed') return; // idempotent: already terminal

    const reason = msg.reason || `Bulk ${msg.action} by moderator`;
    const moderatorPubkey = await getAdminPubkey(env);
    const phase: BulkJobPhase = msg.phase ?? (msg.action === 'delete-all' ? 'events' : 'media');

    await db.prepare('UPDATE bulk_jobs SET status = ?, updated_at = ? WHERE job_id = ?')
      .bind('running', new Date().toISOString(), msg.jobId).run();

    let eventsDelta = 0;
    let mediaDelta = 0;
    const chunkFailures: string[] = [];
    let next: BulkJobMessage | null = null;

    if (phase === 'events') {
      const until = msg.cursor ? Number(msg.cursor) : undefined;
      const page = await queryRelayEventsPage(msg.pubkey, env, until);
      const ev = await deleteEvents(env, page.events, reason, moderatorPubkey);
      eventsDelta = ev.processed;
      chunkFailures.push(...ev.failures);
      if (!page.complete && page.nextUntil === null) {
        chunkFailures.push(`enumeration:${msg.pubkey}:relay could not be fully paginated; some events may be unprocessed`);
      }
      if (page.complete || page.nextUntil === null) {
        // Events done: one pubkey-level zendesk sync, then move to the media phase.
        if (ev.successfulEventIds.length > 0) {
          await syncZendeskAfterAction(env, 'delete_event', 'pubkey', msg.pubkey, moderatorPubkey);
        }
        next = { jobId: msg.jobId, pubkey: msg.pubkey, action: msg.action, reason, phase: 'media' };
      } else {
        next = { jobId: msg.jobId, pubkey: msg.pubkey, action: msg.action, reason, phase: 'events', cursor: String(page.nextUntil) };
      }
    } else {
      const { hashes, nextCursor } = await queryUserVideosPage(msg.pubkey, env, msg.cursor);
      const mediaAction = msg.action === 'delete-all' ? 'DELETE' : msg.action === 'age-restrict-all' ? 'QUARANTINE' : 'SAFE';
      const media = await moderateMediaHashes(env, hashes, mediaAction, reason);
      mediaDelta = media.processed;
      chunkFailures.push(...media.failures);
      next = nextCursor
        ? { jobId: msg.jobId, pubkey: msg.pubkey, action: msg.action, reason, phase: 'media', cursor: nextCursor }
        : null;
    }

    const status = next ? 'running' : 'done';
    await db.prepare(
      'UPDATE bulk_jobs SET status = ?, events_processed = ?, media_processed = ?, failures = ?, updated_at = ? WHERE job_id = ?'
    ).bind(
      status,
      job.eventsProcessed + eventsDelta,
      job.mediaProcessed + mediaDelta,
      JSON.stringify(appendFailures(job.failures, chunkFailures)),
      new Date().toISOString(),
      msg.jobId,
    ).run();

    if (next) await env.BULK_QUEUE!.send(next);
  } catch (error) {
    try {
      await db.prepare('UPDATE bulk_jobs SET status = ?, failures = ?, updated_at = ? WHERE job_id = ?')
        .bind('failed', JSON.stringify([`job:${formatError(error)}`]), new Date().toISOString(), msg.jobId).run();
    } catch (writeErr) {
      console.error('[bulk-job] failed to record terminal state for', msg.jobId, writeErr);
    }
  }
}

// Status endpoint: the UI polls this until status is terminal (done/failed). If a
// row is stuck in pending/running past STALE_JOB_MS (a worker eviction that no
// catch could recover from), self-heal it to `failed` so the poller never hangs.
export async function handleBulkJobStatus(
  jobId: string,
  env: BulkModerateEnv,
  corsHeaders: Record<string, string>,
): Promise<Response> {
  if (!env.DB) {
    return json({ error: 'bulk_jobs storage (D1) is not bound' }, 500, corsHeaders);
  }
  await ensureBulkJobsTable(env.DB);
  const row = await env.DB.prepare('SELECT * FROM bulk_jobs WHERE job_id = ?').bind(jobId).first<BulkJobRow>();
  if (!row) {
    return json({ error: 'job not found' }, 404, corsHeaders);
  }

  const job = rowToBulkJob(row);
  if ((job.status === 'pending' || job.status === 'running') && Date.parse(job.updatedAt) < Date.now() - STALE_JOB_MS) {
    job.status = 'failed';
    job.failures = ['job:abandoned (no terminal update; worker likely evicted mid-run)'];
    job.updatedAt = new Date().toISOString();
    await env.DB.prepare('UPDATE bulk_jobs SET status = ?, failures = ?, updated_at = ? WHERE job_id = ?')
      .bind(job.status, JSON.stringify(job.failures), job.updatedAt, jobId).run().catch(() => {});
  }
  return json(job, 200, corsHeaders);
}

export async function queryRelayEvents(
  pubkey: string,
  env: Pick<BulkModerateEnv, 'RELAY_URL'>,
): Promise<{ events: RelayEventSummary[]; complete: boolean }> {
  type Result = { events: RelayEventSummary[]; complete: boolean };
  return new Promise((resolve, reject) => {
    try {
      const ws = new WebSocket(env.RELAY_URL);
      let resolved = false;
      const byId = new Map<string, RelayEventSummary>(); // dedup across pages (until boundary overlaps)
      let page = 0;
      let currentSub = '';
      let pageEvents = 0;        // events seen in the current page
      let pageStartSize = 0;     // byId.size at page start -> detects whether the page added anything new
      let pageOldest = Infinity; // min created_at in the current page -> next `until`
      let incomplete = false;    // true if the relay could not be fully paginated (surfaced to caller)
      let timeout: ReturnType<typeof setTimeout>;

      const finish = (fn: ((v: Result) => void) | ((e: Error) => void), value: Result | Error) => {
        if (resolved) return;
        resolved = true;
        clearTimeout(timeout);
        ws.close();
        (fn as (value: Result | Error) => void)(value);
      };
      const done = () => finish(resolve, { events: Array.from(byId.values()), complete: !incomplete });

      const armTimeout = () => {
        clearTimeout(timeout);
        // Per-page: a prolific account legitimately needs many pages; only a
        // stalled page (no EOSE within the window) is a failure.
        timeout = setTimeout(() => finish(reject, new Error('Relay query timed out before EOSE')), RELAY_QUERY_TIMEOUT_MS);
      };

      const sendPage = (until?: number) => {
        page += 1;
        currentSub = `bulk-${Date.now()}-${page}`;
        pageEvents = 0;
        pageOldest = Infinity;
        pageStartSize = byId.size;
        const filter: { authors: string[]; limit: number; until?: number } = { authors: [pubkey], limit: RELAY_QUERY_PAGE_SIZE };
        if (until !== undefined) filter.until = until;
        armTimeout();
        ws.send(JSON.stringify(['REQ', currentSub, filter]));
      };

      ws.addEventListener('open', () => sendPage());

      ws.addEventListener('message', (msg) => {
        try {
          const data = JSON.parse(msg.data as string);
          if (data[0] === 'EVENT' && data[1] === currentSub) {
            const event = data[2] as { id: string; kind: number; content?: string; tags: string[][]; created_at?: number };
            pageEvents += 1;
            if (!byId.has(event.id)) {
              byId.set(event.id, { id: event.id, kind: event.kind, content: event.content || '', tags: event.tags });
            }
            if (typeof event.created_at === 'number' && event.created_at < pageOldest) pageOldest = event.created_at;
          } else if (data[0] === 'EOSE' && data[1] === currentSub) {
            ws.send(JSON.stringify(['CLOSE', currentSub]));
            // Last page reached: a partial page means the relay has no more events.
            if (pageEvents < RELAY_QUERY_PAGE_SIZE) {
              done();
              return;
            }
            if (page >= RELAY_QUERY_MAX_PAGES) {
              // Bound coverage rather than loop forever; surface it (not silent).
              incomplete = true;
              console.warn(`[bulk-moderate] hit RELAY_QUERY_MAX_PAGES (${RELAY_QUERY_MAX_PAGES}, ~${page * RELAY_QUERY_PAGE_SIZE} events) for ${pubkey}; returning a partial set`);
              done();
              return;
            }
            // Progress guard: a full page that added no new ids means the `until`
            // cursor is stuck -- more than one page of events share a single
            // created_at second (an inclusive `until` cannot subdivide a second),
            // or the events carry no created_at. Surface incompleteness, and where
            // we can, step strictly past the saturated second so we still
            // enumerate everything older instead of looping to the page bound.
            if (byId.size === pageStartSize) {
              incomplete = true;
              if (pageOldest === Infinity) {
                console.warn(`[bulk-moderate] relay events lack created_at; cannot paginate further for ${pubkey}; returning a partial set`);
                done();
                return;
              }
              console.warn(`[bulk-moderate] more than one page of events share created_at=${pageOldest} for ${pubkey}; skipping past that second (some events at it may be unprocessed)`);
              sendPage(pageOldest - 1);
              return;
            }
            // Page through older events. `until` is inclusive so the boundary
            // timestamp may repeat; the byId map dedups it.
            sendPage(pageOldest === Infinity ? undefined : pageOldest);
          }
        } catch {
          // Ignore malformed relay frames and continue collecting.
        }
      });

      ws.addEventListener('error', () => {
        finish(reject, new Error('Relay query failed'));
      });

      ws.addEventListener('close', () => {
        finish(reject, new Error('Relay query closed before EOSE'));
      });
    } catch (error) {
      reject(error);
    }
  });
}

// One chunk of a user's events via a single relay REQ bounded by `until`. Returns
// the next `until` (strictly past the oldest event so the inclusive boundary isn't
// re-counted) and whether enumeration is complete. A full page that can't advance
// the cursor signals the saturated-second caveat via complete=false.
export async function queryRelayEventsPage(
  pubkey: string,
  env: Pick<BulkModerateEnv, 'RELAY_URL'>,
  until?: number,
): Promise<{ events: RelayEventSummary[]; nextUntil: number | null; complete: boolean }> {
  type Page = { events: RelayEventSummary[]; nextUntil: number | null; complete: boolean };
  return new Promise((resolve, reject) => {
    try {
      const ws = new WebSocket(env.RELAY_URL);
      let resolved = false;
      const events: RelayEventSummary[] = [];
      let oldest = Infinity;
      const subId = `bulk-page-${Date.now()}`;
      const timeout = setTimeout(() => finish(reject, new Error('Relay query timed out before EOSE')), RELAY_QUERY_TIMEOUT_MS);
      const finish = (fn: ((v: Page) => void) | ((e: Error) => void), value: Page | Error) => {
        if (resolved) return;
        resolved = true;
        clearTimeout(timeout);
        ws.close();
        (fn as (value: Page | Error) => void)(value);
      };
      ws.addEventListener('open', () => {
        const filter: { authors: string[]; limit: number; until?: number } = { authors: [pubkey], limit: EVENT_CHUNK_SIZE };
        if (until !== undefined) filter.until = until;
        ws.send(JSON.stringify(['REQ', subId, filter]));
      });
      ws.addEventListener('message', (msg) => {
        try {
          const data = JSON.parse((msg as MessageEvent).data as string);
          if (data[0] === 'EVENT' && data[1] === subId) {
            const e = data[2] as { id: string; kind: number; content?: string; tags: string[][]; created_at?: number };
            events.push({ id: e.id, kind: e.kind, content: e.content || '', tags: e.tags });
            if (typeof e.created_at === 'number' && e.created_at < oldest) oldest = e.created_at;
          } else if (data[0] === 'EOSE' && data[1] === subId) {
            ws.send(JSON.stringify(['CLOSE', subId]));
            if (events.length < EVENT_CHUNK_SIZE) {
              finish(resolve, { events, nextUntil: null, complete: true });
            } else if (oldest === Infinity) {
              // Full page with no usable created_at: can't advance the cursor.
              finish(resolve, { events, nextUntil: null, complete: false });
            } else {
              finish(resolve, { events, nextUntil: oldest - 1, complete: false });
            }
          }
        } catch { /* ignore malformed frames */ }
      });
      ws.addEventListener('error', () => finish(reject, new Error('Relay query failed')));
      ws.addEventListener('close', () => finish(reject, new Error('Relay query closed before EOSE')));
    } catch (error) {
      reject(error);
    }
  });
}

const SHA256_HEX = /^[a-f0-9]{64}$/i;
const MEDIA_CHUNK_SIZE = 100; // funnelcake v2 max page
const VIDEO_QUERY_TIMEOUT_MS = 10000; // per page
const VIDEO_MAX_PAGES = 100000; // anti-runaway guard for a non-terminating cursor (~10M videos)

// One page of a user's video media hashes via the funnelcake v2 cursor API.
// v2 returns { data: [{sha256}], next_cursor } and pages by an opaque cursor, so
// we can walk an account of any size (v1 offset degrades + can skip/repeat).
// funnelcake's deduped view returns every video (vs the WebSocket REQ's ~1/kind,
// funnelcake#471). deriveFunnelcakeApiUrl honors FUNNELCAKE_API_URL when the REST
// and relay hosts diverge; the timeout stops a hung endpoint stalling moderation.
export async function queryUserVideosPage(
  pubkey: string,
  env: Pick<BulkModerateEnv, 'RELAY_URL' | 'FUNNELCAKE_API_URL'>,
  cursor?: string,
): Promise<{ hashes: string[]; nextCursor: string | null }> {
  const baseUrl = deriveFunnelcakeApiUrl(env.RELAY_URL, env.FUNNELCAKE_API_URL);
  const qs = new URLSearchParams({ limit: String(MEDIA_CHUNK_SIZE) });
  if (cursor) qs.set('cursor', cursor);
  const res = await fetch(`${baseUrl}/api/v2/users/${pubkey}/videos?${qs.toString()}`, {
    signal: AbortSignal.timeout(VIDEO_QUERY_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`Video query failed: ${res.status}`);
  const body = await res.json() as { data?: Array<{ sha256?: string }>; next_cursor?: string | null };
  const hashes: string[] = [];
  for (const v of body.data ?? []) {
    if (v.sha256 && SHA256_HEX.test(v.sha256)) hashes.push(v.sha256.toLowerCase());
  }
  return { hashes, nextCursor: body.next_cursor ?? null };
}

// Fully enumerate a user's video media hashes (loops the v2 cursor, deduped). Used
// by the SYNCHRONOUS age-review path; the async UI path chunks per page instead.
export async function queryUserMediaHashes(
  pubkey: string,
  env: Pick<BulkModerateEnv, 'RELAY_URL' | 'FUNNELCAKE_API_URL'>,
): Promise<string[]> {
  const hashes = new Set<string>();
  let cursor: string | undefined;
  for (let page = 0; page < VIDEO_MAX_PAGES; page++) {
    const { hashes: pageHashes, nextCursor } = await queryUserVideosPage(pubkey, env, cursor);
    pageHashes.forEach((h) => hashes.add(h));
    if (!nextCursor) return Array.from(hashes);
    cursor = nextCursor;
  }
  throw new Error(`Video cursor did not terminate for ${pubkey} after ${VIDEO_MAX_PAGES} pages`);
}

async function runWithConcurrency<T>(
  items: T[],
  concurrency: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  for (let i = 0; i < items.length; i += concurrency) {
    await Promise.all(items.slice(i, i + concurrency).map(worker));
  }
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function callModerateMedia(
  sha256: string,
  action: string,
  reason: string,
  env: BulkModerateEnv,
): Promise<void> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };

  if (env.SERVICE_API_TOKEN) {
    const token = typeof env.SERVICE_API_TOKEN === 'string'
      ? env.SERVICE_API_TOKEN
      : await env.SERVICE_API_TOKEN.get();
    if (token) headers['Authorization'] = `Bearer ${token}`;
  }

  const body = JSON.stringify({ sha256, action, reason, source: 'relay-manager-bulk' });

  if (env.MODERATION_API) {
    const response = await env.MODERATION_API.fetch('https://moderation-api.divine.video/api/v1/moderate', {
      method: 'POST', headers, body,
    });
    if (!response.ok) throw new Error(`Moderation service returned ${response.status}`);
  } else if (env.MODERATION_ADMIN_URL) {
    const response = await fetch(`${env.MODERATION_ADMIN_URL}/api/v1/moderate`, {
      method: 'POST', headers, body,
    });
    if (!response.ok) throw new Error(`Moderation service returned ${response.status}`);
  } else {
    throw new Error('No moderation service configured');
  }
}
