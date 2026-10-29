# Sexual-video quarantine rollout

This is an opt-in report-enforcement slice. It adds reversible event/media holds,
urgent review and recovery. It does not enable visual provider decisions or change
single-report policy. No production deployment is established by local tests.

## Dependency and activation order

1. Apply Funnelcake migration 295 through its normal schema workflow. Retain both
   active rows and release tombstones. Deploy the compatible API and relay builds;
   check every serving pod supports `seteventhold` and `geteventholds` and loads
   independent holds. Run real ClickHouse integration coverage before production.
2. Deploy Blossom's independent-hold API. Confirm CAS updates, uncached enforcement,
   cache invalidation, post-origin checks and authorized original/Range review.
   Verify actual CDN service/version and backing-origin exposure. A direct publicly
   addressable storage origin is a release blocker; cache purge alone is inadequate.
3. Deploy Relay Manager with admission disabled (the default). Configure
   `COOP_URL`, secret `COOP_API_KEY`, and `REVIEWER_BASE_URL` for the same environment.
   COOP links carry the source relay; the UI blocks reads/actions while a different
   environment is selected, and can switch only to configured environment pairs.
   Existing `RELAY_URL`, `CDN_DOMAIN`, NIP-86 and Blossom credentials must point at
   the compatible services. No configuration or secret belongs in a PR/log.
4. Validate the safe canary below in staging, then a controlled production canary
   through the deployment workflow. Verify production service identities, access
   and reviews; local or deployment-log evidence is not a live canary.
5. Set `SEXUAL_QUARANTINE_ENABLED=true` and enable the existing auto-hide config
   only after the compatible backend checks pass. Adult categories must be in a
   configured tier; trusted-client requirements still apply. The threshold is at
   least two distinct signed reporters across aliases. A first report creates an
   urgent review case without hiding. A single unconfirmed report hiding policy
   remains an explicit product decision; this implementation does not enable it.

Do not enable admission against old APIs. Existing case recovery continues even
when the admission flag or watcher is stopped. Stopping the watcher stops new
replay admission. Once activated, a persisted marker prevents disabled admission
from falling back to legacy adult base bans. Do not erase that marker. Before the
first activation, the existing legacy behavior remains in effect. Verified non-video
reports retain the legacy writer, including after video admission is disabled; a
durable per-target/report marker prevents replay from repeating that attempt.
Unavailable or invalid targets never authorize legacy fallback. Transport failures
retain the replay window. A successful empty public read plus the relay's explicit
`Event not found or not banned` response instead archives the complete signed
report under `sexual-absent:<target ID>:<report ID>` in bounded parts and alerts for
operator backfill review, without pinning unrelated replay. This is a point-in-time
absence response, not proof of deletion or global freshness. Repeated ingestion of
those same archived bytes is deduplicated; operators must inspect and backfill
them if the target later becomes available. Never advance a cursor merely to silence
a transport failure.

An exact configured adult category keeps its own trusted-client and threshold
policy; canonical alias fallback is used only when that category is unconfigured.
For existing fractional thresholds, case admission rounds upward to the next
whole reporter count, matching the legacy count comparison. A case retains the
threshold captured at its creation.

Each alarm escalates up to 100 overdue deadlines before network IO, independently
of network IO. Three due cases take priority, one stable hidden/removed case retains
reconciliation capacity, and a separate one-case lane handles COOP/decision delivery.
Delivery retries back off from 30 seconds to five minutes and do not consume urgent
enforcement slots. Repeated failures update a separate counter while retaining the
first append-only audit event, so an outage cannot displace provenance from history.
Stable cases do not sit ahead of urgent retries. This still bounds throughput:
measure due-queue age, deadline backlog, and drift repair delay at expected load.
Existing unindexed cases are migrated in 100-case alarm transactions; the first
queue read finishes remaining batches before issuing a cursor. That first read is
proportional to retained case history. Subsequent pages contain at most 100 cases,
with enforcement cases before below-threshold reviews, ordered by deadline within
each group. Newly admitted cases are indexed immediately. A first-report-only case
escalates after 15 minutes. Crossing the hide threshold starts a fresh 15-minute
deadline and escalation while preserving the original report timestamp.
Pending human actions receive their own 15-minute deadline. Alert delivery must be
routed from the `[ALERT] Sexual quarantine` and replay messages to the staffed
on-call destination before activation; the code emits logs, not a paging service.

## Contracts and preservation

Hold identity is `sexual:<full event ID>`. A revision changes on hide/restore/remove
intent. Event RPCs use `seteventhold [eventId, holdId, revision, 1|0]`. Media uses
`POST /admin/api/quarantine` with `{sha256, hold_id, version, action}`. All reads must
confirm effective rows; HTTP success alone is insufficient. Higher revisions win;
release tombstones must survive delayed requests. Global `allowevent` is never the
implementation of this stream's Restore. Unversioned legacy review/restore calls
cannot supersede an existing human Remove; use the current case revision.
Blossom limits each hash to 128 lifetime hold IDs, including released tombstones.
This caller reuses one bounded ID per event. A capacity 409 means no hold was
applied; it remains pending and must alert an operator. Never allocate a new ID to
retry it or discard tombstones. A release skips candidates with no existing own hold.

Cases capture the signed video event and signed reports, source and receive times,
canonical category, controlled-origin hashes/paths, deadlines and audit decisions.
Signed URLs and hash tags are candidates. Authenticated media metadata must confirm
ownership eligibility before applying a media hold, including hashes advertised
with mirror URLs. Eligibility is retried separately without changing signed evidence.
Unknown eligibility prevents a verified-hiding claim while eligible assets and the
event can be held. Verified non-video targets are classified
before admission and stay with the legacy writer. Older cases classified as
`out_of_scope` leave this stream's queues and cannot receive its Restore/Remove
commands. Missing or invalid targets are never assumed non-video.
Signed source objects and snapshots are archived under immutable full-ID references
in bounded parts, without truncation; hydrated reviewer reads reproduce the originals.
The case metadata and audit rows remain below Durable Object KV value limits.
Malformed ancillary URLs do not veto signed video admission. Unknown controlled
paths remain review evidence and must deny public probes before hiding is verified.
Disputed or over-budget mappings keep complete verification pending while the event
and safely mapped assets can be held. Failed enforcement never suppresses COOP
handoff; each pass makes at most one handoff attempt. Unmapped external media is outside Divine's
media controls and must be identified during review. URLs and derivatives outside
the configured controlled origin require separate coverage before claiming them
hidden. Existing browser copies cannot be recalled.

Remove keeps this case's holds; it does not erase bytes. Restore releases only this
case's holds. `restored_restricted` means release is confirmed but another hold or
base restriction still applies; it is not successful public restoration. A verified,
signed author deletion is a remaining restriction, never an instruction to revive
the event. Generic Reports Allow/Review returns 409 while the case still needs a
revisioned decision. After a scoped Restore is verified and recorded, a separate
Reports Allow can lift the base event ban; other named holds remain intact.
Versioned decisions project human intent to D1 as
`sexual_quarantine_restore` or `sexual_quarantine_remove`, set target human-review
protection, and append an idempotent Reports decision. This happens after accepted
scoped commands even when complete public verification remains pending; recorded
human intent is not a claim that delivery is hidden or restored. D1 failures retry
without claiming the review is recorded. Moderator pubkeys are hex or NULL;
unattributed reviewer labels remain in the case audit. The human decision resolves
linked Zendesk review tickets on a best-effort, three-second request budget; failed
ticket updates remain open for manual retry. Enforcement remains separately urgent
until verified. A newer revision fences delayed projections. The additive
`sexual_quarantine_reviews` table is initialized through the repository's existing
`ensureSchema` path; no out-of-band production schema command has been run.

The Blossom hold is not a legal-retention lock: independently authorized erasure can
still occur. Define retention/access/erasure obligations before using it as legal
preservation. Reviewers use the existing authenticated media proxy with private,
no-store full/Range responses. Do not attach media or user-linked case data to PRs.

## Safe end-to-end canary

Use an obviously synthetic color-bars clip, with two independently generated test
reporter keys and a dedicated owner. No sexual or child-safety material is needed.
Keep the full event IDs in a private operator record. Use the ordinary upload and
publish clients so media mapping, thumbnails and transcoding follow real paths.

Record monotonic timestamps at upload publication, first and second signed report,
first hold acceptance, each independently observed public denial, COOP acceptance,
review decision and verified restoration. Retain service versions and request IDs.

- Before reports, verify discovery/point queries and public media return the fixture.
  Warm caches for original extensionless/MP4 GET+HEAD+Range, thumbnail, actual
  `/<sha>/hls/master.m3u8`, both variant playlists and segments, and direct 720p/480p
  MP4 routes. Test every active CDN/origin hostname from more than one point of
  presence. Advertised URLs in the signed event must also be checked.
- First report: exactly one urgent case, original signed provenance and COOP review
  link, no hide. Duplicate reporter/alternate category alias must not count twice.
- Second distinct report: observe pending intent, relay hold and every mapped media
  hold. Require confirmed absence from historical point/discovery feeds and existing
  live subscriptions on every relay pod, plus new subscriptions. Include normal and
  draining broadcast queues and the API-management fallback. Hold propagation delay
  across pods counts toward time to verified hiding. Historical query absence alone
  does not establish live-delivery enforcement.
- Require anonymous and owner playback denial for every route; verify authorized
  reviewer original full and Range bytes remain available, private/no-store.
  Delay a public origin request across hold acquisition and cache purge: it must
  not return or refill a public cache entry after the hold completes.
- Evict/restart the case owner after an ambiguous service timeout. Interrupt COOP
  delivery and one hold service independently. Intent must persist, retry, surface
  failure, and converge without clearing unrelated restrictions.
- Submit Restore while a Hide is in flight. Delay/reorder old requests: newer
  release tombstones must win. Verify repeated Restore is safe and stale UI
  revisions return 409. Require public event/media convergence before `restored`.
- Add a separate event/media hold and a base ban. Restore must produce
  `restored_restricted` while preserving those restrictions. Remove retains bytes
  for review and keeps public denial. An unrelated generic moderator hide must
  survive this stream's Restore.
- Age a pending case past its deadline; verify the staffed escalation destination
  receives it and holds remain. Delete a test hold out-of-band and confirm drift
  is detected/repaired. Clean up only the dedicated synthetic fixture afterward.

The replay cursor advances only after confirmed relay EOSE and durable admission.
It looks back 24 hours on first activation with a 60-second overlap. It cannot
recover arbitrary older incidents automatically. A saturated 100-report same-second
page retains its cursor and alerts; pause activation and use a complete authorized
relay export/backfill (outside the capped query) to admit the missing signed
reports. Verify the backfill count before advancing the cursor; never skip the
second or clear the cursor merely to silence the alarm.

## Measurements and release criteria

Persisted case/audit times and structured `[sexual-quarantine-metric]` outcomes
support the following measurements. Build the operational dashboard from private
case/audit data; console delivery alone is not a reliable accounting ledger.

| Measurement | Definition and source |
| --- | --- |
| Time to verified hiding | second qualifying report receive time to the last confirmed public event/media denial, including cache/pod propagation; track p50/p95/p99 and overdue count |
| First report exposure | first report receive time to last public denial, separately from threshold latency |
| Missed explicit content | human-adjudicated explicit-act clips still public, including unreported and detection-only clips; denominator from a permitted, representative evaluation set |
| False positives | human-adjudicated allowed nudity/suggestive/nonsexual cases temporarily hidden, divided by all hidden/adjudicated cases; do not treat every Restore as a model false positive |
| Enforcement failure | pending/retry cases by stage, drift incidents, failed public probes and retry age; verify before classifying a service as healthy |
| Restoration | decision to verified public restoration latency and success rate; report remaining-restriction outcomes separately |
| Review health | oldest open deadline, overdue cases, COOP acceptance failures, queue depth and human completion latency |

Suggested initial operational objective (to approve with on-call): p95 verified
hiding within 60 seconds of the second qualifying report, and urgent human review
within 15 minutes. Do not describe these as measured results. Load-test the bounded
job rotation and real cross-pod/CDN propagation before committing to an SLO.

Visual screening remains a separate, gated slice: evaluate frames across the full
clip (document sampling gaps and timestamps), with explicit sexual acts distinct
from allowed nudity, suggestive content and other categories. Record provider,
model/version, policy version, frame offsets/coverage, category scores, decision
threshold and reviewer adjudication. Select/enable a sufficiently strong threshold
only after a permitted-input, calibrated false-positive/recall evaluation. Broad
NSFW labels and transcript keywords are review evidence, not explicit-act proof.
Suspected child sexual abuse remains on its dedicated path and must not be sent to
ordinary providers whose input terms forbid it. No new provider contract, spend,
model decision or production visual coverage is implied by this change.

## Rollback

Disable new adult admission. Keep compatible event/media APIs, tombstones, case
recovery and reviewer controls running. Do not roll back to an unfenced writer,
drop tables/KV state, reset revisions, globally unban cases or bulk-release holds.
Inspect pending operations and resolve them through the reviewer controls. A broken
provider/COOP handoff must not release held media. Roll forward when existing
holds require the new enforcement code; an old service build is not a safe rollback.

## Local validation boundary

Synthetic unit/integration tests establish local behavior only. Live service auth,
CDN/origin routing, serving-pod convergence, COOP schema/rules and staffed alert
routing must all pass the rollout gate. Source tests do not attest current deployed
behavior. Visual-provider qualification and complete older-report backfill remain
separate operational work.
