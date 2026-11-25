# Report Index Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Relay Manager keeps its own D1 copy of every kind-1984 report and every resolution label it publishes, catches reports missed while the listener was down, and serves the queue, resolved history and target lookups from that copy.

**Architecture:** Three independent PRs to `main`, landed in order (never stacked). PR 1 makes the listener catch up after any disconnect through the unchanged live handler and starts writing reports and labels to D1 (reads unchanged). PR 2 backfills, keeps the copy reconciled against the relay (incremental every 5 minutes, full hourly with a mass-absence guard), certifies it and logs a shadow comparison. PR 3 switches reads to D1 behind flags and shows why a hidden report is kept.

**Tech Stack:** Cloudflare Workers + Durable Objects, D1 (SQLite), nostr-tools 2.26 (`verifyEvent`, `nostr-tools/nip77`), Vitest (+ Miniflare D1 for `*.d1.test.ts`), React 18 + TanStack Query.

**Spec:** `docs/superpowers/specs/2026-11-24-report-index-design.md` (read it with this plan; the plan argues from it). Query-cost findings it rests on: the session scratchpad files `q-rm-inventory.md` (section 4) and `q-client-patterns.md`.

## Global Constraints

- **No relay-walk retries.** A failed relay page fails that walk. Nothing re-requests it immediately. The only re-attempts are a scheduled resume of a durable cursor (catch-up: at most once per 5 minutes; reconcile: at most once per hour, gated by `last_full_attempt_at`).
- **Never show a short queue.** Any doubt shows more and says so (#186, #221). A walk is "complete" only if every page reached EOSE, it ended on a page that added no new ids, and it was not truncated. A short page alone never ends a walk (funnelcake drops newly banned rows after its SQL `LIMIT`, `relay.rs` ~3951-3967, and may cap `limit`).
- **Minimal relay load.** No relay read on the request path once a read is served from D1. New relay reads are: catch-up on reconnect, one incremental window every 5 minutes, one full reconcile per hour, one label reconcile per hour, ban/suspend list reads once per reconcile. The shadow comparison reuses the hourly reconcile, with no walk of its own.
- **D1 limits.** At most 100 bound parameters per statement: `report_index` inserts are 12 rows per statement (8 params each = 96), `report_index_refs` 33 rows (99), `resolution_labels` 11 rows (99), id lookups 100 ids. At most 50 statements per `db.batch` call.
- **Schema** goes in `ensureSchema()` (`worker/src/db.ts`) and in migration `worker/migrations/0022_report_index.sql`, kept identical (a parity test compares `pragma_table_info`). All tables ship in PR 1, so PRs 2 and 3 change no schema.
- **Tests must be able to fail.** Every guard named in a task is mutation-checked: remove that one guard, watch exactly its test go red, restore from a `cp` backup (never `git checkout`). One guard per mutation.
- **Gates before every commit of a task** (fresh worktree: `cd worker && npm ci --legacy-peer-deps` first):
  - root: `npm run typecheck && npx eslint && npx vitest run --exclude src/App.login-prompt.test.tsx`
  - worker: `cd worker && npx vitest run && npm run typecheck`
  - any D1 change or D1-backed route: `cd worker && npm run test:d1` (on macOS a full run can fail ~33 tests with `EADDRNOTAVAIL`; then run each touched `*.d1.test.ts` file alone and say so)
- **Non-critical writes never block the critical path.** Index and label writes are `await`ed inside try/catch and logged; auto-hide, age review, publish and the response proceed on failure (AGENTS.md, Integration Contracts).
- **`created_at` is not an arrival clock.** Catch-up windows come from the watcher's own heartbeat clock, never `max(created_at)`.
- **Arrival = discovery time**, recorded only where the live handler (or its index-only deliberate-stop variant) runs. Backfill, incremental and reconcile before certification record no arrivals.
- **"Never seen"** = id in neither `report_arrivals` nor `report_index`. The live handler runs on a non-live find only if never seen, and, for incremental and reconcile finds, only once `backfill_certified_at` is set.
- **No production or staging access** by agents or their subagents (no prod relay, API or D1). Local stack only; browser harnesses block prod HTTP and WebSocket.
- Divine conventions: no Co-Authored-By; commits authored by Matt; PR titles Conventional Commit; PRs default to draft; each PR description carries PR_REVIEW.md's identity block.

## Review Focus

1. **A relay that caps `limit` below the page size, or drops a row after its SQL limit.** Every page is short but non-empty; the walk must keep going and collect everything. Pinned in Task 1.4 (`collects everything when the relay caps limit below the page size`).
2. **The same report arriving live while catch-up has it.** The handler is not idempotent (a closed under-16 case reopens). It must run once. Pinned in Task 1.5 (`a report delivered live during catch-up is handled once`).
3. **A report indexed live while the hourly walk is in flight.** It is not in the walk's results and must not count as absent or trip the guard. Pinned in Task 2.4 (`ignores rows indexed after the walk started`).
4. **The first connect after deploy, with no heartbeat ever recorded.** Catch-up must not replay history through auto-hide. Pinned in Task 1.5 (`does nothing on the first connect when no heartbeat was ever recorded`).
5. **Mixed-case pubkeys in the relay's ban or suspend list.** A reporter banned under an uppercase key must still classify as `reporter_banned`, not `unknown` (which expires in 30 days). Pinned in Task 2.4 (`classifies a reporter banned under an uppercase pubkey`).

---

## PR 1: Catch-up, burst alert, live dual-write (reports and labels)

Ships alone: reads are unchanged; the listener stops losing reports across restarts.

### Task 1.0: Worktree and base

- [ ] **Step 1:** Use the `divine-worktrees` skill. Branch `feat/report-index-catchup` off fresh `origin/main` (the design worktree `rm-report-index` holds only the spec; do not build on `feat/report-index` if it is stale). Copy `.env.local` and `worker/.dev.vars` only if a local-stack check needs them (never the main checkout's `.dev.vars` into a test env with real creds).
- [ ] **Step 2:** Check whether PR #452 has merged: `gh pr view 452 --json state,mergeCommit`. If merged, `queryRelay(filter, relayUrl, opts?: { timeoutMs?: number })` and `RELAY_WALK_PAGE_TIMEOUT_MS = 15000` exist; use them. If not, Task 1.4 adds the identical optional `opts` parameter to `queryRelay` in `worker/src/relay-profile.ts` (same name, same default 5000) so the later rebase is a trivial conflict.

### Task 1.1: Schema

**Files:**
- Modify: `worker/src/db.ts` (append after `timed_suspensions`)
- Create: `worker/migrations/0022_report_index.sql`
- Test: `worker/test/report-index-schema.d1.test.ts`
- Modify: `AGENTS.md` (D1 Schema table: add the four tables, one line each)

**Interfaces:**
- Produces: tables `report_index`, `report_index_refs`, `report_index_meta`, `resolution_labels` exactly as below.

```sql
CREATE TABLE IF NOT EXISTS report_index (
  report_id TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  reporter_pubkey TEXT NOT NULL,          -- '' once erased
  target_type TEXT,                       -- getReportTarget(): 'event' | 'pubkey' | NULL
  target_id TEXT,
  event_json TEXT,                        -- NULL once erased
  source TEXT NOT NULL CHECK (source IN ('live','catchup','incremental','full','backfill')),
  indexed_at INTEGER NOT NULL,
  last_seen_at INTEGER,
  hidden_reason TEXT CHECK (hidden_reason IS NULL OR hidden_reason IN
    ('reporter_banned','reporter_suspended','reporter_deactivated','reporter_divine_only','unknown')),
  erased_at INTEGER,
  erased_reason TEXT CHECK (erased_reason IS NULL OR erased_reason IN
    ('deleted','vanished','unknown_expired','handled_unknown'))
);
CREATE INDEX IF NOT EXISTS idx_report_index_created ON report_index(created_at, report_id);
CREATE INDEX IF NOT EXISTS idx_report_index_target ON report_index(target_type, target_id);
CREATE INDEX IF NOT EXISTS idx_report_index_live ON report_index(created_at, report_id) WHERE erased_at IS NULL;
-- Every e and p tag value, for target lookups (relay #e/#p match ANY tag, not just the first).
CREATE TABLE IF NOT EXISTS report_index_refs (
  ref_type TEXT NOT NULL CHECK (ref_type IN ('e','p')),
  ref_value TEXT NOT NULL,                -- canonicalHex64(value) ?? value
  report_id TEXT NOT NULL,
  PRIMARY KEY (ref_type, ref_value, report_id)
);
CREATE TABLE IF NOT EXISTS report_index_meta (key TEXT PRIMARY KEY, value INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS resolution_labels (
  label_id TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  signer_pubkey TEXT NOT NULL,
  target_event TEXT,
  target_pubkey TEXT,
  status TEXT,
  event_json TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('publish','backfill','reconcile')),
  recorded_at INTEGER NOT NULL
);
```

Why a refs table (not in the design's column list): `getReportsForTarget` today asks the relay `{'#p':[pk]}`, which returns event reports that also p-tag the author. A lookup on `(target_type, target_id)` alone would drop those and show a shorter Related Reports list than today.

- [ ] **Step 1: Write the failing tests** in `report-index-schema.d1.test.ts` (Miniflare pattern of `report-arrivals.d1.test.ts`):
  - `ensureSchema creates the four report-index tables and is idempotent`
  - `migration 0022 produces the same columns as ensureSchema` (pattern of `timed-suspensions-store.d1.test.ts:58`; compare `pragma_table_info` for all four tables, and `pragma_index_list('report_index')` names)
  - `rejects an unknown source or hidden_reason` (INSERT with `source='x'` throws)
- [ ] **Step 2:** `cd worker && npx vitest run --config vitest.d1.config.ts test/report-index-schema.d1.test.ts` → FAIL (no such table).
- [ ] **Step 3:** Add the DDL to `ensureSchema` with the comment `Keep in sync with migration 0022.` and write the migration file.
- [ ] **Step 4:** Re-run → PASS. Mutation: drop `idx_report_index_live` from the migration only → the parity test fails.
- [ ] **Step 5:** Gates; commit `feat(reports): add the report index and resolution label tables`.

### Task 1.2: Index write and lookup helpers

**Files:**
- Create: `worker/src/report-index.ts`
- Modify: `worker/src/report-arrivals.ts` (extract the statement)
- Test: `worker/test/report-index.d1.test.ts`

**Interfaces:**
- Produces (`report-index.ts`):
  - `type ReportIndexSource = 'live' | 'catchup' | 'incremental' | 'full' | 'backfill'`
  - `type HiddenReason = 'reporter_banned' | 'reporter_suspended' | 'reporter_deactivated' | 'reporter_divine_only' | 'unknown'`
  - `interface SignedReport { id: string; pubkey: string; created_at: number; kind: 1984; tags: string[][]; content: string; sig: string }`
  - `reportIndexStatements(db: D1Database, reports: readonly SignedReport[], source: ReportIndexSource, nowSec: number): D1PreparedStatement[]` — `INSERT OR IGNORE` into `report_index` (12 rows/statement) then `INSERT OR IGNORE` into `report_index_refs` (33 rows/statement). `event_json` is `JSON.stringify` of exactly `{id,pubkey,created_at,kind,tags,content,sig}`. `target_type/target_id` from `getReportTarget`. Ids and reporter lowercased.
  - `runStatements(db: D1Database, statements: D1PreparedStatement[]): Promise<void>` — `db.batch` in groups of 50.
  - `indexReports(db, reports, source, nowSec): Promise<void>` = `runStatements(reportIndexStatements(...))`.
  - `findUnseenReportIds(db: D1Database, ids: readonly string[]): Promise<Set<string>>` — ids in neither `report_index` nor `report_arrivals`; 100 ids per statement, one batch.
  - `const META_KEYS = ['backfill_certified_at','last_full_ok_at','last_full_attempt_at','last_full_seen_count','last_incremental_ok_at','watcher_last_alive_at','last_shadow_missing','last_shadow_extra','labels_certified_at','labels_last_attempt_at','labels_last_ok_at','reconcile_negentropy_disabled'] as const; type MetaKey = typeof META_KEYS[number]`
  - `readMeta(db: D1Database): Promise<Partial<Record<MetaKey, number>>>` (one `SELECT key, value FROM report_index_meta`)
  - `metaStatement(db: D1Database, key: MetaKey, value: number): D1PreparedStatement` (`INSERT ... ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
- Produces (`report-arrivals.ts`): `reportArrivalStatement(db, reportId, seenAt): D1PreparedStatement`; `recordReportArrival` becomes `reportArrivalStatement(...).run()`.

- [ ] **Step 1: Write the failing tests:**
  - `indexes 250 reports across statements within 100 parameters` (all 250 rows present; spy on `prepare` and assert every bound statement has ≤ 100 args)
  - `keeps the first source and indexed_at when a report is indexed again` (index as `live` at t=100, then `full` at t=200 → `source='live'`, `indexed_at=100`)
  - `writes a ref for every e and p tag, lowercasing 64-hex values` (report with `['e', UPPER]`, `['e', other]`, `['p', pk]` → 3 refs, first lowercased)
  - `sets the target from the first e tag, else the first p tag` (matches `getReportTarget`)
  - `findUnseenReportIds excludes ids in report_index and in report_arrivals, across 250 ids`
  - `readMeta returns only stored keys; metaStatement overwrites`
- [ ] **Step 2:** Run `npx vitest run --config vitest.d1.config.ts test/report-index.d1.test.ts` → FAIL.
- [ ] **Step 3:** Implement. One line on chunking: build each statement's `VALUES (?,…),(…)` list from the chunk; never one statement per row.
- [ ] **Step 4:** PASS. Mutations, one at a time: raise the row chunk to 13 → the parameter test fails; change `INSERT OR IGNORE` to `INSERT OR REPLACE` → the first-source test fails; check only `report_index` in `findUnseenReportIds` → its test fails.
- [ ] **Step 5:** Gates (plus `test/report-arrivals.d1.test.ts` still green); commit `feat(reports): write and look up rows in the report index`.

### Task 1.3: Live dual write, heartbeat, deliberate-stop marker

**Files:**
- Modify: `worker/src/ReportWatcher.ts` (`handleReportEvent` ~873-925, `alarm` ~1577, `handleStop` ~306, `connect` 'open' ~716)
- Test: `worker/src/ReportWatcher.test.ts` (extend `describe('report arrival log (#324)')`; its `arrivalDb` mock gains `batch`)

**Interfaces:**
- Consumes: `reportArrivalStatement`, `reportIndexStatements`, `metaStatement` (1.2).
- Produces (ReportWatcher, private):
  - `handleReportEvent(event: ReportEvent, opts?: { source?: ReportIndexSource; preClaimed?: boolean; sideEffects?: boolean }): Promise<void>` — defaults `{ source: 'live', preClaimed: false, sideEffects: true }`. With `sideEffects: false` it records arrival + index and returns before auto-hide and age review.
  - `catchUpPlannedForConnection: boolean` — set false on every `connect()`, true once Task 1.5 has saved the window.
  - DO storage key `report-watcher-deliberate-stop` (unix seconds), written by `handleStop`.

- [ ] **Step 1: Write the failing tests:**
  - `writes the arrival and the index row in one batch for a verified report` (mock `batch` receives 1 arrival statement + ≥1 `report_index` statement; no separate arrival `run`)
  - `still runs auto-hide and the age-review path when the batch throws` (adapt the existing arrival-throws test to throw from `batch`)
  - `stamps watcher_last_alive_at on the health alarm only while connected and after the catch-up window is saved` (alarm with ws OPEN and flag false → no meta write; flag true → one `report_index_meta` upsert with now in seconds; ws closed → none)
  - `stop records a deliberate-stop marker` (`/stop` → storage has `report-watcher-deliberate-stop`)
- [ ] **Step 2:** `cd worker && npx vitest run src/ReportWatcher.test.ts -t "arrival log"` → FAIL.
- [ ] **Step 3:** Implement. Replace the `recordReportArrival` call with `db.batch([reportArrivalStatement(...), ...reportIndexStatements(db, [event], source, now)])` inside the existing try/catch (verified events only, as today). Heartbeat stamp goes in `alarm()` after the reconnect check, own try/catch.
- [ ] **Step 4:** PASS. Mutation: drop the `catchUpPlannedForConnection` check in `alarm` → the stamp test fails.
- [ ] **Step 5:** Gates; commit `feat(reports): write each live report to the index with its arrival`.

### Task 1.4: Relay window walker

**Files:**
- Create: `worker/src/relay-walk.ts`
- Modify (only if #452 is unmerged): `worker/src/relay-profile.ts` (`queryRelay` gains `opts?: { timeoutMs?: number }`)
- Test: `worker/src/relay-walk.test.ts`

**Interfaces:**
- Produces:
  - `interface WalkOptions { relayUrl: string; filter: Record<string, unknown>; kind: number; since?: number; until?: number; pageSize: number; maxPages: number; pageTimeoutMs: number; fetchPage?: (filter: Record<string, unknown>) => Promise<unknown[]> }`
  - `interface WalkResult { complete: boolean; truncated: boolean; pages: number; rejected: number }`
  - `walkRelayEvents<T extends { id: string; created_at: number }>(opts: WalkOptions, onPage: (events: T[], nextUntil: number) => Promise<void>): Promise<WalkResult>` — newest first; filter `{...filter, kinds:[kind], limit: pageSize, since?, until?}` with inclusive `until`; de-duplicates by id across pages; passes only events that `verifyEvent` accepts with `kind === opts.kind` (counts the rest in `rejected`); awaits `onPage` before the next page. **Ends only on a page that adds no new id** (`complete: true`). Stops `truncated` (and `complete: false`) when a full page cannot advance the cursor (every event in the cursor's second) or at `maxPages`. A failed page (queryRelay `success: false`) throws; nothing more is requested.
  - `const RELAY_WALK_PAGE_TIMEOUT_MS` re-exported from `relay-profile.ts` (15000).

- [ ] **Step 1: Write the failing tests** (inject `fetchPage` over an in-memory corpus of signed kind-1984 events):
  - `ends only on a page that adds no new ids` (corpus 7, pageSize 5 → requests: until=∅, until=oldest-of-page-1, until=oldest-of-page-2; the last adds nothing; `complete: true`)
  - `collects everything when the relay caps limit below the page size` (fetchPage returns at most 3 per request when asked 5; all 11 collected, `complete: true`) — Review Focus 1
  - `continues past a short page that is not the end` (page 1 returns 4 of 5 because one row was dropped; older rows still collected)
  - `throws on a failed page and requests nothing more`
  - `stops truncated when one second fills a whole page`
  - `stops truncated at maxPages`
  - `sends since and an inclusive until, and kinds [kind]`
  - `rejects events that fail verification or have another kind, counting them`
- [ ] **Step 2:** `cd worker && npx vitest run src/relay-walk.test.ts` → FAIL.
- [ ] **Step 3:** Implement. Do not modify `shared/relay-pager.ts` (the browser's history read uses its short-page rule).
- [ ] **Step 4:** PASS. Mutations, one at a time: end on `batch.length < pageSize` → the capped-limit test fails; skip `verifyEvent` → the rejection test fails; drop the saturated-second check → that test loops or fails.
- [ ] **Step 5:** Gates; commit `feat(reports): walk a relay window without treating a short page as the end`.

### Task 1.5: Catch-up on connect through the live handler, with the burst alert

**Files:**
- Create: `worker/src/report-catchup.ts`
- Create: `worker/src/report-index-alerts.ts`
- Modify: `worker/src/ReportWatcher.ts` (`connect` 'open', `handleReportEvent` claim, new `/internal/report-catchup` POST route, `ReportWatcherEnv` gains `SLACK_WEBHOOK_URL?: string; ENVIRONMENT?: string`)
- Modify: `worker/src/index.ts` (`scheduled()`: after the maintenance call, POST `https://do/internal/report-catchup`; own try/catch)
- Test: `worker/test/report-catchup.d1.test.ts` (real D1, `ReportWatcher` constructed directly as in `greenlight-report-race.d1.test.ts`, fake relay WebSocket answering REQ, `fetch` stub recording NIP-86 methods and Slack posts)
- Test: `worker/src/report-catchup.test.ts` (pure window logic)

**Interfaces:**
- Consumes: `walkRelayEvents` (1.4), `findUnseenReportIds`, `readMeta` (1.2), `handleReportEvent` opts (1.3; index-only finds go through `sideEffects: false`, so arrival and index stay in one batch).
- Produces (`report-catchup.ts`):
  - `interface CatchUpWindow { since: number; until: number; handlerEnabled: boolean }`
  - constants `CATCHUP_OVERLAP_SECONDS = 600`, `CATCHUP_PAGE_SIZE = 500`, `CATCHUP_MAX_PAGES = 40`, `CATCHUP_MIN_ATTEMPT_INTERVAL_MS = 270_000`, `CATCHUP_MAX_PENDING_WINDOWS = 8`, `AUTO_ACTION_BURST_THRESHOLD = 10`
  - `planCatchUpWindow(lastAliveAt: number | undefined, nowSec: number, deliberateStop: boolean): CatchUpWindow | null` — `null` when `lastAliveAt` is undefined; else `{ since: lastAliveAt - 600, until: nowSec, handlerEnabled: !deliberateStop }`.
  - `addPendingWindow(pending: CatchUpWindow[], next: CatchUpWindow): { windows: CatchUpWindow[]; merged: boolean }` — append; beyond 8, merge the two oldest into `{ since: min, until: max, handlerEnabled: a && b }` and report `merged`.
  - `interface CatchUpDeps { db: D1Database; relayUrl: string; storage: DurableObjectStorage; claim(id: string): boolean; handle(report: SignedReport, handlerEnabled: boolean): Promise<void>; autoHiddenCount(): number; alert(text: string): Promise<void>; nowMs(): number }`
  - `runPendingCatchUp(deps: CatchUpDeps): Promise<{ ran: boolean; found: number; handled: number; autoHidden: number; complete: boolean }>` — skips (ran false) if the last attempt (storage `report-catchup-last-attempt`) is under 270 s old; else processes windows oldest first: for each page, `claim` each id, `findUnseenReportIds`, `handle` each unseen claimed report, then save `{...window, until: nextUntil}`; drops a window only when its walk is `complete`. A thrown page logs and leaves the window. After the pass, `autoHidden = autoHiddenCount() delta`; if `> AUTO_ACTION_BURST_THRESHOLD` → `alert`.
  - Storage keys: `report-catchup-windows` (CatchUpWindow[]), `report-catchup-last-attempt` (ms).
- Produces (`report-index-alerts.ts`): `sendReportIndexAlert(env: { SLACK_WEBHOOK_URL?: string; ENVIRONMENT?: string }, text: string): Promise<void>` — always `console.error('[ALERT] [report-index] ' + text)`; POSTs `{ text }` to the webhook when set; never throws (pattern of `sendDbUnavailableAlert`).
- ReportWatcher wiring: on 'open', after sending the live REQ: `blockConcurrencyWhile` → read `watcher_last_alive_at` and the deliberate-stop marker, `planCatchUpWindow`, `addPendingWindow`, save, delete the marker, set `catchUpPlannedForConnection = true`; then `state.waitUntil(runPendingCatchUp(...))`. `claim` uses `private claimedReportIds: Map<string, number>` (insertion order, cap 5000). The live path calls `claim(event.id)` first and returns if already claimed. `handle(report, true)` → `handleReportEvent(report, { source: 'catchup', preClaimed: true })`; `handle(report, false)` → same with `sideEffects: false`.

- [ ] **Step 1: Write the failing tests.** `report-catchup.test.ts`:
  - `plans no window when no heartbeat was ever recorded`
  - `starts the window ten minutes before the last heartbeat, from the watcher clock` (a future-dated report in the corpus does not move `since`)
  - `merges the two oldest windows past eight, keeping the handler off if either had it off`

  `report-catchup.d1.test.ts` (auto-hide config enabled, immediate tier `sexual_minors`, trusted client; seed `watcher_last_alive_at = now - 120`):
  - `runs auto-hide and age-review intake on a report filed while the watcher was down` (report A `sexual_minors` on an event, report B `NS-underageUser` on a pubkey, both `created_at = now - 60`, only in the fake relay → NIP-86 `banevent` for A's target; an `age_review_cases` row for B's pubkey; `report_index` rows `source='catchup'`; `report_arrivals` rows for both)
  - `skips a report already in report_arrivals` (seed an arrival for A → no `banevent`)
  - `indexes but runs no auto-hide or age review after a deliberate stop` (`/stop`, `/start` → rows indexed with arrivals, no `banevent`, no case)
  - `does nothing on the first connect when no heartbeat was ever recorded` (no meta row → no REQ with `since`, no index rows) — Review Focus 4
  - `a report delivered live during catch-up is handled once` (fake relay also pushes A on the live subscription before catch-up's page returns → exactly one `banevent`) — Review Focus 2
  - `alerts once when one pass auto-hides more than ten reports` (11 immediate-tier reports → one `[ALERT]` log and one webhook POST; with 10 → none)
  - `keeps a failed window and resumes it from its saved cursor no sooner than the attempt interval` (page 2 CLOSED → window saved with page-1 cursor; immediate second call → `ran: false`; after advancing time → request starts at the saved `until`)
- [ ] **Step 2:** `npx vitest run src/report-catchup.test.ts` and `npx vitest run --config vitest.d1.config.ts test/report-catchup.d1.test.ts` → FAIL.
- [ ] **Step 3:** Implement the module, the ReportWatcher wiring and the `/internal/report-catchup` route (returns `runPendingCatchUp`'s summary; the public proxy already refuses `/internal/`, `index.ts:4084`).
- [ ] **Step 4:** PASS. Mutations, one at a time: call `handle(report, false)` always → the auto-hide/age-review test fails; drop the `claim` check on the live path → the handled-once test fails; skip `findUnseenReportIds` → the arrival-skip test fails; remove the attempt-interval check → the resume test fails; threshold `>=` → the 10-report case fails.
- [ ] **Step 5:** Gates (the existing `ReportWatcher.test.ts` WebSocket tests now see a second REQ only when a heartbeat is seeded; update assertions that count sockets if they break, without weakening them); commit `fix(reports): catch up on reports filed while the listener was down`.

### Task 1.6: Record each published resolution label in D1

**Files:**
- Create: `worker/src/resolution-label-index.ts`
- Modify: `worker/src/index.ts` (`handlePublish`, after `publishResult.success`, before the Zendesk block ~1355)
- Test: `worker/test/resolution-label-index.d1.test.ts`; extend `worker/src/human-decision.test.ts` (publish route)

**Interfaces:**
- Produces:
  - `interface SignedLabel { id: string; pubkey: string; created_at: number; kind: number; tags: string[][]; content: string; sig: string }`
  - `isResolutionLabel(event: { kind: number; tags: string[][] }): boolean` (kind 1985 with `['L','moderation/resolution']`)
  - `resolutionLabelStatements(db: D1Database, labels: readonly SignedLabel[], source: 'publish' | 'backfill' | 'reconcile', nowSec: number): D1PreparedStatement[]` — `INSERT OR IGNORE`, 11 rows/statement; `target_event`/`target_pubkey` from the first `e`/`p` tag; `status` from the `l` tag in `moderation/resolution`; non-resolution labels skipped.
  - `recordResolutionLabel(db: D1Database, event: SignedLabel, nowSec: number): Promise<void>`

- [ ] **Step 1: Write the failing tests:**
  - D1: `records a resolution label once, with both targets and its status`; `ignores a kind-1985 label outside moderation/resolution`; `writes 30 labels within 100 parameters per statement`
  - Route: `records the label after the relay accepts it`; `records nothing when the relay rejects it`; `still answers success when the label write throws`
- [ ] **Step 2:** Run both → FAIL.
- [ ] **Step 3:** Implement; in `handlePublish` call `ensureSchemaOnce(env.DB)` then `recordResolutionLabel(env.DB, event, now)` inside try/catch, only when `env.DB` and `isResolutionLabel(event)`.
- [ ] **Step 4:** PASS. Mutation: move the write before `publishToRelay` → the reject test fails.
- [ ] **Step 5:** Gates; commit `feat(reports): record each published resolution label in D1`.

### Task 1.7: PR 1 verification

- [ ] **Step 1:** Local stack (`./scripts/dev-local.sh` plus local funnelcake per AGENTS.md, browser harness blocking prod). Start the watcher, wait for one heartbeat, stop the worker, publish an immediate-tier report from a trusted client to the local relay, start the worker. Expected: within one connect, the target is banned on the local relay, `report_index` has the row with `source='catchup'`, the queue shows the report.
- [ ] **Step 2:** All gates, including the full `npm run test:d1` (or per-file with the macOS note).
- [ ] **Step 3:** `superpowers:requesting-code-review` (problem-briefed) plus a second model seat per memory; resolve; re-review until clean. Then ask Matt draft vs ready with the fit-and-size verdict.

---

## PR 2: Backfill, incremental, hourly reconcile, certification, shadow comparison

Ships alone after PR 1 is merged and deployed: reads are still the relay walk; logs show whether the copy matches.

### Task 2.1: Route non-live finds to the live handler

**Files:**
- Modify: `worker/src/ReportWatcher.ts` (new `POST /internal/ingest-reports`)
- Create: `worker/src/report-reconcile.ts` (only `postIngest` in this task)
- Test: `worker/test/report-ingest.d1.test.ts`

**Interfaces:**
- Consumes: `claim`, `findUnseenReportIds`, `handleReportEvent` opts, `sendReportIndexAlert`, `AUTO_ACTION_BURST_THRESHOLD`.
- Produces: `POST /internal/ingest-reports` body `{ source: 'incremental' | 'full'; events: SignedReport[] }` (≤ 200 events); verifies each, claims, re-checks never-seen in D1, runs `handleReportEvent(e, { source, preClaimed: true })` for each unseen one, alerts past the threshold; returns `{ received, handled, autoHidden }`. Callers: `postIngest(env, source, events): Promise<void>` in `worker/src/report-reconcile.ts` (chunks of 200).

- [ ] **Step 1: Write the failing tests:** `handles a never-seen report from the cron like a live one` (banevent issued, arrival recorded); `skips a report already indexed`; `rejects an event that fails verification`; `alerts past ten auto-hides in one ingest`.
- [ ] **Step 2–4:** Run → FAIL; implement; PASS. Mutation: drop the in-DO never-seen re-check → the already-indexed test fails.
- [ ] **Step 5:** Gates; commit `feat(reports): run the live handler on reports the cron finds`.

### Task 2.2: Incremental window every five minutes

**Files:**
- Modify: `worker/src/report-reconcile.ts`
- Modify: `worker/src/index.ts` (`scheduled()`, own try/catch, after the watcher calls)
- Test: `worker/test/report-reconcile.d1.test.ts`

**Interfaces:**
- Produces: `INCREMENTAL_WINDOW_SECONDS = 7200`, `INCREMENTAL_PAGE_SIZE = 500`, `INCREMENTAL_MAX_PAGES = 20`; `runIncrementalReportSync(env: ReconcileEnv, nowSec: number): Promise<{ complete: boolean; found: number; added: number; routed: number }>` where `ReconcileEnv = { DB: D1Database; RELAY_URL: string; REPORT_WATCHER?: DurableObjectNamespace; SLACK_WEBHOOK_URL?: string; ENVIRONMENT?: string }`. Walks `since = now - 7200`; before certification indexes new ids with source `incremental` (no arrivals, no handler); after certification sends never-seen ids to `postIngest` and indexes nothing itself. Sets `last_incremental_ok_at` only on a complete walk.

- [ ] **Step 1: Write the failing tests:** `indexes a missed report without arrivals before certification`; `routes a never-seen report to the watcher after certification` (stub DO namespace records the ingest call); `does not stamp last_incremental_ok_at when a page fails`; `sends since = now - 7200`.
- [ ] **Step 2–4:** FAIL → implement → PASS. Mutation: stamp before the walk → the failed-page test fails.
- [ ] **Step 5:** Gates; commit `feat(reports): sync the last two hours of reports every five minutes`.

### Task 2.3: Hourly full walk, backfill, certification, shadow counts

**Files:**
- Modify: `worker/src/report-reconcile.ts`, `worker/src/index.ts` (`scheduled()`)
- Test: `worker/test/report-reconcile.d1.test.ts`

**Interfaces:**
- Produces: `FULL_PAGE_SIZE = 2000`, `FULL_MAX_PAGES = 50`, `FULL_INTERVAL_SECONDS = 3600`; `isFullReconcileDue(meta, nowSec): boolean` (`last_full_attempt_at` absent or ≥ 3600 s old); `runFullReportReconcile(env: ReconcileEnv & Nip86Env, nowSec: number): Promise<FullReconcileSummary>` with `FullReconcileSummary = { complete: boolean; seen: number; missingFromIndex: number; extraInIndex: number; certifiedNow: boolean; guard: 'ok' | 'tripped' | 'skipped' }`.
- Stamp `last_full_attempt_at` and walk all reports. Continue only after a complete walk. Read the indexed IDs and compute `missing = seen − indexed`.
- Before certification, index `missing` as `backfill` without arrivals or automated actions. After certification, send never-seen reports to `postIngest` before writing their index rows. The watcher rechecks whether each ID has been seen and writes the index and arrival for any report it handles. Pre-inserting those rows would cause the watcher to skip them. Reports that already have an arrival but lack an index row can be indexed directly as `full`.
- Restore `event_json`, `reporter_pubkey` and refs for seen rows erased as `unknown_expired` or `handled_unknown`, and clear their erasure fields. Clear `hidden_reason` and stamp `last_seen_at` on seen rows (100 IDs per statement). Run the absence step from Task 2.4 after certification.
- Set `extraInIndex` to the live unhidden rows indexed before the walk and absent from the results. Log `[report-index] shadow: missing_from_index=… extra_in_index=… seen=… held=…` and store `last_shadow_*`. Set `last_full_ok_at`, update `last_full_seen_count` unless the guard tripped, and set `backfill_certified_at` on the first complete walk.
- Backfill is simply this run while `backfill_certified_at` is unset: no arrivals, no handler.

- [ ] **Step 1: Write the failing tests:** `certifies on the first complete walk and records no arrivals for backfilled reports`; `does not certify or stamp last_full_ok_at when a page fails`; `runs at most once per hour, even after a failure`; `counts a report the live writer missed as missing_from_index and indexes it`; `brings back a report erased as unknown_expired when the relay serves it again`; `never brings back a report erased as deleted or vanished`; `stamps last_seen_at only on rows the walk saw`.
- [ ] Cover a full reconcile after certification through the watcher's D1 seen check. Assert that a missing report with no arrival reaches the handler and gets indexed. Assert that a missing report with a prior arrival is indexed without running the handler again.
- [ ] **Step 2–4:** FAIL → implement → PASS. Mutations: certify on an incomplete walk → its test fails; drop the `deleted`/`vanished` guard on resurrection → its test fails.
- [ ] **Step 5:** Gates; commit `feat(reports): reconcile the report index hourly and certify the backfill`.

### Task 2.4: Absent rows, mass-absence guard, 30-day fallback

**Files:**
- Modify: `worker/src/report-reconcile.ts`
- Test: `worker/src/report-reconcile.test.ts` (pure planner), `worker/test/report-reconcile.d1.test.ts`

**Interfaces:**
- Produces:
  - `MASS_ABSENCE_MIN_SEEN_RATIO = 0.9`, `UNKNOWN_HIDDEN_KEEP_SECONDS = 30 * 86400`
  - `planAbsence(input: { held: { reportId: string; reporter: string; indexedAt: number }[]; seen: ReadonlySet<string>; walkStartedAt: number; lastFullSeenCount: number | null; banned: ReadonlySet<string>; suspended: ReadonlySet<string> }): { guard: 'ok' | 'tripped'; reason?: string; marks: { reportId: string; hiddenReason: HiddenReason }[] }` — `held` excludes rows with `indexedAt >= walkStartedAt`; trips when absent > 10% of held, or `seen.size < 0.9 × lastFullSeenCount`; `banned`/`suspended` hold lowercase pubkeys; banned before suspended; else `unknown`.
  - `classifyAndExpire(env, db, nowSec, seen, walkStartedAt, meta): Promise<{ guard; marked: number; expired: number; handledDropped: number }>` — reads `listbannedpubkeys` and `listsuspendedpubkeys` once each via `callNip86Rpc` (either fails → mark nothing this hour, log); lowercases both; applies marks; erases `unknown` rows whose `coalesce(last_seen_at, indexed_at)` is over 30 days old (`erased_reason='unknown_expired'`); when `labels_certified_at` is set, also erases `unknown` rows whose report is handled under `isResolvedForReview` using D1 decisions and D1 labels (`erased_reason='handled_unknown'`). Every erasure sets `erased_at`, `event_json = NULL`, `reporter_pubkey = ''` and deletes the row's refs.
  - Guard trip → `sendReportIndexAlert` with counts only.

- [ ] **Step 1: Write the failing tests:** pure — `marks nothing and trips when more than ten percent are absent`; `trips when far fewer are seen than last time`; `ignores rows indexed after the walk started` (Review Focus 3); `classifies a reporter banned under an uppercase pubkey` (Review Focus 5); `marks unknown when the reporter is in neither list`. D1 — `keeps a banned reporter's report with its reason`; `erases an unknown row after thirty days and clears its body and refs`; `marks nothing when the ban list read fails`; `drops a handled unknown row only once labels are certified`.
- [ ] **Step 2–4:** FAIL → implement → PASS. Mutations, one at a time: remove the `indexedAt` filter → Review Focus 3 test fails; remove the lowercase step → Review Focus 5 test fails; ratio check `<` to `<=` on the guard → the boundary test fails (write it at exactly 90%).
- [ ] **Step 5:** Gates; commit `feat(reports): keep reports the relay stops serving, marked, behind a mass-absence guard`.

### Task 2.5: Label backfill and hourly label reconcile

**Files:**
- Modify: `worker/src/resolution-label-index.ts`, `worker/src/index.ts` (`scheduled()`)
- Test: `worker/test/resolution-label-index.d1.test.ts`

**Interfaces:**
- Produces: `runLabelReconcile(env: ReconcileEnv & Pick<Nip86Env, 'NOSTR_NSEC'>, nowSec: number): Promise<{ complete: boolean; seen: number; added: number; certifiedNow: boolean }>` — gated hourly by `labels_last_attempt_at`; resolves the signer with `resolveLabelSigner` (null → skip, log); walks `{ kinds:[1985], authors:[signer], '#L':['moderation/resolution'] }` with `walkRelayEvents` (page 2000, max 20); inserts unseen labels (`backfill` before certification, `reconcile` after, logging the count after); on a complete walk sets `labels_last_ok_at` and, first time, `labels_certified_at`. Labels in D1 but not on the relay are kept and counted in the log.

- [ ] **Step 1: Write the failing tests:** `backfills every label and certifies on a complete walk`; `adds a label whose publish-time write failed`; `does not certify when a page fails`; `skips labels from another signer`.
- [ ] **Step 2–4:** FAIL → implement → PASS. Mutation: drop the signer check → its test fails.
- [ ] **Step 5:** Gates; commit `feat(reports): backfill and reconcile resolution labels in D1`.

### Task 2.6: NIP-77 reconcile, walk as fallback

Splits into its own PR (2b) if PR 2 is already large; it changes only how the hourly runs read the relay.

**Files:**
- Create: `worker/src/relay-negentropy.ts`
- Modify: `worker/src/report-reconcile.ts`, `worker/src/resolution-label-index.ts`
- Test: `worker/src/relay-negentropy.test.ts` (fake relay that answers NEG-OPEN/NEG-MSG with `nostr-tools/nip77`'s `Negentropy` over its own `NegentropyStorageVector`)

**Interfaces:**
- Produces:
  - `negentropyDiff(relayUrl: string, filter: Record<string, unknown>, items: readonly { id: string; created_at: number }[], opts: { timeoutMs: number }): Promise<{ complete: true; have: string[]; need: string[] } | { complete: false; refused: boolean; error: string }>` — `have` = ours only, `need` = relay only; NEG-ERR → `refused: true`; timeout or close → `refused: false`. One socket, NEG-CLOSE at the end, no retry.
  - `fetchEventsByIds(relayUrl: string, ids: readonly string[], kind: number): Promise<SignedReport[] | SignedLabel[]>` — `{ ids, kinds:[kind], limit }` in chunks of 500, each must reach EOSE, verified and kind-checked; throws on any failed chunk.
- Behaviour: the hourly report and label reconciles use `negentropyDiff` unless `reconcile_negentropy_disabled = 1`; `seen = held − have ∪ need`; bodies for `need` via `fetchEventsByIds`. A refusal sets `reconcile_negentropy_disabled = 1` and logs; that hour ends incomplete (no walk in the same hour). Backfill (uncertified) always walks.
- Verify the `nostr-tools/nip77` import resolves in the worker bundle: `cd worker && npx wrangler deploy --dry-run --config wrangler.local.toml --outdir /tmp/rm-dry` (no deploy).

- [ ] **Step 1: Write the failing tests:** `reports ids only we hold and ids only the relay holds`; `is incomplete on a timeout and refused on NEG-ERR`; `a refusal disables negentropy and does not walk in the same hour` (D1, in `report-reconcile.d1.test.ts`); `fetches bodies for needed ids in chunks of 500 and fails the run when one chunk fails`.
- [ ] **Step 2–4:** FAIL → implement → PASS. Mutation: treat a timeout as refused → its test fails.
- [ ] **Step 5:** Gates; commit `perf(reports): reconcile with NIP-77 instead of re-reading every report`.

### Task 2.7: PR 2 verification

- [ ] **Step 1:** Local stack: seed the local relay with ~50 reports (include one from a reporter then banned via NIP-86, one then deleted). Trigger the cron with `wrangler dev --test-scheduled` (`curl "http://localhost:8787/__scheduled?cron=*/5+*+*+*+*"`). Expected logs: certification, `shadow: missing_from_index=0`, banned reporter's row `hidden_reason='reporter_banned'`, deleted report `unknown`.
- [ ] **Step 2:** Gates; review loop as in 1.7. PR description includes the cutover rule (design "Cutover"): at least 3 days of `missing_from_index=0` in prod logs before PR 3's flag flips.

---

## PR 3: Read cutover behind flags, hidden-reason marking

Ships alone after PR 2 is deployed and shadowed: with both flags off, behaviour is today's.

### Task 3.1: D1 read functions

**Files:**
- Create: `worker/src/report-index-reads.ts`
- Modify: `worker/src/resolution-label-index.ts`
- Test: `worker/test/report-index-reads.d1.test.ts`

**Interfaces:**
- Produces:
  - `interface IndexStatus { certified: boolean; labelsCertified: boolean; indexAsOf: number | null; lastFullOkAt: number | null; degraded: boolean }`; `readIndexStatus(db, nowSec): Promise<IndexStatus>` — `watcherAlive = now − watcher_last_alive_at ≤ 120`; `indexAsOf = watcherAlive ? now : max(last_incremental_ok_at, watcher_last_alive_at)`; `degraded = !lastFullOkAt || now − lastFullOkAt > 21600 || (!watcherAlive && now − (last_incremental_ok_at ?? 0) > 900)`.
  - `INDEX_READ_CHUNK = 1000`; `readLiveReports(db): Promise<{ events: RelayReport[]; hiddenReasons: Record<string, HiddenReason> }>` — `erased_at IS NULL`, keyset `(created_at, report_id) <` cursor, newest first, until a short chunk.
  - `readResolvedIndexPage(db, cursor: number | undefined, limit: number): Promise<{ events: RelayReport[]; hiddenReasons }>` — `created_at <= cursor` inclusive, `ORDER BY created_at DESC, report_id DESC LIMIT limit` (same cursor semantics as the relay page).
  - `readReportsByRef(db, ref: { type: 'e' | 'p'; value: string }): Promise<{ events; hiddenReasons }>` — `ref_value = canonicalHex64(value) ?? value`, joined to live rows, keyset paged.
  - `readLabelTargetsFromIndex(db, signer: string): Promise<PagedLabelTargets>` — parses `event_json` of every row and returns `reduceLabelsToTargets(events, signer)` with `truncated: false`, `oldestCovered` = min `created_at`.

- [ ] **Step 1: Write the failing tests:** `reads every live row across chunks, newest first, and leaves out erased rows`; `returns hidden reasons for marked rows`; `a pubkey lookup includes event reports that p-tag the account`; `a lookup by an uppercase id finds the lowercased ref`; `resolved page repeats the boundary second like the relay page`; `label targets from D1 equal the relay reduction for the same events`; `status is degraded when the full reconcile is over six hours old, or the watcher is down and the incremental is over fifteen minutes old`.
- [ ] **Step 2–4:** FAIL → implement → PASS. Mutation: drop `erased_at IS NULL` → its test fails.
- [ ] **Step 5:** Gates; commit `feat(reports): read reports and label targets from the index`.

### Task 3.2: Routes behind `REPORT_INDEX_READS` and `LABEL_INDEX_READS`

**Files:**
- Modify: `worker/src/reports-needing-attention.ts` (report and label sources become parameters), `worker/src/index.ts` (routes at ~891, ~923, ~976; `Env` gains both flags), `worker/wrangler.prod.toml`, `worker/wrangler.staging.toml`, `worker/wrangler.local.toml` (`REPORT_INDEX_READS = "false"`, `LABEL_INDEX_READS = "false"`)
- Test: `worker/test/reports-needing-attention.d1.test.ts` (extend), `worker/src/reports-needing-attention.test.ts`

**Interfaces:**
- Produces: `type ReportSource = { kind: 'relay' } | { kind: 'index'; status: IndexStatus }` and `type LabelSource = { kind: 'relay' } | { kind: 'index' }`; `getReportsNeedingAttention(db, relayUrl, labelSigner, opts?: { reportsPaging?; labelsPaging?; reportSource?: ReportSource; labelSource?: LabelSource })`, same added opts on `getResolvedReportsPage` and `getReportsForTarget`, and `readResolutionKeys(db, relayUrl, labelSigner, labelsPaging?, labelSource?)`. The route picks `index` only when the flag is `"true"` and the matching certification is set; otherwise `relay` (today's walk). `getReportsForTarget` derives its ref from `mode.filter` (`#e` → `e`, `#p` → `p`, first value). With `index`, no relay read happens on that request, and no fallback to the relay walk on error (502 as today).
- Response additions when served from the index: `index_as_of`, `last_full_ok_at`, `index_degraded`, `report_hidden_reasons` (by report id, returned events only); `truncated: false`. `/api/resolution-label-targets` serves `readLabelTargetsFromIndex` under `LABEL_INDEX_READS`. Legacy bulk mode and `/api/resolution-labels` stay on the relay.

- [ ] **Step 1: Write the failing tests:** `with the flag on and the index certified, the queue makes no relay request` (fake relay records zero REQs); `with the flag on but uncertified, the queue walks the relay`; `queue from the index selects the same events as the relay path for the same corpus` (both paths, one fixture); `a failed index read answers 502 and does not walk the relay`; `label targets come from D1 under LABEL_INDEX_READS with no relay request`; `response carries index status and hidden reasons only from the index path`.
- [ ] **Step 2–4:** FAIL → implement → PASS. Mutation: remove the certification check → the uncertified test fails.
- [ ] **Step 5:** Gates; commit `feat(reports): serve the queue, history and lookups from the index behind a flag`.

### Task 3.3: Degraded banner and hidden-reason marking

**Files:**
- Create: `src/lib/reportHiddenReason.ts` (+ `.test.ts`)
- Modify: `src/lib/adminApi.ts` (`ReportsNeedingAttention`, `ResolvedReportsPage`, `fetchReportsByTarget`), `src/components/ResolutionStateNotice.tsx` (new `ReportIndexDegradedBanner`), `src/components/Reports.tsx` (banner near `QueueTruncatedBanner` ~2419; row badges beside `HandledBeforeBadge` ~393 and ~476), `src/components/ReportDetail.tsx` (badge by the reporter)
- Test: `src/lib/adminApi.test.ts` (parse), `src/components/Reports.test.tsx` or the closest existing queue test

**Interfaces:**
- Produces: `HIDDEN_REASON_LABEL: Record<HiddenReason, string>` = `reporter_banned: 'Reporter is now banned'`, `reporter_suspended: 'Reporter is now suspended'`, `reporter_deactivated: 'Reporter has deactivated their account'`, `reporter_divine_only: 'Reporter uses Divine-only privacy'`, `unknown: 'Reporter no longer visible'`; `parseHiddenReasons(value: unknown): Record<string, HiddenReason>` (unknown values dropped); adminApi fields `reportHiddenReasons` and `indexStatus: { asOf: number | null; lastFullOkAt: number | null; degraded: boolean } | null`; `ReporterHiddenBadge({ reasons }: { reasons: HiddenReason[] })` (one outline badge per distinct reason, text only). Banner copy: `Relay Manager's copy of reports may be out of date. Last full check: {relative time or "never"}.`

- [ ] **Step 1: Write the failing tests:** `parses hidden reasons and drops unknown values`; `shows the degraded banner only when the feed says degraded`; `marks a row whose report's reporter is now banned`.
- [ ] **Step 2–4:** FAIL → implement (match existing Badge styles) → PASS.
- [ ] **Step 5:** Gates; commit `feat(reports): mark reports kept after their reporter became hidden`.

### Task 3.4: PR 3 verification

- [ ] **Step 1:** Local stack with both flags set to `"true"` by a temporary edit of `wrangler.local.toml` (reverted before commit; never via `.dev.vars`), Playwright harness blocking prod: queue loads with zero relay REQs for reports or labels (check worker logs), banner off; stop the watcher and age `last_incremental_ok_at` → banner on; banned reporter's row shows the badge. Screenshots for the PR.
- [ ] **Step 2:** Gates, `vite build` with blank dev URLs (memory: `VITE_WORKER_URL= VITE_RELAY_URL=`), review loop. PR description: cutover = set `REPORT_INDEX_READS` then `LABEL_INDEX_READS` to `"true"` after the shadow rule holds; the flags are the rollback.

---

## Not in these PRs

- **Phase 4, Relay Manager side** (after the divine-funnelcake `listmoderationreports` PR ships): catch-up, incremental, reconcile and backfill switch to that method; its reasons replace `unknown`; deleted and vanished reports erase as `deleted`/`vanished` and never return; the 30-day fallback retires. Needs its own plan once the method's response shape is merged.
- **Small load cuts** (design lists): Events tab kind default and refresh, `listeventsneedingmoderation` on mount, Users tab paging, ban-list poll rate. Separate small PRs.
- **Fold-ins:** the second label walk per refresh disappears when `LABEL_INDEX_READS` is on. `cancelRefetch` on a moderator action, double-click restarts and the related-reports focus re-walk stay as separate small PRs (PR #452 already joins a Retry to a running walk); after PR 3 they no longer touch the relay for reports.
