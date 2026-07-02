# Protected-minor visibility in the moderator UI — design

**Issue:** divinevideo/divine-relay-manager#141 (T&S visibility of protected-minor status).
**Follow-on:** #143 (surface active protections once #175/#176 exist).
**Date:** 2026-07-01
**Status:** Ready for review in PR #142.

## Goal
Let a moderator see, from the age-review case view, whether the account is an **approved protected minor (13-15)** — keycast's durable `verified_minor` flag. This is a true, server-backed fact today (it confirms the minor-approval flow actually set the flag).

## What already exists (so this is mostly surfacing)
- `worker/src/keycast-client.ts` `getUserStatus(pubkey, env)` already calls keycast `GET /api/admin/users/:pubkey/status` and returns `verified_minor` + `verified_minor_at` (already used by `ReportWatcher.ts`). **Note:** this is keycast's *admin* endpoint, so #141 is **independent** of the in-review detection PRs.
- `AgeReviewDetail.tsx` is the moderator case view and has the case `pubkey`.
- Frontend uses `adminApi.ts` + React Query.

## Approved decisions
1. **Dedicated endpoint + lazy hook** (not folded into the case GET): keeps live keycast status separate from the case record, degrades gracefully, and is reusable.
2. **Surface `verified_minor` only (honest MVP).** Do **not** display "which protections are active." The protections (content-lock #175, DM-restriction #176) do not exist yet, so asserting them — even as static policy text — would give moderators **false assurance** of protection that isn't being enforced. The active-protections display is deferred to follow-on **#143**, to land once #175/#176 are real. #141's acceptance is re-scoped to "surface `verified_minor`" accordingly.

## Design

**Worker** — new route `GET /api/account-status/:pubkey`:
- Auth: same admin auth as the other `/api/*` moderator routes.
- Validates the 64-hex pubkey; calls `getUserStatus`; returns `{ verified_minor, verified_minor_at, status, suspended_reason?, suspended_at? }`.
- If keycast is not configured or errors, returns a graceful shape the UI reads as "unavailable" (not a hard 500), so it never blocks the case view.

**Frontend**:
- `adminApi.ts`: `getAccountStatus(pubkey)` client method.
- Account-status React Query hook (keyed on selected API URL + pubkey; enabled when both are present).
- `AgeReviewDetail.tsx`: an **Account status** line that, when `verified_minor` is true, shows a badge **"Approved protected minor (13-15)"** + the `verified_minor_at` date. When false, it stays quiet (or a muted "not a protected minor"); on loading/error, an unobtrusive "status unavailable". The badge is clearly the *outcome* ("Approved"), distinct from the case's existing *suspected* age-band badge.

**Placement:** age-review case detail only (not the cases list — avoids N keycast calls per list load). The hook is reusable elsewhere later (nuke button, user lookup).

## Error handling
Best-effort and independent of the case load: a keycast blip shows "status unavailable" and never blocks the case. React Query defaults suffice.

## Testing
- Worker: endpoint auth, invalid pubkey rejected, `getUserStatus` success maps `verified_minor`/`_at`, and not-configured/error degrades to a graceful response (not a 500).
- Frontend: hook maps the response; `AgeReviewDetail` renders the "Approved protected minor" badge + date when `verified_minor` is true, stays quiet when false, and shows an unobtrusive fallback on loading/error.

## Out of scope (tracked)
- **Active-protections display** (which protections apply/are active) — **follow-on #143**, after #175/#176.
- Lifecycle reflection (age-up/revocation).
- Cases-list badge.
