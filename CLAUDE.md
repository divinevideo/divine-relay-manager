# Divine Relay Admin

Content moderation UI and API for Divine's Nostr relay infrastructure. Internal tool used by moderators to review reports, take moderation actions, and manage relay state.

## Architecture

```
Frontend (React/Vite)                  Worker (Cloudflare Workers)
CF Pages                               CF Workers (staging + prod)
  |                                      |
  |-- CF Access (edge auth) ------------>|-- CF Access (edge auth)
  |-- Service Token headers              |-- verifyAdminAccess() (defense-in-depth)
  |                                      |
  |-- useThread, useAuthor, etc.         |-- handleModerate() --> relay RPC
  |   (direct relay WebSocket)           |-- syncZendeskAfterAction()
  |                                      |-- notifyBlossom()
  |                                      |-- ReportWatcher (Durable Object)
  v                                      v
Funnelcake relay (GKE)               D1 (moderation_decisions, zendesk_tickets,
                                         moderation_targets)
                                     Zendesk API
                                     Blossom media server (Fastly)
                                     Moderation Service (CF Workers)
```

**Domains and environment config live in `wrangler.*.toml` files and `.env.local`. Those are the source of truth. Do not hardcode domains in application code.**

## Build & Run

```bash
# Frontend
npx vite --port 8080          # dev server
npx vite build                # production build
npx tsc --noEmit              # type-check

# Worker
cd worker
npx wrangler dev --config wrangler.local.toml    # local dev
npx wrangler deploy --config wrangler.staging.toml
npx wrangler deploy --config wrangler.prod.toml

# Frontend deploy (Pages)
npx vite build && npx wrangler pages deploy dist --project-name divine-relay-admin --branch main

# Tests
cd worker && npx vitest run
```

**There is no `wrangler.toml`.** Each environment has its own config file:
- `wrangler.local.toml` -- local dev (legacy D1, no secrets store)
- `wrangler.staging.toml` -- staging deploy
- `wrangler.prod.toml` -- production deploy

Never deploy with the local config. Always pass `--config` explicitly.

## Integration Contracts

### handleModerate() side effects

When a moderation action completes, `handleModerate()` triggers side effects:

| Side effect | Critical? | Failure behavior |
|-------------|-----------|------------------|
| Relay RPC (banevent/banpubkey/etc.) | **YES** | Return error to UI. Do not proceed. |
| `markHumanReviewed()` | No | Log error, continue. Prevents auto-hide from overriding human decisions. |
| `syncZendeskAfterAction()` | No | Log error, continue. Zendesk ticket state may lag. |
| `notifyBlossom()` | No | Log error, continue. Media moderation state may lag. |

**Rules:**
- Critical side effects: `await`, return error on failure.
- Non-critical side effects: `await` inside try/catch, log errors, continue.
- **Never fire-and-forget.** Always `await`. Fire-and-forget masks failures and races with the response.
- **Never duplicate side effect calls.** Two targets need two explicit sequential calls.

### syncZendeskAfterAction()

- Looks up linked tickets in `zendesk_tickets` table by `event_id` or `author_pubkey`
- Only resolves tickets for actions in the `resolutionActions` array
- **When adding new moderation actions, check whether they should resolve tickets and add to `resolutionActions` if so.**

### notifyBlossom()

- POSTs to the Blossom media server admin moderation endpoint with Bearer token auth
- Payload: `{ sha256, action: "BLOCK"|"RESTRICT"|"APPROVE" }`
- Auth token is a per-worker secret (not in wrangler config)

### ReportWatcher (Durable Object)

- Maintains persistent WebSocket to relay, subscribes to kind 1984 (report) events
- Auto-hides reported content when: category matches high-priority list AND client tag is from a trusted app AND target hasn't been human-reviewed
- Dedup: checks `moderation_decisions` table before acting
- Health check: cron trigger every 5 minutes, internal heartbeat every 30 seconds
- Known limitation: same-second concurrent reports can bypass dedup (idempotent, no user impact)

## Frontend Data Flow

The frontend connects directly to the relay via WebSocket for reading events. It calls the worker API for moderation actions.

### Report loading hooks

```
useReportContext(report)
  |-- useThread(eventId)         -- event + ancestors + replies from relay
  |-- useAuthor(targetPubkey)    -- kind 0 profile metadata
  |-- useUserStats(targetPubkey) -- recent posts, labels, reports
  |-- useAuthor(reporterPubkey)  -- reporter profile
  |-- reporterStats query        -- reporter's filing history
```

All relay queries are subject to network latency (500ms-2s per round-trip). Use `staleTime` on TanStack Query hooks to cache across report navigation.

### Media URL handling

- Events may contain media URLs in `imeta` tags, `url` tags, or inline in `content`
- `MediaPreview` extracts URLs, tries direct load, falls back to authenticated proxy (`/api/media-proxy/{sha256}`)
- The proxy uses `CDN_DOMAIN` env var with admin bypass auth
- If both direct and proxy fail, shows a warning indicator

## Security Model

### Authentication layers

1. **CF Access** (edge): Enforced on frontend and API domains. Unauthenticated requests never reach the worker.
2. **Worker auth** (`verifyAdminAccess()`): Checks for CF Access JWT or API key header. Defense-in-depth.
3. **Zendesk endpoints**: Exempt from admin auth. Use HMAC signature verification (webhooks) or JWT validation (mobile SDK).

### Secrets

Secrets are configured as per-worker secrets or via Cloudflare Secrets Store bindings. See wrangler configs for binding names.

**Secrets Store bindings are NOT plain strings.** They are `SecretStoreSecret` objects requiring `await binding.get()`. Pattern:
```typescript
const value = typeof env.X === 'string' ? env.X : await env.X.get();
```

**VITE_ env vars** must be plaintext at build time. Set in `.env.local` (gitignored). CF Pages dashboard secrets are encrypted and invisible to Vite's build process.

## D1 Schema

Schema is created on-demand via `ensureDecisionsTable()` and `ensureZendeskTable()` in the worker.

| Table | Purpose |
|-------|---------|
| `moderation_decisions` | Append-only decision log (action, reason, target, moderator, timestamp) |
| `moderation_targets` | Per-target state tracking (`ever_human_reviewed` prevents auto-hide override) |
| `zendesk_tickets` | Maps Zendesk ticket IDs to Nostr event IDs and pubkeys |

## Gotchas

### Funnelcake admin key alignment

The worker's signing key (from Secrets Store) must derive the same pubkey that the relay recognizes as admin. Mismatch causes 403 on all NIP-86 management commands, which the UI shows as generic action failures.

### Environment variables

Two separate env var systems:
- **Worker** (`wrangler.*.toml`): `RELAY_URL`, `CDN_DOMAIN`, `ALLOWED_ORIGINS`, etc.
- **Frontend** (`.env.local`): `VITE_PROD_RELAY_URL`, `VITE_PROD_API_URL`, etc.

These must stay in sync. The frontend environment selector reads VITE_ vars to determine available environments.

## Before Making Changes

### Always do first
- Read the file(s) you're modifying. Don't assume current state.
- Check `wrangler.staging.toml` and `wrangler.prod.toml` for env vars and bindings.
- Run `npx tsc --noEmit` after edits.
- If touching `handleModerate()`: trace ALL side effects. Verify none are duplicated and none are fire-and-forget.
- If touching media URLs or external service calls: verify domains against wrangler config env vars.

### Verify, don't assume
- **Hardcoded URLs**: Check against wrangler configs. Never hardcode domains in application code.
- **Side effect completeness**: Every external service call must handle its response. No fire-and-forget.
- **Duplicate code paths**: Two calls to the same service with different parameters is probably a bug.
- **TanStack Query options**: Hooks without `staleTime` refetch on every mount, which matters when navigating between reports.
- **Auth boundaries**: CF Access at the edge does not replace worker-level validation.

## Technology Stack

- **Frontend**: React 18, TypeScript, Vite, TailwindCSS 3, shadcn/ui (Radix primitives), TanStack Query 5, React Router
- **Nostr**: @nostrify/nostrify, @nostrify/react (protocol framework), nostr-tools (NIP-19 encoding, event signing)
- **Worker**: Cloudflare Workers, D1 (SQLite), Durable Objects, Secrets Store
- **Tests**: Vitest (worker tests in `worker/src/*.test.ts`)

## Project Structure

```
src/
  components/       -- UI (ReportDetail, ThreadContext, MediaPreview, EventDetail, etc.)
  components/ui/    -- shadcn/ui primitives
  hooks/            -- Data fetching (useThread, useAuthor, useUserStats, useReportContext, useModerationStatus)
  lib/              -- Utilities (adminApi, constants, environment config)
  pages/            -- Page components
worker/
  src/index.ts      -- Worker entry point (routes, handleModerate, RPC handlers)
  src/ReportWatcher.ts -- Durable Object for report monitoring and auto-hide
  src/*.test.ts     -- Worker tests
  wrangler.*.toml   -- Per-environment config (source of truth for domains and env vars)
.env.local          -- Frontend env vars (gitignored)
```

## Nostr Conventions

- **NIP-19**: Bech32 identifiers (`npub`, `note`, `nevent`). Use for display. Decode to hex for relay filters.
- **NIP-86**: Relay management API. Worker signs kind 27235 auth events and publishes management commands.
- **NIP-10**: Reply threading. Events have `root` and `reply` e-tags for ancestor traversal.
- **NIP-56**: Kind 1984 report events. Core input for the moderation queue.
- **NIP-32**: Kind 1985 label events. Published by the moderation service with AI classification results.
- **Kind 0**: Profile metadata. Fetched by `useAuthor` for display names and avatars.

## Cross-Repo Coordination

This repo is **Layer 1** in the auto-hide evolution plan. Read the coordination doc at session start:
`~/code/support-trust-safety/docs/moderation/auto-hide-evolution-plan.md`

When you make decisions or discover constraints that affect other layers, update that doc and flag it for the user.
