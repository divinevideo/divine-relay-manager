# Clear verified_minor on revoke/deny (relay-manager#147)

**Status:** WIP design — implementation follows on this branch.
**Part of:** support-trust-safety#173 (protected-minor epic). Follow-on of keycast#265 / keycast PR #280.
**Depends on:** keycast#280 merging (the `DELETE /api/admin/users/:pubkey/verified-minor` endpoint). Built against that PR's pinned contract; mergeable once it lands.

## Problem

Revoking an approved minor's approval in relay-manager changes account status but
leaves `verified_minor` set in keycast, so protected-minor protections persist (or,
for a mistaken approval being reversed, linger on a normal account). keycast#265
added the clear primitive; this wires the moderator flow to call it.

## Design

**Compose, do not couple** (per issue #147): revoke = existing status leg +
a new clear-verified-minor leg. The status decision stays here (deny → ban,
mistaken approval / cleared → unsuspend); keycast's primitive is clear-only.

1. **New client fn** `clearVerifiedMinor(pubkey, actor, reason, env)` in
   `worker/src/keycast-client.ts`, following the existing fn pattern:
   `DELETE {url}/api/admin/users/{pubkey}/verified-minor?actor=<hex>&reason=<text>`
   with the service-token auth the other calls use. Returns `KeycastResult`.
2. **New enforcement leg** in the age-review state-transition handler
   (`worker/src/age-review.ts`, alongside the Keycast status leg at ~:349):
   run on `deniedCase` and `clearedCase` transitions, **unconditionally** —
   keycast's clear is an idempotent success no-op on never-minor/already-cleared
   accounts and only writes the durable audit row on a real transition, so no
   pre-read of `verified_minor` is needed.
3. **Leg status surfaces like the others**: tracked via the shared
   `runStatusLeg` wrapper, folded into `enforcementComplete`, so a keycast
   failure is reported (HTTP 207, success:false) rather than silently leaving
   the flag set — issue requirement "must not silently leave the flag set."
4. **actor + reason**: pass the acting moderator's pubkey as `actor` and a
   reason derived from the transition (e.g. `age_review_denied` /
   `age_review_mistaken_approval`) so keycast writes the durable
   `admin_audit_events` row. OPEN: confirm where the handler gets the
   moderator identity (CF Access context vs request body) — if unavailable,
   keycast falls back to log-only per #265, acceptable but not preferred.

## Out of scope

- Age-up transitions (support-trust-safety#179, deferred by the epic).
- Surfacing active protections in the age-review view (relay-manager#143).

## Tests

- client: `clearVerifiedMinor` happy path, keycast error surfaced, URL/auth shape.
- handler: deny transition runs the clear leg and reports it in `enforcement`;
  cleared transition likewise; leg failure → `enforcementComplete=false` / 207;
  non-terminal transitions do not call clear.
- Follow existing `age-review.test.ts` / `keycast-client.test.ts` harnesses.

## Acceptance (from #147)

Revoking an approved minor in relay-manager clears `verified_minor` in keycast
(with a durable audit row), and the age-review view reflects the change.
