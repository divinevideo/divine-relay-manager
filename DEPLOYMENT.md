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
| `VITE_RELAY_URL` | WebSocket URL of the Nostr relay | `wss://relay.dvines.org` |

You can set different values per environment:
- **Production** (main branch): Your production relay
- **Preview** (other branches): Your staging/dev relay

### Deploy

Pages auto-deploys on push to connected repository. Manual deploy:

```bash
npm run build
npx wrangler pages deploy dist --project-name=divine-relay-admin
```

---

## Worker Deployment (Cloudflare Workers)

### Environment Variables

Configure in `worker/wrangler.toml` `[vars]` section or override in Cloudflare Dashboard.

| Variable | Required | Description | Example |
|----------|----------|-------------|---------|
| `RELAY_URL` | Yes | WebSocket URL of the Nostr relay | `wss://relay.dvines.org` |
| `MANAGEMENT_PATH` | No | Path for NIP-86 management API (default: `/management`) | `/management` |
| `MODERATION_SERVICE_URL` | No | URL for media moderation service | `https://moderation.admin.divine.video` |
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
wrangler secret put NOSTR_NSEC
wrangler secret put ANTHROPIC_API_KEY
# ... etc
```

### Deploy

```bash
cd worker
npm install
wrangler deploy
```

---

## Environment Configurations

### Production (relay.dvines.org)

**Frontend (Pages):**
```
VITE_RELAY_URL=wss://relay.dvines.org
```

**Worker (wrangler.toml):**
```toml
[vars]
RELAY_URL = "wss://relay.dvines.org"
MANAGEMENT_PATH = "/management"
```

### Staging (relay.divine.video)

**Frontend (Pages):**
```
VITE_RELAY_URL=wss://relay.divine.video
```

**Worker (wrangler.toml):**
```toml
[vars]
RELAY_URL = "wss://relay.divine.video"
MANAGEMENT_PATH = "/management"
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
   wrangler dev
   ```

---

## Verifying Deployment

### Check Worker Configuration

```bash
curl https://relay.admin.divine.video/api/info
```

Expected response:
```json
{
  "success": true,
  "pubkey": "...",
  "npub": "npub1...",
  "relay": "wss://relay.dvines.org"
}
```

### Test NIP-86 Management API

```bash
curl -X POST https://relay.admin.divine.video/api/relay-rpc \
  -H "Content-Type: application/json" \
  -d '{"method": "supportedmethods", "params": []}'
```

---

## Troubleshooting

### "Relay error: 404" on management calls
- Verify `MANAGEMENT_PATH` is set correctly (Funnelcake uses `/management`)
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
