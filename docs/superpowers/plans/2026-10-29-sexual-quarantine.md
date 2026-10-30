# Sexual-video quarantine implementation plan

> For agentic workers: use superpowers:executing-plans; apply TDD to each task.

**Goal:** Persist and verify reversible report-triggered event and media holds.
**Architecture:** ReportWatcher owns transactionally revisioned durable cases and recovery. Blossom
owns independent additive media holds. Existing admin event decisions also finish
or preserve the corresponding case; they cannot silently bypass its media hold.
**Tech stack:** TypeScript, Cloudflare Durable Objects, existing Nostr/Fastly APIs.
**Spec:** ../specs/2026-10-29-sexual-quarantine.md

## Global constraints

- Two distinct adult-sexual reporters; no new single-report hiding policy.
- No account actions, physical deletion, CSAM routing changes, or new dependencies.
- No production activation until the media API and canary are verified.
- Use full synthetic identifiers in tests; never real end-user data.

## Review focus

- A timeout can mean an action landed: retain intent and retry idempotently.
- A restore racing a retry must win through durable revision fences.
- Shared media and unrelated restrictions must survive releasing one hold.
- Signed-event identity and controlled URLs bind media targets, not report claims.
- A successful command is not verified public hiding or restoration.

### Task 1: Durable cases and report policy

Files: worker/src/sexual-quarantine.ts and its colocated tests.
Interfaces: admit(eventId, report), decide(eventId, revision, decision), advance(),
get(eventId), list(), history(eventId). Media IO uses named hold/release/read APIs.

- [x] Write failing tests for first-report review, alias dedup, two reporters,
  durable retry, restore supersession, shared media, and overdue escalation.
- [x] Implement persisted cases, bounded attempts, and append-only audit entries.
- [x] Run focused tests, inspect failures, and verify green.

### Task 2: Service IO and watcher integration

Files: worker/src/sexual-quarantine-io.ts, ReportWatcher.ts and tests.
Consumes Task 1 case interfaces and Blossom's POST /admin/api/quarantine
{sha256, hold_id, action: hold|release}; GET /admin/api/quarantine/{sha256}.

- [x] Write failing tests for signed video snapshots, hash/origin validation,
  independent hold/release, denied public probes, and incomplete read outcomes.
- [x] Implement bounded authenticated service IO and cancel response bodies.
- [x] Integrate adult-only admission, alarm recovery, protected admin case routes,
  and human restore/remove actions with revision-fenced IO outside concurrency gates.
- [x] Run focused and existing watcher tests plus worker type checking.

### Task 3: Verification and rollout handback

Files: docs/sexual-quarantine-rollout.md; affected source/tests only as needed.

- [x] Run worker regression suite and frontend checks; record baseline blockers.
- [x] Perform a fresh independent review and address substantive findings.
- [x] Document activation, safe canary, rollback, metrics and remaining live gates.
- [x] Commit with agent attribution, push an owned branch and open a focused PR.

## Execution record

Pre-flight: Task 2 consumes Task 1's case state. Review found network work can
exceed Durable Object concurrency-gate deadlines; IO now runs outside the gate
with transactional revision checks and versioned service commands. Blossom is a separate worktree and API contract.
Ruling: proceed from the user's approved proposal without an additional plan
confirmation. Root worker install has a pre-existing Cloudflare/Vitest peer conflict;
no dependency changes or peer-resolution bypasses are authorized by this plan.

Local validation: frontend typecheck/lint/full tests/build, the full locked
Vitest 4 worker unit suite, real Miniflare D1 suite, and worker typecheck pass.
The PR records the current checked counts and head; synthetic desktop/mobile
captures document queue, detail, pending, remaining-restriction, empty and error states. Existing worker
`npm ci` fails its pre-existing pool-runner peer conflict; exact locked-version
test tools were installed outside the repository and linked only in ignored
node_modules, without project dependency/lockfile changes or peer bypass.

Independent reviews found and repaired unrelated-hide coupling, real HLS and
variant coverage, inline media mapping, gate timeout/revision races, legacy-ban
restoration recognition, audit/queue ordering, COOP empty-202 handling, stopped
replay, rollback fallback, and cross-environment review links. Backend reviews
also found late-origin cache refill and relay cache expiry/propagation issues;
those are repaired and undergoing final full-diff review in their own worktrees.

Follow-up review repaired non-video legacy routing, category policy selection,
fractional legacy threshold compatibility, independent deadline/retry scheduling,
bounded complete source persistence, and versioned D1 human-decision recording.
Generic Restore reports remaining restrictions as incomplete public restoration.
No service was deployed and no admission or visual provider was activated.
