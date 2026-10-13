# Design: Sticky approved-minor state on age-review approval (issue #192)

Date: 2026-10-12
Repos: `keycast` (Rust) + `divine-relay-manager` (worker + moderator UI). No funnelcake change:
funnelcake holds no minor or age state.
Supersedes: the unmerged 2026-07-20 draft on local branch `feat/192-durable-verified-minor`,
which predates the D1 protected-minor registry and gated on band alone.
Related: #147/#174 (clear on revoke), #191 (keycast `not_applicable`), #266 (retention),
keycast#265/#295 (verified_minor lifecycle), STS#203 (classification survives deletion).

## Problem

An account created through **New Minor Account** gets a durable approved-minor state. An
existing account whose age-review case a moderator approves does not.

What minor onboarding writes (`handleCreateMinorAccount`, one D1 batch plus one keycast call):

1. keycast `users.verified_minor = TRUE` (DM containment gate, key-egress block, auto-clear of
   later under-16 reports);
2. an `active` row in `protected_minor_subjects` bound to the pubkey through
   `protected_minor_account_bindings` (the classification that outlives the keycast row, and the
   thing keycast's deletion flow resolves and closes);
3. a `cleared` case as its source record.

What **Clear** on an existing case writes today: relay `unsuspendpubkey`, media
`un-age-restrict-all`, keycast `status=active`, Zendesk solve. No flag, no subject. `cleared` is
terminal and the ReportWatcher dedup guard only looks for non-terminal cases, so the next
under-16 report opens a fresh `open_reported` case and the approved account is restricted again.

keycast has no way to set the flag on an existing row. It exposes only
`POST /admin/create-minor-account` (new row) and `DELETE /admin/users/:pubkey/verified-minor`.

## Goal

When a moderator approves an existing account as a 13-15 protected minor, that account ends up
in the same durable state as an onboarded one: an active D1 subject and keycast
`verified_minor = TRUE`. Approval is an explicit, acknowledged moderator act, never a side effect
of dismissing a report.

## Decisions

All ratified by Matt on 2026-10-12, including the keycast `account_unclaimed` guard and settling
(not retrying) a projection job keycast refuses with it. Credential-less rows are not keycast
logins and are not part of this flow; the guard only makes that explicit.


- **Explicit action, not an inferred one.** `cleared` stays overloaded on the transition, and the
  band cannot disambiguate it: Clear is reachable straight from `open_reported`, and every
  report-created case defaults to `age_13_15`. Gating on band alone would make dismissing a false
  report against an adult confer protected-minor status. The PATCH therefore carries an explicit
  `resolution`, and the UI offers two distinct actions.
- **D1 subject is the source of truth, keycast is a projection.** This is the deny path's existing
  shape (`clearSubject` first, then `clearVerifiedMinor`, with cron retry) run in the other
  direction. It records approvals for self-custody accounts and survives a keycast outage.
- **ReportWatcher auto-clear consults both.** It auto-clears on keycast `verified_minor` OR an
  active D1 subject binding, so approval is sticky for self-custody accounts and during a pending
  projection retry.

## keycast: `PUT /api/admin/users/:pubkey/verified-minor`

Mirror of the existing `DELETE` on the same path.

1. **Repo, `UserRepository::set_verified_minor(pubkey, tenant_id) -> Result<SetVerifiedMinorOutcome>`**
   Single statement, same CTE shape as `clear_verified_minor`:
   ```sql
   WITH existing AS (
       SELECT verified_minor, (email IS NULL AND password_hash IS NULL) AS credentialless
       FROM users WHERE pubkey = $1 AND tenant_id = $2
   ),
   changed AS (
       UPDATE users
       SET verified_minor = TRUE, verified_minor_at = $3, updated_at = $3
       WHERE pubkey = $1 AND tenant_id = $2 AND verified_minor = FALSE
         AND NOT (email IS NULL AND password_hash IS NULL)
       RETURNING 1
   )
   SELECT EXISTS (SELECT 1 FROM existing),
          COALESCE((SELECT verified_minor FROM existing), FALSE),
          COALESCE((SELECT credentialless FROM existing), FALSE),
          EXISTS (SELECT 1 FROM changed)
   ```
   Outcome, in this order (the CTE reads the pre-update snapshot):
   - no row: `NotFound`;
   - changed: `Set` (timestamp stamped);
   - already `verified_minor`: `AlreadySet`, no write, no `updated_at` bump, original
     `verified_minor_at` preserved;
   - credential-less: `Unclaimed`, no write (see guard below).
   - Never touches `status`, `suspended_reason` or `suspended_at`.
2. **Guard: refuse credential-less rows (409, code `account_unclaimed`).** keycast treats
   `verified_minor AND email IS NULL AND password_hash IS NULL` as an *unclaimed minor*, and
   `create-minor-account` re-issues a claim link for an unclaimed minor matched by username.
   Flagging an existing credential-less row (an unclaimed preloaded Vine account, or a bare
   `INSERT INTO users (pubkey, tenant_id, ...)` row) would make it claimable through that path by
   whoever supplied the username. Refusing is cheaper and safer than re-keying that predicate.
   An already-flagged credential-less row (an onboarded, unclaimed minor) is `AlreadySet`, not
   refused: the guard only blocks the FALSE to TRUE write.
3. **Handler, `set_verified_minor_admin`.** Service-token auth (`authorize_service_token`), the
   same 64-hex `actor` validation (400 on malformed or empty) and `sanitize_reason` as the clear
   handler. On `Set` or `AlreadySet`, invalidate the account-status cache
   (`nostr_rpc::invalidate_account_status_cache`) so the DM gate sees the flag at once. On `Set`
   with an actor, write `admin_audit_events` action `set_verified_minor` (best-effort; failure
   logs and the set stands). Structured log `event="verified_minor_set"`. Response:
   `UserStatusResponse` from `get_full_admin_status`. Rename `ClearVerifiedMinorParams` to
   `VerifiedMinorParams` and share it (identical shape).
   - Does **not** touch claim tokens. Clearing invalidates them to close a revocation door;
     setting opens no door.
4. **Route.** `routes.rs` service-admin group: `.route("/admin/users/:pubkey/verified-minor",
   put(set_verified_minor_admin).delete(clear_verified_minor_admin))`.
5. **Tests.** `api/tests/set_verified_minor_test.rs` modelled on `clear_verified_minor_test.rs`:
   set + response + audit row with actor; no audit without actor; idempotent repeat (no second
   audit row, timestamp preserved); 404 unknown user; 409 credential-less; already-flagged
   credential-less is 200; 401 missing/wrong token; 400 malformed/empty actor; reason
   sanitizing; tenant isolation; status untouched on a suspended user. Repo unit tests in
   `user.rs` for each outcome.

## relay-manager worker

### Data

- `age_review_cases.clear_resolution TEXT` (NULL, `'approved_minor'`, `'not_minor'`), added in
  `ensureSchema` with the existing `ALTER TABLE ... ADD COLUMN` guard pattern and a numbered
  migration file. Historical cleared rows stay NULL (unknown).
- `protected_minor_projection_jobs` is unchanged in shape. Its meaning widens from "pending
  keycast clear" to "pending projection of this subject's current classification".

### PATCH `/api/age-review/cases/:id`

- New body field `resolution`. Rules, checked before the CAS:
  - Required when `state === 'cleared'`; 400 when absent or not one of the two values.
  - 400 when sent without `state: 'cleared'` (another state, or no state at all).
  - `approved_minor` requires the effective band (`body.suspected_age_band ?? existing.suspected_age_band`)
    to be `age_13_15`; otherwise 400.
- Persisted as `clear_resolution` in the same CAS `UPDATE`.

### Approval is atomic with the case transition

For `approved_minor`, the CAS update and the registry writes go in **one `db.batch`**, so a case
can never be terminal-approved without a subject, and a lost CAS never writes a subject. Each
registry statement is conditional on the CAS having landed:

```
guard := EXISTS (SELECT 1 FROM age_review_cases
                 WHERE id = :case AND version = :expected+1 AND clear_resolution = 'approved_minor')
```

1. `UPDATE age_review_cases SET ... WHERE id = ? AND version = ?` (existing CAS).
2. `INSERT INTO protected_minor_subjects (subject_id, source_case_id, 'active', now)
    SELECT ... WHERE guard AND NOT EXISTS (active binding to an active subject for :pubkey)`.
3. `INSERT INTO protected_minor_account_bindings ... SELECT ... FROM protected_minor_subjects
    WHERE source_case_id = :case AND guard AND NOT EXISTS (active binding for :pubkey)`.
4. `INSERT INTO protected_minor_projection_jobs (subject_id, pubkey, 'age_review_approved',
    'pending', now, now) SELECT <the pubkey's active subject> WHERE guard
    ON CONFLICT(subject_id) DO UPDATE SET pubkey = excluded.pubkey, reason = excluded.reason,
    state = 'pending', updated_at = excluded.updated_at, created_at = <kept when the existing job
    is already pending, else excluded.created_at>`.

If the pubkey already has an active subject (for example, an onboarded account whose keycast read
failed during auto-clear, so a case opened), no new subject is created; the existing one gets a
projection job. The CAS outcome is read from statement 1's `meta.changes` exactly as today.

### Enforcement legs on approval

After the batch, alongside the unchanged relay / bulk / keycast-status legs:

- `subjectActivate`: observed from the batch, not assumed. `ok` when statement 4 armed a job
  (`meta.changes === 1`); otherwise `failed` with an explanatory error, the keycast set is skipped
  (D1 holds no active subject to project), and the response is HTTP 207. The UI treats anything but
  `ok` on an approval, including a worker too old to report it, as "not recorded".
- `keycastMinorSet`: `setVerifiedMinor(pubkey, actor, 'age_review_approved', env)` via
  `runStatusLeg`. `ok` or `not_applicable` (keycast's own "user not found", i.e. self-custody)
  marks the projection job complete. A 409 `account_unclaimed` is reported as `failed` with that
  error and also marks the job complete: no retry can succeed, and a human has to look. Any other
  failure leaves the job pending for the cron.
- `enforcementComplete` also requires `subjectActivate !== 'failed'` and
  `keycastMinorSet !== 'failed'`; a failure is HTTP 207 and never rolls back the approval.

`resolution: 'not_minor'` behaves exactly as Clear does today.

### Projection-job generalization (fixes a latent drop)

Today `clearSubject` enqueues with `ON CONFLICT(subject_id) DO NOTHING`, and the cron assumes every
job is a clear. Once approvals enqueue jobs, an approved subject later denied would already own a
(complete) job row, the clear's insert would be dropped, and keycast would keep
`verified_minor = TRUE` for a denied account. Changes:

- `clearSubject`'s job insert becomes the same `ON CONFLICT ... DO UPDATE ... state = 'pending'`.
- `pendingProjectionJobs` joins `protected_minor_subjects` and returns `classification_state`.
  The cron calls `setVerifiedMinor` for `active` and `clearVerifiedMinor` for `cleared`. The job's
  `reason` is passed through as the keycast reason.
- `markProjectionAttempt` keeps its `WHERE pubkey = ? AND state = 'pending'` key.
  `markProjectionComplete` also requires the job's subject to still hold the classification that
  was projected (see Amendments).

### keycast-client

`setVerifiedMinor(pubkey, actor, reason, env)`: `PUT` mirror of `clearVerifiedMinor` (token
resolution, HEX_64 guards, actor dropped when malformed, `isKeycastUserNotFound` for `notFound`).
`KeycastReason` gains `'age_review_approved'`. A 404 from a keycast without the route is *not*
`notFound`, so the leg fails and the job retries until keycast deploys.

### ReportWatcher auto-clear

`createAgeReviewCase` auto-clears when keycast reports `verified_minor` **or** `resolveByPubkey`
finds an active subject. The D1 check runs first (cheap, local, works for self-custody), so a
keycast outage no longer opens a case against an approved minor. The auto-cleared case records
`clear_resolution = NULL` (see Amendments), and its decision-log reason names the source that
proved the approval (`via registry` or `via keycast`).

### Shared types

`AgeReviewEnforcement` gains optional `subjectActivate`, `keycastMinorSet` (+ `...Error`).
`AgeReviewCase` gains `clear_resolution`. A `ClearResolution` union and `CLEAR_RESOLUTIONS` live
in `shared/age-review.ts`.

## relay-manager UI (`AgeReviewDetail`)

Replace the single green **Clear** with two actions:

- **Approve as protected minor (13-15)**: shown only when the band is `age_13_15`. Opens a
  `ConfirmDialog` (approval styling; add an optional confirm-variant prop defaulting to today's
  destructive style so existing callers are unchanged):
  > **Approve as a protected minor?**
  > This account is restored and marked as an approved 13-15 minor: minor DM limits apply,
  > key export is blocked for Divine login accounts, and future under-16 reports clear
  > automatically.
  >
  > [Cancel] [Approve]

  Fires `{ state: 'cleared', resolution: 'approved_minor', ... }`.
- **Clear: not a minor**: immediate, fires `{ state: 'cleared', resolution: 'not_minor', ... }`.

The partial-failure toast names the new legs (`protected-minor registry`, `protected-minor account
projection`). A closed case shows its resolution ("Approved minor" / "Not a minor") beside the
state badge. `adminApi.updateAgeReviewCase` and the `useAdminApi` wrapper forward `resolution`
(the wrapper has silently dropped new args before).

## Error handling summary

| Failure | Result |
| --- | --- |
| CAS lost | 409 `version_conflict`, no subject written (batch-conditional) |
| Batch throws | 500, nothing written (atomic) |
| keycast set: network / 5xx / route-404 | leg `failed`, 207, job pending, cron retries |
| keycast set: user not found | leg `not_applicable`, job complete |
| keycast set: 409 `account_unclaimed` | leg `failed`, 207, job complete, logged |
| relay / bulk / status legs | unchanged |

## Testing

- **keycast:** the integration and unit tests above, `cargo fmt --check`, `cargo clippy ...
  -D warnings`, targeted `cargo test` with `integration-tests`.
- **worker (vitest):** PATCH validation matrix (missing / bad / mismatched resolution, band gate
  including band-change in the same PATCH); legs per outcome; 207 on set failure.
- **worker (`test:d1`):** batch atomicity (lost CAS writes no subject; approval writes subject,
  binding, job); reuse of an existing active subject; approve-then-deny re-enqueues a clear job
  (the latent-drop regression); cron dispatch by classification; ReportWatcher auto-clear from
  D1 alone; retention keeps the approving case.
- **frontend:** two actions render per band; confirm gates the approval; `resolution` reaches the
  request body.
- **Mutation checks:** each guard (band gate, resolution required, batch guard, unclaimed guard,
  ON CONFLICT upsert, cron dispatch, auto-clear D1 branch) dies to exactly one mutation.
- **Full local stack:** keycast (docker deps) + funnelcake kind relay + moderation-service +
  wrangler + Caddy + Vite. Report an account under 16, approve it in the UI, confirm the keycast
  row and D1 subject, re-report and watch it auto-clear, deny it and watch the flag clear; repeat
  with keycast stopped to exercise the cron retry.

## Amendments during implementation

Decisions made while building and reviewing the branch. Where they differ from the text above,
these win.

- **Auto-clears record a NULL resolution.** A ReportWatcher auto-clear observes an existing
  approval rather than making one, so it must not count as a newer approval under the
  latest-decision rule below. The UI's "Auto-cleared" note already marks these cases.
- **Latest decision wins for subject-clear retries.** A `denied_closed` case is a retry source for
  clearing a subject only while no explicit approval (`cleared` with
  `clear_resolution = 'approved_minor'`) of that subject, on any pubkey in its binding history, is
  newer. Ties within one second fall back to row creation order, an accepted limitation.
- **Projection completion is compare-and-set on classification.** `markProjectionComplete` marks a
  job complete only while its subject still holds the classification that was sent to keycast. A
  deny that re-arms the job mid-flight therefore survives the in-flight set's completion.
- **Re-arms upsert, and created_at measures a pending job's age.** Every job write
  (`clearSubject`, the approval batch, convergence re-arms) is an `ON CONFLICT ... DO UPDATE` that
  sets the job pending. `created_at` is kept when the job is already pending and reset otherwise,
  so the retention overdue-projection alarm still fires for a persistently failing projection.
- **Superseded clear jobs settle without keycast.** A cleared subject's job whose pubkey now has a
  live binding to a different active subject is completed without a DELETE: keycast must mirror the
  pubkey's current protection. Settling it still converges (re-arms the live subject's set), because
  an earlier attempt at that DELETE may have failed from the worker's side yet landed in keycast
  after the new subject's set.
- **Convergence after every projection.** After any keycast verified_minor call that landed
  (success or no account), on every path (inline approve, inline deny, expiry, cron),
  `convergeProjection` re-arms the opposite projection when a racing write left keycast
  disagreeing with D1: after a clear, the pubkey's live active subject's set; after a set, with no
  live active subject, its most recent cleared subject's clear. A refused (`account_unclaimed`)
  call changed nothing in keycast and needs none. A failed call may still have landed; its job
  stays pending and converges when it settles.
- **Non-hex pubkeys are a 400.** `approved_minor` for a case whose pubkey cannot be bound (the
  bindings table requires 64 lowercase hex) is refused before any write.
- **keycast's set uses an explicit transaction** rather than the single-statement CTE described in
  the keycast section.
- **The case view reads the registry too.** `GET /api/account-status/:pubkey` adds
  `protected_minor` (true for an active subject, false for none, null when D1 cannot answer). The
  approved badge shows when either keycast or the registry says protected, with a note when
  keycast's app protections are not in force. "Protected-minor status unavailable" shows when
  neither source says protected and either keycast could not say what kind of account this is or
  the registry did not answer. A self-custody approved minor has no keycast account, so the
  registry is the only source for it.
- **The approve confirm claims only what the account gets.** A Divine login account: DM limits,
  the adult content lock and the key-export block, plus report auto-clear. An account holding its
  own key: report auto-clear only. Unknown account type: a qualified version.
- **The DM restriction is an applied protection.** It shipped in mobile 1.0.16 (app stores carry
  1.0.23), so the panel's "Rolling out" section is gone and the panel also lists the key-export
  block.
- **The second Clear is labelled "Clear: not a protected minor"** (resolution label "Not a
  protected minor"). A cleared 16+ case can still be a 16-17 year old minor; the stored value stays
  `not_minor`.
- **An `account_unclaimed` refusal is reported as permanent** (`keycastMinorSetUnclaimed`), with
  its own toast, since the job is settled and nothing retries it.

## Rollout

Two independent PRs, each to its repo's `main`, no stacking. keycast deploys first (Cloud Run for
prod). relay-manager is safe to deploy before it: the set leg fails on the generic 404 and the cron
converges once keycast ships. Nothing is pushed, filed or opened without Matt's go; the keycast
issue text is drafted locally for review.

## Out of scope

- Backfilling historical cleared 13-15 cases (their resolution is unknown).
- Splitting the funnel's "restored" count by `clear_resolution`.
- Ageing out at 16. There is no automatic age-out, by decision; a manual path to make an account
  an allowed minor without protections (on appeal or request) is a later follow-up.
- Mobile/web behaviour, which already keys off `verified_minor`.
