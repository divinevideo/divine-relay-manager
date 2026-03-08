# Divine Relay Admin

Content moderation UI and API for Divine's Nostr relay infrastructure. This is an internal tool used by moderators to review reports, take moderation actions, and manage relay state.

## Architecture

```
Frontend (React/Vite)                  Worker (Cloudflare Workers)
CF Pages                               CF Workers (staging + prod)
  |                                      |
  |-- CF Access (edge auth) ------------>|-- CF Access (edge auth)
  |-- Service Token headers              |-- verifyAdminAccess() (belt-and-suspenders)
  |                                      |
  |-- useThread, useAuthor, etc.         |-- handleModerate() --> relay RPC
  |   (direct relay WebSocket)           |-- syncZendeskAfterAction()
  |                                      |-- notifyBlossom()
  |                                      |-- ReportWatcher (Durable Object)
  v                                      v
Funnelcake relay (GKE)               D1 (moderation_decisions, zendesk_tickets)
                                     Zendesk API
                                     Blossom media server (Fastly)
                                     Moderation Service (CF Workers)
```

**Domains, endpoints, and environment config live in `wrangler.*.toml` files and `.env.local`. Those are the source of truth. Do not hardcode domains in application code without checking them.**

## Build & Run

```bash
# Frontend
npx vite --port 8080          # dev server
npx vite build                # production build
npx tsc --noEmit              # type-check

# Worker
cd worker
npx wrangler dev              # local dev
npx wrangler deploy --config wrangler.staging.toml
npx wrangler deploy --config wrangler.prod.toml

# Frontend deploy (Pages)
npx vite build && npx wrangler pages deploy dist --project-name divine-relay-admin --branch main

# Tests
cd worker && npx vitest run
```

## Integration Contracts

### handleModerate() side effects

When a moderation action completes, `handleModerate()` triggers side effects:

| Side effect | Critical? | Contract | Failure behavior |
|-------------|-----------|----------|------------------|
| Relay RPC (banevent/banpubkey/etc.) | **YES** | Must succeed or action fails. Return error to UI. | Return 500, do not proceed. |
| `markHumanReviewed()` | No | Best-effort. Prevents auto-hide from overriding human decisions. | Log error, continue. UI still shows success. |
| `syncZendeskAfterAction()` | No | Best-effort. Updates linked Zendesk tickets. | Log error, continue. Moderator sees success. |
| `notifyBlossom()` | No | Best-effort. Forwards moderation state to media server. | Log error, continue. Media state may lag. |

**Rules for side effects:**
- Critical side effects: `await`, return error on failure, do NOT return success to UI.
- Non-critical side effects: `await` inside try/catch, log errors, continue to success response.
- **Never fire-and-forget** non-critical side effects. Always `await` so the operation completes before the response. Fire-and-forget masks failures and can race with the response.
- **Never duplicate side effect calls.** If an action needs to sync both an event target and a pubkey target, make two explicit sequential calls, not two overlapping calls with fallback logic.

### syncZendeskAfterAction()

- Looks up linked tickets in `zendesk_tickets` table by `event_id` or `author_pubkey`
- Only resolves tickets for actions in the `resolutionActions` array (see Gotchas below)
- Posts internal note with action details, then transitions ticket status
- **Both event and pubkey targets may have linked tickets.** When a `ban_pubkey` action includes an `eventId`, sync both targets explicitly.

### notifyBlossom()

- POSTs to the Blossom admin moderation endpoint with Bearer token auth
- Payload: `{ sha256, action: "BLOCK"|"RESTRICT"|"APPROVE" }`
- Auth: `BLOSSOM_WEBHOOK_SECRET` (per-worker secret, NOT in wrangler.toml)

### ReportWatcher (Durable Object)

- Subscribes to relay WebSocket, watches for kind 1984 (report) events
- Auto-hides reported events when: category is high-priority AND client tag is from a trusted app AND target hasn't been human-reviewed
- Dedup: checks `moderation_decisions` table before acting (known race condition with same-second concurrent reports)

## Frontend Data Flow

The frontend connects directly to the relay via WebSocket for reading events. It calls the worker API for moderation actions.

### Report loading hooks (performance-sensitive path)

```
useReportContext(report)
  |-- useThread(eventId)         -- fetches event + ancestors + replies from relay
  |-- useAuthor(targetPubkey)    -- kind 0 profile lookup
  |-- useUserStats(targetPubkey) -- recent posts, labels, reports
  |-- useAuthor(reporterPubkey)  -- reporter profile
  |-- reporterStats query        -- reporter's filing history
```

**All relay queries are subject to network latency.** The relay can take 500ms-2s per round-trip. Minimize sequential queries. Use `staleTime` on TanStack Query hooks to cache across report navigation.

### Media URL handling

- Events may contain media URLs in `imeta` tags, `url` tags, or inline in `content`
- `MediaPreview` extracts URLs, tries direct load, falls back to authenticated proxy (`/api/media-proxy/{sha256}`)
- The proxy uses `CDN_DOMAIN` env var with admin bypass auth
- If both direct and proxy fail, shows warning triangle (media genuinely missing)
- **Verify media URLs point to the correct domain.** Check `CDN_DOMAIN` in wrangler configs. Third-party or deprecated media domains must not appear in application code.

## Security Model

### Authentication layers

1. **CF Access** (edge): Enforced on frontend and API domains. Frontend uses Service Token. Unauthenticated requests never reach the worker.
2. **Worker auth** (`verifyAdminAccess()`): Checks for `Cf-Access-Jwt-Assertion` header or `X-Admin-Key` header. Defense-in-depth backup.
3. **Zendesk endpoints**: Exempt from admin auth, use their own auth (HMAC signature verification for webhooks, callback key for JWT endpoint).

### Secrets

Secrets are configured as per-worker secrets or via Cloudflare Secrets Store bindings. See wrangler configs for binding names.

**Secrets Store bindings are NOT plain strings.** They are `SecretStoreSecret` objects requiring `await binding.get()`. Pattern: `typeof env.X === 'string' ? env.X : await env.X.get()`

**VITE_ env vars** must be plaintext at build time (not CF Pages secrets). Set in `.env.local` (gitignored). CF Pages dashboard only manages encrypted secrets, which are invisible to Vite's build.

## Gotchas

### Zendesk sync resolution actions

**Resolution actions must be explicitly listed.** `syncZendeskAfterAction()` only resolves Zendesk tickets for actions in the `resolutionActions` array. When adding new moderation actions, add them here if they should resolve tickets.

### Funnelcake admin key alignment

The worker's `NOSTR_NSEC` must match the relay's admin pubkey. Mismatch causes 403 on all NIP-86 management commands (ban, delete, etc.), which the UI shows as "Failed to ban user."

## Before Making Changes

### Always do first
- Read the file(s) you're modifying. Don't assume current state from memory.
- Check `wrangler.staging.toml` and `wrangler.prod.toml` for env vars and bindings relevant to your change.
- Run `npx tsc --noEmit` after edits.
- If touching `handleModerate()`: trace ALL side effects and verify none are duplicated, none are fire-and-forget, and critical vs non-critical classification is correct.
- If touching media URLs or external service calls: verify domains against wrangler config env vars.

### Ask for context when
- You're unsure which external service a feature integrates with, or what domain/endpoint to use.
- A side effect's criticality isn't clear (should failure block the action or just log?).
- You're adding a new moderation action and need to know if it should resolve Zendesk tickets.
- You need to understand a moderator workflow (what does the moderator actually do with this feature?).
- You're touching auth paths and need to understand the trust boundary.
- You need user stories or operational context to inform a design decision.

### Verify, don't assume
- **Hardcoded URLs/domains**: Check against wrangler configs. Libraries ship with example/default URLs that must be replaced with project infrastructure.
- **Side effect completeness**: If a function calls an external service, verify it handles the response. Not fire-and-forget.
- **Duplicate code paths**: If something is called twice with different parameters, that's probably a bug. Ask why before preserving it.
- **TanStack Query options**: Hooks without `staleTime` refetch on every mount. This matters when users navigate between reports.
- **Auth boundaries**: CF Access protects at the edge, but the worker must not assume CF Access is the only gate. Defense-in-depth means the worker validates independently.

## Technology Stack

- **Frontend**: React 18, TypeScript, Vite, TailwindCSS 3, shadcn/ui (Radix UI primitives), TanStack Query, React Router
- **Nostr**: @nostrify/nostrify + @nostrify/react (protocol framework), nostr-tools (NIP-19 encoding, event finalization)
- **Worker**: Cloudflare Workers, D1 (SQLite), Durable Objects, Secrets Store
- **Tests**: Vitest (worker tests in `worker/src/*.test.ts`)

## Project Structure

- `/src/components/` -- UI components (ReportDetail, MediaPreview, ThreadContext, etc.)
  - `/src/components/ui/` -- shadcn/ui primitives
- `/src/hooks/` -- Data fetching hooks (useThread, useAuthor, useUserStats, useReportContext, etc.)
- `/src/lib/` -- Utilities (adminApi with `getApiHeaders()`, constants)
- `/src/pages/` -- Page components
- `/worker/src/index.ts` -- Worker entry point (routes, handleModerate, RPC handlers, ReportWatcher)
- `/worker/src/*.test.ts` -- Worker tests
- `/worker/wrangler.*.toml` -- Per-environment worker config (source of truth for domains and env vars)
- `.env.local` -- Frontend env vars (gitignored)

## Nostr Conventions

- **NIP-19 identifiers** (`npub`, `note`, `nevent`, `naddr`): Use for display and URLs. Decode to hex for relay filters.
- **NIP-86**: Relay management API. Worker signs management events with admin key and publishes to relay.
- **NIP-10**: Reply threading. Events have `root` and `reply` e-tags pointing to thread ancestors. Used by `useThread` for context.
- **Kind 1984**: Report events (NIP-56). The core input for the moderation queue.
- **Kind 1985**: Label events (NIP-32). Published by moderation service with AI classification results.
- **Kind 0**: Profile metadata. Fetched by `useAuthor` for display names and avatars.

## Writing Tests

Only create tests when explicitly requested or when diagnosing a specific problem. Worker tests use Vitest with the `TestApp` component providing context providers. Focus testing on auth paths, data mutation logic, and edge cases in ReportWatcher.
