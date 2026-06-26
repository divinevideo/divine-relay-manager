# Chunked Bulk Moderation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a single bulk moderation action drain an account of any size by processing it as resumable per-page chunks across Cloudflare Queue messages.

**Architecture:** The queue consumer (`processBulkJob`) does ONE bounded chunk per invocation, persists incremental progress to the `bulk_jobs` D1 row, then re-enqueues the next chunk (carrying a continuation cursor) or marks the job terminal. Media enumerates via the funnelcake v2 cursor API; delete-all events via a per-page relay WS `until` cursor. The synchronous `runBulkModeration` (age-review enforcement) is kept and refactored to share per-item helpers.

**Tech Stack:** Cloudflare Workers + Queues + D1, TypeScript, Vitest.

## Global Constraints

- Branch: `feat/bulk-moderate-async-job` (#135). All work as new commits here. Keep DRAFT; no push without Matt's go-ahead.
- `age-restrict-all` → `QUARANTINE`; `un-age-restrict-all` → `SAFE`; `delete-all` → `DELETE`. Never `AGE_RESTRICTED`.
- `MEDIA_CHUNK_SIZE = 100` (funnelcake v2 max page). `EVENT_CHUNK_SIZE = 200` (≈400 subrequests). `BULK_ACTION_CONCURRENCY = 5`.
- Failure semantics: per-item failures recorded in `failures[]`, job continues; a thrown infra error → status `failed` (partial counts), acked.
- Stored `failures[]` capped at 50 entries + a `"+N more"` tail.
- Gates before any push: `cd worker && npx tsc --noEmit && npx eslint src && npx vitest run`; frontend `npx tsc -p tsconfig.app.json --noEmit && npx vitest run --exclude '**/App.test.tsx'`.
- Worktree: `/Users/mjb/code/divine-relay-manager-async`. Worker tests: `cd worker && npx vitest run src/bulk-moderate.test.ts`.

---

### Task 1: BulkJobMessage gains phase + cursor

**Files:**
- Modify: `shared/bulk-moderation.ts`
- Test: covered by Task 5 (types only).

**Interfaces:**
- Produces: `BulkJobPhase = 'events' | 'media'`; `BulkJobMessage` with optional `phase?: BulkJobPhase`, `cursor?: string`.

- [ ] **Step 1: Add the types.** In `shared/bulk-moderation.ts`, replace the `BulkJobMessage` interface:

```ts
export type BulkJobPhase = 'events' | 'media';

// A bulk job is processed in chunks across multiple queue messages so an account
// of any size drains without hitting a single worker invocation's subrequest
// ceiling. The first message omits phase/cursor (start); each chunk re-enqueues
// the next with its continuation state, or finalizes the job.
//   - phase: 'events' (delete-all only: ban + kind-5 per event) then 'media'
//     (moderate each video blob). age-restrict/un-age-restrict are media-only.
//   - cursor: opaque continuation for the current phase -- funnelcake v2
//     next_cursor for media, or the relay `until` timestamp (stringified) for
//     events. Absent = start of the phase.
export interface BulkJobMessage {
  jobId: string;
  pubkey: string;
  action: BulkAction;
  reason?: string;
  phase?: BulkJobPhase;
  cursor?: string;
}
```

- [ ] **Step 2: tsc.** `cd worker && npx tsc --noEmit` → clean (no consumers reference the new fields yet).
- [ ] **Step 3: Commit.** `git add shared/bulk-moderation.ts && git commit -m "feat(bulk-moderate): add phase+cursor to BulkJobMessage for chunked jobs"`

---

### Task 2: Extract per-item chunk helpers + refactor runBulkModeration

Behavior-preserving refactor so the chunked consumer and the synchronous path share one implementation of the per-item work.

**Files:**
- Modify: `worker/src/bulk-moderate.ts` (`runBulkModeration` body + new helpers)
- Test: `worker/src/bulk-moderate.test.ts` (existing `runBulkModeration` tests must stay green)

**Interfaces:**
- Produces:
  - `moderateMediaHashes(env, hashes: string[], mediaAction: string, reason: string): Promise<{ processed: number; failures: string[] }>`
  - `deleteEvents(env, events: RelayEventSummary[], reason: string, moderatorPubkey: string): Promise<{ processed: number; successfulEventIds: string[]; failures: string[] }>`
  - `writeDecisionBatch(env, eventIds: string[], reason: string, moderatorPubkey: string): Promise<void>` (non-critical; swallows errors)

- [ ] **Step 1: Add the helpers** above `runBulkModeration` in `worker/src/bulk-moderate.ts`:

```ts
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

async function writeDecisionBatch(
  env: BulkModerateEnv, eventIds: string[], reason: string, moderatorPubkey: string,
): Promise<void> {
  if (!env.DB || eventIds.length === 0) return;
  // Non-critical audit write: log and continue, never abort the run.
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
```

- [ ] **Step 2: Rewrite `runBulkModeration`** to use them (the delete-all branch becomes):

```ts
  if (action === 'delete-all') {
    const [{ events, complete }, mediaHashes] = await Promise.all([
      queryRelayEvents(pubkey, env),
      queryUserMediaHashes(pubkey, env),
    ]);
    if (!complete) {
      result.failures.push(`enumeration:${pubkey}:relay could not be fully paginated; actioned a partial set`);
    }
    const { processed: eventsProcessed, successfulEventIds, failures: eventFailures } =
      await deleteEvents(env, events, reason, moderatorPubkey);
    result.eventsProcessed = eventsProcessed;
    result.failures.push(...eventFailures);
    if (successfulEventIds.length > 0) {
      await syncZendeskAfterAction(env, 'delete_event', 'pubkey', pubkey, moderatorPubkey);
    }
    const media = await moderateMediaHashes(env, mediaHashes, 'DELETE', reason);
    result.mediaProcessed = media.processed;
    result.failures.push(...media.failures);
  } else {
    const mediaHashes = await queryUserMediaHashes(pubkey, env);
    result.eventsProcessed = mediaHashes.length;
    const mediaAction = action === 'age-restrict-all' ? 'QUARANTINE' : 'SAFE';
    const media = await moderateMediaHashes(env, mediaHashes, mediaAction, reason);
    result.mediaProcessed = media.processed;
    result.failures.push(...media.failures);
  }
  result.success = result.failures.length === 0;
  return result;
```

- [ ] **Step 3: Run the existing tests** — they must stay green (behavior unchanged): `cd worker && npx vitest run src/bulk-moderate.test.ts`. Expected: all pass (runBulkModeration QUARANTINE/SAFE/delete-all/250-video/failure/batch tests).
- [ ] **Step 4: tsc + eslint.** `cd worker && npx tsc --noEmit && npx eslint src/bulk-moderate.ts`.
- [ ] **Step 5: Commit.** `git commit -am "refactor(bulk-moderate): extract per-item chunk helpers (no behavior change)"`

---

### Task 3: v2 cursor media enumeration

Replace the offset-paged `queryUserMediaHashes` with a v2-cursor page function + a full-loop wrapper.

**Files:**
- Modify: `worker/src/bulk-moderate.ts` (constants + `queryUserMediaHashes`, add `queryUserVideosPage`)
- Test: `worker/src/bulk-moderate.test.ts` (update `mockUserVideos` to v2 envelope; the 250-video test)

**Interfaces:**
- Produces: `queryUserVideosPage(pubkey, env, cursor?): Promise<{ hashes: string[]; nextCursor: string | null }>`; `queryUserMediaHashes(pubkey, env): Promise<string[]>` (loops the page fn fully).

- [ ] **Step 1: Update the mock to the v2 envelope** in `worker/src/bulk-moderate.test.ts`:

```ts
function mockUserVideos(videos: Array<{ sha256: string }>) {
  vi.spyOn(globalThis, 'fetch').mockImplementation((async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    if (url.pathname.includes('/api/v2/users/') && url.pathname.includes('/videos')) {
      const limit = Number(url.searchParams.get('limit') ?? '100');
      const offset = url.searchParams.get('cursor') ? Number(url.searchParams.get('cursor')) : 0;
      const page = videos.slice(offset, offset + limit);
      const next = offset + limit < videos.length ? String(offset + limit) : null;
      return new Response(JSON.stringify({ data: page, next_cursor: next }), { status: 200 });
    }
    return new Response('not found', { status: 404 });
  }) as typeof fetch);
}
```

- [ ] **Step 2: Run the 250-video test to verify it FAILS** (code still does v1 offset): `cd worker && npx vitest run src/bulk-moderate.test.ts -t "pages through ALL"`. Expected: FAIL (the mock now only answers the v2 path).

- [ ] **Step 3: Replace constants + implement** in `worker/src/bulk-moderate.ts`. Replace the `VIDEO_PAGE_SIZE`/`VIDEO_MAX_PAGES` block:

```ts
const MEDIA_CHUNK_SIZE = 100; // funnelcake v2 max page
const VIDEO_QUERY_TIMEOUT_MS = 10000; // per page
const VIDEO_MAX_PAGES = 100000; // anti-runaway guard for a non-terminating cursor (~10M videos)
```

Replace `queryUserMediaHashes` with:

```ts
// One page of a user's video media hashes via the funnelcake v2 cursor API.
// v2 returns { data: [{sha256}], next_cursor } and pages by an opaque cursor, so
// we can walk an account of any size (v1 offset degrades + can skip/repeat).
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

// Fully enumerate a user's video media hashes (loops the v2 cursor). Used by the
// SYNCHRONOUS age-review path; the async UI path chunks per page instead.
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
```

- [ ] **Step 4: Add a page-function test** in `worker/src/bulk-moderate.test.ts` (new describe near `runBulkModeration`):

```ts
describe('queryUserVideosPage', () => {
  beforeEach(() => vi.restoreAllMocks());
  it('parses the v2 envelope and returns the cursor', async () => {
    mockUserVideos([{ sha256: 'a'.repeat(64) }, { sha256: 'b'.repeat(64) }]);
    const page = await queryUserVideosPage('a'.repeat(64), { RELAY_URL: 'wss://relay.test' });
    expect(page.hashes).toEqual(['a'.repeat(64), 'b'.repeat(64)]);
    expect(page.nextCursor).toBeNull(); // 2 < limit 100 -> last page
  });
});
```

Import `queryUserVideosPage` in the test file.

- [ ] **Step 5: Run tests** — the 250-video test now passes (loops the cursor), plus the new page test: `cd worker && npx vitest run src/bulk-moderate.test.ts`. Expected: all pass.
- [ ] **Step 6: tsc + eslint, commit.** `git commit -am "feat(bulk-moderate): enumerate media via funnelcake v2 cursor (unbounded)"`

---

### Task 4: queryRelayEventsPage (one WS chunk)

**Files:**
- Modify: `worker/src/bulk-moderate.ts` (add `queryRelayEventsPage` + `EVENT_CHUNK_SIZE`)
- Test: `worker/src/bulk-moderate.test.ts`

**Interfaces:**
- Produces: `queryRelayEventsPage(pubkey, env, until?): Promise<{ events: RelayEventSummary[]; nextUntil: number | null; complete: boolean }>`

- [ ] **Step 1: Write the failing test.** Reuse the existing `mockPaginatedRelay` helper (it answers REQ with up to `limit` events ≤ `until`). Add:

```ts
describe('queryRelayEventsPage', () => {
  beforeEach(() => vi.restoreAllMocks());
  it('returns one chunk and the next until cursor', async () => {
    const all = Array.from({ length: 250 }, (_, i) => ({ id: `e${i}`, kind: 1, content: '', tags: [] as string[][], created_at: 250 - i }));
    mockPaginatedRelay(all);
    const page = await queryRelayEventsPage('a'.repeat(64), { RELAY_URL: 'wss://relay.test' });
    expect(page.events).toHaveLength(200);           // EVENT_CHUNK_SIZE
    expect(page.complete).toBe(false);               // more remain
    expect(page.nextUntil).toBe(all[199].created_at - 1); // strictly past the boundary
  });
  it('signals completion on a short final page', async () => {
    const all = Array.from({ length: 50 }, (_, i) => ({ id: `e${i}`, kind: 1, content: '', tags: [] as string[][], created_at: 50 - i }));
    mockPaginatedRelay(all);
    const page = await queryRelayEventsPage('a'.repeat(64), { RELAY_URL: 'wss://relay.test' });
    expect(page.events).toHaveLength(50);
    expect(page.complete).toBe(true);
    expect(page.nextUntil).toBeNull();
  });
});
```

Import `queryRelayEventsPage`.

- [ ] **Step 2: Run, verify FAIL** (function missing): `cd worker && npx vitest run src/bulk-moderate.test.ts -t "queryRelayEventsPage"`.

- [ ] **Step 3: Implement** in `worker/src/bulk-moderate.ts` (add the const near the other relay consts, and the function after `queryRelayEvents`):

```ts
const EVENT_CHUNK_SIZE = 200; // ~400 subrequests/chunk (ban + kind-5 per event)
```

```ts
// One chunk of a user's events via a single relay REQ bounded by `until`. Returns
// the next `until` (strictly past the oldest event so the inclusive boundary isn't
// re-counted) and whether enumeration is complete. `complete=false` with a full
// page that didn't advance signals the saturated-second caveat.
export async function queryRelayEventsPage(
  pubkey: string,
  env: Pick<BulkModerateEnv, 'RELAY_URL'>,
  until?: number,
): Promise<{ events: RelayEventSummary[]; nextUntil: number | null; complete: boolean }> {
  return new Promise((resolve, reject) => {
    try {
      const ws = new WebSocket(env.RELAY_URL);
      let resolved = false;
      const events: RelayEventSummary[] = [];
      let oldest = Infinity;
      const subId = `bulk-page-${Date.now()}`;
      const timeout = setTimeout(() => finish(reject, new Error('Relay query timed out before EOSE')), RELAY_QUERY_TIMEOUT_MS);
      function finish(fn: (v: unknown) => void, value: unknown) {
        if (resolved) return;
        resolved = true; clearTimeout(timeout); ws.close(); fn(value);
      }
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
              finish(resolve as (v: unknown) => void, { events, nextUntil: null, complete: true });
            } else if (oldest === Infinity) {
              // Full page with no usable created_at: can't advance the cursor.
              finish(resolve as (v: unknown) => void, { events, nextUntil: null, complete: false });
            } else {
              finish(resolve as (v: unknown) => void, { events, nextUntil: oldest - 1, complete: false });
            }
          }
        } catch { /* ignore malformed frames */ }
      });
      ws.addEventListener('error', () => finish(reject, new Error('Relay query failed')));
      ws.addEventListener('close', () => finish(reject, new Error('Relay query closed before EOSE')));
    } catch (error) { reject(error); }
  });
}
```

- [ ] **Step 4: Run, verify PASS.** `cd worker && npx vitest run src/bulk-moderate.test.ts -t "queryRelayEventsPage"`.
- [ ] **Step 5: tsc + eslint, commit.** `git commit -am "feat(bulk-moderate): add queryRelayEventsPage (one until-cursored WS chunk)"`

---

### Task 5: Chunked processBulkJob (the state machine)

**Files:**
- Modify: `worker/src/bulk-moderate.ts` (`processBulkJob`)
- Test: `worker/src/bulk-moderate.test.ts` (rewrite the async-job tests for chunking)

**Interfaces:**
- Consumes: Task 2 helpers, Task 3/4 page enumerators, `BulkJobMessage` (Task 1), `env.BULK_QUEUE`.
- Produces: chunked `processBulkJob(msg, env): Promise<void>` that re-enqueues continuations.

- [ ] **Step 1: Write failing tests.** In the `async bulk job model` describe, the consumer mock env needs `BULK_QUEUE.send` to capture re-enqueues. Replace the `processBulkJob runs the work` test and add chunk tests:

```ts
it('media-only job chunks across messages until done', async () => {
  // 250 videos => pages of 100/100/50 across 3 messages.
  const many = Array.from({ length: 250 }, (_, i) => ({ sha256: i.toString(16).padStart(64, '0') }));
  mockUserVideos(many);
  const jobId = 'job-chunk-1';
  jobDb.rows.set(jobId, { job_id: jobId, pubkey: 'a'.repeat(64), action: 'age-restrict-all', status: 'pending', events_processed: 0, media_processed: 0, failures: '[]', created_at: 't', updated_at: 't' });

  // Drive the chain: process the first message, then each re-enqueued one.
  let msg: BulkJobMessage | undefined = { jobId, pubkey: 'a'.repeat(64), action: 'age-restrict-all' };
  let guard = 0;
  while (msg && guard++ < 10) {
    sent.length = 0;
    await processBulkJob(msg, mockEnv);
    msg = sent[0];
  }
  const row = jobDb.rows.get(jobId)!;
  expect(row.status).toBe('done');
  expect(row.media_processed).toBe(250);
  expect(moderationActionFor(mockEnv, '0'.padStart(64, '0'))).toBe('QUARANTINE');
});

it('delete-all transitions events -> media and finishes', async () => {
  const { banEvent } = await import('./nip86');
  vi.mocked(banEvent).mockResolvedValue({ success: true });
  mockPaginatedRelay(Array.from({ length: 30 }, (_, i) => ({ id: `e${i}`, kind: 1, content: '', tags: [] as string[][], created_at: 30 - i })));
  mockUserVideos([{ sha256: 'a'.repeat(64) }]);
  const jobId = 'job-del-1';
  jobDb.rows.set(jobId, { job_id: jobId, pubkey: 'a'.repeat(64), action: 'delete-all', status: 'pending', events_processed: 0, media_processed: 0, failures: '[]', created_at: 't', updated_at: 't' });

  let msg: BulkJobMessage | undefined = { jobId, pubkey: 'a'.repeat(64), action: 'delete-all' };
  let guard = 0;
  while (msg && guard++ < 10) { sent.length = 0; await processBulkJob(msg, mockEnv); msg = sent[0]; }
  const row = jobDb.rows.get(jobId)!;
  expect(row.status).toBe('done');
  expect(row.events_processed).toBe(30);
  expect(row.media_processed).toBe(1);
});

it('records status=failed (partial counts) on an infra error', async () => {
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('err', { status: 500 }));
  const jobId = 'job-fail-2';
  jobDb.rows.set(jobId, { job_id: jobId, pubkey: 'a'.repeat(64), action: 'age-restrict-all', status: 'pending', events_processed: 0, media_processed: 0, failures: '[]', created_at: 't', updated_at: 't' });
  await processBulkJob({ jobId, pubkey: 'a'.repeat(64), action: 'age-restrict-all' }, mockEnv);
  expect(jobDb.rows.get(jobId)!.status).toBe('failed');
});
```

(The `async bulk job model` beforeEach already sets `sent = []` and `BULK_QUEUE.send` pushes to `sent`; `makeJobDb` UPDATEs by job_id. `mockPaginatedRelay` is the existing helper.)

- [ ] **Step 2: Run, verify FAIL** (current processBulkJob is all-in-one, no re-enqueue): `cd worker && npx vitest run src/bulk-moderate.test.ts -t "chunks across messages"`. Expected: FAIL (no second message sent; status done in one call but `sent` empty / counts may differ).

- [ ] **Step 3: Implement the chunked consumer.** Replace `processBulkJob`:

```ts
const MAX_STORED_FAILURES = 50;

function appendFailures(existing: string[], added: string[]): string[] {
  const merged = existing.concat(added);
  if (merged.length <= MAX_STORED_FAILURES) return merged;
  const extra = merged.length - MAX_STORED_FAILURES;
  return merged.slice(0, MAX_STORED_FAILURES).concat(`+${extra} more`);
}

export async function processBulkJob(msg: BulkJobMessage, env: BulkModerateEnv): Promise<void> {
  if (!env.DB) throw new Error('bulk_jobs storage (D1) is not bound');
  const db = env.DB;
  try {
    await ensureBulkJobsTable(db);
    const row = await db.prepare('SELECT * FROM bulk_jobs WHERE job_id = ?').bind(msg.jobId).first<BulkJobRow>();
    if (!row) return;                              // unknown job: nothing to do
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
      const res = await deleteEvents(env, page.events, reason, moderatorPubkey);
      eventsDelta = res.processed;
      chunkFailures.push(...res.failures);
      if (!page.complete) chunkFailures.push(`enumeration:${msg.pubkey}:relay could not be fully paginated; some events may be unprocessed`);
      if (page.complete || page.nextUntil === null) {
        // Events done: one pubkey-level zendesk sync, then move to media.
        if (res.successfulEventIds.length > 0) {
          await syncZendeskAfterAction(env, 'delete_event', 'pubkey', msg.pubkey, moderatorPubkey);
        }
        next = { jobId: msg.jobId, pubkey: msg.pubkey, action: msg.action, reason, phase: 'media' };
      } else {
        next = { jobId: msg.jobId, pubkey: msg.pubkey, action: msg.action, reason, phase: 'events', cursor: String(page.nextUntil) };
      }
    } else {
      const { hashes, nextCursor } = await queryUserVideosPage(msg.pubkey, env, msg.cursor);
      const mediaAction = msg.action === 'delete-all' ? 'DELETE' : msg.action === 'age-restrict-all' ? 'QUARANTINE' : 'SAFE';
      const res = await moderateMediaHashes(env, hashes, mediaAction, reason);
      mediaDelta = res.processed;
      chunkFailures.push(...res.failures);
      next = nextCursor
        ? { jobId: msg.jobId, pubkey: msg.pubkey, action: msg.action, reason, phase: 'media', cursor: nextCursor }
        : null;
    }

    const mergedFailures = appendFailures(job.failures, chunkFailures);
    const status = next ? 'running' : 'done';
    await db.prepare(
      'UPDATE bulk_jobs SET status = ?, events_processed = ?, media_processed = ?, failures = ?, updated_at = ? WHERE job_id = ?'
    ).bind(status, job.eventsProcessed + eventsDelta, job.mediaProcessed + mediaDelta, JSON.stringify(mergedFailures), new Date().toISOString(), msg.jobId).run();

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
```

- [ ] **Step 4: Run the async tests, verify PASS.** `cd worker && npx vitest run src/bulk-moderate.test.ts`. Expected: all pass (chunk-chain, delete-all transition, infra-fail, plus existing enqueue/status/stale-heal/rollback).
- [ ] **Step 5: tsc + eslint, full worker suite.** `cd worker && npx tsc --noEmit && npx eslint src && npx vitest run`.
- [ ] **Step 6: Commit.** `git commit -am "feat(bulk-moderate): chunk the queue consumer (resumable per-page, any account size)"`

---

### Task 6: Gates + local Miniflare validation

- [ ] **Step 1: Full gates.** Worker: `cd worker && npx tsc --noEmit && npx eslint src && npx vitest run`. Frontend: `npx tsc -p tsconfig.app.json --noEmit && npx vitest run --exclude '**/App.test.tsx'`. All green.
- [ ] **Step 2: Local Miniflare drive (multi-page).** Bring up the async worker (`cd worker && npx wrangler dev --config wrangler.local.toml --local --port 8787`) with `worker/.dev.vars` pointing RELAY_URL + MODERATION_ADMIN_URL at a stub that serves a v2 videos envelope with `next_cursor` across multiple pages (>200 videos). Enqueue an age-restrict job; poll status; confirm it transitions `running` across several messages and ends `done` with `mediaProcessed` = the full count, and the stub recorded that many QUARANTINE calls. If workerd can't reach the local stub in this environment (documented loopback regression), record the blocker and rely on the unit chunk-chain test.
- [ ] **Step 3: Update #135 PR body + DEPLOYMENT note** if anything changed for deploy (queue + chunking are already documented). Commit any doc tweaks.

## Self-review

- Spec coverage: chunking state machine → Task 5; v2 cursor → Task 3; event page → Task 4; chunk sizes (MEDIA_CHUNK_SIZE/EVENT_CHUNK_SIZE) → Tasks 3/4; failure cap → Task 5 (`appendFailures`); message contract → Task 1; helpers/DRY + runBulkModeration sync → Task 2; testing → each task + Task 6.
- Type consistency: `queryUserVideosPage`/`queryRelayEventsPage`/`moderateMediaHashes`/`deleteEvents`/`appendFailures` signatures match across tasks; `BulkJobMessage.phase|cursor` used in Tasks 1 + 5.
- No placeholders: each code step is complete.
