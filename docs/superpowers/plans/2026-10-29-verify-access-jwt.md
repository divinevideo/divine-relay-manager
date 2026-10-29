# Verify the Cloudflare Access JWT in verifyAdminAccess (issue #338) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `verifyAdminAccess` accepts a `Cf-Access-Jwt-Assertion` only when it verifies (RS256 signature against the team certs, issuer, audience of the main API Access app, expiry), instead of accepting any request that carries the header.

**Architecture:** Extract the verifier in `worker/src/consent-video.ts` into a shared `worker/src/access-jwt.ts` that takes a team domain and audience, caches the certs per isolate, and returns the verified claims (or null). The consent route and `verifyAdminAccess` both call it. In `verifyAdminAccess` the `X-Admin-Key` / `MOD_RELAY_ADMIN_KEY` checks run first, unchanged; a request without a matching key then needs a verified JWT.

**Tech Stack:** Cloudflare Workers, WebCrypto (`crypto.subtle`), Vitest.

**Spec:** relay-manager issue #338 (sub-issue of #178). No separate design doc.

## Global Constraints

- `X-Admin-Key` (ADMIN_API_KEY) and `MOD_RELAY_ADMIN_KEY` (relay-rpc only) paths unchanged. moderation-service reaches `/api/relay-rpc` over a service binding with `X-Admin-Key` only (bypasses Access); osprey's relay-manager sink uses `X-Admin-Key`.
- Fail closed: no audience or team domain configured means no JWT is accepted, in every environment. Local dev has no Access and keeps using `X-Admin-Key`.
- Certs fetched from `https://<team>/cdn-cgi/access/certs`, cached per isolate.
- The audience value comes from an Access admin. Never guessed. Code and tests do not need it; the rollout task does.
- No new dependencies.

## Review Focus

1. A forged header plus a valid `X-Admin-Key` still authorizes (fall-through), and a forged header alone does not.
2. Key rotation: a token signed by a kid missing from the cached certs triggers one refetch, and that refetch is rate-limited, so random kids can't make every request refetch.
3. A certs fetch that fails or throws refuses, and is not cached as an empty key set.
4. `aud` as a string or an array; `exp` missing, non-numeric, or in the past; `alg` other than RS256 (including `none`).
5. Consent route behaviour unchanged: still 503 without its own config, 401 without a valid JWT, and still never accepts `X-Admin-Key`.

## Decisions

- After review round 1: keep a single audience. Add list support only if the rollout dashboard check finds another Access app on `api-relay-*`. When the certs can't be refetched after the cache expires, refuse, with no stale-key fallback. Two pre-existing gaps are tracked separately: #347 (a failed MOD_RELAY_ADMIN_KEY read answers 500) and #348 (constant-time key comparison).

- `ACCESS_TEAM_DOMAIN` is a toml var (`divinevideo.cloudflareaccess.com`). `API_ACCESS_AUD` is a worker secret, string or Secrets Store binding, set per environment, staging first. It's never in toml, because the repo is public. The verifier returns the verified claims (option A). On the UI path these are a service token's, so they carry no moderator identity. The suspended-content audit will use a verified Divine login (#178 phase 2) instead. `CONSENT_ACCESS_*` is left as is.
- Certs cache TTL is 1 hour. A refetch on an unknown kid happens at most once per 60 seconds per isolate. A failed fetch is not cached and refuses: no stale-key fallback.
- `X-Admin-Key` is checked before the JWT. That's cheaper (no certs fetch for server callers), and it gives the same result as the old order, because either credential alone is sufficient.
- A JWT that fails verification gets the same 401 text as today. When the audience setting is missing, the worker logs a `console.error` naming the setting, so a misconfigured deploy is diagnosable from the logs.

---

### Task 1: Shared verifier with claims and a certs cache

**Files:**
- Create: `worker/src/access-jwt.ts`
- Create: `worker/src/access-jwt.test.ts`
- Modify: `worker/src/consent-video.ts` (replace the body of `verifyConsentAccessJwt` with a call to the shared verifier; move `b64UrlDecode` and `FetchFn`)
- Modify: `worker/src/consent-video.test.ts` (only if imports move)

**Interfaces:**
- Produces:
  - `export interface AccessClaims { iss: string; aud: string[]; exp: number; sub?: string; email?: string; common_name?: string }`
  - `export async function verifyAccessJwt(token: string, config: { teamDomain?: string; audience?: string; onReject?: (reason: AccessJwtRejection) => void }, fetchFn?: FetchFn, now?: () => number): Promise<AccessClaims | null>`
  - `export function __resetAccessCertsCacheForTests(): void`
- `verifyConsentAccessJwt(token, env, fetchFn)` keeps its signature and boolean result.

- [ ] Step 1: Write failing tests in `access-jwt.test.ts`, using a shared signer helper (`worker/src/test-helpers/access-jwt.ts`, `makeAccessJwtSigner`) that `consent-video.test.ts` also uses:
  - valid token returns claims including `email` when present and `common_name` for a service-token-shaped payload
  - tampered signature, unknown kid after refetch, wrong `iss`, `aud` missing the audience (string and array forms), `exp` past, `exp` missing, `alg: 'none'` and `alg: 'HS256'` each return null
  - missing `teamDomain`, missing `audience` or empty token return null without calling fetch
  - certs `ok: false` returns null; fetch throwing returns null; a following call refetches (failure not cached)
  - two verifications within the TTL fetch certs once; after the TTL (via `now`) they refetch
  - unknown kid triggers one refetch; a second unknown kid within 60s does not fetch again
- [ ] Step 2: Run `cd worker && npx vitest run src/access-jwt.test.ts`. Expected: FAIL (module missing).
- [ ] Step 3: Implement `access-jwt.ts`, moving the existing decode/verify logic and adding module-level `certsCache` (`Map<teamDomain, { keys, fetchedAt }>`) and `unknownKidRefetchAt` (`Map<teamDomain, number>`), the latter claimed before the refetch is awaited.
- [ ] Step 4: Re-point `verifyConsentAccessJwt` at it: `claims !== null`, with an `onReject` that logs the reason.
- [ ] Step 5: Run `npx vitest run src/access-jwt.test.ts src/consent-video.test.ts`. Expected: PASS. `consent-video.test.ts` needs `__resetAccessCertsCacheForTests` in `afterEach` if the cache bleeds between tests.
- [ ] Step 6: Mutation-check each guard one at a time (iss, aud, exp, alg, kid, signature, cache TTL, miss-refetch limit, failure-not-cached). Each should turn exactly its test red. Restore from a `cp` backup.

### Task 2: verifyAdminAccess verifies the JWT

**Files:**
- Modify: `worker/src/index.ts` (`Env`: `ACCESS_TEAM_DOMAIN?`, `API_ACCESS_AUD?`; `verifyAdminAccess` and its header comment)
- Create: `worker/src/admin-access.test.ts` (through `worker.fetch`, as `human-decision.test.ts` does)
- Modify: `worker/src/human-decision.test.ts`, `worker/src/zendesk-sync.test.ts` (swap `'Cf-Access-Jwt-Assertion': 'test'` for `'X-Admin-Key'` plus `ADMIN_API_KEY` in env; these tests were never about auth)

- [ ] Step 1: Write failing tests. Probe with `GET /api/no-such-route`: it's past the gate, so authorized means 404 and refused means 401. Don't use `/api/info`, which is handled before the gate.
  - forged header (`'test'`, and a well-formed JWT signed by a key not in the certs) gets 401
  - valid JWT for `API_ACCESS_AUD` is authorized
  - valid JWT for a different audience (e.g. the consent app's) gets 401
  - `API_ACCESS_AUD` unset: a valid-looking JWT gets 401, and `console.error` names `API_ACCESS_AUD`
  - forged header plus correct `X-Admin-Key` is authorized
  - `/api/relay-rpc` POST with `MOD_RELAY_ADMIN_KEY` still authorized; the same key on another route still 401
  - certs fetch failing gets 401
- [ ] Step 2: Run the file. Expected: the forged-header and unset-audience cases FAIL against main's presence check.
- [ ] Step 3: Implement it: key checks first (unchanged). Then read `API_ACCESS_AUD` via `resolveSecret` inside a try/catch that refuses on error, and call `verifyAccessJwt(header, { teamDomain: env.ACCESS_TEAM_DOMAIN, audience, onReject })`. Update the function's comment to describe what is actually checked.
- [ ] Step 4: Update the two existing test files. Run `cd worker && npx vitest run`. Expected: all pass.
- [ ] Step 5: Mutation-check one at a time: the presence-only check restored; the audience argument swapped for the consent audience; the missing-config log removed; key paths removed. Each turns exactly its test red.

### Task 3: Config and rollout notes

**Files:**
- Modify: `worker/wrangler.staging.toml`, `worker/wrangler.prod.toml` (`ACCESS_TEAM_DOMAIN = "divinevideo.cloudflareaccess.com"`, plus a comment on the `API_ACCESS_AUD` secret: how to set it, and that without it Access logins are locked out)
- Modify: `worker/wrangler.local.toml` (comment only: unset locally, so use `X-Admin-Key`)
- Modify: `AGENTS.md` Security Model, item 1-2 (the worker now verifies the JWT)
- Modify: `DEPLOYMENT.md` (the new var and secret, set-before-deploy, troubleshooting an all-401 deploy)

- [ ] Step 1: At rollout, an Access admin stores each AUD tag in the team password manager and pipes it into `wrangler secret put API_ACCESS_AUD`. Do this before deploying the build.
- [ ] Step 1b: In the Cloudflare dashboard, confirm that no other Access application covers `api-relay-*` hostnames or paths. If one does, accept its AUD too, or route it before the check, as consent-video already is (pinned by a test in `admin-access.test.ts`).
- [ ] Step 2: Before any deploy, decode (don't log) the claims of one real staging JWT, and confirm its `aud` matches and which identity claim it carries (email vs `common_name`).
- [ ] Step 3: Rollout plan for the PR:
  1. Deploy to staging.
  2. Load the staging UI and do a read and one harmless write.
  3. Confirm a forged header gets 401 on staging.
  4. Check moderation-service relay-rpc on staging.
  5. Then prod, with the rollback version ID ready.

### Task 4: Verify

- [ ] `cd worker && npx vitest run`, `npm run typecheck`, `npm run test:d1` (run `age-review-handler.d1` separately on Mac), `npx tsc -p tsconfig.app.json --noEmit` and `npm run test` at the root (no frontend change expected, but confirm)
- [ ] Self-review loop with varied lenses until a round comes back clean
