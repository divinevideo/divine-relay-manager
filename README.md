# Divine Relay Manager

Divine Relay Manager is the internal content-moderation console for Divine's Nostr
relay infrastructure. Moderators use it to review reports, drill into the surrounding
conversation, run the minor-safety age-review workflow, and take relay-level moderation
actions. It ships as two deployables: a React/Vite single-page app on Cloudflare Pages
and a Cloudflare Worker API that signs and issues NIP-86 relay-management commands.
The app deploys under the name `divine-relay-admin`.

## Features

- **Reports queue** — the default view. Loads NIP-56 kind-1984 reports and, for each, pulls
  the reported event, its thread ancestors and replies, the target's profile and recent
  activity, and the reporter's filing history into a single review screen.
- **Moderation actions** — ban/allow events and pubkeys through the Worker's NIP-86 RPC.
  Actions record an append-only decision log and sync linked Zendesk tickets as a side effect.
- **Bulk moderation** — an async job model (enqueue, queue-consumer, status polling) for
  actioning an account's media at scale via Cloudflare Queues.
- **Age review** — the minor-safety workflow, including the Greenlight consent-funnel
  dashboard, protected-minor visibility, minor-account onboarding, and keycast integration.
- **Auto-hide** — a `ReportWatcher` Durable Object holds a persistent relay subscription to
  kind-1984 events and auto-hides high-priority reports from trusted apps unless a human has
  already reviewed the target.
- **Media preview** — extracts media URLs from events and, when direct load fails, falls back
  to an authenticated Blossom admin proxy so moderators can view blocked content.
- **AI context** — Hive AI and AI-detection reports, transcript analysis, scene
  classification, and Claude-powered user summaries to speed up review.
- **Events, Users, and Labels views** — browse relay events, inspect users, and publish
  NIP-32 (kind-1985) moderation labels.

## Architecture

Two components deploy and version independently:

```
Frontend (React/Vite on CF Pages)        Worker (Cloudflare Workers)
  |                                         |
  |-- CF Access (edge auth) -------------->|-- CF Access (edge auth)
  |-- direct relay WebSocket reads          |-- verifyAdminAccess() (defense-in-depth)
  |   (useThread, useAuthor, useUserStats)  |-- handleModerate() --> relay NIP-86 RPC
  |                                         |-- Zendesk ticket sync
  v                                         |-- media proxy (Blossom)
Nostr relay (Funnelcake)                    |-- ReportWatcher (Durable Object)
                                            v
                                          D1 (SQLite): decisions, targets, tickets, jobs
                                          Cloudflare Queues (bulk moderation)
```

The **frontend** reads directly from the relay over WebSocket for event, thread, and profile
data, and calls the Worker only for privileged actions. It's built with React 18, TypeScript,
Vite, TailwindCSS 3, shadcn/ui (Radix primitives), TanStack Query 5, and React Router. Nostr
integration uses `@nostrify/nostrify`, `@nostrify/react`, and `nostr-tools`.

The **Worker** holds the admin signing key and issues NIP-86 relay-management commands
(signing kind-27235 auth events). It persists moderation state in D1, runs the auto-hide
`ReportWatcher` as a Durable Object, and processes bulk jobs off a Cloudflare Queue. Relevant
NIPs: NIP-11 (relay info), NIP-19 (bech32 identifiers), NIP-32 (labels), NIP-56 (reports),
NIP-86 (relay management), and NIP-98 (HTTP auth).

Access is layered: Cloudflare Access enforces edge auth on both the frontend and API domains,
and the Worker independently re-verifies admin access (`verifyAdminAccess()`) as defense in
depth. Domains and bindings live in the `wrangler.*.toml` files and env files — treat those as
the source of truth rather than hardcoding URLs.

## Getting started

Requires Node.js 22.

```bash
npm run dev          # install deps and start the Vite dev server (http://localhost:5173)
npm run test         # type-check, lint, run Vitest, and build
npx tsc --noEmit     # type-check only
```

Worker development lives under `worker/`:

```bash
cd worker
npm run dev          # wrangler dev
npm run test:run     # worker unit tests
npm run typecheck    # tsc --noEmit
```

For the full local stack (Worker + Caddy HTTPS proxy + Vite), run `./scripts/dev-local.sh`.
It requires `mkcert` and `caddy` (`brew install mkcert caddy`, then `sudo mkcert -install`)
and reads local CF Access and admin-key values from `.env.local` and `worker/.dev.vars`. The
HTTPS proxy exists because the frontend runs over TLS and browsers block an HTTPS page from
fetching an HTTP endpoint.

## Configuration

There are two separate variable systems; they must stay in sync.

**Frontend (Vite).** Non-secret production and staging URLs are committed in `.env.production`
(`VITE_PROD_RELAY_URL`, `VITE_PROD_API_URL`, `VITE_STAGING_RELAY_URL`, `VITE_STAGING_API_URL`).
Copy `.env.example` to `.env.local` (gitignored) for secrets and local overrides:

| Variable | Purpose |
|----------|---------|
| `VITE_CF_ACCESS_CLIENT_ID` | CF Access service-token ID for reaching Access-protected APIs |
| `VITE_CF_ACCESS_CLIENT_SECRET` | CF Access service-token secret |
| `VITE_LOCAL_RELAY_URL` / `VITE_LOCAL_API_URL` | Optional local-dev endpoint overrides |
| `VITE_ADMIN_API_KEY` | Optional; local admin auth for `./scripts/dev-local.sh` |

`VITE_` values must be plaintext at build time, so they come from env files, not the encrypted
Pages dashboard secrets.

**Worker.** Vars (`RELAY_URL`, `CDN_DOMAIN`, `ALLOWED_ORIGINS`, `MANAGEMENT_PATH`,
`MODERATION_SERVICE_URL`, and others) live in `worker/wrangler.*.toml`. Secrets are set via
`wrangler secret put` or the Cloudflare dashboard and include `NOSTR_NSEC` (admin signing key),
`ANTHROPIC_API_KEY`, the CF Access and Zendesk credentials, and `BLOSSOM_WEBHOOK_SECRET`.
Secrets Store bindings resolve via `await binding.get()`, not as plain strings. Never commit
secrets. The wrangler configs are the authoritative list of vars and bindings per environment.

## Deployment

The frontend deploys to Cloudflare Pages and the Worker to Cloudflare Workers. There is **no
root worker `wrangler.toml`** — each Worker environment has its own config, and you must pass
`--config` explicitly. The root `wrangler.toml` configures only the Pages build output.

Deploy the Worker first, then the frontend back-to-back, because the two version independently
and there is no version negotiation between them:

```bash
# 1. Worker (staging, verify, then prod)
cd worker
npx wrangler deploy --config wrangler.staging.toml
npx wrangler deploy --config wrangler.prod.toml

# 2. Frontend (Cloudflare Pages)
npx vite build
npx wrangler pages deploy dist --project-name divine-relay-admin --branch main
```

Bulk moderation depends on a Cloudflare Queue that must exist before the first Worker deploy —
see `DEPLOYMENT.md` for queue creation, deploy ordering, and rollback details.

CI (`.github/workflows/test.yml`) runs the root test suite plus the Worker typecheck and tests
on every push and pull request to `main`. A separate workflow enforces Conventional Commit PR
titles.

---

Part of [Divine](https://divine.video) — your playground for human creativity · [Brand guidelines](https://github.com/divinevideo/brand-guidelines)
