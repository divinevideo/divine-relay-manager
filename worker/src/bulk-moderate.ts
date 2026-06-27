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
      failures_dropped INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`
  ).run();
  // Defensive add for a bulk_jobs table created before failures_dropped existed
  // (on-demand schema, no migration runner). Ignored once the column is present.
  await db.prepare('ALTER TABLE bulk_jobs ADD COLUMN failures_dropped INTEGER NOT NULL DEFAULT 0')
    .run().catch(() => {});
}

interface BulkJobRow {
  job_id: string;
  pubkey: string;
  action: string;
  status: string;
  events_processed: number;
  media_processed: number;
  failures: string;
  failures_dropped: number;
  created_at: string;
  updated_at: string;
}

// `failures[]` stores a capped raw list (<= MAX_STORED_FAILURES, no synthetic
// marker); the overflow count lives in its own `failures_dropped` column so it
// survives across chunks. Render the "+N more" marker only for display/the API.
function failuresForDisplay(list: string[], dropped: number): string[] {
  return dropped > 0 ? list.concat(`+${dropped} more`) : list;
}

function parseFailuresList(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw) as string[];
    // Defensive: never let a previously-stored synthetic marker re-enter the list.
    return parsed.filter((f) => !/^\+\d+ more$/.test(f));
  } catch {
    return [];
  }
}

function rowToBulkJob(row: BulkJobRow): BulkJob {
  const dropped = Number(row.failures_dropped) || 0;
  return {
    jobId: row.job_id,
    pubkey: row.pubkey,
    action: row.action as BulkJob['action'],
    status: row.status as BulkJob['status'],
    eventsProcessed: Number(row.events_processed) || 0,
    mediaProcessed: Number(row.media_processed) || 0,
    failures: failuresForDisplay(parseFailuresList(row.failures), dropped),
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
  let body: { pubkey?: string; action?: string; reason?: string };
  try {
    body = await request.json() as { pubkey?: string; action?: string; reason?: string };
  } catch {
    return json({ error: 'Malformed JSON body' }, 400, corsHeaders);
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return json({ error: 'Request body must be a JSON object' }, 400, corsHeaders);
  }

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
    `INSERT INTO bulk_jobs (job_id, pubkey, action, status, events_processed, media_processed, failures, failures_dropped, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(jobId, body.pubkey, action, 'pending', 0, 0, '[]', 0, now, now).run();

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
//
// Idempotency: Cloudflare Queues is at-least-once. Every write to bulk_jobs.status
// is guarded so done/failed are sticky — the running-claim and terminal writes
// only act while the row is still non-terminal, and `next` is enqueued only when
// the terminal write actually changed a row. So a duplicate delivery for a job
// another chunk already finished is a no-op: it can't flap done->running, re-fire
// the UI's onComplete, or fork a second chunk chain. What these guards do NOT cover
// is two duplicates of the same still-running message racing the same page; there
// is no data corruption (banevent/kind-5/moderate-media are all idempotent), only
// count inflation and wasted compute on that rare overlap. A full atomic per-chunk
// claim (and recovering an abandoned job's dropped continuation) is a focused
// follow-up.
// TODO(#async-retry): atomic per-chunk claim + continuation recovery.
const MAX_STORED_FAILURES = 50;

// Merge new failures into the stored list, tracking the cumulative dropped count
// as its own number so it survives across chunks. Returns the capped raw list
// (<= MAX_STORED_FAILURES, no marker) plus the running dropped total. Re-deriving
// the marker from only the stored set each chunk loses earlier overflow and lets
// a clean final chunk erase the count entirely; a dedicated counter can't be
// erased. On a destructive path `failures[]` is the moderator's only signal of how
// much went un-actioned, so the total must not silently understate.
function mergeFailures(
  existing: string[], existingDropped: number, added: string[],
): { list: string[]; dropped: number } {
  const base = existing.filter((f) => !/^\+\d+ more$/.test(f));
  const merged = base.concat(added);
  if (merged.length <= MAX_STORED_FAILURES) {
    return { list: merged, dropped: existingDropped };
  }
  return {
    list: merged.slice(0, MAX_STORED_FAILURES),
    dropped: existingDropped + (merged.length - MAX_STORED_FAILURES),
  };
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
    const phase: BulkJobPhase = msg.phase ?? (msg.action === 'delete-all' ? 'events' : 'media');

    // Claim the chunk: flip to running only while still non-terminal. A duplicate
    // delivery for a job another chunk already finished changes zero rows here, so
    // we bail rather than flap `done`/`failed` back to `running` and re-fire the
    // UI's onComplete. (Not a full atomic claim against a concurrent same-state
    // duplicate -- that's TODO(#async-retry); this just stops the backward flips.)
    const claim = await db.prepare(
      `UPDATE bulk_jobs SET status = ?, updated_at = ? WHERE job_id = ? AND status IN ('pending','running')`
    ).bind('running', new Date().toISOString(), msg.jobId).run();
    if (!claim.meta?.changes) return;

    const moderatorPubkey = await getAdminPubkey(env);

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
      if (page.saturated) {
        // More than EVENT_CHUNK_SIZE events share one timestamp; an `until` cursor
        // can't subdivide a second, so some at it may be unprocessed. Surface it.
        chunkFailures.push(`enumeration:${msg.pubkey}:more than ${EVENT_CHUNK_SIZE} events share one timestamp; some at that second may be unprocessed`);
      }
      if (!page.complete && page.nextUntil === null) {
        chunkFailures.push(`enumeration:${msg.pubkey}:relay could not be fully paginated; some events may be unprocessed`);
      }
      if (page.complete || page.nextUntil === null) {
        // Events done: one pubkey-level zendesk sync (gated on the job's CUMULATIVE
        // successes, not just this final chunk's -- the last chunk is often an empty
        // short page), then move to the media phase.
        if (job.eventsProcessed + ev.processed > 0) {
          await syncZendeskAfterAction(env, 'delete_event', 'pubkey', msg.pubkey, moderatorPubkey);
        }
        next = { jobId: msg.jobId, pubkey: msg.pubkey, action: msg.action, reason, phase: 'media' };
      } else {
        next = { jobId: msg.jobId, pubkey: msg.pubkey, action: msg.action, reason, phase: 'events', cursor: String(page.nextUntil) };
      }
    } else {
      const mediaPage = msg.mediaPage ?? 0;
      const { hashes, nextCursor } = await queryUserVideosPage(msg.pubkey, env, msg.cursor);
      const mediaAction = msg.action === 'delete-all' ? 'DELETE' : msg.action === 'age-restrict-all' ? 'QUARANTINE' : 'SAFE';
      const media = await moderateMediaHashes(env, hashes, mediaAction, reason);
      mediaDelta = media.processed;
      chunkFailures.push(...media.failures);
      // Parity with the synchronous path: for media-only actions one video == one
      // event, so the UI's "across N events" stays meaningful (delete-all counts
      // events in its own phase, so leave eventsDelta 0 there).
      if (msg.action !== 'delete-all') eventsDelta = hashes.length;
      if (nextCursor) {
        // Bound the media phase on PAGES FETCHED, not items moderated. mediaProcessed
        // only counts successes, so a cursor that advances forever while the
        // moderation service fails would keep it near zero and never trip a
        // success-based bound -- churning the queue forever (each chunk refreshes
        // updated_at, so the stale-heal can't reclaim it either). Counting pages
        // catches advance-forever and A->B->A cycles regardless of success.
        if (nextCursor === msg.cursor) {
          throw new Error(`Video cursor did not advance for ${msg.pubkey} (stuck at ${nextCursor})`);
        }
        if (mediaPage + 1 >= VIDEO_MAX_PAGES) {
          throw new Error(`Video enumeration exceeded ${VIDEO_MAX_PAGES} pages for ${msg.pubkey}; cursor is not terminating`);
        }
        next = { jobId: msg.jobId, pubkey: msg.pubkey, action: msg.action, reason, phase: 'media', cursor: nextCursor, mediaPage: mediaPage + 1 };
      } else {
        next = null;
      }
    }

    const status = next ? 'running' : 'done';
    const merged = mergeFailures(parseFailuresList(row.failures), Number(row.failures_dropped) || 0, chunkFailures);
    // Guard the terminal write on the status we claimed (`running`), and only
    // enqueue the next chunk if this write actually landed. If a concurrent or
    // duplicate chunk already moved the row to a terminal state, changes is 0 and
    // we must NOT send `next` (that would fork the chunk chain).
    const wrote = await db.prepare(
      `UPDATE bulk_jobs SET status = ?, events_processed = ?, media_processed = ?, failures = ?, failures_dropped = ?, updated_at = ? WHERE job_id = ? AND status = 'running'`
    ).bind(
      status,
      job.eventsProcessed + eventsDelta,
      job.mediaProcessed + mediaDelta,
      JSON.stringify(merged.list),
      merged.dropped,
      new Date().toISOString(),
      msg.jobId,
    ).run();

    if (next && wrote.meta?.changes) await env.BULK_QUEUE!.send(next);
  } catch (error) {
    try {
      // Preserve per-item failures earlier chunks recorded (forensic detail on a
      // destructive path) and append the infra error, rather than clobbering them.
      // Guard on a non-terminal status so this can't resurrect a `done` job.
      const cur = await db.prepare('SELECT failures, failures_dropped FROM bulk_jobs WHERE job_id = ?').bind(msg.jobId).first<{ failures: string; failures_dropped: number }>();
      const merged = mergeFailures(
        cur ? parseFailuresList(cur.failures) : [],
        cur ? Number(cur.failures_dropped) || 0 : 0,
        [`job:${formatError(error)}`],
      );
      await db.prepare(`UPDATE bulk_jobs SET status = ?, failures = ?, failures_dropped = ?, updated_at = ? WHERE job_id = ? AND status IN ('pending','running')`)
        .bind('failed', JSON.stringify(merged.list), merged.dropped, new Date().toISOString(), msg.jobId).run();
    } catch (writeErr) {
      console.error('[bulk-job] failed to record terminal state for', msg.jobId, writeErr);
    }
  }
}

// Status endpoint: the UI polls this until status is terminal (done/failed). If a
// row is stuck in pending/running past STALE_JOB_MS, self-heal it to `failed` so
// the poller never hangs.
//
// Why STALE_JOB_MS can't fire on a LIVE chunked job: each chunk completes in
// seconds (bounded by the per-invocation subrequest/CPU ceiling) and re-enqueues
// its successor immediately, which refreshes updated_at. So a healthy multi-chunk
// job is never 30 minutes between updates -- a gap that long means the queue
// message was lost or the worker was evicted mid-consume (max_retries=0, so the
// message is gone), i.e. genuinely abandoned. The status guards make done/failed
// sticky, so this heal can only act on a still-non-terminal row. Recovering the
// dropped continuation of such an abandoned job (re-enqueuing the remaining pages)
// is separate work: TODO(#async-retry).
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
    // Append the abandonment note to the failures the consumer already recorded
    // (don't overwrite them), and preserve the cumulative dropped count.
    const merged = mergeFailures(
      parseFailuresList(row.failures), Number(row.failures_dropped) || 0,
      ['job:abandoned (no terminal update; worker likely evicted mid-run)'],
    );
    job.status = 'failed';
    job.failures = failuresForDisplay(merged.list, merged.dropped);
    job.updatedAt = new Date().toISOString();
    await env.DB.prepare(`UPDATE bulk_jobs SET status = ?, failures = ?, failures_dropped = ?, updated_at = ? WHERE job_id = ? AND status IN ('pending','running')`)
      .bind(job.status, JSON.stringify(merged.list), merged.dropped, job.updatedAt, jobId).run().catch(() => {});
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

// One chunk of a user's events via a single relay REQ bounded by `until`.
//
// Pagination correctness on a destructive path: a relay returns the newest
// EVENT_CHUNK_SIZE events with created_at <= until, in descending time. On a FULL
// page the oldest second is at the cut boundary -- there may be more events at that
// exact second that didn't fit. Stepping strictly past it (oldest - 1) would
// silently drop them. So on a multi-second full page we DEFER the boundary
// (oldest) second entirely: process only events strictly newer than `oldest` and
// set nextUntil = oldest (inclusive) so the next chunk re-fetches that whole
// second fresh. No event is processed twice (the boundary second is excluded here,
// processed next chunk) and none is skipped.
//
// The one unavoidable case: a SINGLE second holding more than EVENT_CHUNK_SIZE
// events (min === max on a full page). An `until` cursor cannot subdivide a
// second, so we process this page, step past (oldest - 1), and set
// `saturated: true` so the consumer SURFACES the gap (never silent). Matches the
// synchronous queryRelayEvents progress-guard behavior.
export async function queryRelayEventsPage(
  pubkey: string,
  env: Pick<BulkModerateEnv, 'RELAY_URL'>,
  until?: number,
): Promise<{ events: RelayEventSummary[]; nextUntil: number | null; complete: boolean; saturated: boolean }> {
  type Page = { events: RelayEventSummary[]; nextUntil: number | null; complete: boolean; saturated: boolean };
  return new Promise((resolve, reject) => {
    try {
      const ws = new WebSocket(env.RELAY_URL);
      let resolved = false;
      const collected: Array<{ summary: RelayEventSummary; createdAt: number | null }> = [];
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
            collected.push({
              summary: { id: e.id, kind: e.kind, content: e.content || '', tags: e.tags },
              createdAt: typeof e.created_at === 'number' ? e.created_at : null,
            });
          } else if (data[0] === 'EOSE' && data[1] === subId) {
            ws.send(JSON.stringify(['CLOSE', subId]));
            const all = collected.map((c) => c.summary);
            if (collected.length < EVENT_CHUNK_SIZE) {
              // Partial page: the relay has no more events at or before `until`.
              finish(resolve, { events: all, nextUntil: null, complete: true, saturated: false });
              return;
            }
            const times = collected.map((c) => c.createdAt).filter((t): t is number => t !== null);
            if (times.length === 0) {
              // Full page with no usable created_at: cannot advance the cursor.
              finish(resolve, { events: all, nextUntil: null, complete: false, saturated: false });
              return;
            }
            const oldest = Math.min(...times);
            const newest = Math.max(...times);
            if (oldest === newest) {
              // Entire full page is one second -> more events at it were cut off and
              // an `until` cursor can't subdivide. Process this page, step strictly
              // past, and surface the unavoidable gap.
              finish(resolve, { events: all, nextUntil: oldest - 1, complete: false, saturated: true });
              return;
            }
            // Multi-second full page: defer the boundary (oldest) second to the next
            // chunk so we never process or skip a partial second at the cut.
            const kept = collected
              .filter((c) => c.createdAt === null || c.createdAt > oldest)
              .map((c) => c.summary);
            finish(resolve, { events: kept, nextUntil: oldest, complete: false, saturated: false });
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
export const VIDEO_MAX_PAGES = 100000; // anti-runaway guard for a non-terminating cursor (~10M videos)

// One page of a user's video media hashes via the funnelcake v2 cursor API.
// v2 serializes the { data, pagination } envelope (PaginatedResponse<T> in
// funnelcake's crates/api/src/handlers.rs) -- the cursor is at
// `pagination.next_cursor`, NOT top-level. Reading it from the wrong place makes
// next_cursor always null, silently capping enumeration at the first page (100
// videos) and reporting success -- the exact under-enforcement this path fixes.
// v2's opaque cursor walks an account of any size (v1 offset degrades + can
// skip/repeat). funnelcake's deduped view returns every video (vs the WebSocket
// REQ's ~1/kind, funnelcake#471). deriveFunnelcakeApiUrl honors FUNNELCAKE_API_URL
// when the REST and relay hosts diverge; the timeout stops a hung endpoint
// stalling moderation.
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
  const body = await res.json() as {
    data?: Array<{ sha256?: string }>;
    pagination?: { next_cursor?: string | null };
  };
  const data = body.data ?? [];
  if (!Array.isArray(data)) {
    throw new Error(`Video page returned a non-array data field for ${pubkey}; response shape may have changed`);
  }
  const hashes: string[] = [];
  for (const v of data) {
    if (v.sha256 && SHA256_HEX.test(v.sha256)) hashes.push(v.sha256.toLowerCase());
  }
  if (data.length > 0 && hashes.length === 0) {
    // Rows present but none carried a usable sha256: the response shape drifted.
    // Treating zero hashes as a clean page would under-action on a withhold path.
    throw new Error(`Video page returned ${data.length} rows with no valid sha256 for ${pubkey}; response shape may have changed`);
  }
  return { hashes, nextCursor: body.pagination?.next_cursor ?? null };
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
