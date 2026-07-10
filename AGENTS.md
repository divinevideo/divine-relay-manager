# Repository Guidelines

Divine Relay Admin is the content moderation UI and API for Divine's Nostr relay
infrastructure. It is an internal tool used by moderators to review reports, take
moderation actions, and manage relay state.

## Divine Context And Brain

Before broad product, architecture, protocol, cross-repo, or service-boundary work, read the shared Divine context primer.

Use `DIVINE_CONTEXT_ROOT` if set; otherwise look for `../divine-context`. If it is missing, try:

`gh repo clone divinevideo/divine-context ../divine-context`

The `divine-context` repo is private, so cloning requires GitHub access. If clone, network, or auth fails, continue from the local repo docs and avoid cross-repo assumptions.

Before updating an existing context checkout, verify it is clean and on its default branch. If it is clean and on the default branch, update it with `git -C <context-dir> pull --ff-only`. If it is dirty, on another branch, cannot fast-forward, or network/auth fails, leave it untouched and say the context may be stale.

Read `<context-dir>/AGENT_CONTEXT.md` and follow its instructions. If unavailable, continue from the local repo docs and avoid cross-repo assumptions.

If a Divine Brain search or ask tool is available, you may use it for company memory. Treat it as optional and credentialed: tool names vary by client, and work must continue when Brain is unavailable. When Brain results influence work, cite the returned document ids. Never commit Brain credentials or expose Brain-derived sensitive content in public PRs, issues, branch names, commit messages, code comments, logs, screenshots, release notes, or externally shared agent transcripts.

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
  |                                      |-- handleMediaProxy()
  |                                      |-- ReportWatcher (Durable Object)
  v                                      v
Funnelcake relay (GKE)               D1 (moderation_decisions, zendesk_tickets,
                                         moderation_targets)
                                     Zendesk API
                                     Blossom media server (Fastly)
                                     Moderation Service (CF Workers)
```

**Domains and environment config live in `wrangler.*.toml` files and `.env.local`.
Those are the source of truth. Do not hardcode domains in application code.**

## Project Structure & Module Organization
- Frontend application code lives under `src/`, including `components/`, `components/ui/`, `hooks/`, `lib/`, and `pages/`.
- Cloudflare Worker code lives under `worker/src/`, with tests colocated as `*.test.ts`.
- Environment and deploy configuration lives in `worker/wrangler.*.toml`, root `wrangler.toml`, and `.env.local` for Vite-only variables. Treat those files as the source of truth for domains and bindings.
- Supporting docs live in `README.md`, `DEPLOYMENT.md`, `CONTEXT.md`, `NIP.md`, and `docs/`.

Detailed layout:

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

## Technology Stack
- **Frontend**: React 18, TypeScript, Vite, TailwindCSS 3, shadcn/ui (Radix primitives), TanStack Query 5, React Router
- **Nostr**: @nostrify/nostrify, @nostrify/react (protocol framework), nostr-tools (NIP-19 encoding, event signing)
- **Worker**: Cloudflare Workers, D1 (SQLite), Durable Objects, Secrets Store
- **Tests**: Vitest (worker tests in `worker/src/*.test.ts`)

## Build, Test, and Validation Commands
- `npm run test`: primary repo test command.
- `npx tsc --noEmit`: frontend and shared type-check.
- `npx vite build`: frontend production build.
- `npx vite --port 8080`: frontend dev server.
- `cd worker && npx vitest run`: worker tests when touching worker code.
- `cd worker && npx wrangler dev --config wrangler.local.toml`: local worker development. Never deploy with local config.

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

## Coding Style & Naming Conventions
- Keep frontend and worker changes scoped. Do not mix unrelated UI, worker, relay-integration, and deployment cleanup in one PR.
- Follow the existing React, TypeScript, Tailwind, TanStack Query, and Cloudflare Worker patterns already established in the repo.
- Verify domains, bindings, and env var names against wrangler config files before introducing or changing URLs. Do not hardcode environment-specific domains in application code.

## Integration Contracts

### handleModerate() side effects

When a moderation action completes, `handleModerate()` triggers side effects:

| Side effect | Critical? | Failure behavior |
|-------------|-----------|------------------|
| Relay RPC (banevent/banpubkey/etc.) | **YES** | Return error to UI. Do not proceed. |
| `markHumanReviewed()` | No | Log error, continue. Prevents auto-hide from overriding human decisions. |
| `syncZendeskAfterAction()` | No | Log error, continue. Zendesk ticket state may lag. |

**Rules:**
- Critical side effects: `await`, return error on failure.
- Non-critical side effects: `await` inside try/catch, log errors, continue.
- **Never fire-and-forget.** Always `await`. Fire-and-forget masks failures and races with the response.
- **Never duplicate side effect calls.** Two targets need two explicit sequential calls.

### syncZendeskAfterAction()

- Looks up linked tickets in `zendesk_tickets` table by `event_id` or `author_pubkey`
- Only resolves tickets for actions in the `resolutionActions` array
- **When adding new moderation actions, check whether they should resolve tickets and add to `resolutionActions` if so.**

### handleMediaProxy()

- Proxies blocked media to moderators via Blossom's admin blob endpoint
- Requires `BLOSSOM_WEBHOOK_SECRET` Bearer auth and returns a clear 500 if the secret is unbound
- Uses `CDN_DOMAIN` from `wrangler.*.toml`, defaulting to `media.divine.video`
- Forwards `Range` requests and streams the upstream response body through without buffering

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

## Security & Operational Notes
- Never commit secrets, CF Access credentials, API keys, service tokens, or screenshots/logs containing sensitive values.
- Public issues, PRs, branch names, screenshots, and descriptions must not mention corporate partners, customers, brands, campaign names, or other sensitive external identities unless a maintainer explicitly approves it. Use generic descriptors instead.
- If touching moderation workflows, trace side effects carefully and avoid fire-and-forget behavior.

## D1 Schema

Schema is created on-demand via `ensureDecisionsTable()` and `ensureZendeskTable()` in the worker.

| Table | Purpose |
|-------|---------|
| `moderation_decisions` | Append-only decision log (action, reason, target, moderator, timestamp) |
| `moderation_targets` | Per-target state tracking (`ever_human_reviewed` prevents auto-hide override) |
| `zendesk_tickets` | Maps Zendesk ticket IDs to Nostr event IDs and pubkeys |

## Local Development

Full local stack: Wrangler worker + Caddy HTTPS proxy + Vite frontend.

### Prerequisites

```bash
brew install mkcert caddy
sudo mkcert -install          # one-time: trust the local CA
```

### One-time setup

1. Copy `.env.example` to `.env.local` and set the CF Access credentials
2. Add `VITE_ADMIN_API_KEY=osprey-local-dev-key` to `.env.local`
3. Create `worker/.dev.vars` with:
   ```
   NOSTR_NSEC=your-test-nsec
   ADMIN_API_KEY=osprey-local-dev-key
   ```

### Running

```bash
./scripts/dev-local.sh
```

This starts:
- **Worker** on `http://localhost:8787` (Wrangler dev with local D1 + Durable Objects)
- **Caddy HTTPS proxy** on `https://localhost:8788` (terminates TLS, forwards to worker)
- **Vite frontend** on `https://localhost:5173`

Select "Local" in the environment selector. The frontend sends `X-Admin-Key` header (from `VITE_ADMIN_API_KEY`) for admin auth since CF Access isn't available locally.

### Why HTTPS locally

The frontend runs on HTTPS (Vite's built-in TLS). Browsers block mixed content: an HTTPS page cannot fetch from an HTTP endpoint. Caddy on port 8788 terminates TLS with mkcert certs so `https://localhost:8788` proxies cleanly to the HTTP worker on 8787.

The same applies to the relay WebSocket: `wss://localhost:4443` proxies to `ws://localhost:4444`.

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

## Nostr Conventions

- **NIP-19**: Bech32 identifiers (`npub`, `note`, `nevent`). Use for display. Decode to hex for relay filters.
- **NIP-86**: Relay management API. Worker signs kind 27235 auth events and publishes management commands.
- **NIP-10**: Reply threading. Events have `root` and `reply` e-tags for ancestor traversal.
- **NIP-56**: Kind 1984 report events. Core input for the moderation queue.
- **NIP-32**: Kind 1985 label events. Published by the moderation service with AI classification results.
- **Kind 0**: Profile metadata. Fetched by `useAuthor` for display names and avatars.

## Pull Request Guardrails
- PR titles must use Conventional Commit format: `type(scope): summary` or `type: summary`.
- Set the correct PR title when opening the PR. Do not rely on fixing it later.
- If a PR title is edited after opening, verify that the semantic PR title check reruns successfully.
- Keep PRs tightly scoped. Do not include unrelated formatting churn, dependency noise, or drive-by refactors.
- Temporary or transitional code must include `TODO(#issue):` with a tracking issue.
- UI or externally visible API changes should include screenshots, sample payloads, or an explicit note that there is no visual change.
- PR descriptions must include a summary, motivation, linked issue, and manual validation plan.
- Before requesting review, run the relevant checks for the files you changed, or note what you could not run.
