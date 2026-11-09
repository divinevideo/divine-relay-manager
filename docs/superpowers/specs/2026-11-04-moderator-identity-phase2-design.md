# Moderator identity via Divine login: phase 2 design

Issue: #178. Phase 1 (PR #181, design `2026-07-14-moderator-identity-divine-login-design.md`) put "Sign in with Divine" in the app. Phase 2 is this document. Phase 3 (per-moderator NIP-98 signing) stays out of scope.

## Intent

Today the worker records whichever moderator the browser says acted. Seven routes take a `moderatorPubkey` (or `moderator_pubkey`) from the request body and store it after, at most, a format check (ticket close and the age-review PATCH check nothing). An eighth, the sexual-quarantine decision, takes the reviewer as `actor` from the body (decision 8). Anyone who can reach the API can put any name on any action.

Phase 2 makes the worker work out who acted from the moderator's Divine login, and stop trusting the browser's claim. It serves two uses:

1. **Recording who acted.** Every moderation record names the moderator who actually did it, or no human at all. It never names someone who didn't.
2. **Gating sensitive views.** Viewing suspended content (#212, "piece 4" of the suspended-content track) must know for certain who is looking, so every view gets an audit row. Phase 2 provides that check. The viewer itself is not part of phase 2.

## The settled direction (unchanged from phase 1)

- **Cloudflare Access decides who may use the tool at all.** That doesn't change. PR #352 made the worker verify the Access token rather than trust the header.
- **The Divine login only says who acted.** A Keycast outage or a missing login must never block moderation. Matt and Daniel settled this on #178 on 2026-07-14.
- Caveat the builder should keep in mind: the API sees one shared Access service token from the app, not the person. Access identifies the person at the front end by Workspace email; the worker cannot. That is why the worker needs the Divine login to know who acted.

## Goals

- Every attribution route records the verified moderator, or the route's existing "no human named" value: null on most routes, `'unattributed'` on sexual-quarantine decisions, `'auto'` where a route reaches ReportWatcher's `recordAutoHideHumanDecision` (`shared/automated-decision.ts`), and the worker's admin pubkey on bulk moderate. Those fallbacks stay as they are. Changing them is out of scope (my call).
- No route stores a moderator pubkey taken from the request body.
- A strict "who is this, or refuse" check exists, tested, ready for the viewer.
- Moderation keeps working when the moderator isn't signed in, the token is bad, or Keycast is down or slow.

## Non-goals

- Refusing actions that have no verified moderator. #178 settled no. Once phase 2 records who acted, the share of unattributed actions will show whether to revisit that.
- Restricting anything to Keycast's support-admin list (decision 5).
- Asking Keycast for a narrower login scope (decision 6, a follow-up issue).
- A new Keycast endpoint (decision 1, option D, a follow-up).
- Making the app's sign-out revoke the login in Keycast (decision 9, a follow-up that must land before the viewer).
- The suspended-content viewer and its view log (#212).
- Per-moderator signing (phase 3).

## Anti-goals (would make this a failure even if it works)

- A login problem, Keycast outage or slow Keycast that blocks or noticeably slows a moderation action.
- The login token appearing in any log, D1 row, queue message, error body or Sentry event.
- A record naming a moderator who didn't act, including through an old browser tab, a stale cache entry, or a fallback to an unverified stored value.
- The staging worker acting on production accounts (see decision 2).

## Decisions (1-7 ratified by Matt 2026-10-30; 8-10 on 2026-11-04; the calls in the last section on 2026-11-05)

### 1. How the worker checks a login

The browser sends the moderator's Divine login access token with each request, in a new header `X-Divine-Login-Token`. The worker verifies it by calling Keycast's `POST /api/nostr` with `{"method":"get_public_key","params":[]}` and the token as a Bearer credential, the same call the app's signer already makes. A 2xx with a 64-hex lowercase `result` is the verified pubkey. Anything else is "not verified."

Why this call: Keycast has no token-check endpoint for other services. This one needs no Keycast change. On current Keycast main it refuses an expired token, and it refuses a revoked authorization within about 5 seconds, because cached sessions are rechecked against the database (`AUTHORIZATION_RECHECK_INTERVAL` in `api/src/api/http/nostr_rpc.rs`, added in keycast `3048a5d`). Confirm that commit is deployed to production Keycast before relying on revocation. Lighter options (a lookup that doesn't see revocation, or verifying the token inside the worker) were rejected because they miss revocation, and Keycast doesn't publish the key the worker would need. The cost is small: Keycast loads the moderator's key only when it has no cached session for the token.

**App sign-out and the login.** Making the app's sign-out also revoke the login in Keycast is decision 9, a follow-up.

### 2. Which Keycast verifies logins

The app always signs in at production Keycast (`login.divine.video`), even when its environment switch points at staging. So both the staging and production workers verify logins against production Keycast, through a **new setting** used only for this check. Proposed name: `MODERATOR_LOGIN_URL`, set to `https://login.divine.video` in both `wrangler.staging.toml` and `wrangler.prod.toml`.

The existing `KEYCAST_URL` keeps driving suspend, unsuspend, ban and minor-status calls. It must not be repointed: on staging that would act on real production accounts.

Accepted cost: the staging worker also receives production login tokens. It is the same Cloudflare account behind the same Access gate, and the token is used only for the check: never logged, never stored, only its hash kept in memory.

`wrangler.local.toml` leaves the setting unset. `worker/test/local-config-targets-local-stack.test.ts` keeps local config off deployed services. Locally, nothing is attributed and the strict check refuses. That is a change from today, when local runs record the browser's claimed pubkey.

### 3. When the browser's claim disagrees with the login

After phase 2 the frontend stops sending a claimed moderator. The worker ignores any claimed value that still arrives, for example from an old open tab, and records the verified one, or null. When a claimed value is present and differs from the verified one, the worker logs one warning line naming both pubkeys in full and the route. It does not refuse the action. The claimed value never reaches a record, so tampering gains nothing, and refusing would only block a real moderator on a stale tab.

### 4. How long a verified login is remembered

- A successful check is cached in memory per isolate for **60 seconds**, keyed on the SHA-256 of the token, never the token itself. A revocation takes effect within about a minute. Revoking on app sign-out is decision 9.
- Each Keycast call has a **3-second** timeout.
- Failures are never cached, so the next request tries again and a fresh sign-in works at once.
- No in-flight checks are shared across requests (the same Workers rule PR #352 follows).
- Expected load is a handful of checks a minute: bulk moderate is one check per request, not per item. Keycast rate-limits login, not this call.

### 5. Support-admin list

Not in phase 2. Access already decides who is a moderator, and that list would need filling first. Revisit with the viewer.

### 6. Login scope

Asking Keycast for a narrower login scope becomes a follow-up issue, not a blocker. The handling rules in decision 2 apply meanwhile.

### 7. Build approach

A fresh branch off main (`feat/178-phase2-moderator-identity`). An earlier, unpushed July branch (`feat/178-phase2-token-verification`) has a token check and tests worth lifting: `worker/src/verifyModeratorToken.ts` and its test. Lift them, then change them to this design: 60 s not 5 min, 3 s not 4 s, `MODERATOR_LOGIN_URL` not `KEYCAST_URL`. Don't follow that branch otherwise. It misses four of the eight routes and predates PR #352. After this lands, the local July branch and worktree get deleted on Matt's go.

### 8. Sexual-quarantine decisions are in phase 2 (Matt, 2026-11-04)

`POST /api/report-watcher/sexual-quarantine/:eventId` becomes the eighth attribution route. A decision records the verified moderator, or `'unattributed'` as today when there's no verified login. It is never refused for lack of a login, the same rule as every other action. The route proxies the whole request into ReportWatcher, so the worker:

- removes the login token before forwarding, so it never reaches the Durable Object;
- replaces the body's `actor` with the verified pubkey or `'unattributed'`, so a browser-supplied name can't get through.

Rewriting the body or passing the identity in a worker-set internal header is left to the builder. If it's a header, the worker must first strip any copy the client sent.

### 9. Sign-out revokes the login in a follow-up (Matt, 2026-11-04)

Recording who acted stays correct, because a token only ever names its owner. A follow-up issue makes the app's sign-out also revoke the login in Keycast. That follow-up must land before the suspended-content viewer (#212) relies on strict mode.

### 10. Keycast status calls name the moderator (Matt, 2026-11-04)

Suspend, unsuspend and ban calls to Keycast pass the verified moderator as `actor`, so they show in Keycast's audit under the moderator who acted. This closes `TODO(#178)` in `worker/src/keycast-client.ts`. It covers:

- the age-review PATCH's status calls;
- the `banpubkey`, `unbanpubkey`, `suspendpubkey` and `unsuspendpubkey` cases in `/api/relay-rpc`, which call `banUser`, `unsuspendUser` and `suspendUser` with no actor today.

`/api/relay-rpc` therefore verifies the login like the attribution routes. That includes the internal relay-rpc requests `handleModerate` builds, which must carry the verified identity through. moderation-service's calls with `X-Admin-Key` carry no login, so they stay actor-less. A missing actor stays log-only on Keycast's side, as today.

## The two modes

One verifier, two ways to use it:

- **Attribution mode** (all eight routes, plus relay-rpc for the Keycast actor): returns the verified pubkey or `undefined`. Any failure (no header, no setting, non-2xx, timeout, bad JSON, a malformed result, a thrown setting read) gives `undefined`, and the action proceeds with the route's existing fallback. The whole body, setting resolution included, sits inside the try/catch (memory: Secrets Store reads can throw).
- **Strict mode** (for the viewer): the same check, but the caller refuses when it gets `undefined`. Phase 2 exports a small wrapper whose refusal is a 401 with a stable error code the frontend can turn into "Sign in with Divine to view." Phase 2 tests it, but no route uses it yet.

## Where the verified identity goes

The eight routes on current main (`worker/src/index.ts` unless noted):

| Route | Handler | Today |
|---|---|---|
| `POST /api/publish` | `handlePublish` | body `moderatorPubkey` |
| `POST /api/moderate` | `handleModerate` | body `moderatorPubkey`. Hide/allow store it. `delete_event` validates it but never passes it on. Phase 2 attributes `delete_event` too (my call). |
| `POST /api/decisions` | `handleLogDecision` | body `moderatorPubkey` |
| `POST /api/bulk-moderate` | `worker/src/bulk-moderate.ts` | body `moderatorPubkey`, carried in the queue job |
| `POST /api/confirm-auto-hide` | `handleConfirmAutoHide` | body `moderatorPubkey` |
| `POST /api/tickets/:id/close` | `handleCloseTicket` | body `moderatorPubkey`, no format check; reaches the Zendesk comment and `resolution_moderator` |
| `PATCH /api/age-review/cases/:id` | `worker/src/age-review.ts` | body `moderator_pubkey`, unvalidated |
| `POST /api/report-watcher/sexual-quarantine/:eventId` | proxied to `ReportWatcher` | body `actor`, any non-empty string up to 200 characters (decision 8) |

Re-verified on 2026-11-05 against main `278762a6`: the same eight routes and relay-rpc. Nothing merged since the design added or changed one.

`/api/relay-rpc` also verifies the login, so it can pass the moderator to Keycast as the actor (decision 10). It records no moderator itself.

Rules:

- The verification runs once per request, near the access gate, before the handler. The handler receives the verified pubkey as an argument. Handlers no longer read a moderator from the body.
- **Bulk moderate:** the check runs when the request arrives. Only the verified pubkey goes into the queue job. The token never enters the queue. The existing fallback to the worker's admin pubkey for unattributed bulk work stays as it is.
- **ReportWatcher and Zendesk sync** receive the verified pubkey where they're called from these routes. Their existing format checks stay.
- **Age review (my call):** no frontend code sends `moderator_pubkey` on the PATCH today, so the column is never set in practice, and it gates greenlight attachment and voluntary-case detection (`worker/src/age-review.ts`, the `moderator_pubkey IS NULL` checks). Phase 2 does not start setting it. The PATCH stops accepting it from the body (ignored, not refused, as in decision 3). The Keycast audit actor on the minor-status calls (`minorFlagActor`) becomes the verified moderator making this request, with no fallback to the stored column.
- `POST /api/age-review/create-minor-account` and the protected-minor routes take no moderator from the body (checked).

## Frontend

- Send `X-Divine-Login-Token` from every request that reaches the attribution routes. Take the token when the action starts, not when each request is sent, and use it for the action's follow-up requests too (such as the `logDecision` POST after `EventActions` and `ReportDetail` actions). This matches `DivineSessionProvider`'s existing rule that a sign-out or account switch mid-action can't retarget it (my call).
- Stop sending `moderatorPubkey` / `moderator_pubkey` in those bodies.
- Keep the existing "sign in so your actions are attributed" notice (`AttributionNotice`).
- The relay-rpc requests the browser sends for ban, unban, suspend and unsuspend carry the header too (decision 10).
- The sexual-quarantine decision stops sending `actor` (decision 8).
- The worker's CORS allow-list must include the new header, or the browser drops it before it leaves.

## Rollout

> **Correction (2026-11-06, final review):** this section used to deploy staging's worker and frontend, then prod's. There is one Pages frontend for both environments, so that order put the new frontend in front of the old prod worker, which breaks actions (see step 2). Corrected to both workers first, then the frontend, with rollback in the reverse order.

1. Set `MODERATOR_LOGIN_URL` in the staging and prod tomls (it ships with the code; no secret).
2. Deploy the staging worker, then the prod worker, then the single frontend. Note each previous worker version ID first. The order matters:
   - New worker, old frontend (the gap this order accepts): old tabs send a claimed pubkey and no token, so their actions record nobody. Nothing fails.
   - New frontend, old worker (the gap this order avoids): the frontend sends no `actor`, so the old Durable Object answers 400 to every sexual-quarantine decision, and the old CORS allow-list lacks `X-Divine-Login-Token`, so the browser's preflight blocks every request that carries the token, which is every attribution request from a signed-in moderator.
3. Between the two worker deploys, check on staging that an action from the current frontend still succeeds (it records nobody, as expected).
4. After the frontend deploy, ask moderators to reload. A tab opened before it sends no token, so its actions stay unattributed until reloaded.
5. On staging, then prod: sign in with Divine, take one harmless action, and check that the recorded moderator is the signed-in pubkey. Sign out, act again, and check that it records null. Check the logs for a mismatch line from an old tab, if you can make one.
6. Rollback runs in reverse: the frontend first, then the workers. Rolling a worker back while the new frontend is live recreates the new-frontend, old-worker break in step 2.

## Testing the builder must cover

- The verifier: each failure path gives `undefined`. That covers no header, unset setting, a setting read that throws, 401, 5xx, timeout, non-JSON, a non-hex or uppercase result, and a thrown fetch. The cache hits within 60 s and misses after. Failures aren't cached. The token never appears in a log line (assert on the console spy).
- Each attribution route records the verified pubkey, records its existing fallback when unverified, and ignores a body-supplied moderator. Each needs a test that goes red if the route reads the body again (mutation-check one guard at a time).
- Bulk moderate: the queue job carries the pubkey and no token.
- Mismatch logging: one line, both full pubkeys, and the action still succeeds.
- Strict wrapper: refuses on `undefined`, with the stable code.
- Sexual quarantine: the Durable Object receives the verified pubkey or `'unattributed'`, never the body's `actor` and never the token.
- Keycast status calls: each of the four relay-rpc account cases and the age-review status calls pass the verified moderator as `actor`, and pass none when unverified. Calls through `handleModerate`'s internal relay-rpc requests are included.
- D1-backed routes need `npm run test:d1` (run the age-review file on its own on macOS).

## Left to the builder

- The exact module layout and names beyond those above.
- Whether to cache by isolate-level `Map` (as the July branch does) or another structure, as long as decision 4's limits hold.
- Error code name for the strict refusal.
- How the frontend threads the token. Keep it in one place, so a later caller can't forget it (memory: `useAdminApi` wrapper silently dropping new args).

## Calls Matt ratified on 2026-11-05

- The header name `X-Divine-Login-Token` and the setting name `MODERATOR_LOGIN_URL`.
- Ignoring, rather than rejecting, a body-supplied moderator, including the format check that today returns 400.
- The age-review PATCH stops accepting `moderator_pubkey` and doesn't start setting it. The Keycast audit actor becomes the verified requester, with no fallback to the stored value.
- Existing fallbacks (`'auto'`, the admin pubkey on bulk moderate) stay.
- `delete_event` on `/api/moderate` becomes attributed.
- The token is taken when the action starts.
- Local dev records nobody (a consequence of decision 2 plus the local-config test).
