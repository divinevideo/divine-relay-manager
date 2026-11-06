# Moderator identity via Divine login, phase 2: implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The worker records the moderator it verified from the moderator's Divine login, never a moderator named in the request body, and moderation never blocks on that check.

**Architecture:** One worker module verifies the `X-Divine-Login-Token` header against Keycast's `get_public_key` (60 s hash-keyed cache, 3 s timeout, never throws). The fetch handler calls it once, right after the access gate, and passes the result to each attribution handler as an argument. Handlers stop reading moderators from bodies. The frontend snapshots the login token at the start of an action and sends it in the header from one place in the API client.

**Tech Stack:** Cloudflare Workers (TypeScript), D1, Durable Objects, Vitest 3 (worker and root), React 18, TanStack Query 5.

**Spec:** `docs/superpowers/specs/2026-11-04-moderator-identity-phase2-design.md` (re-verified against main `51aa37a7` on 2026-11-05: the same eight routes plus relay-rpc. `/api/moderate-media` records no moderator. #359 changed only the outbound Coop call. Checked again against `278762a6`: #367 and #368 touch no attribution route, and the `TODO(#178)` is still at `worker/src/keycast-client.ts:95`.)

## Global Constraints

- Header name: `X-Divine-Login-Token`. Worker setting: `MODERATOR_LOGIN_URL`, a plain `[vars]` string, `https://login.divine.video` in both `wrangler.staging.toml` and `wrangler.prod.toml`, and absent from `wrangler.local.toml`.
- Keycast call: `POST ${MODERATOR_LOGIN_URL}/api/nostr`, body `{"method":"get_public_key","params":[]}`, `Authorization: Bearer <token>`. Only a 2xx whose `result` matches `/^[0-9a-f]{64}$/` is verified.
- Cache successes only, for 60 s, keyed on the SHA-256 hex of the token. Each Keycast call times out after 3 s. Failures are never cached. No in-flight checks are shared across requests.
- The token never appears in a log line, D1 row, queue message, error body, or anything forwarded to the ReportWatcher Durable Object.
- No route reads a moderator from the request body. A body moderator is ignored, never refused, so the old 400 format checks go away.
- Existing "no human" fallbacks stay: `null` (decisions, ticket close), `'auto'` (DO-recorded decisions), the worker's admin pubkey (bulk moderate), `'unattributed'` (sexual-quarantine actor).
- `KEYCAST_URL` is not repointed. It keeps driving the status calls.
- No moderation action is refused or delayed past the 3 s check for lack of a verified login.
- Zendesk sync keeps today's arguments. Publish, moderate and bulk keep passing the worker's admin key. Only ticket close and the sexual-quarantine decision, which already pass a moderator, get the verified value (see Matt's answer 1).
- No em dashes in new comments or copy. Commits carry no AI trailers.

## Review Focus

1. **An old tab sends a body moderator and no token.** It must record the fallback, not the claimed value, with no mismatch line (nothing verified to compare). Pinned in Task 3.
2. **A token for a different account than the claimed one.** It must record the token's pubkey, with exactly one warn line naming both full pubkeys and the route, and the action still succeeds. Pinned in Task 3.
3. **Keycast slow or down during a bulk or age-review action.** The action proceeds after at most 3 s, with the fallback. Pinned in Task 1 (timeout) and Task 2 (gate proceeds).
4. **A token header reaching the Durable Object on a non-decision report-watcher route** (GET `/config`, `/start`). It must be stripped. Pinned in Task 8.
5. **The internal relay-rpc request `handleModerate` builds for Ban.** It must carry the verified moderator to Keycast as `actor`. It builds a fresh `Request` without the original headers. Pinned in Task 4.

## Matt's answers (2026-11-05)

1. **Zendesk comments on publish and moderate** keep naming the worker's admin key. Naming the verified moderator there can be a follow-up once phase 2 is live.
2. **Mismatch log** only when a claimed value and a verified value are both present and differ. An unverified old tab logs nothing.

Execution: a fresh implementer and a fresh reviewer for each task, then a review of the whole branch.

---

### Task 0: Record the ratified calls in the design doc

Matt confirmed the seven calls in the authoring session on 2026-11-05.

**Files:** Modify `docs/superpowers/specs/2026-11-04-moderator-identity-phase2-design.md`.

- [x] **Step 1:** Rename the last section to "Calls Matt ratified on 2026-11-05". Keep its seven bullets. Change the "Decisions" heading to "(1-7 ratified by Matt 2026-10-30; 8-10 on 2026-11-04; the calls in the last section on 2026-11-05)". Record the re-verification against main `278762a6` under "Where the verified identity goes".
- [ ] **Step 2:** Commit: `docs(178): record the ratified phase 2 calls`.

### Task 1: The login verifier

**Files:**
- Create: `worker/src/moderator-identity.ts`
- Test: `worker/src/moderator-identity.test.ts`
- Lift from `git show feat/178-phase2-token-verification:worker/src/verifyModeratorToken.ts` and its test. Change them to the constraints above. Don't check out that branch.

**Interfaces (produces):**
```ts
export const MODERATOR_LOGIN_HEADER = 'X-Divine-Login-Token';
export interface ModeratorLoginEnv { MODERATOR_LOGIN_URL?: string }
export async function verifyModeratorLogin(env: ModeratorLoginEnv, token: string | null | undefined): Promise<string | undefined>;
export function noteClaimedModerator(route: string, claimed: unknown, verified: string | undefined): void;
export const MODERATOR_LOGIN_REQUIRED = 'moderator_login_required';
export function requireVerifiedModerator(verified: string | undefined, corsHeaders: Record<string, string>): { pubkey: string } | Response;
export function __clearModeratorLoginCache(): void; // test-only
```
- `verifyModeratorLogin`:
  - The whole body sits in try/catch, setting read included.
  - It returns `undefined` on any failure.
  - It logs on failure without the token: one `console.warn('[moderator-identity] login check failed: <reason>')`, where the reason is a status code or an error name.
- `noteClaimedModerator`:
  - When `claimed` is a string, `verified` is defined, and `claimed.toLowerCase() !== verified`, it emits one `console.warn(\`[moderator-identity] ${route}: claimed moderator ${claimedOrMalformed} differs from verified ${verified}\`)`.
  - `claimedOrMalformed` is the lowercased claim if it is 64-hex, else the literal `malformed`.
- `requireVerifiedModerator` returns a 401 `{ success: false, error: 'Sign in with Divine to continue', code: MODERATOR_LOGIN_REQUIRED }` when `verified` is undefined.

- [ ] **Step 1: Write the failing tests** in `moderator-identity.test.ts`. Stub fetch with `vi.stubGlobal('fetch', ...)`, and use `beforeEach(__clearModeratorLoginCache)` and `afterEach(vi.restoreAllMocks)`. Write each test as one `it`:
  - `returns the verified pubkey for a 2xx get_public_key result`. Assert the URL is `https://login.test/api/nostr`, the method is POST, the `Authorization` header is `Bearer tok`, and the body equals `{ method: 'get_public_key', params: [] }`.
  - `returns undefined with no token`, `with no MODERATOR_LOGIN_URL`, and `when reading MODERATOR_LOGIN_URL throws` (use a getter that throws). For all three, assert fetch was not called.
  - `returns undefined for 401`, `for 500`, `for a non-JSON body`, `for a non-hex result`, `for an uppercase result`, and `when fetch throws`.
  - `passes a 3-second timeout`: spy on `AbortSignal.timeout` and expect it called with `3000`.
  - `serves a second call within 60 s from the cache`: one fetch for two calls.
  - `checks again after 60 s`: fake timers, advance 60_001 ms, two fetches.
  - `does not cache a failure`: first 401, then 2xx, so two fetches and the second returns the pubkey.
  - `never logs the token`: run the failure cases with spies on `console.warn`, `console.error` and `console.log`, and assert no call argument contains the token string.
  - `noteClaimedModerator logs once when the claim differs from the verified pubkey, naming both in full`.
  - `noteClaimedModerator stays silent when the claim matches, is absent, or nothing is verified`.
  - `noteClaimedModerator names a malformed claim "malformed"`.
  - `requireVerifiedModerator refuses an unverified moderator with 401 and code moderator_login_required`.
  - `requireVerifiedModerator passes a verified pubkey through`.
- [ ] **Step 2:** Run `cd worker && npx vitest run src/moderator-identity.test.ts`. Expect FAIL (module not found).
- [ ] **Step 3:** Implement the module. Keep the July branch's hash and cache shape: `Map<string, { pubkey; expiresAt }>`, keyed on the SHA-256 hex.
- [ ] **Step 4:** Run the same command. Expect PASS. Mutation-check four removals one at a time, each restored with `cp`: the cache expiry check, the result regex, the try around the setting read, and the timeout. Each must go red.
- [ ] **Step 5:** Commit: `feat(worker): verify a moderator's Divine login against Keycast`.

### Task 2: Run the check once per request, after the access gate

**Files:**
- Modify: `worker/src/index.ts`:
  - the `Env` interface (:75): extend `ModeratorLoginEnv`;
  - `buildCorsHeaders` (:364): add the header;
  - the fetch handler right after the gate (:605).
- Modify: `worker/wrangler.staging.toml` and `worker/wrangler.prod.toml` `[vars]`: add `MODERATOR_LOGIN_URL = "https://login.divine.video"`.
- Test: `worker/src/index.test.ts` (CORS strings at :139 and :171), and a new describe in `worker/src/moderator-identity-gate.test.ts`.

**Interfaces:**
- Consumes `verifyModeratorLogin` and `MODERATOR_LOGIN_HEADER` from Task 1.
- Produces a local `const moderator: string | undefined` in the fetch handler. Tasks 3 to 8 pass it to their handlers.

- [ ] **Step 1: Failing tests.**
  - In `moderator-identity-gate.test.ts`:
    - `verifies the login once per request when the header is present`. POST `/api/decisions` with the header and a fetch spy routed on `/api/nostr`. Exactly one `/api/nostr` call.
    - `makes no login call without the header`.
    - `verifies only after the access gate`. With the header but no `X-Admin-Key`: a 401, and no `/api/nostr` call.
  - In `index.test.ts`, update the two exact CORS strings to end with `, X-Divine-Login-Token`.
- [ ] **Step 2:** Run `cd worker && npx vitest run src/moderator-identity-gate.test.ts src/index.test.ts`. Expect FAIL.
- [ ] **Step 3:** Implement. After the gate: `const moderator = request.headers.has(MODERATOR_LOGIN_HEADER) ? await verifyModeratorLogin(env, request.headers.get(MODERATOR_LOGIN_HEADER)) : undefined;`. Add the toml lines. Confirm that `worker/test/local-config-targets-local-stack.test.ts` and `worker/test/deployed-config-canonical-hosts.test.ts` still pass.
- [ ] **Step 4:** Run `cd worker && npx vitest run`. Expect all green.
- [ ] **Step 5:** Commit: `feat(worker): check the moderator login once, after the access gate`.

### Task 3: Publish, decisions, confirm-auto-hide, and moderate's event actions

**Files:**
- Modify: `worker/src/index.ts`:
  - `handlePublish` (:1096; drop the 400 at :1107-1109, use `moderator` at :1137);
  - `handleModerate` (:1235; drop the 400s at :1267 and :1342, pass `moderator` at :1272 for `delete_event` and at :1352);
  - `handleLogDecision` (:1958; drop :1983-1985, use `moderator` at :1996 and in the insert at :2015);
  - `handleConfirmAutoHide` (:2037; drop :2055-2057, use `moderator` at :2068);
  - the router calls at :647, :658, :678 and :682.
- Remove `moderatorPubkey` from the `UnsignedEvent` body type (:377-384) and the moderate body type (:1241-1247), so the compiler finds any leftover read.
- Test:
  - `worker/src/human-decision.test.ts`;
  - `worker/src/index.test.ts`: allow-with-moderator at :931-962, the malformed 400 at :995-1011, which flips to ignored, and the confirm provenance test at :1013-1055;
  - `worker/test/content-decision.d1.test.ts`.

**Interfaces:** each handler gains a final parameter `moderator: string | undefined`, and each calls `noteClaimedModerator('<route path>', body.moderatorPubkey, moderator)` once.

- [ ] **Step 1: Failing tests.** For each of `/api/publish` (resolution label), `/api/decisions`, `/api/confirm-auto-hide`, and `/api/moderate` with `allow_event` and with `delete_event`, write three tests:
  - `records the verified moderator`. The DB binding or the `visibilityOperations` entry equals the verified pubkey from a mocked `/api/nostr`.
  - `records the fallback without a verified login`: `null` for the decisions insert, and `moderatorPubkey` absent from the DO operation (the DO's `'auto'`).
  - `ignores a body moderator`. A body `moderatorPubkey: 'c'.repeat(64)` with no token records the fallback. A body `moderatorPubkey: { forged: true }` returns success, not 400.

  Plus one mismatch test on `/api/decisions`: `logs one mismatch line and still succeeds when the body claims another moderator`.
- [ ] **Step 2:** Run `cd worker && npx vitest run src/human-decision.test.ts src/index.test.ts`. Expect FAIL.
- [ ] **Step 3:** Implement as listed under Files.
- [ ] **Step 4:** Run the worker suite, `npm run typecheck`, and `npx vitest run --config vitest.d1.config.ts test/content-decision.d1.test.ts test/decisions-truncation.d1.test.ts test/resolution-state.d1.test.ts`. Mutation-check one route at a time by restoring `body.moderatorPubkey` in its sink. Each must turn its "ignores a body moderator" test red.
- [ ] **Step 5:** Commit: `feat(worker): record the verified moderator on publish, decisions, confirm and moderate`.

### Task 4: Keycast status calls name the moderator (relay-rpc)

**Files:**
- Modify: `worker/src/index.ts`:
  - `handleRelayRpc` (:1568) and `runRelayRpc` (:1581) gain a final `moderator?: string`;
  - the account cases at :1721-1742 pass it as the `actor` argument of `banUser`, `suspendUser` and `unsuspendUser`, for both unban and unsuspend;
  - the `ban_pubkey` (:1412-1421) and `allow_pubkey` (:1471-1481) internal calls pass `moderator`;
  - the router call at :662 passes `moderator`;
  - `handleDeleteDecisions` (:2307-2317) passes nothing.
- Modify: `worker/src/keycast-client.ts:95-98`: delete the `TODO(#178)` comment.
- Test: `worker/src/index.test.ts`, describe `'relay-rpc account-state side effects'` (:296). Extend `keycastCalls` (:450) to return `.actor`.

- [ ] **Step 1: Failing tests.**
  - `passes the verified moderator as the Keycast actor on banpubkey, unbanpubkey, suspendpubkey and unsuspendpubkey`. Use `it.each` over the four methods, with the header plus `/api/nostr` mocked, and drain `waitUntil`.
  - `passes no actor without a verified login`.
  - `carries the verified moderator through /api/moderate ban_pubkey and allow_pubkey to Keycast`.
  - `moderation-service's X-Admin-Key relay-rpc call passes no actor`.
- [ ] **Step 2:** Run `cd worker && npx vitest run src/index.test.ts -t 'relay-rpc'`. Expect FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run the worker suite and typecheck. Mutation-check by dropping the `moderator` argument on the `ban_pubkey` internal call. The through-moderate test must go red.
- [ ] **Step 5:** Commit: `feat(worker): name the verified moderator on Keycast status calls`.

### Task 5: Bulk moderate

**Files:**
- Modify: `worker/src/bulk-moderate.ts`:
  - `handleBulkModerateEnqueue` (:749) gains `moderator: string | undefined`;
  - drop the 400 at :788-790;
  - the queue send at :826 uses `moderatorPubkey: moderator`;
  - remove `moderatorPubkey` from the body type (:754-757).
- Modify: `worker/src/index.ts:858`, which passes `moderator`.
- Test: `worker/src/bulk-moderate.test.ts:1854-1895` and `worker/test/bulk-jobs-kind.d1.test.ts:84-124`.

- [ ] **Step 1: Failing tests.**
  - `enqueues the verified moderator`. Every message has `moderatorPubkey === MODERATOR`.
  - `enqueues no moderator without a verified login, so processing falls back to the admin pubkey`. The D1 test asserts the decision row's `moderator_pubkey` is the admin pubkey.
  - `ignores a body moderatorPubkey`. Body `moderatorPubkey: 'c'.repeat(64)`, called with `undefined`: messages lack the field, and a malformed body value is not a 400.
  - `never puts the login token in a queue message`. Call with the header on the request and assert that `JSON.stringify(messages)` doesn't contain the token.
- [ ] **Step 2:** Run `cd worker && npx vitest run src/bulk-moderate.test.ts`. Expect FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run the worker suite, typecheck, and `npx vitest run --config vitest.d1.config.ts test/bulk-jobs-kind.d1.test.ts test/age-review-lookup.d1.test.ts`.
- [ ] **Step 5:** Commit: `feat(worker): carry the verified moderator into bulk jobs`.

### Task 6: Ticket close

**Files:**
- Modify: `worker/src/index.ts`:
  - the router at :714-715 stops parsing the body and calls `handleCloseTicket(env, ticketId, moderator, corsHeaders)`;
  - `handleCloseTicket` (:3776) takes `moderator: string | undefined` in place of `body`, and calls `closeTicketById(env, ticketId, moderator ?? null)`.
- Test: `worker/src/zendesk-sync.test.ts` (route tests at :619 and :674), and `worker/test/zendesk-closure.d1.test.ts:90-102`.

- [ ] **Step 1: Failing tests.**
  - `records the verified moderator as resolution_moderator`.
  - `records null without a verified login`, which reads as `'unknown'` in the note.
  - `ignores a body moderatorPubkey`.
- [ ] **Step 2:** Run. Expect FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run the worker suite, typecheck, and `npx vitest run --config vitest.d1.config.ts test/zendesk-closure.d1.test.ts`.
- [ ] **Step 5:** Commit: `feat(worker): close tickets as the verified moderator`.

### Task 7: Age-review PATCH

**Files:**
- Modify: `worker/src/age-review.ts`:
  - `handleUpdateAgeReviewCase` (:340) gains `moderator: string | undefined`;
  - delete the moderator assignment block at :448-455, so a body `moderator_pubkey` is ignored and never written;
  - :717 becomes `const minorFlagActor = moderator;`, rewriting the comment at :712-716 to say why there is no fallback to the stored column;
  - the Keycast status legs at :688-694 pass `moderator` as the final `actor` argument.
- Modify: `worker/src/index.ts:941`, which passes `moderator`.
- Test: `worker/src/age-review.test.ts` (update the exact-argument assertions at :768, :807 and :907, and the `clearVerifiedMinor` actor tests at :1024-1060), and `worker/test/age-review-handler.d1.test.ts`.

- [ ] **Step 1: Failing tests.**
  - `passes the verified moderator as actor to suspendUser, unsuspendUser and banUser`.
  - `passes the verified moderator to setVerifiedMinor, clearVerifiedMinor and clearSubject`.
  - `passes no actor without a verified login, even when the case row has moderator_pubkey set`. Seed the row with `moderator_pubkey = 'd'.repeat(64)`.
  - `ignores a body moderator_pubkey and leaves the column unchanged`. In D1: the column is still NULL after a PATCH with `moderator_pubkey: 'c'.repeat(64)`. A non-string value is not a 400.
  - `a greenlight case stays voluntary after a PATCH that names a moderator in the body`, from `greenlight-start.d1.test.ts`. It pins that the `moderator_pubkey IS NULL` gates still hold.
- [ ] **Step 2:** Run `cd worker && npx vitest run src/age-review.test.ts`. Expect FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run the worker suite and typecheck. Run `npx vitest run --config vitest.d1.config.ts test/age-review-handler.d1.test.ts` on its own (macOS ports). Then run `test/greenlight-start.d1.test.ts test/greenlight-report-race.d1.test.ts test/protected-minors.d1.test.ts`.
- [ ] **Step 5:** Commit: `feat(worker): attribute age-review decisions to the verified moderator`.

### Task 8: Sexual-quarantine decisions and the report-watcher proxy

**Files:**
- Modify: `worker/src/index.ts`: `handleReportWatcherRoutes` (:3628) gains `moderator: string | undefined`, and the router at :754 passes it.
- Forwarding (:3655-3662) copies the headers, deletes `X-Divine-Login-Token` for every forwarded request, and forwards the rest unchanged.
- For `POST` on `/sexual-quarantine/<eventId>` with no further suffix:
  - read the JSON body;
  - set `actor` to `moderator ?? 'unattributed'`;
  - call `noteClaimedModerator('/api/report-watcher/sexual-quarantine', input.actor, moderator)`;
  - forward the rewritten body with `Content-Type: application/json`.
  - An unparseable body is forwarded unchanged, so the DO's existing 400 answers it.
- Test: `worker/src/sexual-quarantine-proxy.test.ts` and `worker/test/sexual-quarantine-decision.d1.test.ts`.

- [ ] **Step 1: Failing tests.** Stub `REPORT_WATCHER` to capture the forwarded Request.
  - `forwards the verified moderator as actor`.
  - `forwards 'unattributed' without a verified login`.
  - `replaces a body actor`. Body `actor: 'someone-else'` arrives as `'unattributed'`.
  - `strips the login token from a decision POST`.
  - `strips the login token from GET /config and POST /start`.
  - `forwards an unparseable decision body unchanged`.
- [ ] **Step 2:** Run `cd worker && npx vitest run src/sexual-quarantine-proxy.test.ts`. Expect FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run the worker suite, typecheck, `src/ReportWatcher-sexual.test.ts`, `src/admin-access.test.ts`, and `npx vitest run --config vitest.d1.config.ts test/sexual-quarantine-decision.d1.test.ts`. Mutation-check by removing the header delete. The GET test must go red.
- [ ] **Step 5:** Commit: `feat(worker): decide sexual-quarantine cases as the verified moderator`.

### Task 9: The frontend session's token snapshot

**Files:**
- Modify:
  - `src/contexts/DivineSessionContext.ts`: add `getModeratorToken: () => string | undefined` to `DivineSessionValue`, defaulting to `() => undefined`;
  - `src/components/DivineSessionProvider.tsx`: add a `tokenRef` mirroring `credentials?.accessToken`, updated in the same effect as `signerRef` (:104-106), and add `getModeratorToken` to the value memo;
  - `src/hooks/useCurrentUser.ts`: expose `getModeratorToken`.
- Reference: July commit `e0e5a0a9`. It was async; this one is synchronous, because a caller snapshots it at the click.
- Test: `src/components/DivineSessionProvider.test.tsx`, or the existing provider test file.

- [ ] **Step 1: Failing tests.**
  - `getModeratorToken returns the signed-in access token`.
  - `returns undefined after logout`.
  - `a token taken before an account switch keeps the old value`. Capture the token, switch credentials, and the captured string is unchanged.
- [ ] **Step 2:** Run `npx vitest run src/components/DivineSessionProvider`. Expect FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run `npx tsc -p tsconfig.app.json --noEmit` and the test file. Expect PASS.
- [ ] **Step 5:** Commit: `feat(frontend): snapshot the moderator's login token`.

### Task 10: The API client sends the token from one place

**Files:**
- Modify `src/lib/adminApi.ts`:
  - `apiRequest` (:205) opts gain `loginToken?: string`;
  - headers become `{ ...getApiHeaders(), ...(opts?.loginToken ? { 'X-Divine-Login-Token': opts.loginToken } : {}) }`;
  - `callRelayRpc` (:310) opts gain the same and apply it at :324.
- Every function in the attribution table below gains a final `opts?: { loginToken?: string }` and forwards it to `apiRequest` or `callRelayRpc`:
  - `publishEvent`, `publishLabel`, `publishLabelAndBan`, `markAsReviewed`;
  - `moderateAction`, `deleteEvent`, `hideEvent`, `restoreEvent`, `allowPubkey`, `banPubkey`;
  - `unbanPubkey`, `suspendPubkey`, `unsuspendPubkey`;
  - `logDecision`, `closeTicket`, `confirmAutoHide`, `updateAgeReviewCase`, `bulkModerate`, `decideSexualQuarantine`.
- Remove these body fields:
  - `moderatorPubkey` from `UnsignedEvent` (:56-63), `ModerateParams` (:65-71), `LabelParams` (:101), the `logDecision` params, `confirmAutoHide` params and `BulkModerateOptions`;
  - the `moderatorPubkey` argument of `restoreEvent`, `markAsReviewed` and `closeTicket`;
  - `actor` from `decideSexualQuarantine`'s body.
- Modify `src/hooks/useAdminApi.ts`:
  - move the memo body into `function buildAdminApi(apiUrl: string, relayUrl: string, loginToken?: string)`;
  - every attribution wrapper passes `{ loginToken }`;
  - `useAdminApi()` returns `{ ...buildAdminApi(apiUrl, relayUrl), asModerator: (loginToken: string | undefined) => buildAdminApi(apiUrl, relayUrl, loginToken) }`.
- Test: `src/lib/adminApi.test.ts`, and a new `src/hooks/useAdminApi.attribution.test.ts`.

**Interfaces (produces):** `api.asModerator(token)` returns the same API surface, with the token bound to every attribution call. Task 11's callers use it.

- [ ] **Step 1: Failing tests.**
  - In `useAdminApi.attribution.test.ts`, list `ATTRIBUTION_CALLS` as `[name, invoke]` pairs, one per function in the table above. Test with `it.each`:
    - `asModerator(token).<name> sends X-Divine-Login-Token`;
    - `the plain api.<name> sends no login header`.
    - This table is the guard against a wrapper forgetting the token.
  - In `adminApi.test.ts`, `no attribution request body carries moderatorPubkey, moderator_pubkey or actor`.
- [ ] **Step 2:** Run `npx vitest run src/hooks/useAdminApi.attribution.test.ts src/lib/adminApi.test.ts`. Expect FAIL.
- [ ] **Step 3:** Implement. Let `tsc` list every caller that still passes a removed argument. Task 11 fixes them, so this task's commit may leave the app's `tsc` red only if Tasks 10 and 11 land as one commit. Prefer one commit for 10 and 11 if the caller list is long.
- [ ] **Step 4:** Run the two test files. Expect PASS.
- [ ] **Step 5:** Commit, together with Task 11 if needed: `feat(frontend): send the login token on every attribution request`.

### Task 11: Callers take the token at action start

**Files** (from the code map, section 4.6):
- `EventActions.tsx`, `ReportDetail.tsx`, `UserActions.tsx`, `UserManagement.tsx`, `EventDetail.tsx`, `DebugPanel.tsx`;
- `EventModeration.tsx`, `EventsList.tsx`, `BulkNotesPanel.tsx`, `BulkDeleteByKind.tsx` (prop `getModeratorPubkey` becomes `getModeratorToken`), `LinkedTicketPanel.tsx`;
- `SexualQuarantine.tsx`, which drops `actor`, keeps the identity banner and uses `session.getModeratorToken()`;
- `AgeReviewDetail.tsx`, whose PATCH goes through `asModerator`.
- Plus each one's tests.

- [ ] **Step 1: Failing tests.**
  - `moderator-attribution.integration.test.tsx` (extend it): `an action and its follow-up logDecision both send the token taken at the click, even after an account switch mid-action`.
  - `no attribution call sends a moderator in the body when signed in`, which lifts the idea of July's `494a0926`.
  - For each caller file, its existing attribution assertion changes from `moderatorPubkey: X` to "called through `asModerator(token)`".
- [ ] **Step 2:** Run `npx vitest run src/components`. Expect FAIL.
- [ ] **Step 3:** Implement. Each action does `const act = api.asModerator(getModeratorToken());` as its first line and uses `act` for every request in that action. `getModeratorPubkey` stays only for display.
- [ ] **Step 4:** Run root `npm run test`. Expect green.
- [ ] **Step 5:** Commit: `feat(frontend): take the login token when an action starts`.

### Task 12: Whole-branch verification

- [ ] Root: `npm run test`, which includes `tsc -p tsconfig.app.json` and the build.
- [ ] Worker: `npx vitest run`, `npm run typecheck`, `npm run test:d1`. Run the age-review D1 file on its own on macOS.
- [ ] Grep that no handler reads a moderator from the body: `git grep -n "body.moderatorPubkey\|body.moderator_pubkey" worker/src ':!*.test.ts'` returns nothing.
- [ ] Grep that the token isn't logged: no `console.*` argument references a variable holding the header value.
- [ ] Self-review to PR_REVIEW.md:
  - one fresh-context review using `superpowers:requesting-code-review`'s template;
  - one GPT seat: `codex exec -m gpt-6.1-sol -c model_reasoning_effort=high -s read-only "<brief>" </dev/null`;
  - a disposition for every finding;
  - each guard mutation-checked one at a time;
  - suites with counts on current main.
- [ ] Then ask Matt for the commit, push and PR go. The rollout runs staging-first through RM orchestration, per the design's Rollout section.
