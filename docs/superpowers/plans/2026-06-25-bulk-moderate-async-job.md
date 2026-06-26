# Bulk-Moderate Async Job Model — Implementation Plan (Plan B)

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:test-driven-development per change. Checkbox steps.

**Goal:** Make `/api/bulk-moderate` return a `jobId` immediately and run the work in a Cloudflare Queue consumer, with progress in a `bulk_jobs` D1 table and a status endpoint the UI polls. Removes the 180s client bound (enqueue is fast).

**Architecture:** Producer (HTTP) validates + inserts a `pending` `bulk_jobs` row + enqueues + returns `{jobId}`. Queue consumer runs the existing enumerate→action loop (refactored to `runBulkModeration`) and writes progress/result to the row. UI polls `GET /api/bulk-moderate/status/:jobId`.

**Branch:** `feat/bulk-moderate-async-job`, off `fix/bulk-moderate-rest-api` (#91). Depends on #91's `queryUserMediaHashes`; rebase onto main once #91 lands.

## Global Constraints

- Keep DRAFT. No push/merge/deploy without Matt's go-ahead.
- Queues run locally via Miniflare (wrangler ≥3.1) — validate the full enqueue→drain cycle locally.
- `age-restrict-all` stays `QUARANTINE`; pagination preserved (inherited from #91).
- Gates before push, both worktrees: `tsc --noEmit`, `eslint`, full `vitest run`.

---

### Task 1: shared BulkJob types

**Files:** Modify `shared/bulk-moderation.ts`. Test: covered by consumers.

- [ ] Add `BulkJobStatus`, `BulkJob`, `BulkJobMessage`, `BulkEnqueueResponse`. Code:

```ts
export type BulkJobStatus = 'pending' | 'running' | 'done' | 'failed';

export interface BulkJobMessage {
  jobId: string;
  pubkey: string;
  action: BulkAction;
  reason?: string;
}

export interface BulkJob {
  jobId: string;
  pubkey: string;
  action: BulkAction;
  status: BulkJobStatus;
  eventsProcessed: number;
  mediaProcessed: number;
  failures: string[];
  createdAt: string;
  updatedAt: string;
}

export interface BulkEnqueueResponse {
  success: boolean;
  jobId: string;
}
```

### Task 2: worker — `ensureBulkJobsTable`, `runBulkModeration`, enqueue/consume/status

**Files:** Modify `worker/src/bulk-moderate.ts`. Test: `worker/src/bulk-moderate.test.ts` (new describe `async job`).

- Refactor: rename the body of `handleBulkModerate` (validation aside) into
  `export async function runBulkModeration(env, pubkey, action, reason): Promise<BulkModerateResult>`.
- `ensureBulkJobsTable(db)`: `CREATE TABLE IF NOT EXISTS bulk_jobs (job_id TEXT PRIMARY KEY, pubkey TEXT, action TEXT, status TEXT, events_processed INTEGER, media_processed INTEGER, failures TEXT, created_at TEXT, updated_at TEXT)`.
- `handleBulkModerateEnqueue(request, env, corsHeaders)`: validate pubkey/action (reuse), `jobId = crypto.randomUUID()`, ensure table, insert `pending` row, `env.BULK_QUEUE.send({jobId,pubkey,action,reason})`, return `{success:true, jobId}`. 500 if `BULK_QUEUE`/`DB` unbound (clear message).
- `processBulkJob(msg, env)`: set row `running`, `runBulkModeration`, write `done`/`failed` + counts + failures(json) + updated_at.
- `handleBulkJobStatus(jobId, env, corsHeaders)`: read row → `BulkJob` (404 if missing).

**TDD steps:**
- [ ] RED: test `runBulkModeration` returns the same result shape (move the existing age-restrict/delete asserts to call it directly). Run → red. GREEN: extract. 
- [ ] RED: enqueue inserts a pending row + calls `BULK_QUEUE.send` + returns jobId (mock `env.BULK_QUEUE.send`, in-memory DB stub). GREEN.
- [ ] RED: `processBulkJob` runs the moderation and writes `done` with counts. GREEN.
- [ ] RED: status returns the row; 404 when missing. GREEN.
- [ ] Commit.

### Task 3: worker — routes + queue handler + Env binding + wrangler configs

**Files:** `worker/src/index.ts`, `worker/wrangler.local.toml`, `worker/wrangler.staging.toml`, `worker/wrangler.prod.toml`.

- [ ] `Env`: add `BULK_QUEUE?: Queue<BulkJobMessage>`.
- [ ] Route `POST /api/bulk-moderate` → `handleBulkModerateEnqueue`.
- [ ] Route `GET /api/bulk-moderate/status/:jobId` → `handleBulkJobStatus`.
- [ ] `export default`: add `async queue(batch: MessageBatch<BulkJobMessage>, env)` → `processBulkJob` per message (ack/retry on throw).
- [ ] wrangler configs: add producer+consumer queue bindings (`bulk-moderate-jobs[-staging|-prod]`).
- [ ] Gates: tsc, eslint, vitest. Commit.

### Task 4: worker — local Miniflare validation

- [ ] `wrangler dev --config wrangler.local.toml` (queues simulated). POST `/api/bulk-moderate` → jobId; poll status → `done`; confirm consumer drained (counts match). Paste output.

### Task 5: frontend — `bulkModerate` enqueues, `getBulkJobStatus`, drop bulk bound

**Files:** `src/lib/adminApi.ts`, `src/lib/adminApi.test.ts`.

- [ ] RED: `bulkModerate` returns `{jobId}` from the enqueue response; `getBulkJobStatus(apiUrl, jobId)` GETs the status. Remove `BULK_API_TIMEOUT_MS` (bulk now uses the 30s default — fast enqueue). Update the existing bulk-timeout test to assert the 30s default now applies to enqueue. GREEN. Commit.

### Task 6: frontend — `useBulkModerateJob` polling hook + UserActions states

**Files:** `src/hooks/useBulkModerateJob.ts` (new), `src/components/UserActions.tsx`, `src/components/UserActions.test.tsx`.

- [ ] RED: hook enqueues then polls status until terminal; exposes `{enqueue, status, isPending}`. GREEN.
- [ ] RED: UserActions bulk buttons render pending → progress (`m media / n events`) → done toast / partial-failure toast, driven by the hook. GREEN. Commit.

### Task 7: frontend gates + browser validation

- [ ] tsc, eslint, vitest. 
- [ ] Drive the UI (Playwright) against the local stack: Age-Restrict-All on the seeded multi-video account → enqueues, polls, renders done. Confirm job row `done` via status endpoint.

## Self-review
- Spec decision (c) → Tasks 1–6. 180s-bound removal → Task 5. Local queue validation → Task 4 + 7.
