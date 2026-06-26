# Chunked Bulk Moderation — Design

Date: 2026-06-26
Status: Approved (brainstorming complete)
Branch: `feat/bulk-moderate-async-job` (#135) — folded in as new commits

## Problem

The async bulk-moderate job model (#135) runs each job in a single Cloudflare
Queue consumer invocation. That invocation has a ~1000-subrequest / CPU ceiling,
so a large account exceeds it and the job lands `failed`:

- Media: one `callModerateMedia` subrequest per video.
- delete-all events: `banEvent` + kind-5 per event (2 subrequests each).

Separately, media enumeration was capped (the funnelcake videos endpoint defaults
to `limit=25`, max 100; #91's offset paging bounded at 10k and threw beyond).

Goal: a single bulk action drains an account of **any size**, non-destructively,
with per-item failures surfaced to the moderator.

## Decisions (confirmed)

1. **Chunk both events and media** across queue messages (truly unbounded for every
   action, including delete-all). Not media-only.
2. **Fold into #135** as new commits (not a separate stacked PR).
3. **Failure semantics:** per-*item* failures (a single ban/moderate call) are
   recorded in `failures[]` and the job *continues* — action everything we can. A
   thrown *infra* error in a chunk (enumeration fetch dies, D1 unreachable) →
   caught → status `failed` with partial counts, acked (no retry). Fail loud on
   infra, resilient on items.
4. **Age-review enforcement stays synchronous.** It needs the enforcement result
   inline for the case's enforcement-leg status. A >~1000-video minor account
   auto-enforced via age-review can still hit the ceiling, but it fails *visibly*
   (the case shows the bulk-media leg failed/207) and the moderator re-runs from
   the Users page (which chunks). Acceptable; not a silent gap.

## Architecture

A bulk job becomes a **resumable state machine driven by the queue**. The producer
enqueues the first message (no phase/cursor) and returns the jobId. Each consumer
invocation does **one bounded chunk**, persists incremental progress to the
`bulk_jobs` row, then **re-enqueues the next chunk** (carrying a continuation
cursor) or marks the job terminal. `max_batch_size = 1` ⇒ one chunk per invocation
⇒ no account size hits the per-invocation ceiling.

### Message contract

`BulkJobMessage` gains two optional fields:

```ts
interface BulkJobMessage {
  jobId: string;
  pubkey: string;
  action: BulkAction;
  reason?: string;
  phase?: 'events' | 'media';  // omitted on the first message
  cursor?: string;             // opaque continuation for the current phase
}
```

- First message: `phase`/`cursor` omitted. Phase is derived: delete-all → `events`,
  age-restrict/un-age-restrict → `media`.
- `cursor`: funnelcake v2 `next_cursor` for `media`; relay `until` timestamp
  (stringified) for `events`. Omitted = start of the phase.

### Enumeration units (small, independently testable)

- `queryUserVideosPage(pubkey, env, cursor?) → { hashes: string[]; nextCursor: string | null }`
  — one funnelcake **v2** page: `GET /api/v2/users/{pubkey}/videos?limit=100&cursor=…`,
  parses the `{ data: [{sha256}], next_cursor }` envelope. v2 cursor paging is
  unbounded and avoids v1 offset's skip/repeat caveat and O(offset) penalty.
- `queryRelayEventsPage(pubkey, env, until?) → { events: RelayEventSummary[]; nextUntil: number | null; complete: boolean }`
  — one WS REQ chunk (`{authors, until, limit: RELAY_QUERY_PAGE_SIZE}`); `nextUntil`
  = oldest `created_at` − 1 (strictly past, so chunks don't double-count the
  inclusive boundary); `complete=false` surfaces the saturated-second caveat (a
  full page sharing one `created_at` that an `until` cursor can't subdivide).

`queryUserMediaHashes(pubkey, env)` (used by the *synchronous* age-review path)
loops `queryUserVideosPage` fully (unbounded, deduped) — no 10k cap. `queryRelayEvents`
(full, single-WS) stays for that path. The chunked path uses the per-page units.

### The chunk (consumer, per invocation)

`processBulkJob(msg, env)`:

1. Load the `bulk_jobs` row (accumulated counts). If missing or already terminal,
   ack (idempotent — a duplicate/late message is a no-op).
2. Set `status='running'`, refresh `updated_at` (so an actively-progressing
   multi-chunk job is never stale-healed by the 30-min reaper).
3. Phase = `msg.phase ?? (action === 'delete-all' ? 'events' : 'media')`.
4. Run **one page** of that phase (concurrency `BULK_ACTION_CONCURRENCY = 5`):
   - `events`: `queryRelayEventsPage(until=cursor)`; per event → `banEvent` +
     `publishKind5Deletion`; non-critical D1 decision batch + per-event zendesk
     sync; count `eventsProcessed`; collect per-item failures.
   - `media`: `queryUserVideosPage(cursor)`; `mediaAction = delete-all ? 'DELETE' :
     age-restrict-all ? 'QUARANTINE' : 'SAFE'`; per hash → `callModerateMedia`;
     count `mediaProcessed`; collect per-item failures.
5. Persist incrementally: `events_processed`/`media_processed` += chunk counts;
   append failures (capped at 50 entries + a "+N more" tail so the row can't grow unbounded);
   `updated_at`.
6. Decide next:
   - Current phase has more (`nextCursor`/`nextUntil` not exhausted): re-enqueue
     `{…, phase, cursor: next}`.
   - Events exhausted (delete-all): run the once-per-job pubkey-level zendesk sync,
     then re-enqueue `{…, phase: 'media'}` (no cursor).
   - Media exhausted: write `status='done'`.
7. A thrown infra error anywhere in 1–6 → caught → write `status='failed'` with the
   partial counts (best-effort), ack.

### Status / counts / stale-heal

- Counts accumulate across chunks (read-add-write per chunk).
- Job stays `running` across chunks; the final media chunk writes `done`. `done`
  still means "ran to completion"; `failures[]` carries partials (existing
  contract).
- Each chunk refreshes `updated_at`, so the 30-min stale-heal only fires on a
  genuinely abandoned (no-progress) job — unchanged semantics.

### Frontend

Unchanged. `useBulkModerateJob` already polls `/api/bulk-moderate/status/:jobId`
until terminal; counts simply grow across chunks, and the terminal toast reports
the final totals (or the partial/failed toast). The 10-min client give-up still
bounds an abandoned job.

## Testing

- `queryUserVideosPage`: parses the v2 `{data, next_cursor}` envelope; passes
  `cursor` through; returns `nextCursor: null` at the end.
- `queryRelayEventsPage`: one WS chunk; correct `nextUntil`; `complete=false` on a
  saturated second.
- Chunked consumer (`processBulkJob`):
  - media-only (age-restrict): 250 videos → 3 messages → all QUARANTINE, counts
    accumulate to 250, final message writes `done`.
  - delete-all: events phase chunks → transitions to media phase → `done`; the
    pubkey-level zendesk sync runs once at the transition.
  - a per-item failure is recorded in `failures[]` and the job continues to a
    terminal state.
  - an infra error (enumeration fetch throws) → `status='failed'` with partial counts.
- Existing async + sync tests stay green (runBulkModeration synchronous path for
  age-review; enqueue/status/stale-heal/rollback).

## Out of scope

- Async age-review enforcement (decision #4 keeps it synchronous).
- Live progress percentage in the UI (counts are available via status; the toast
  reports the final total — a live progress bar is a later nicety).
