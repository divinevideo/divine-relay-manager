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
   - **A plain `wrangler deploy`, never a gradual or percentage rollout** (#299).
     A job's media messages from this worker and the one before it read
     differently: each restarts the other's file walk. With one version serving
     the queue that costs at most one restart per job, but with both serving it a
     job can restart on every message until its page bound.
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
  or the file's page in moderation-service's admin), wait five minutes, then run
  Age Restrict All. Blossom caches a file's status for up to five minutes per
  location, so a run straight after the block can read the blocked video as active
  and report a status disagreement for it instead of leaving it alone.
  Confirm `{jobId}` returns, a queue-consumer log line fires (`npx wrangler tail`),
  and the job row reaches `done`. In Blossom the blocked video stays Banned and the
  others become AgeRestricted (18+ gate), and the result message counts 1 file left
  as it was. Delete All sets Deleted; the age-review withhold (`age-restrict-all`)
  sets Restricted.
- Bulk actions read each file's status from Blossom first, and (#299) the
  account's file list from Blossom's admin API, so the worker needs
  `BLOSSOM_WEBHOOK_SECRET` (prod and staging bind it). Without it the job records
  a failure saying it could not list the account's files, and every file fails
  with "could not read current status".
- `bulk_jobs` table is created on demand in the prod D1 (`divine-moderation-decisions-prod`),
  and its `media_skipped` and `kind` columns are added on demand to an existing table.
- **Delete by kind (#289).** Open Bulk Delete by Kind on a throwaway account, check
  that its per-kind counts match the account, delete one kind, and confirm the job
  row reaches `done`. Delete by kind touches only the relay of the environment it
  runs in, never media, so unlike the Age Restrict All check, a staging run does
  not change production files.
- **Files found through the media server (#299).** On a throwaway test account
  (the caveat above applies: staging changes production media):
  1. post a video from the account;
  2. ban the account (Ban User), so the relay and funnelcake hide its videos;
  3. run Delete All Content on it;
  4. confirm the job row reaches `done` with `media_processed` of at least 1, and
     that Blossom shows the video Deleted. Before #299 this job ended `done` with
     no media processed, and the file stayed.

  Optionally confirm the notes table exists:
  `npx wrangler d1 execute divine-moderation-decisions-prod --remote --command "SELECT COUNT(*) FROM bulk_job_notes;"`.
- **Results to look at (#299).** Files a bulk action left for a person (videos a
  clear left hidden, other accounts' files) are notes, not failures. They are kept
  in the `bulk_job_notes` table, created on demand in the same D1 as `bulk_jobs`:
  a queued job's under its job id, and an age-review transition's under
  `age-review:<case id>:<case version>:<state>` (the expiry cron's auto-delete
  too), with that transition's failure lines beside them. Keeping age review's
  results never fails or alters the transition. A case's kept results are
  deleted with the case by retention's case-delete stage, under the same hold.
- **Restore's account check (#299).** A note's Restore sends the account's pubkey
  to `/api/moderate-media` with its SAFE and `from: 'QUARANTINE'`. When a pubkey is
  sent, the worker refuses while that account has an open age review, or unless
  the media server records it as the file's owner (both fail closed). It also
  refuses a file the media server shows as blocked, deleted or behind the 18+
  gate, which SAFE would make public, and names that status on the row. It marks
  the file's notes restored when the restore lands, or when the record is already
  public and the media server serves the file too; a public record over a file the
  media server still hides is refused and named on the row. Callers that send no
  pubkey (COOP, the per-post buttons) are unchanged. An older worker ignores the
  pubkey, so the `from` check is the only one it applies.
- **Known limits (#299), not fixed by it:**
  - Some files the media server holds are outside the videos-only filter and are
    not changed. Tracked privately.
  - The media server's list of an account's files is not paged
    (divinevideo/divine-blossom#309). A large account is slow to list, and past
    the worker's timeout the job falls back to funnelcake's list and records a
    failure line saying so.
  - The media server's list can leave files out without saying so
    (divinevideo/divine-blossom#308). The end-of-walk check finds some of them on
    a later read.
  - Blossom caches a file's status for up to 5 minutes per location. Right after a
    change, Un-age-restrict All can name a file as still hidden that a restore just
    made active, or end with no note while a file the withhold just hid is still
    hidden. For the same reason, a Restore of a file just made public elsewhere can
    be refused as "the media server shows this file as hidden" for a few minutes;
    a later Restore marks it. And for up to 5 minutes after a block, delete or
    18+ gate set in the media server's own admin, a Restore can still read the
    old status and go through.
  - Counts only, nothing left unchanged: a file that only funnelcake's video list
    shows, and that was already at the action's result before the job, is not
    counted as left as it was. The count can be lower than the previous worker's.
    When a media-server list read fails, the count can also be low or doubled,
    and the job's warning says the count may be off.
  - Counts only: a media-only job (Age Restrict All) that the previous worker
    started and this one finishes, across a forward deploy, shows inflated counts.
    This worker restarts the file walk, so it counts the first page's events again
    and counts the files the previous worker already changed as left as they were.
    The files themselves all end changed.
  - The expiry cron closes and bans every expired case before any auto-delete. An
    invocation that ends after a case is closed and before its auto-delete
    finishes, for example at a CPU or time limit, leaves that case's files in
    place. Its case screen keeps an 'Auto-delete was not confirmed' line,
    unless that line itself could not be stored, or that tick could not read
    the age-review config, and nothing retries the delete. #319 tracks
    running the cron's delete as a queued job and recovering a lost one.

### Rollback

Rolling back to a build from before this async job model: revert the worker
deploy (`wrangler rollback` or redeploy the prior version). The `bulk_jobs` table
and the queue persist but go inert (that build has no producer/consumer). No data
cleanup required, except for unfinished delete-kind jobs (see "Rolling back past
#289" below).

Rolling back past #289 (to any build without delete by kind): either order is
safe.

- **Worker first:** the newer dialog gets a 404 from
  `GET /api/bulk-moderate/kind-counts`, so it shows the count error and keeps
  Delete off, and a `delete-kind` enqueue gets a 400.
- **Frontend first:** the older dialog deletes event by event from the browser,
  against any worker.

Either way, stop the unfinished `delete-kind` jobs after the worker rollback. The
older worker acknowledges their queued messages and does nothing, and only a
status read marks a stale job failed, which the older dialog never makes, so
those rows would otherwise stay `running`. Note the listed (pubkey, kind) pairs:
each account is part-way through deleting that kind. Re-run those deletes after
the roll-forward.

```bash
npx wrangler d1 execute divine-moderation-decisions-prod --remote --command \
  "SELECT job_id, pubkey, kind FROM bulk_jobs WHERE action = 'delete-kind' AND status IN ('pending', 'running');"
npx wrangler d1 execute divine-moderation-decisions-prod --remote --command \
  "UPDATE bulk_jobs SET status = 'failed', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE action = 'delete-kind' AND status IN ('pending', 'running');"
```

Rolling back past #299 (finding files through the media server). First list the
jobs a rollback can leave unfinished:

```bash
npx wrangler d1 execute divine-moderation-decisions-prod --remote --command \
  "SELECT job_id, pubkey, action FROM bulk_jobs WHERE action IN ('delete-all', 'age-gate-all') AND status IN ('pending', 'running');"
```

For each listed job, either wait for it to finish, or note its account and re-run
the action after the roll-forward. The older worker would finish such a job on
funnelcake's video list, which hides what these jobs act on, and end it `done`
with no failures while files remain:
- a Delete All in its media phase deletes none of the files of the events it
  already banned (the row does not record its phase, so treat every listed Delete
  All as in it);
- an Age Restrict All on a banned or suspended account leaves the rest of its
  files ungated.

Run the SELECT again immediately before the rollback: a job can start between
the first check and the deploy. Then roll the worker back to the version deployed
before this one, with a plain deploy as above. #299's cross-version tests were
run against `028e0ac` (#294). main's changes after it, up to `6b53be1` (#330),
touch neither `worker/src/bulk-moderate.ts` nor `shared/bulk-moderation.ts`, so
any build in that range pairs the same way; if the version before this one is
another build, ask #299's author before rolling back past it. Apart from the
jobs above, each worker reads the other's queue messages (the older one ignores
the new fields), and nothing else needs stopping or cleaning up. The
`bulk_job_notes` table stays and the older worker never reads it. Restore's
account check is gone with it: only `from` is checked.

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
   If the target build also predates #289, list and stop the unfinished
   `delete-kind` jobs here too, with the two commands under "Rolling back past
   #289" above, and note their (pubkey, kind) pairs to re-run after the
   roll-forward.

4. **Run step 2's two commands again** (keep the time you noted the first time),
   then check for jobs a stale tab queued between steps 2 and 3
   (replace `<step-2 time>` with a UTC time a minute before you ran step 2, in
   the stored format `YYYY-MM-DDTHH:MM:SS.000Z`). For any row, the older worker
   may have un-restricted that account's media, including files previously
   blocked or hidden. Restore each file's prior restriction from pre-rollback
   state or verified moderation history; applying the 18+ gate to everything
   is not enough. The current moderation record may already reflect the
   rollback's un-restrict action, so do not use it alone to infer the prior
   decision. If that decision cannot be established, keep the file withheld
   until a moderator determines the appropriate restriction.

   ```bash
   npx wrangler d1 execute divine-moderation-decisions-prod --remote --command \
     "SELECT job_id, pubkey, status FROM bulk_jobs WHERE action = 'age-gate-all' AND created_at >= '<step-2 time>';"
   ```
