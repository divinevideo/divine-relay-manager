# Moderation Report Read (divine-funnelcake) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An admin-only NIP-86 method, `listmoderationreports`, that pages kind-1984 reports past the reporter-visibility filters (banned, suspended, deactivated, divine-only), keeps the erasure filters, returns each report's hidden reason, and reads `relay_events_by_kind_time`.

**Architecture:** Modelled on `getsuspendedevent` / `listsuspendedpubkeyevents` (#680, #1445): a new `VisibilityAudience` variant that only removes predicates from the one public list, a SQL builder, a validated options parser, a storage method on `ManagementQueries`, and a dispatch arm served only on the relay's NIP-86 endpoint. The read is a single ordered, limited scan of the `kind = 1984` slice of `relay_events_by_kind_time` with a `(created_at, id)` cursor, no `FINAL`, no 3x over-fetch, no `argMax`.

**Tech Stack:** Rust workspace (`crates/proto`, `crates/clickhouse`, `crates/relay`, `crates/api` tests), ClickHouse, `tests/integration_clickhouse.rs`, the query-cost harness (`crates/clickhouse/src/query_cost.rs`, `examples/measure_query_cost.rs`).

**Spec:** divine-relay-manager `docs/superpowers/specs/2026-11-24-report-index-design.md`, section "The divine-funnelcake PR (we build, Platform reviews)". Cost background: the session scratchpad `q-rm-inventory.md` (section 0 cost model; section 4, last row).

## Global Constraints

- **Reads `relay_events_by_kind_time`, never `events_deduped FINAL`.** Copied as-is across all reporters, the `listsuspendedpubkeyevents` shape would merge the whole events table on every page.
- **`kind = 1984`** as an equality (not `IN`), so the read stays on the sort-key prefix and reads in order (cost-cap doc, 2026-08-11).
- **No 3x inner over-fetch, no `GROUP BY` / `argMax`.** Kind 1984 is non-replaceable; the dedup key is the id. Unmerged duplicate rows are dropped with `LIMIT 1 BY id`.
- **Drops exactly** `banned_pubkeys_set`, `suspended_pubkeys_set`, `deactivated_pubkeys_set`, `divine_only_pubkeys_set`. **Keeps** `deleted_events_set`, `addressable_deleted_events_set`, `blocked_events_set`, `vanished_pubkeys_set`, expiry, future-date, and (see open question) `banned_events_set` and `quarantined_events_set`. An audience may only remove entries from the shared list (`VisibilityAudience` doc comment).
- **Admin-only:** NIP-98 admin auth, as every NIP-86 method. Served only where `SuspendedReads::Served` (the relay endpoint); the API `/management` fallback refuses it with `SUSPENDED_READS_UNAVAILABLE` and does not advertise it.
- **Page bounds:** default 500, maximum 2000 (Relay Manager's reconcile page), capped not refused. Final maximum is set by the measurement in Task 6.
- **Both visibility modes:** every predicate and membership expression is emitted through `not_member` / the new `member` for `SetTables` and `Dictionaries`; SQL-shape tests use the emitted form, never a hard-coded literal.
- **Production query path rules apply** (AGENTS.md "Adversarial Performance Review For Queries And Schemas"): measured before review, attack answers in the PR, measured under a stated credential, and an independent re-derivation by someone who did not produce the numbers. `scripts/check_clickhouse_query_guardrails.py` passes unmodified.
- **Gates:** `cargo fmt --all -- --check`, `cargo clippy --all-targets -- -D warnings`, `cargo test --all --lib`, `cargo test --test integration_clickhouse -- --test-threads=1` (local test stack up; `REQUIRE_TEST_INFRA=1` in CI), the guardrails script, then `python3 scripts/ci/request_full_ci.py <PR>` before handback.
- Worktree in `~/code/.worktrees/fc-moderation-report-read` off fresh `origin/main` (never the main checkout, which sits on another branch). Tear down `target/` when done. No production ClickHouse access from the authoring session except through the harness's sanctioned measurement route.
- Platform-owned paths: request review per divine-context `PR_REVIEW_TEAMS.md`; a Platform member approves. No corporate or individual identities in fixtures.

## Review Focus

1. **A reporter both banned and divine-only.** The reason must be deterministic: priority banned > suspended > deactivated > divine-only. Pinned in Task 3 (`hidden_reason_priority_is_banned_suspended_deactivated_divine_only`).
2. **Many reports in one second across a page boundary.** The `(until, until_id)` cursor must neither skip nor repeat. Pinned in Task 5 (`moderation_reports_page_through_a_shared_second`).
3. **A report from a vanished or deleted-and-banned reporter.** Erasure wins over the review audience. Pinned in Task 5 (`moderation_reports_keep_erasure_filters`).
4. **Unmerged duplicate rows** in the ReplacingMergeTree before a merge. One report must come back once. Pinned in Task 5 (`moderation_reports_return_each_report_once_before_merge`).
5. **A misspelled option** (`untill`, `since_id`). Must be refused, not silently return page one forever. Pinned in Task 4 (`moderation_reports_refuse_unknown_options`).

---

### Task 1: Protocol types

**Files:**
- Modify: `crates/proto/src/management.rs` (`RpcMethod` ~63, `as_str` ~152, `all()` ~192, `FromStr` ~248; types beside `SuspendedPubkeyEventsPage` ~284)

**Interfaces:**
- Produces:
  - `RpcMethod::ListModerationReports` ↔ `"listmoderationreports"`
  - `#[serde(rename_all = "snake_case")] enum ReportHiddenReason { ReporterBanned, ReporterSuspended, ReporterDeactivated, ReporterDivineOnly }`
  - `struct ModerationReport { event: RelayEvent, hidden_reason: Option<ReportHiddenReason> }` (`hidden_reason` always serialized, `null` when publicly visible)
  - `struct ModerationReportsPage { reports: Vec<ModerationReport>, next_until: Option<u64>, next_until_id: Option<String> }` (cursor fields always serialized)

- [ ] **Step 1: Write the failing tests** in the module's tests: `moderation_report_method_is_advertised_and_parses`; `moderation_reports_page_always_serializes_cursor_and_reason` (a page with one public report serializes `"hidden_reason":null`, `"next_until":null`, `"next_until_id":null`); `report_hidden_reason_serializes_snake_case` (`ReporterDivineOnly` → `"reporter_divine_only"`).
- [ ] **Step 2:** `cargo test -p funnelcake-proto moderation_report` → FAIL.
- [ ] **Step 3:** Add the variant and types.
- [ ] **Step 4:** PASS; `test_rpc_method_round_trip` still passes.
- [ ] **Step 5:** Commit `feat(nip86): add listmoderationreports protocol types`.

### Task 2: Positive membership helper

**Files:**
- Modify: `crates/clickhouse/src/event_filters.rs` (beside `not_member` ~259)

**Interfaces:**
- Produces: `pub(crate) fn member(mode: VisibilityFilterMode, set_table: &str, column: &str) -> String` — `"{column} IN {set_table}"` or `"dictHas('nostr.{dict}', {column})"`, the exact negation of `not_member`.

- [ ] **Step 1: Write the failing test:** `member_is_the_exact_negation_of_not_member` (for both modes and every entry the new audience classifies: `format!("NOT {}", member(..))` equals `not_member(..)` in dictionary mode; `"{column} NOT IN {set}"` vs `"{column} IN {set}"` in set-table mode).
- [ ] **Step 2–4:** FAIL → implement → PASS.
- [ ] **Step 5:** Commit `refactor(clickhouse): add a positive visibility membership helper`.

### Task 3: Audience and SQL builder

**Files:**
- Modify: `crates/clickhouse/src/event_queries.rs` (`VisibilityAudience` ~3216 and its predicate functions ~3258-3343; builder beside `build_suspended_author_events_sql` ~438; tests module)

**Interfaces:**
- Consumes: `member` (Task 2), `kind_condition`, `build_cursor_condition`, `push_event_read_policy_condition`, `split_suspended_page`, `EventPageCursor`.
- Produces:
  - `VisibilityAudience::ModerationReportReview` — drops exactly the four reporter predicates; keeps every other entry. Implement through small predicate methods on the enum (e.g. `applies_reporter_visibility()`), the way `applies_suspension_and_quarantine()` / `applies_event_ban()` work.
  - `pub const MODERATION_REPORTS_MAX_PAGE: usize = 2000; pub const MODERATION_REPORTS_DEFAULT_PAGE: usize = 500;`
  - `pub(crate) enum ModerationReportsStart<'a> { Newest, AtOrBefore(u64), Before(&'a EventPageCursor) }`
  - `pub(crate) fn build_moderation_reports_sql(start: ModerationReportsStart<'_>, since: Option<u64>, protected_kinds: &[u16]) -> String` (and a `_with_mode` twin for tests). Binds only the row limit (`limit + 1`). Shape:

```sql
SELECT id, pubkey, created_at, kind, content, sig, tags, relay_source,
       multiIf(<member banned_pubkeys_set pubkey>,      'reporter_banned',
               <member suspended_pubkeys_set pubkey>,   'reporter_suspended',
               <member deactivated_pubkeys_set pubkey>, 'reporter_deactivated',
               <member divine_only_pubkeys_set pubkey>, 'reporter_divine_only',
               '') AS hidden_reason
FROM relay_events_by_kind_time
WHERE kind = 1984 AND <since: created_at >= toDateTime(since)> AND <start condition>
  AND <ModerationReportReview visibility conditions on id/pubkey> AND <read policy>
ORDER BY created_at DESC, id DESC
LIMIT 1 BY id
LIMIT ?
SETTINGS max_rows_to_read = <from measurement>, max_bytes_to_read = <from measurement>
```

  No time or memory `SETTINGS` (operator client options, as `SUSPENDED_AUTHOR_READ_SETTINGS` explains). Doc comment states the bound, the audience and why the read is not confined to a subject (reports, not an account: the only rows reachable are kind 1984, which every admin may review).

- [ ] **Step 1: Write the failing tests** (all through `emitted_not_member` / `member` with the active mode):
  - `moderation_report_review_drops_exactly_the_reporter_predicates` (pattern of `suspended_author_review_drops_exactly_suspension_and_quarantine` ~6258: compare the audience's list with `Public`'s; the difference is exactly the four `pubkey` entries)
  - `moderation_reports_sql_reads_kind_time_without_final` (contains `FROM relay_events_by_kind_time`, `kind = 1984`; contains neither `events_deduped` nor `FINAL` nor `GROUP BY` nor `argMax`)
  - `moderation_reports_sql_pages_by_strict_cursor` (`Before(cursor)` emits `build_cursor_condition`; `AtOrBefore(u)` emits `created_at <= toDateTime(u)`; `since` emits `created_at >= toDateTime(s)`)
  - `hidden_reason_priority_is_banned_suspended_deactivated_divine_only` (the `multiIf` arguments appear in that order) — Review Focus 1
  - `moderation_reports_sql_keeps_erasure_predicates_in_both_modes` (deleted, addressable-deleted, blocked, vanished, expiry, `created_at <= now()`)
- [ ] **Step 2:** `cargo test -p funnelcake-clickhouse moderation_report` → FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** PASS. Mutations, one at a time: let the new audience drop `vanished_pubkeys_set` too → the drops-exactly test fails; swap the first two `multiIf` arms → the priority test fails.
- [ ] **Step 5:** `python3 scripts/check_clickhouse_query_guardrails.py` passes; commit `feat(clickhouse): build the moderation report read on the kind-time index`.

### Task 4: Parser, storage method, dispatch

**Files:**
- Modify: `crates/clickhouse/src/management.rs` (parser beside `parse_suspended_events_query` ~4410; storage method beside `list_suspended_pubkey_events` ~1934; dispatch arm after `ListSuspendedPubkeyEvents` ~3963; `SupportedMethods` filter ~3800)
- Modify: `crates/clickhouse/src/queries.rs` (row type beside `EventRow` ~23)
- Modify: `crates/clickhouse/src/traits.rs` (trait ~2407, `ClickHouseClient` forwarding ~2795)
- Modify: `crates/relay/src/management.rs` (`read_only_method` ~21)
- Modify: `crates/api/src/tests.rs` (both `ManagementQueries` mocks ~17271, ~18840; dispatch tests near ~17854)

**Interfaces:**
- Produces:
  - `pub struct ModerationReportsQuery { pub since: Option<u64>, pub until: Option<u64>, pub until_id: Option<String>, pub limit: usize }`
  - `fn parse_moderation_reports_query(params: &[serde_json::Value]) -> Result<ModerationReportsQuery, String>` — options object at `params[0]` (absent or null = defaults); keys `since`, `until`, `until_id`, `limit`; unknown keys refused; `until`/`since` ≤ `u32::MAX`; `until_id` lowercase 64-hex and only with `until`; `since <= until` when both; `limit` 1.. capped at `MODERATION_REPORTS_MAX_PAGE`.
  - `struct ModerationReportRow` (`#[derive(clickhouse::Row, Deserialize)]`, the `EventRow` columns plus `hidden_reason: String`) with `fn into_moderation_report(self) -> ModerationReport` (`""` → `None`).
  - `ClickHouseClient::list_moderation_reports(&self, query: &ModerationReportsQuery, protected_kinds: &[u16]) -> Result<ModerationReportsPage, ClickHouseError>` — builds the start from the query as `list_suspended_pubkey_events` does, binds `limit + 1`, splits with `split_suspended_page`, instrumented as `"mgmt_moderation_reports"`.
  - `ManagementQueries::list_moderation_reports(...)` with the same signature; forwarding impl; both test mocks implement it.
  - Dispatch: `RpcMethod::ListModerationReports` requires `SuspendedReads::Served { protected_kinds }` (else `SUSPENDED_READS_UNAVAILABLE`); `SupportedMethods` hides it when unavailable; `read_only_method` lists it.

- [ ] **Step 1: Write the failing tests:**
  - management.rs: `moderation_reports_refuse_unknown_options` (Review Focus 5); `moderation_reports_cap_limit_and_default_to_500`; `moderation_reports_refuse_until_id_without_until`; `moderation_reports_refuse_since_after_until`
  - api tests: `moderation_reports_are_served_and_advertised_on_the_relay_endpoint`; `moderation_reports_are_refused_and_hidden_on_the_api_fallback`; `moderation_reports_require_admin_auth` (if the existing auth tests are per-method, follow that pattern; otherwise cover through the relay handler's admin check)
- [ ] **Step 2:** `cargo test --all --lib moderation_report` → FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** PASS. Mutation: drop the `SuspendedReads` gate → the API-fallback test fails.
- [ ] **Step 5:** `cargo clippy --all-targets -- -D warnings`; commit `feat(nip86): serve listmoderationreports on the relay endpoint`.

### Task 5: Integration tests against ClickHouse

**Files:**
- Modify: `tests/integration_clickhouse.rs` (beside the suspended-read tests ~49797; reuse `refresh_suspended_pubkeys_set` ~3718 and the set-refresh helpers for the other sets)

- [ ] **Step 1: Write the failing tests** (synthetic keys only):
  - `moderation_reports_return_reports_hidden_by_reporter_state_with_reasons` (reports from a banned, a suspended, a deactivated, a divine-only and a plain reporter → all five, reasons `reporter_banned`, `reporter_suspended`, `reporter_deactivated`, `reporter_divine_only`, `null`; a public REQ `{kinds:[1984]}` over the same data returns only the plain one)
  - `moderation_reports_keep_erasure_filters` (a NIP-09-deleted report, a report from a vanished reporter, an expired report and a blocked one are absent) — Review Focus 3
  - `moderation_reports_page_through_a_shared_second` (7 reports in one second, limit 3 → three pages, all 7 once, cursor from `next_until`/`next_until_id`) — Review Focus 2
  - `moderation_reports_return_each_report_once_before_merge` (insert the same report row twice without `OPTIMIZE` → one result) — Review Focus 4
  - `moderation_reports_respect_since` (rows older than `since` absent)
- [ ] **Step 2:** Start the local test stack (`docker-compose -f docker-compose.test.yml up -d`); `cargo test --test integration_clickhouse moderation_reports -- --test-threads=1` → FAIL.
- [ ] **Step 3:** Fix anything the tests expose (expected: none beyond Tasks 3–4).
- [ ] **Step 4:** PASS. Mutation: remove `LIMIT 1 BY id` → the before-merge test fails.
- [ ] **Step 5:** Commit `test(clickhouse): cover the moderation report read end to end`.

### Task 6: Query-cost adapter and measurements

**Files:**
- Modify: `crates/clickhouse/src/query_cost.rs` and `crates/clickhouse/examples/measure_query_cost.rs` (a `moderation-reports` adapter that calls `build_moderation_reports_sql` and binds as the application does; scenarios `{ "start": "newest" | {"until": n} | {"until": n, "until_id": hex}, "since": n?, "limit": n }`)
- Read first: `docs/query-cost-harness.md`, `docs/clickhouse-cost-analysis-guardrails.md`, `.claude/rules/clickhouse-sql.md`

- [ ] **Step 1:** Add the adapter with a render test (`--render` emits the canonical statement and bindings, executes nothing).
- [ ] **Step 2:** Measure through a sanctioned route (native harness or Brain `clickhouse_measure`), aggregating every computed column including `hidden_reason`: scenarios Newest/500, Newest/2000, a deep `Before` cursor/2000, `since = now − 7200`/500 (Relay Manager's incremental window). Record wall time, rows and bytes read, peak memory from `clusterAllReplicas('default', system.query_log)` `QueryFinish`, and `system.parts` size of `relay_events_by_kind_time` and of the `kind = 1984` slice.
- [ ] **Step 3:** Benchmark `LIMIT 1 BY id` against the same statement without it (and, for comparison only, against `relay_events_by_kind_time FINAL` with the kind prefix) under the guardrails doc's method; keep `LIMIT 1 BY id` unless the numbers say otherwise, and record why. Set `max_rows_to_read`/`max_bytes_to_read` from the measured worst case with headroom, and the final `MODERATION_REPORTS_MAX_PAGE`.
- [ ] **Step 4:** Commit `test(clickhouse): add a query-cost adapter for the moderation report read`.

### Task 7: Documentation and PR

**Files:**
- Modify: `README.md` (NIP-86 method list ~734), `docs/LLM_API_GUIDE.md` (NIP-86 section), `docs/TRUST-AND-SAFETY.md` ("Reviewing reports": name `listmoderationreports` as the raw-report admin read, beside the aggregated `/api/moderation/reports`)

- [ ] **Step 1:** Document params, response, reasons, the kept and dropped filters, and "relay endpoint only".
- [ ] **Step 2:** All gates; `python3 scripts/ci/request_full_ci.py <PR>` once the PR exists.
- [ ] **Step 3:** PR description (draft unless Matt says ready): the gap (from the design, generic wording, no identities), what is dropped and kept, the measurements with the credential's `max_memory_usage` / `max_execution_time` / readonly state, the attack answers (no prune: impossible, `kind = 1984` is the sort prefix; 10x volume: the 1984 slice grows linearly, reads stop at `limit` rows in order; no `FINAL`; not an MV; memory bounded by `limit` and the scan caps), migration hygiene "not applicable (no migration)", what could not be verified, Relay Manager's call pattern (hourly full walk of ~3 pages at 2000, a `since` window every 5 minutes, a `since` catch-up on reconnect), and PR_REVIEW.md's identity block. Request the Platform review team and an independent performance review session (divine-plugin `independent-performance-review`, dispatched by a Platform member) before merge.
