# Funnelcake REST API Reads for Relay Admin Tool

**Date:** 2026-03-15
**Status:** Design
**Branch:** `feat/funnelcake-rest-reads`

## Problem

The relay admin tool fetches all event and profile data via WebSocket Nostr protocol (`nostr.query()` through nostrify). Report detail loading takes 1-3+ minutes for the moderator because:

- `useThread` makes serial/batched WebSocket queries to fetch the reported event, ancestors, and replies
- `useAuthor` makes a WebSocket query for each profile (kind 0 event)
- No query deduplication across WebSocket connections
- WebSocket queries hit the relay's event store; Funnelcake's REST API hits ClickHouse, which is significantly faster

## Solution

Proxy Funnelcake's REST read API through the relay-manager worker. Update frontend hooks to use REST for event and profile lookups, with WebSocket fallback.

## Architecture

```
Browser (relay.admin.divine.video)
  → relay-manager worker (api-relay-prod.divine.video)
    → Funnelcake REST API (same host as relay, /api/* path)
      → ClickHouse
```

The worker already handles environment switching. Adding Funnelcake API proxies keeps the frontend environment-agnostic and consistent with the existing pattern where all external calls go through the worker.

## Verified Assumptions

- **No bearer token auth on Funnelcake read endpoints.** `API_TOKEN` is not set in the production or staging k8s deployments. divine-web already calls `/api/users/{pubkey}` directly from the browser with no auth headers. Auth middleware only activates when `API_TOKEN` env var is present.
- **Funnelcake API shares the relay hostname.** Production HTTPRoute serves both WebSocket relay and REST API on `relay.divine.video`. Staging uses `relay.staging.divine.video`. This coupling is a known constraint -- if the API ever moves to a separate hostname, the URL derivation will need an explicit env var override.
- **`useAuthor` consumers only use `metadata`, not `event`.** All 9 consumers access `author.data?.metadata` (display_name, name, picture, nip05, about). None access `author.data?.event`. The REST path can return `{ metadata }` without the kind 0 event object.
- **divine-web already has a Funnelcake profile hook** (`useFunnelcakeProfile.ts`) that flattens the nested REST response into a flat profile object. We can reference this as a pattern.

## Scope

### Phase 1 (this PR)

**Worker: two proxy endpoints**

`GET /api/funnelcake/event/{id}`
- Proxies to `GET {funnelcakeApiUrl}/api/event/{id}`
- Returns Nostr event JSON (id, pubkey, kind, tags, content, sig)
- Forward Funnelcake's `Cache-Control` header (currently `public, max-age=300`)
- Note: existing worker proxy pattern (`proxyJsonResponse`) strips upstream headers. This proxy must explicitly forward cache headers.

`GET /api/funnelcake/users/{pubkey}`
- Proxies to `GET {funnelcakeApiUrl}/api/users/{pubkey}`
- Returns nested profile + social + stats + engagement
- Forward Funnelcake's `Cache-Control` header (currently `public, max-age=60`)

**Worker: URL derivation**

Derive the Funnelcake API base URL from `RELAY_URL` at request time:
- `wss://relay.divine.video` → `https://relay.divine.video`
- `wss://relay.staging.divine.video` → `https://relay.staging.divine.video`
- No new env vars needed. Add `FUNNELCAKE_API_URL` as an optional explicit override in the Env interface for cases where the API host diverges from the relay.

**Frontend: adminApi.ts**

Two new functions:
- `getFunnelcakeEvent(apiUrl, eventId)` → calls `/api/funnelcake/event/{id}`, returns `NostrEvent | null`
- `getFunnelcakeUser(apiUrl, pubkey)` → calls `/api/funnelcake/users/{pubkey}`, returns flattened `{ metadata }` matching the shape `useAuthor` consumers expect

**Frontend: useThread.ts**

- Replace `nostr.query([{ ids: [eventId] }])` with `getFunnelcakeEvent()` for the main event fetch
- Replace ancestor batch `nostr.query([{ ids: ancestorIds }])` with parallel `getFunnelcakeEvent()` calls (one per ancestor -- typically 1-2, max 3)
- Keep WebSocket `nostr.query()` as fallback if REST returns error or null
- Repost handling (kind 6/16): the inline content JSON parse path stays unchanged. If inline parsing fails, the original event fetch also uses `getFunnelcakeEvent()` with WebSocket fallback.
- Reply fetching stays on WebSocket for now (Phase 2)

**Frontend: useAuthor.ts**

- Replace `nostr.query([{ kinds: [0], authors: [pubkey] }])` with `getFunnelcakeUser()`
- Return `{ metadata }` from the REST response (flattened from `data.profile.*`). The `event` field is set to `undefined` in the REST path -- no consumers use it.
- Keep WebSocket fallback if REST fails

**Frontend: environment context**

Hooks need the worker API URL to call the proxy endpoints. `useThread` currently uses only `useNostr()` and has no API URL. It will need access to the current environment's API URL, either via:
- Passing `apiUrl` as a parameter (simple, explicit)
- Using the existing environment context/provider

### Phase 2 (fast follow)

`GET /api/funnelcake/videos/{id}/comments`
- Proxies to `GET {funnelcakeApiUrl}/api/videos/{id}/comments`
- Note: the `{id}` parameter is a video event ID, which should match the Nostr event ID used in `useThread`. Verify the identifier space matches before implementing.
- Replace reply fetching in `useThread` with REST call

## What doesn't change

- Moderation actions still go through existing worker endpoints (`/api/moderate`, `/api/relay-rpc`)
- Report list still fetches kind 1984 events via WebSocket
- `useUserStats`, `useReportContext` stay on WebSocket (less hot than event/author)
- All existing WebSocket functionality preserved as fallback

## Error handling

REST calls can fail (Funnelcake down, network issues). Every REST call falls back to the existing WebSocket path on error. The moderator sees the same data either way, just slower on fallback. Fallback is silent (no error UI), with a console.warn for debugging.

## Testing

### TDD: worker proxy endpoints

Unit tests for the two proxy endpoints, written before implementation:
- Event proxy: returns Nostr event JSON on success, forwards 404 on not found, returns 502 on upstream error
- User proxy: returns profile data on success, forwards 404, returns 502 on upstream error
- URL derivation: wss→https conversion, explicit override via `FUNNELCAKE_API_URL`
- Cache header forwarding: upstream `Cache-Control` preserved in proxy response

### TDD: frontend hooks

Unit tests for the REST-then-fallback pattern, written before implementation:
- `useThread` with REST: fetches event and ancestors via REST, falls back to WebSocket on REST failure
- `useAuthor` with REST: fetches profile via REST, returns flattened metadata, falls back to WebSocket on REST failure
- Repost handling: inline JSON parse path unchanged, original event fetch uses REST with fallback

### Local functional testing

Spin up the local stack (Funnelcake relay via divine-relay-test, relay-manager worker via wrangler, Caddy for HTTPS, Vite frontend) and verify end-to-end:
- Open a report with a known event ID, confirm the REST proxy is called (network tab / wrangler tail)
- Confirm report detail loads noticeably faster than WebSocket-only path
- Confirm profile data renders correctly in ThreadContext, ReporterCard, UserProfileCard
- Kill Funnelcake API, confirm fallback to WebSocket works transparently
- Switch environments, confirm each hits its own Funnelcake instance
