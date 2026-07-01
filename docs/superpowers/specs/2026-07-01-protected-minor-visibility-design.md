# Protected-minor visibility in the moderator UI — design

**Issue:** divinevideo/divine-relay-manager#141 (T&S visibility of protected-minor status). Part of the protected-minor safeguards epic (support-trust-safety#173); equal sibling of keycast#265 (lifecycle).
**Date:** 2026-07-01
**Status:** WIP (draft PR staked out early to flag work-in-progress).

## Goal
Let a moderator see, from the age-review case view, whether the account is an **approved protected minor (13-15)** — i.e. keycast's durable `verified_minor` flag — and what protections that implies.

## What already exists (so this is mostly surfacing)
- `worker/src/keycast-client.ts` `getUserStatus(pubkey, env)` already calls keycast `GET /api/admin/users/:pubkey/status` and returns `verified_minor` + `verified_minor_at` (already used by `ReportWatcher.ts`).
- `AgeReviewDetail.tsx` is the moderator case view and has the case `pubkey`.
- Frontend uses `adminApi.ts` + React Query.

## Approved decisions
1. **Dedicated endpoint + lazy hook** (not folded into the case GET): keeps live keycast status separate from the case record, degrades gracefully, and is reusable.
2. **Surface `verified_minor` + static policy text** (not per-device "active protections", which aren't server-observable and depend on unbuilt #175/#176).

## Design

**Worker** — new route `GET /api/account-status/:pubkey`:
- Auth: same admin auth as the other `/api/*` moderator routes.
- Validates the 64-hex pubkey; calls `getUserStatus`; returns `{ verified_minor, verified_minor_at, status, suspended_reason?, suspended_at? }`.
- If keycast is not configured or errors, returns a graceful "unknown" shape (not a hard failure) so the UI can degrade.

**Frontend**:
- `adminApi.ts`: `getAccountStatus(pubkey)` client method.
- `useAccountStatus(pubkey)` React Query hook (keyed on pubkey; enabled when a pubkey is present).
- `AgeReviewDetail.tsx`: an **Account status** section that, when `verified_minor` is true, shows a badge "Approved protected minor (13-15)", the `verified_minor_at` date, and a short static line: "Protections that apply: adult content locked; DMs restricted to HQ/Support (client-enforced)." When false/unknown, it stays unobtrusive (no badge, or a muted "not a protected minor / status unavailable").

**Placement:** age-review case detail only (not the cases list — avoids N keycast calls per list load). The hook is reusable elsewhere later (nuke button, user lookup).

## Error handling
Best-effort: the account-status fetch is independent of the case load, so a keycast blip shows "status unavailable" and never blocks the case. No retries needed beyond React Query defaults.

## Testing
- Worker: endpoint auth, invalid pubkey rejected, `getUserStatus` success maps `verified_minor`/`_at`, and not-configured/error degrades to a graceful response (not a 500).
- Frontend: hook maps the response; `AgeReviewDetail` renders the badge + policy text when `verified_minor` is true, stays quiet when false, and shows an unobtrusive fallback on loading/error.

## Out of scope
- Lifecycle reflection (age-up/revocation) — keycast#265.
- Real per-device "active" protection telemetry — depends on #175/#176.
- Cases-list badge.
