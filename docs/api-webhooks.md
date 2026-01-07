# Divine Relay Manager - Webhook & API Documentation

## Overview

The Divine Relay Manager exposes several API endpoints that allow external systems to trigger moderation actions. This enables integration with customer support tools like Zendesk, automated moderation pipelines, and other external services.

**Base URL:** `https://api-relay.divine.video` (or `https://relay.admin.divine.video/api`)

## Authentication

### Cloudflare Zero Trust (Recommended)

All endpoints are protected by Cloudflare Access. External services need service tokens:

```
CF-Access-Client-Id: <your-client-id>
CF-Access-Client-Secret: <your-client-secret>
```

### Webhook Signature Verification

For Zendesk webhooks, requests are verified using HMAC-SHA256:

```
X-Zendesk-Webhook-Signature: t=<timestamp>,v0=<signature>
```

---

## Moderation Action Endpoints

### POST /api/moderate

Execute a moderation action directly.

**Request:**
```json
{
  "action": "ban_pubkey" | "allow_pubkey" | "delete_event",
  "pubkey": "hex-pubkey",      // Required for ban/allow
  "eventId": "hex-event-id",   // Required for delete
  "reason": "Spam account"     // Optional
}
```

**Response:**
```json
{
  "success": true,
  "message": "Action executed successfully"
}
```

**Actions:**
| Action | Description |
|--------|-------------|
| `ban_pubkey` | Ban a user from posting to the relay |
| `allow_pubkey` | Remove a user from the ban list |
| `delete_event` | Delete a specific event from the relay |

---

### POST /api/relay-rpc

Execute NIP-86 relay management commands. This is the low-level interface used by the admin UI.

**Request:**
```json
{
  "method": "banpubkey",
  "params": ["<hex-pubkey>", "Reason for ban"]
}
```

**Available Methods:**
| Method | Params | Description |
|--------|--------|-------------|
| `banpubkey` | `[pubkey, reason?]` | Ban a pubkey |
| `allowpubkey` | `[pubkey, reason?]` | Add to allowlist |
| `listbannedpubkeys` | `[]` | Get all banned pubkeys |
| `listallowedpubkeys` | `[]` | Get all allowed pubkeys |
| `deleteevents` | `[eventId, reason?]` | Delete events |

**Response:**
```json
{
  "success": true,
  "result": { ... }
}
```

---

### POST /api/moderate-media

Moderate media content (images/videos) by SHA-256 hash.

**Request:**
```json
{
  "sha256": "abc123...",
  "action": "PERMANENT_BAN" | "SAFE" | "AGE_RESTRICTED" | "REVIEW",
  "reason": "CSAM content"
}
```

**Response:**
```json
{
  "success": true,
  "sha256": "abc123...",
  "action": "PERMANENT_BAN"
}
```

**Actions:**
| Action | Description |
|--------|-------------|
| `PERMANENT_BAN` | Block this media hash permanently |
| `SAFE` | Mark as safe, allow serving |
| `AGE_RESTRICTED` | Allow but flag as adult content |
| `REVIEW` | Queue for manual review |

---

### GET /api/check-result/:sha256

Check the moderation status of a media file.

**Response:**
```json
{
  "success": true,
  "sha256": "abc123...",
  "action": "PERMANENT_BAN",
  "reason": "Blocked by moderator",
  "created_at": "2025-01-05T12:00:00Z"
}
```

---

## Zendesk Integration

### POST /api/zendesk/webhook

Receives webhook events from Zendesk when ticket custom fields are updated.

**Headers:**
```
Content-Type: application/json
X-Zendesk-Webhook-Signature: t=1704067200,v0=abc123...
```

**Request:**
```json
{
  "ticket_id": 12345,
  "action_requested": "ban_user",
  "nostr_pubkey": "abc123...",
  "nostr_event_id": "def456...",
  "agent_email": "agent@example.com"
}
```

**Supported Actions:**
| action_requested | Description |
|------------------|-------------|
| `ban_user` | Ban the pubkey from the relay |
| `allow_user` | Remove the pubkey from ban list |
| `delete_event` | Delete the specified event |
| `mark_safe` | Mark media as safe |
| `age_restrict` | Mark media as age-restricted |

**Response:**
```json
{
  "success": true,
  "action": "ban_user",
  "message": "User banned successfully"
}
```

**Error Response:**
```json
{
  "success": false,
  "error": "Invalid signature"
}
```

---

### GET /api/zendesk/context

Get moderation context for a user (used by Zendesk sidebar app).

**Query Params:**
- `pubkey` - The Nostr pubkey to look up

**Headers:**
```
Authorization: Bearer <zendesk-jwt-token>
```

**Response:**
```json
{
  "success": true,
  "pubkey": "abc123...",
  "is_banned": false,
  "ban_reason": null,
  "decision_history": [
    {
      "action": "delete_event",
      "reason": "Spam",
      "created_at": "2025-01-04T10:00:00Z"
    }
  ],
  "report_count": 3,
  "recent_events_count": 42
}
```

---

### POST /api/zendesk/action

Execute moderation action from Zendesk sidebar (JWT authenticated).

**Headers:**
```
Authorization: Bearer <zendesk-jwt-token>
Content-Type: application/json
```

**Request:**
```json
{
  "action": "ban_user",
  "pubkey": "abc123...",
  "event_id": "def456...",
  "ticket_id": 12345,
  "reason": "Multiple spam reports"
}
```

**Response:**
```json
{
  "success": true,
  "action": "ban_user",
  "logged": true
}
```

---

## Decision Logging

### POST /api/decisions

Log a moderation decision (called automatically by action endpoints).

**Request:**
```json
{
  "targetType": "pubkey" | "event" | "media",
  "targetId": "abc123...",
  "action": "ban_user",
  "reason": "Spam account",
  "moderatorPubkey": "mod-pubkey...",
  "reportId": "report-id...",
  "zendeskTicketId": 12345
}
```

---

### GET /api/decisions/:targetId

Get all decisions for a target.

**Response:**
```json
{
  "success": true,
  "decisions": [
    {
      "id": 1,
      "target_type": "pubkey",
      "target_id": "abc123...",
      "action": "ban_user",
      "reason": "Spam",
      "moderator_email": "agent@example.com",
      "created_at": "2025-01-05T12:00:00Z"
    }
  ]
}
```

---

### DELETE /api/decisions/:targetId

Delete all decisions for a target (reopen a dismissed report).

**Response:**
```json
{
  "success": true,
  "deleted": 2
}
```

---

## Setting Up Zendesk Webhooks

### 1. Create Custom Ticket Fields

In Zendesk Admin > Objects and rules > Tickets > Fields:

| Field Name | Type | Options |
|------------|------|---------|
| `nostr_pubkey` | Text | - |
| `nostr_event_id` | Text | - |
| `action_requested` | Dropdown | none, ban_user, allow_user, delete_event, mark_safe, age_restrict |
| `action_status` | Dropdown | pending, in_progress, executed, failed |
| `risk_level` | Dropdown | low, medium, high, critical |

### 2. Create Webhook

In Zendesk Admin > Apps and integrations > Webhooks:

- **Endpoint URL:** `https://api-relay.divine.video/api/zendesk/webhook`
- **Request method:** POST
- **Request format:** JSON
- **Authentication:** None (signature verification used instead)

### 3. Create Trigger

In Zendesk Admin > Objects and rules > Business rules > Triggers:

**Conditions:**
- Ticket > action_requested > Changed
- Ticket > action_requested > Is not > none

**Actions:**
- Notify webhook with JSON body:

```json
{
  "ticket_id": {{ticket.id}},
  "action_requested": "{{ticket.ticket_field_<action_requested_id>}}",
  "nostr_pubkey": "{{ticket.ticket_field_<nostr_pubkey_id>}}",
  "nostr_event_id": "{{ticket.ticket_field_<nostr_event_id_id>}}",
  "agent_email": "{{current_user.email}}"
}
```

### 4. Set Environment Variables

In `worker/wrangler.toml` or Cloudflare dashboard:

```bash
wrangler secret put ZENDESK_WEBHOOK_SECRET
# Enter the signing secret from Zendesk webhook settings

wrangler secret put ZENDESK_JWT_SECRET
# Enter a shared secret for JWT tokens (for sidebar app)
```

---

## Error Codes

| Code | Description |
|------|-------------|
| 400 | Bad request - missing or invalid parameters |
| 401 | Unauthorized - invalid or missing authentication |
| 403 | Forbidden - valid auth but insufficient permissions |
| 404 | Not found - resource doesn't exist |
| 500 | Internal error - check logs |

---

## Rate Limits

Currently no rate limits are enforced, but aggressive use may trigger Cloudflare protection.

---

## Example: Curl Commands

**Ban a user:**
```bash
curl -X POST https://api-relay.divine.video/api/moderate \
  -H "Content-Type: application/json" \
  -H "CF-Access-Client-Id: $CF_CLIENT_ID" \
  -H "CF-Access-Client-Secret: $CF_CLIENT_SECRET" \
  -d '{"action": "ban_pubkey", "pubkey": "abc123...", "reason": "Spam"}'
```

**Check media status:**
```bash
curl https://api-relay.divine.video/api/check-result/abc123... \
  -H "CF-Access-Client-Id: $CF_CLIENT_ID" \
  -H "CF-Access-Client-Secret: $CF_CLIENT_SECRET"
```

**Delete an event:**
```bash
curl -X POST https://api-relay.divine.video/api/moderate \
  -H "Content-Type: application/json" \
  -H "CF-Access-Client-Id: $CF_CLIENT_ID" \
  -H "CF-Access-Client-Secret: $CF_CLIENT_SECRET" \
  -d '{"action": "delete_event", "eventId": "def456..."}'
```
