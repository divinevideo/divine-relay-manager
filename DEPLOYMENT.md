# Divine Relay Manager - Deployment Guide

This application consists of two deployable components:

1. **Frontend** - React/Vite app deployed to Cloudflare Pages
2. **Worker** - Cloudflare Worker API for NIP-86 signing and relay management

## Prerequisites

- Cloudflare account with Pages and Workers access
- `wrangler` CLI installed (`npm install -g wrangler`)
- Authenticated to Cloudflare (`wrangler login`)

---

## Frontend Deployment (Cloudflare Pages)

### Environment Variables

Configure these in: **Cloudflare Dashboard → Pages → [project] → Settings → Environment variables**

| Variable | Description | Example |
|----------|-------------|---------|
| `VITE_RELAY_URL` | WebSocket URL of the Nostr relay | `wss://relay.divine.video` |

You can set different values per environment:
- **Production** (main branch): Your production relay
- **Preview** (other branches): Your staging/dev relay

### Deploy

Pages auto-deploys on push to connected repository. Manual deploy:

```bash
npm run build
npx wrangler pages deploy dist --project-name=divine-relay-admin
```

### Frontend artifact path

Root `public/` contains Vite static source files such as `_redirects` and
`manifest.json`. `npm run build` emits the deployable frontend artifact to
`dist/`, and the build script copies `dist/index.html` to `dist/404.html` for
SPA fallback routing. Cloudflare Pages deploys `dist/` per the root
`wrangler.toml`; the API Worker serves no static assets and has no asset
binding.

---

## Worker Deployment (Cloudflare Workers)

### Environment Variables

Configure in the `[vars]` section of the per-environment `worker/wrangler.local.toml`,
`worker/wrangler.staging.toml`, and `worker/wrangler.prod.toml`, or override in the
Cloudflare Dashboard. There is no root `worker/wrangler.toml`.

| Variable | Required | Description | Example |
|----------|----------|-------------|---------|
| `RELAY_URL` | Yes | WebSocket URL of the Nostr relay | `wss://relay.divine.video` |
| `MANAGEMENT_PATH` | No | Path for NIP-86 management API (default: `/management`) | `/` |
| `MODERATION_SERVICE_URL` | No | URL for media moderation service | `https://moderation-api.divine.video` |
| `ALLOWED_ORIGINS` | Yes | Comma-separated allowed CORS origins | `https://relay.admin.divine.video,*.pages.dev` |

### Secrets (must be set via CLI or Dashboard)

**Never commit these to the repository.**

| Secret | Description |
|--------|-------------|
| `NOSTR_NSEC` | Admin signing key in nsec format (`nsec1...`) |
| `ANTHROPIC_API_KEY` | API key for Claude user summarization feature |
| `CF_ACCESS_CLIENT_ID` | Cloudflare Access service token ID |
| `CF_ACCESS_CLIENT_SECRET` | Cloudflare Access service token secret |
| `ZENDESK_JWT_SECRET` | Shared secret for Zendesk JWT verification |
| `ZENDESK_WEBHOOK_SECRET` | Shared secret for Zendesk webhook signatures |

Set secrets via CLI:
```bash
cd worker
npx wrangler secret put NOSTR_NSEC --config wrangler.prod.toml
npx wrangler secret put ANTHROPIC_API_KEY --config wrangler.prod.toml
# ... etc
```

### Deploy

There is no default worker config, so `--config` is required on every command.
Never deploy with `wrangler.local.toml`.

```bash
cd worker
npm install
npx wrangler deploy --config wrangler.staging.toml   # staging
npx wrangler deploy --config wrangler.prod.toml      # production
```

---

## Environment Configurations

### Production (relay.divine.video)

**Frontend (Pages):**
```
VITE_RELAY_URL=wss://relay.divine.video
```

**Worker (`worker/wrangler.prod.toml`):**
```toml
[vars]
RELAY_URL = "wss://relay.divine.video"
MANAGEMENT_PATH = "/"
```

### Staging (relay.staging.divine.video)

**Frontend (Pages):**
```
VITE_RELAY_URL=wss://relay.staging.divine.video
```

**Worker (`worker/wrangler.staging.toml`):**
```toml
[vars]
RELAY_URL = "wss://relay.staging.divine.video"
MANAGEMENT_PATH = "/"
```

---

## Local Development

1. Copy `.env.example` to `.env.local`:
   ```bash
   cp .env.example .env.local
   ```

2. Edit `.env.local` with your development relay URL

3. Start dev server:
   ```bash
   npm run dev
   ```

4. For worker development:
   ```bash
   cd worker
   npx wrangler dev --config wrangler.local.toml
   ```

---

## Verifying Deployment

### Check Worker Configuration

```bash
curl https://api-relay-prod.divine.video/api/info
```

Expected response:
```json
{
  "success": true,
  "pubkey": "...",
  "npub": "npub1...",
  "relay": "wss://relay.divine.video"
}
```

### Test NIP-86 Management API

```bash
curl -X POST https://api-relay-prod.divine.video/api/relay-rpc \
  -H "Content-Type: application/json" \
  -d '{"method": "supportedmethods", "params": []}'
```

---

## Troubleshooting

### "Relay error: 404" on management calls
- Verify `MANAGEMENT_PATH` is set correctly (Funnelcake serves NIP-86 at `/`,
  which is what both deployed configs set; the worker's built-in default is
  `/management` and will 404 against Funnelcake)
- Check that the relay supports NIP-86

### CORS errors in browser
- Verify `ALLOWED_ORIGINS` includes your frontend domain
- For Pages preview deployments, include `*.divine-relay-admin.pages.dev`

### "Secret key not configured"
- Ensure `NOSTR_NSEC` is set via `wrangler secret put`
- Secrets don't appear in dashboard after setting (security feature)

### Admin pubkey not authorized
- Get pubkey from `/api/info` endpoint
- Ensure DevOps has added this pubkey to relay's admin list

## Bulk-moderate async job model (Cloudflare Queues) — deploy prerequisites

The async bulk-moderate feature adds a Cloudflare Queue (`BULK_QUEUE`) with producer
and consumer bindings in `worker/wrangler.{staging,prod}.toml`. **The queue must
exist before you deploy the worker** — `wrangler deploy` validates queue bindings
and fails (deploying nothing) if the queue is missing. There is no fallback to the
old synchronous path: `POST /api/bulk-moderate` returns 500 if `BULK_QUEUE` is unbound.

### One-time queue creation (per environment, before the first deploy)

```bash
cd worker
npx wrangler queues create bulk-moderate-jobs-staging
npx wrangler queues create bulk-moderate-jobs-prod
npx wrangler queues list   # verify
```

### Deploy order (worker BEFORE frontend)

The worker and the Pages frontend deploy separately, and there is no version
negotiation, so order matters and the gap should be minimized:

1. **Worker first.** `npx wrangler deploy --config wrangler.staging.toml` (verify), then prod.
   - Old frontend + new worker: the old UI expects a synchronous `BulkModerateResult`
     but gets `{jobId}` — bulk moderation misreports until the frontend catches up.
2. **Frontend second**, back-to-back. `npx vite build && npx wrangler pages deploy dist ...`.
   - New frontend + old worker: the UI polls `/api/bulk-moderate/status/:jobId` against
     a worker with no status route (404) — bulk moderation breaks until the worker catches up.

### Post-deploy verification

- `npx wrangler queues list` shows the prod queue with a consumer attached.
- **Use a throwaway test account for the checks below, in either environment.**
  Staging's worker uses production's moderation service and media server (its
  `MODERATION_API` service binding and `CDN_DOMAIN` in `wrangler.staging.toml` are
  the same as prod's), so a bulk action run from staging changes real production
  media.
- On a fresh test account, block one video first (Block Media on a report about it,
  or the file's page in moderation-service's admin), then run Age Restrict All.
  Confirm `{jobId}` returns, a queue-consumer log line fires (`npx wrangler tail`),
  and the job row reaches `done`. In Blossom the blocked video stays Banned and the
  others become AgeRestricted (18+ gate), and the result message counts 1 file left
  as it was. Delete All sets Deleted; the age-review withhold (`age-restrict-all`)
  sets Restricted.
- Bulk actions read each file's status from Blossom first, so the worker needs
  `BLOSSOM_WEBHOOK_SECRET` (prod and staging bind it). Without it every file fails
  with "could not read current status".
- `bulk_jobs` table is created on demand in the prod D1 (`divine-moderation-decisions-prod`),
  and its `media_skipped` column is added on demand to an existing table.

### Rollback

Rolling back to a build from before this async job model: revert the worker
deploy (`wrangler rollback` or redeploy the prior version). The `bulk_jobs` table
and the queue persist but go inert (that build has no producer/consumer). No data
cleanup required.

Rolling back past #290 (to any build that has the job model but not
`age-gate-all`): do not revert the worker first. Follow the steps below in order,
because an older worker reads `age-gate-all` as unknown and sends SAFE,
un-restricting the account's media. Stop those jobs rather than waiting for them:
both workers only pick up a job that is still `pending` or `running`, so a job
marked `failed` sends nothing more, even if its next message is still in the
queue.

1. **Roll the frontend back** and ask moderators to reload. The older UI sends
   `age-restrict-all`, which every worker handles; a tab still showing the newer
   UI keeps sending `age-gate-all` until it reloads.
2. **Note the time, list the unfinished `age-gate-all` jobs, and stop them.**
   Those accounts are part-way gated; finish them by hand afterwards with
   single-video Age Restrict (the older Users-page button hides instead).

   ```bash
   npx wrangler d1 execute divine-moderation-decisions-prod --remote --command \
     "SELECT job_id, pubkey FROM bulk_jobs WHERE action = 'age-gate-all' AND status IN ('pending', 'running');"
   npx wrangler d1 execute divine-moderation-decisions-prod --remote --command \
     "UPDATE bulk_jobs SET status = 'failed', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE action = 'age-gate-all' AND status IN ('pending', 'running');"
   ```

3. **Roll the worker back.** From then on it refuses `age-gate-all` at enqueue
   with a 400 ("Invalid action").
4. **Run step 2's two commands again** (keep the time you noted the first time),
   then check for jobs a stale tab queued between steps 2 and 3
   (replace `<step-2 time>` with a UTC time a minute before you ran step 2, in
   the stored format `YYYY-MM-DDTHH:MM:SS.000Z`). For any row, the older worker
   may have un-restricted that account's media: re-gate it by hand.

   ```bash
   npx wrangler d1 execute divine-moderation-decisions-prod --remote --command \
     "SELECT job_id, pubkey, status FROM bulk_jobs WHERE action = 'age-gate-all' AND created_at >= '<step-2 time>';"
   ```
