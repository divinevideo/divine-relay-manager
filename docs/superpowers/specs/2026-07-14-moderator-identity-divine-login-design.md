# moderator identity via divine-login — phase 1 design

Issue: #178. Scope: **phase 1 only** (login surface + attribution). Phases 2 (server-side token verification) and 3 (per-moderator NIP-98) are out of scope here and get their own spec/plan cycles.

## Motivation (verified)

Every moderation attribution in this tool reads `useCurrentUser`, and nothing renders a login surface (the `LoginArea` components exist but nothing has mounted them since December). Verified read-only against prod D1 on 2026-07-14, across all `moderation_decisions` rows:

| `moderator_pubkey` | rows | window |
|---|---|---|
| `null` (unattributed) | 2217 | 2026-01-27 → 2026-07-14 |
| `auto` (ReportWatcher) | 833 | 2026-02-20 → 2026-07-14 |
| `81549…cd2898` (shared worker admin key, bulk-moderate) | 45 | 2026-05-22 → 2026-07-09 |

Zero rows attributed to an individual human. PR #176's keycast audit actor and `UserManagement`'s `moderatorPubkey` both ride `useCurrentUser`, so they stay log-only/null until a login ships.

## The settled direction

Split the planes (settled with Daniel, 2026-07-14):

- **Access plane stays CF Access.** Workspace email gets a moderator into the tool; deprovisioning is one workspace cut. Unchanged.
- **Identity plane becomes divine-login (keycast).** Moderators sign in with their Divine account inside relay-admin via `@divinevideo/login` (OAuth2 + PKCE against `login.divine.video`). The app gets their Nostr pubkey and attributes actions to the acting human.
- **A keycast outage degrades attribution only** (log-only fallback, today's behavior), never tool access.

## What we build on, and what we own

Three layers, kept deliberately separate so we stay on divine-login's upgrade path instead of forking it:

1. **`@divinevideo/login` (npm SDK, v1.0.0, MIT) — depend on directly.** It owns the OAuth2+PKCE flow, PKCE material, token storage, **automatic refresh** (`getSessionWithRefresh`), expiry checks, and the REST RPC signer (`createRpc` → `DivineRpc` → `POST /api/nostr`). This is "using divine-login as intended." When it improves, we `npm update`.
2. **divine-web's app glue — do NOT copy.** `useDivineSession` refresh scheduling, the cross-subdomain `divine_jwt` cookie, multi-account precedence. These are divine-web-specific and unnecessary here.
3. **One thin adapter we own** — a small `NostrSigner` wrapper over the SDK's `DivineRpc`, because relay-manager's signer abstraction is `@nostrify`'s and the SDK ships no nostrify adapter *yet*. The future `@divinevideo/divine-signer` package is exactly this adapter; ours carries `TODO(#178): replace with divine-signer when published`.

Phase-1 attribution needs only `user.pubkey` (moderation actions are **worker-signed** via `useAdminApi`/`useAdminPublish`; the moderator pubkey travels as a plain field). `user.signer` is consumed by exactly one non-moderation feature — `EditProfileForm` (a moderator editing their own kind-0 profile + avatar upload). The adapter exists to keep that working; it is not on the critical path.

## Ratified decisions (issue #178 forks)

- **Integration shape:** SDK-direct, wired straight into `useCurrentUser`. No interaction with nostrify's (dormant) login store. Nothing in the live app populates that store today, so a parallel/precedence reconciliation is unneeded.
- **Admin gate:** none in phase 1. CF Access is the authorization gate. keycast exposes no `admin_role` token claim; `GET /api/admin/status` could resolve it server-side, but that adds a keycast-allowlist dependency and a confusing "CF Access let me in but login says not-admin" state for zero security benefit while CF Access already gates access. Real enforcement lands in phase 2.
- **Dormant auth:** delete the Finder-copy duplicate files only (`LoginArea 2.tsx`, `SignupDialog 2.tsx`, `SignupDialog 3.tsx`, `useLoggedInAccounts 2.ts`). Leave the real dormant `LoginDialog`/`SignupDialog`/`AccountSwitcher`/`LoginArea` in place (out of scope; marked "stable").

## Components (what we own)

| File | Role |
|---|---|
| `src/lib/divineLogin.ts` | Configures the SDK client (`createDivineClient`) as a singleton; exports `startLogin(returnPath)` (build authorize URL + full-page redirect), `completeLogin(url)` (parse callback + `exchangeCode`), `logout()`, and a `getSession`/`getSessionWithRefresh` accessor. Config: `serverUrl` from `VITE_DIVINE_LOGIN_URL` (default `https://login.divine.video`), `clientId = 'divine-relay-admin'`, `redirectUri = ${origin}/auth/callback`, `storage: localStorage`. |
| `src/lib/divineSigner.ts` | `DivineRpcSigner implements NostrSigner`: `getPublicKey`, `signEvent`, `nip04`, `nip44`, `getRelays` — each delegates to `client.createRpc(currentTokens)`. Closes over a *getter* for current tokens so refreshed tokens are picked up. Caches the resolved pubkey. `TODO(#178)` to replace with published `divine-signer`. |
| `src/hooks/useDivineSession.ts` | Owns session state. On mount, resolves current credentials via `getSessionWithRefresh()`; re-checks on `window` focus. Exposes `{ credentials, isResolving, startLogin, logout }`. Thin — the SDK does refresh/expiry. |
| `src/components/auth/DivineLoginButton.tsx` | The sign-in surface in the shell header (next to `EnvironmentSelector`). Signed-out → "Sign in"; signed-in → avatar/name + "Sign out". |
| `src/pages/AuthCallback.tsx` | Renders at `/auth/callback`: calls `completeLogin(window.location.href)`, then navigates to the stored return path (default `/reports`). Shows a spinner and a clear error state on failure. |

| File | Modification |
|---|---|
| `src/hooks/useCurrentUser.ts` | Source the current user from the divine-login session. If credentials exist, build the `DivineRpcSigner`, resolve its pubkey via an effect (RPC), and return `{ user: { pubkey, signer }, ...author }`. Expose a resolving flag so the UI does not flap between logged-out and logged-in while the pubkey resolves. Returns `user: undefined` when there is no session. |
| `src/AppRouter.tsx` | Add `<Route path="/auth/callback" element={<AuthCallback />} />` above the catch-all. |
| `src/components/RelayManager.tsx` | Mount `<DivineLoginButton />` in the header row. |
| `package.json` | Add `@divinevideo/login@^1.0.0`. |

## Data flow

```
moderator clicks "Sign in"
  → startLogin(returnPath): SDK getAuthorizationUrl (PKCE stored in localStorage) → window.location.assign(url)
  → login.divine.video OAuth2 (already holds a CF Access session cookie for relay.admin.divine.video)
  → redirect back to /auth/callback?code=…
  → AuthCallback: parseCallback → exchangeCode(code) → SDK persists StoredCredentials to localStorage → navigate(returnPath)
  → useDivineSession resolves credentials
  → useCurrentUser builds DivineRpcSigner, resolves pubkey via RPC getPublicKey (POST /api/nostr, Bearer access_token)
  → user.pubkey is now the moderator's hex pubkey

moderator restricts an age-review account (acceptance path)
  → AgeReviewDetail reads useCurrentUser().user?.pubkey
  → PATCH /api/age-review/cases/:id { state, moderator_pubkey } (worker validates canonical 64-hex)
  → worker persists moderator_pubkey on the CAS update AND forwards it as the keycast audit actor
```

The resolved pubkey **must be canonical lowercase 64-hex** — the worker rejects anything else (PR #176 validation). `DivineRpc.getPublicKey()` returns hex; we assert/normalize and treat a non-canonical value as unresolved.

## Error handling and degradation

- **login.divine.video down / exchange fails** → `completeLogin` throws; `AuthCallback` shows a clear error and a retry; the moderator keeps working unauthenticated (attribution null, log-only). **Access is unaffected** (CF Access). This is the "degrade attribution only" property.
- **Token expired, refresh fails** → session drops to logged-out; the sign-in button reappears; actions taken meanwhile are unattributed (existing behavior).
- **`getPublicKey` RPC fails** → treat as not-signed-in (`user: undefined`); never block a moderation action on identity resolution.

## Testing (TDD)

Unit/integration (vitest):
- `divineLogin.ts` — config assembly (clientId, `redirectUri` derived from origin, `serverUrl` from env with default); `startLogin`/`completeLogin`/`logout` against a mocked SDK.
- `divineSigner.ts` — `getPublicKey`/`signEvent`/`nip04`/`nip44` delegate to `createRpc` with the *current* token; pubkey caching; non-canonical pubkey handling.
- `useDivineSession.ts` — resolves on mount, `logout` clears, focus re-check.
- `useCurrentUser.ts` — yields `{ pubkey, signer }` when a session resolves; `undefined` with no session; resolving flag behavior; a non-hex `getPublicKey` result yields no user.
- `AuthCallback.tsx` — success (exchange → navigate) and error (clear message, no navigate).
- Attribution wiring already covered by #176's `AgeReviewDetail.test.tsx` (mocks `useCurrentUser`); no change needed there.

Acceptance (manual + Playwright, documented in the PR):
- From a **fresh browser profile**: sign in → the header shows the signed-in moderator → restrict an age-review account → verify `moderator_pubkey` persists on the case row and is forwarded as the keycast audit actor. This is the #176-review lesson: verify the real end-to-end path, not just the plumbing.

## Assumptions to verify (not asserted)

- **CF Access callback interplay:** the redirect back to `relay.admin.divine.video/auth/callback` passes CF Access because the moderator already holds a CF Access session cookie. Verify in staging.
- **CF Access IdP config** (Workspace vs email OTP) is **not documented in-repo**; the plane split assumes workspace email. Confirm with whoever manages CF Access. Does not block phase-1 code.
- **Open-OAuth acceptance:** an unregistered `client_id = 'divine-relay-admin'` is accepted by `login.divine.video` today (keycast falls back to any-HTTPS-redirect for unregistered clients). Verify against the staging login server early.

## External dependency (follow-up, not a blocker)

Register `divine-relay-admin` (client_id + `allowed_redirect_uris`) in keycast to get keycast#282 redirect hardening — a seed migration or `POST /api/admin/registered-clients` by a full admin. Owner: Daniel. Phase 1 ships without it (open OAuth).

## Out of scope

Phase 2 (worker verifies the token server-side, superseding the `Cf-Access-Jwt-Assertion` presence check), phase 3 (per-moderator NIP-98 signing), retiring the dormant manual login beyond dupe deletion, cross-subdomain SSO, multi-account.
