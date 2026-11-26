# Relay Manager's own copy of reports

Status: draft for Matt's approval, 2026-11-24.

## Why

Every time a moderator opens the report queue, Relay Manager re-reads every report ever filed from the relay: 5,295 reports today, in pages of 2,000, plus the resolution labels twice. Each open tab repeats this every minute. That was tolerable on ClickHouse Cloud. On the self-hosted ClickHouse with a per-query thread cap (switched 2026-11-24), it puts avoidable load on the relay's database, and slow pages made about one queue load in three fail until #452's stopgap.

Matt's direction: tax the relay's database as little as possible and be patient.

Three more problems surfaced during the investigation, and this design addresses them too:

- The background listener (ReportWatcher) subscribes with `{ kinds: [1984], limit: 0 }` and never catches up. A report filed while it is disconnected, including during every deploy restart, never gets auto-hide (immediate-tier categories included) and never starts age review.
- The relay's REQ path applies its public visibility filters to every read, with no moderator bypass (funnelcake `event_queries.rs` ~3279-3358). Moderators never see reports whose reporter is later banned, suspended, deactivated, vanished or "divine-only" (a privacy setting users choose themselves), nor reports that were deleted, quarantined or expired.
- The queue cost grows with every report ever filed.

## Goals

1. The queue loads from Relay Manager's own D1 copy of reports, in milliseconds, with no relay read per page view.
2. The copy is complete: no report the relay accepted is missing from it for longer than one reconciliation cycle.
3. A report filed while the listener is down is still caught, and gets the same treatment as a live report.
4. Moderators see reports the relay hides because of something about the reporter, marked with the reason.
5. Relay load from Relay Manager drops to the live subscription plus a periodic reconcile.
6. Resolution labels come from Relay Manager's own record too. Relay Manager signs every resolution label itself (since #451), so it records each one in D1 when it publishes it and stops reading them back from the relay (today the label walk runs twice per tab per minute and costs the relay thousands of per-id lookups).

## Non-goals

- Changing which reports are "handled". Handled state stays exactly as today: D1 decisions plus resolution labels, read live on every load.
- Changing the moderation UI beyond the new "reporter is now …" marking and a degraded-index banner.
- Replacing the relay as the source of truth. The relay remains authoritative; the copy is a cache we can rebuild.

## Anti-goals (a failure even if it technically works)

- **A short queue.** The copy must never silently show fewer reports than the relay holds. Any doubt shows more and says so (the #186 / #221 rule).
- **Keeping data someone asked to erase.** A report its reporter deleted, or any report from a reporter who invoked vanish (NIP-62), must not live on in our copy.
- **A burst of automated actions nobody notices.** If catch-up applies auto-hide to many reports at once, it must be visible.
- **More relay load than today**, at any point, including during backfill.

## Constraints

- Cloudflare Workers + D1 (SQLite): 100 bound parameters per statement, single writer, row reads are billed. Schema is created on demand (`ensureSchema`) with a matching migration file kept in sync.
- The relay sends nothing until a query finishes, and keeps running a query up to 30s after the client hangs up. Never retry relay walks; never start a query nobody will wait for.
- `created_at` is set by the reporter and can differ from relay arrival time. The current report reads expose only `created_at`. Catch-up uses the watcher's clock to plan read windows and the report timestamp to approximate the pause boundary.
- Handled-before logic (#324) depends on `report_arrivals` (first-seen time). The copy must keep that meaning.
- No production access from agents during build; staging is gone, so validation is local plus a shadow period in prod.

## Approaches considered

1. **Relay Manager keeps its own copy.** The listener writes each report to D1 as it arrives, catches up after restarts, and a timer reconciles against the relay. Fast, no per-view relay load, no dependency on Platform. Costs: we build and maintain the sync, and must make reconciliation safe.
2. **Platform builds a moderation reports endpoint** with an arrival-ordered cursor that includes hidden reports. Less for us to build, but depends on Platform's time, the relay still does the work on every load, and it does nothing for the listener's missed auto-hides.
3. **Approach 1 now, Platform help later.** Build our own copy; later ask Platform for a cheaper reconcile (NIP-77 negentropy, which funnelcake's storage supports, or an arrival-ordered cursor) and for a way to learn why a report is hidden.

**Matt picked 3** (2026-11-24).

## Decisions Matt made

- 2026-11-24, after a query-cost audit (see "Query cost" below): add the label record to this project; the relay change must read the relay's efficient reports index; reconcile uses NIP-77 where available; quick load fixes outside this design ship as separate small PRs.

- Build our own copy; catch-up ships first; Platform help later (approach 3).
- Keep reports whose reporter is later **banned, suspended, deactivated or divine-only**, and **mark why** in the queue ("reporter is now banned", "reporter uses Divine-only privacy", …).
- Catch-up sends previously unseen reports outside recorded stop periods through the live handler, including auto-hide and age-review intake. There is no age cap on that handling. The burst alert covers outages that produce many automated hides.
- When the relay stops serving a report and we **can't tell why**, keep it up to **30 days**, marked "reporter no longer visible"; drop it earlier once a moderator has handled it, and at once if the relay later says it was a deletion or erasure.
- **Queue, resolved history and report lookups** (related reports, deep links) all switch to our copy together, so they always agree. Screen widgets that read the relay directly (reporter history counts, the Events tab) stay as they are for now.
- **Divine-only reports: we bring the fix.** Rather than asking Platform to build it, this project includes a divine-funnelcake PR (below) that we write and a Platform reviewer approves. The underlying gap is documented here so it can be filed when we're ready.

## My calls (Matt can override)

- **Drop** a report its reporter deleted (NIP-09) and every report from a reporter who invoked vanish (NIP-62): both are explicit erasure choices.
- **Keep all history**, as today's queue does.
- **Arrival time for late-found reports = discovery time**, exactly as the live path records it. The one-time backfill never records arrivals (otherwise every old report on a handled target would resurface as "handled before").
- **Every way of finding a report runs the live handler on a report we've never seen**: catch-up, the incremental cron and the full reconcile (only they can see a backdated report or one missed while connected). The handler runs in the ReportWatcher Durable Object, so cron and reconcile finds are routed to it. **"Never seen" means not in `report_arrivals` and not in `report_index`, and the handler only runs after backfill is certified**; before that, only catch-up runs it, and only for reports newer than the listener's last heartbeat minus the overlap. This keeps already-handled history from re-running (the handler is not idempotent: a closed under-16 case would reopen).
- **A deliberate stop is not a gap.** If the listener was stopped on purpose (`/api/report-watcher/stop`), the next start indexes what it missed but runs no auto-hide or age review for that period, and it respects the auto-hide switch as it stands. The period runs from the stop to two minutes after the `/start`, by `created_at`: the margin holds reports filed during the stop by a client whose clock runs fast. Time after that until a late connect is an outage. The adult-report replay skips the same periods.
- **Burst alert**: if one catch-up pass applies auto-hide to more than N reports (start N = 10), log it loudly and send a Slack alert when SLACK_WEBHOOK_URL is set (it is not yet; that's a pending call).

## Design

### Data

`report_index` (D1):

| column | meaning |
|---|---|
| `report_id` | lowercase hex event id, primary key |
| `created_at` | the report's own timestamp (reporter-set) |
| `reporter_pubkey` | lowercase hex |
| `target_type`, `target_id` | lookup aids, computed by the existing shared report-target helper |
| `event_json` | the full signed event |
| `source` | `live`, `catchup`, `incremental`, `full`, `backfill` |
| `indexed_at` | when we first stored it |
| `last_seen_at` | last time a confirmed full reconcile saw it on the relay |
| `hidden_reason` | null, or why the relay no longer serves it but we keep it (`reporter_banned`, `reporter_suspended`, `reporter_deactivated`, `reporter_divine_only`, `unknown`) |
| `erased_at` | set when we drop it for deletion or vanish; the row's `event_json` is cleared at the same time |

Indexes on `(created_at, report_id)`, `(target_type, target_id)`, and a partial index on live rows (`erased_at IS NULL`).

`report_index_meta`: `backfill_certified_at`, `last_full_ok_at`, `last_full_seen_count`, `last_incremental_ok_at`, `watcher_last_alive_at`.

Selection stays in TypeScript: the read path parses `event_json` and runs the unchanged queue selection, so casing rules and the handled-before rules can't drift into SQL.

### Writers

1. **Live** (ReportWatcher, existing handler): after signature verification, insert into `report_index` in the same batch as `report_arrivals`. Non-critical: logged, never blocks auto-hide.
2. **Catch-up on reconnect** (ships first): when the listener connects, it sends a paged REQ for reports since `watcher_last_alive_at` minus a 10-minute overlap. The listener's heartbeat defines the start of the recovery window. Catch-up skips reports already in the arrival log or index. It runs the live handler for other reports and records arrivals and index rows without moderation for reports in stopped periods. The 30-second heartbeat advances once the current live subscription reaches EOSE and the recovery window is saved.
3. **Incremental** (existing */5 cron): read a recent window (since now minus 2h) and upsert. This covers anything the watcher missed while alive.
4. **Full reconcile** (hourly, off the request path, patient timeouts, no retries): walk all reports; upsert every row seen; stamp `last_seen_at`. Only after a confirmed complete walk (every page EOSE, not truncated) does it consider rows it did not see.
5. **Backfill**: the first full reconcile into an empty table; sets `backfill_certified_at`. It records no arrivals and runs no auto-hide.

### Rows the relay stops serving

A confirmed full walk that doesn't see a row we hold means the relay is hiding or has removed it. Before changing anything, classify it:

- reporter in the relay's banned or suspended list (NIP-86 `listbannedpubkeys` / `listsuspendedpubkeys`, which Relay Manager already reads): keep, set `hidden_reason`.
- reporter deactivated or divine-only, or the report deleted, vanished, quarantined or expired: Relay Manager can't tell these apart from the relay today (the relay never stores or broadcasts a NIP-62 vanish request, and subscribing to kind 5 deletions would add relay load). The planned reconciliation keeps unknown rows for up to 30 days and drops them earlier once handled. The proposed report read identifies reporter visibility for rows it returns. Retiring the fallback for missing rows also needs an authoritative deletion or erasure signal.

**Mass-absence guard:** if a walk sees fewer than about 90% of the rows we hold, or far fewer than last time, it marks nothing and alerts. A relay that caps `limit` below the page size would otherwise read as "nothing older" and empty the queue.

### Read path

- Applies to the queue (`/api/reports?needs_attention=1`), resolved history (`/api/reports/resolved`) and target lookups (`getReportsForTarget`: related reports, deep links). Legacy bulk mode stays on the relay walk for old bundles.
- Not certified: today's relay walk (with #452's patience).
- Certified, and the flag `REPORT_INDEX_READS=true`: read live rows from D1 in keyset chunks, then the same handled-state inputs as today.
- The response carries `index_as_of`, `last_full_ok_at` and `index_degraded`. The queue shows a banner when the index is degraded (full reconcile older than 6h, or incremental older than 15m while the watcher is down). It never silently serves a stale copy.
- Once certified, no fallback to the relay walk on the request path: the relay is what we're protecting.
- Reports with a `hidden_reason` show in the queue with the marking.

### Cutover

A shadow period before the flag flips: the cron compares the relay walk's id set to the index's and logs counts only (`missing_from_index`, `extra_in_index`). Run at least 3 days in prod with `missing_from_index = 0`, then flip `REPORT_INDEX_READS`. The flag is the rollback.

### Labels

`resolution_labels` (D1): one row per resolution label Relay Manager publishes (event id, target type and id, label value, created_at, the signed event). Written in the publish path after the relay accepts the label (non-critical to the action's own success, logged). A one-time backfill seeds it from the relay (the 2,635+ labels all signed by the worker key). Reads of resolution-label targets (the queue, resolved history, `/api/resolution-label-targets`) come from D1 once seeded and certified, behind the same flag pattern. Reconcile compares against the relay hourly, like reports, to catch a publish whose D1 write failed.

### Query cost (what this design must not get wrong)

- The hourly reconcile should use NIP-77 negentropy (funnelcake supports it; it compares ids and timestamps only) rather than re-reading every report. Until it's wired up, a paged REQ walk at most once an hour.
- The shadow comparison reuses the hourly reconcile's results; it adds no walks of its own.
- A short relay page is not proof of the end: funnelcake can drop newly banned events after its SQL limit (`relay.rs` ~3951-3967). Walks and the mass-absence guard must not treat one short page as "nothing older" on its own.

### The divine-funnelcake PR (we build, Platform reviews)

**The gap.** funnelcake's live broadcast and its REQ path both drop events from divine-only and deactivated pubkeys before any subscriber sees them (`crates/relay/src/relay.rs` ~1598-1611; `crates/clickhouse/src/event_queries.rs` ~3326-3351). Divine-only is a privacy setting ordinary active users choose (their posts are served only inside the Divine app). They can still file reports, and the relay accepts them, but no report they file ever reaches Relay Manager: moderators silently never see them. Our own copy can't fix that alone because we never receive those reports. To be filed as an issue when we're ready.

**The fix.** A new admin-only NIP-86 method, modelled on the existing `getsuspendedevent` / `listsuspendedpubkeyevents` extensions and their `SuspendedAuthorReview` audience (#680): a paged read of kind-1984 reports (`since` / `until` / `limit`, a stable order) under a moderation-review audience that **drops the reporter-visibility filters** (banned, suspended, deactivated, divine-only) but **keeps erasure** (deleted, vanished, expired, blocked), and returns each report with the reason it is hidden from the public, if any. Relay Manager uses it for catch-up, the incremental read, reconcile and backfill. Same admin auth Relay Manager already uses for NIP-86. **It must read the kind-time reports index (`relay_events_by_kind_time`), not `events_deduped FINAL`** as `listsuspendedpubkeyevents` does: copied as-is across all reporters it would merge the whole events table on every page.

A Platform member reviews and approves it; Matt may name a specific reviewer.

### Phases

1. **Catch-up + live writes** (safety fix, ships alone): listener catch-up through the live handler, burst alert, and live inserts into `report_index` (dual write; reads unchanged).
2. **Backfill + reconcile + shadow diff.**
3. **Read cutover** behind the flag, plus the hidden-reason marking in the UI.
4. **The divine-funnelcake PR** (can start in parallel with phase 2): the moderation-review report read with reasons. Relay Manager switches its reads to it once it ships. The 30-day fallback for missing reports stays until an authoritative deletion or erasure signal is available.
5. **Later, optional**: NIP-77 negentropy or an arrival-ordered cursor so reconcile doesn't walk everything; confirm the production per-REQ limit is at least 2,000.

### Load cuts outside this design (separate small PRs, Matt 2026-11-24)

- Events tab: default to a kind filter (no-kinds REQ is the relay's most expensive shape) and stop the 30s auto-refresh.
- `listeventsneedingmoderation`: stop calling it on every Events tab mount (it sorts all of `events_local`).
- Users tab: page the banned/suspended lists and fetch profiles with the bulk REST endpoint.
- Ban lists: poll less often than every 15s.

### Smaller load cuts to fold in (found during review)

- The queue reads the labels twice per refresh (feed and `/api/resolution-label-targets`).
- A moderator action can start a second walk while one is running (`cancelRefetch` default).
- The header Refresh button and the related-reports "Try again" can restart a running walk on double click.
- A successful related-reports read re-walks on tab focus after 60s.

These are listed so the plan can decide whether each lands in phase 3 or as a separate small PR.

## Verification

- D1 tests (`npm run test:d1`) for upsert idempotency, catch-up after a simulated disconnect, the mass-absence guard, the certification gate, erasure, and hidden-reason marking.
- Catch-up must be proven to run the live handler (auto-hide and age-review intake) on a missed report, with a test that fails if it doesn't, and the burst alert must fire past N.
- On the local stack, wait for the watcher's first heartbeat, terminate the worker, and file a report. Restart the worker and verify auto-hide and the queue entry. Repeat with the watcher's `/stop` and `/start` endpoints and verify that catch-up records the report without automated action.
- The shadow period in prod before cutover.

## What's left to the builder

- Exact page sizes, cron cadence for the hourly reconcile (gated by `last_full_ok_at`), and the burst threshold's final value.
- How to batch D1 writes within the 100-parameter limit.
- Where the hidden-reason marking sits in the queue card and report pane, following the existing badge styles.
