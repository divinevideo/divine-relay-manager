# Zendesk JWT Implementation Context

**Date:** February 3, 2026
**Status:** Planning → Implementation
**Related Plan:** `/Users/mjb/code/support-trust-safety/zendesk-jwt-implementation-plan.md`

---

## Overview

Adding a new endpoint `POST /api/zendesk/mobile-jwt` to generate JWTs for mobile app users. This enables:
- Unified user identity across REST API tickets and native Zendesk SDK
- "View Past Messages" showing user's ticket history
- Push notifications when agents reply

## Current State

The worker already has Zendesk JWT infrastructure:

### Existing JWT Code (for Zendesk sidebar app)
- `verifyZendeskJWT()` - verifies incoming JWTs (line 1099)
- `ZendeskJWTPayload` interface (line 47-55)
- `ZENDESK_JWT_SECRET` env var - used for HMAC-SHA256 signing

### Existing Zendesk Integration
- `/api/zendesk/webhook` - handles ticket field changes
- `/api/zendesk/parse-report` - extracts Nostr IDs from tickets
- `/api/zendesk/context` - context for sidebar app (JWT protected)
- `/api/zendesk/action` - execute moderation actions (JWT protected)
- D1 table `zendesk_tickets` - tracks ticket ↔ Nostr mappings

## New Endpoint Spec

```
POST /api/zendesk/mobile-jwt
Content-Type: application/json

Request:
{
  "pubkey": "hex pubkey (required, 64 chars)",
  "name": "display name (optional)",
  "email": "nip05 or npub@divine.video (optional)"
}

Response (200):
{
  "success": true,
  "jwt": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  "expires_at": 1706994000
}

Response (400):
{
  "success": false,
  "error": "Missing required field: pubkey"
}
```

## JWT Payload Structure

```typescript
interface MobileJWTPayload {
  iss: string;           // "divine.video"
  iat: number;           // issued at (unix timestamp)
  exp: number;           // expiry (iat + 3600 for 1 hour)
  jti: string;           // unique request ID (crypto.randomUUID())
  external_id: string;   // npub (bech32) - CRITICAL for ticket linking
  name: string;          // display name
  email: string;         // npub1...@divine.video synthetic email
}
```

**Note:** `external_id` uses npub (bech32 encoding) to match the pattern in divine-mobile's `zendesk_support_service.dart`. This ensures consistency between REST API ticket creation and native SDK identity.
```

## Implementation Location

Add to `handleZendeskRoutes()` in `worker/src/index.ts`:

```typescript
// In handleZendeskRoutes(), add before the JWT auth check:
if (subPath === '/mobile-jwt' && request.method === 'POST') {
  return handleMobileJwt(request, env, corsHeaders);
}
```

## Implementation Checklist

- [ ] Add `handleMobileJwt()` function
- [ ] Validate pubkey (64 hex chars)
- [ ] Generate JWT with HMAC-SHA256 using `ZENDESK_JWT_SECRET`
- [ ] Return JWT with expiry timestamp
- [ ] Test with staging worker

## Key Considerations

1. **No auth required** - pubkey is public info, JWT only grants Zendesk identity (not moderation powers)
2. **external_id uses npub** - bech32-encoded pubkey links REST API tickets to SDK identity
3. **Consistent format** - npub matches divine-mobile's setUserIdentity pattern (npub@divine.video emails)
4. **1-hour expiry** - mobile app should refresh on demand
5. **Same secret** - uses existing `ZENDESK_JWT_SECRET` (must match Zendesk Admin config)

## Testing

Deploy to staging first:
```bash
cd worker
npx wrangler deploy --config wrangler.staging.toml
```

Test with curl:
```bash
curl -X POST https://api-relay-staging.divine.video/api/zendesk/mobile-jwt \
  -H "Content-Type: application/json" \
  -d '{"pubkey":"abc123...64chars...def789","name":"Test User"}'
```

## Related Files

- `worker/src/index.ts` - main worker, all Zendesk routes
- `worker/wrangler.staging.toml` - staging config
- `worker/wrangler.prod.toml` - production config
- `worker/.dev.vars` - local secrets (do not commit)
