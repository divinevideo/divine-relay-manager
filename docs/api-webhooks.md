# Divine Relay Manager - Webhook & API Documentation

## Overview

The Divine Relay Manager exposes several API endpoints for integration with external systems like Zendesk (ticket report parsing, decision sync, age-review replies). Note: Zendesk does **not** execute moderation actions. Moderation is performed in Relay Manager; Zendesk only receives decision updates back. The former inbound moderation-execution path has been retired (see the note under `POST /api/zendesk/webhook`).

**Base URL:** `https://api-relay-prod.divine.video` (production) or `https://api-relay-staging.divine.video` (staging)

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
  "action": "ban_pubkey" | "allow_pubkey" | "delete_event" | "hide_event" | "allow_event",
  "pubkey": "hex-pubkey",      // Required for ban/allow
  "eventId": "hex-event-id",   // Required for delete/hide/allow_event; must be 64 hex chars
  "reason": "Spam account"     // Optional
}
```

**Response:**
```json
{
  "success": true,
  "message": "Action executed successfully",
  "recorded": true             // hide_event / allow_event only — see below
}
```

**Actions:**
| Action | Description |
|--------|-------------|
| `ban_pubkey` | Ban a user from posting to the relay |
| `allow_pubkey` | Remove a user from the ban list |
| `delete_event` | Delete a specific event from the relay, and DM the creator `PERMANENT_BAN` |
| `hide_event` | Hide an event. Same relay operation as `delete_event`, but **no DM** |
| `allow_event` | Un-hide an event |

### `recorded`, and why `hide_event` / `allow_event` exist

These two do more than the relay change, which was already available over
`/api/relay-rpc`. They also mark the event human-reviewed in `moderation_targets`.
ReportWatcher skips auto-hide for any event carrying that mark, so **without it a
moderator's restore is silently undone by the next report** — csam is an immediate,
threshold-1 tier.

`recorded` reports whether that mark actually landed. It is returned on a **200**, not an
error status, because the relay change did apply and a retry would enforce twice. A caller
seeing `recorded: false` should treat the decision as **applied but unprotected** and
surface it: the content is hidden or restored as asked, but the automation may reverse it.

Event visibility changes and their direction-bearing human marks are serialized through the
ReportWatcher Durable Object. Auto-hide uses the same coordination gate and rechecks the
latest action after banning. Explicit restores plus the resolution statuses `dismissed`,
`no-action`, and `false-positive` are allow-direction; the generic `reviewed` status is not.
This preserves whichever coordinated action ran last without letting an older restore undo a
newer human hide or delete.

An `allow_event` response also carries `reconciled`. It is true when the coordinated restore
and human-review mark completed. If it is false, callers should surface the same degraded
state as `recorded: false`: the relay restore landed, but automation protection did not.
Zendesk still receives the final human decision in this case.

Both actions are final human decisions for linked Zendesk reports, so they add an internal
note and resolve the open ticket.

`eventId` is validated as 64 hex characters and lowercased before use. `moderation_targets`
is BINARY-collated and ReportWatcher looks the event up by its lowercase id, so an uppercase
id would write a row nothing can read while the API reported success.

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
  "action": "SAFE" | "REVIEW" | "QUARANTINE" | "AGE_RESTRICTED" | "PERMANENT_BAN" | "DELETE",
  "reason": "CSAM content",
  "from": "AGE_RESTRICTED"
}
```

**`from` (optional): declare the state you expect to be changing.**

This endpoint sets state; it does not describe a transition. `SAFE` means "make
this Active", not "undo the age-restriction I applied", so a caller reversing its
own action and a caller clearing an age-review quarantine on a minor's content
send the identical request.

`from` lets a caller declare the state it believes it is changing. The current
state is read first and the action is refused unless it matches, so a button can
only reverse the thing it is named for. Omit `from` and nothing changes: no
extra read, no new failure mode.

It guards a cooperating caller against its own bug. It is not a security
boundary, since the caller supplies the value and omitting it restores the
unguarded path.

Sending `from` also requires `sha256` to be 64 hex characters, because it becomes
part of an upstream URL. Without `from`, `sha256` is forwarded as-is and
validated upstream.

**Refusals when `from` is present:**

| Status | `code` | Meaning |
|--------|--------|---------|
| 400 | `invalid_from` | `from` was present but empty, whitespace, null, or not a string. Omit it to skip the check. |
| 400 | `invalid_sha256` | `sha256` is not 64 hex characters. |
| 409 | `state_mismatch` | Current state is not the declared one. The body carries `from` and `current`. |
| 503 | `state_unreadable` | Current state could not be read. Retryable, and deliberately not a success. |

A 409 names both states because "refused" alone reads as transient and gets
retried. `state_unreadable` is 503 rather than 409 because "could not check" is a
different answer from "no conflict".

What is compared is moderation-service's recorded result. Actions taken directly
through Blossom's own admin UI do not write there, so they are not reflected.

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
| `QUARANTINE` | Withhold this media hash while preserving reversibility |
| `AGE_RESTRICTED` | Allow but flag as adult content |
| `REVIEW` | Queue for manual review |
| `DELETE` | Delete this media hash |

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

> **Retired (#103).** This inbound moderation-execution endpoint has been removed from the worker. Moderation happens in Relay Manager, not Zendesk. The Zendesk-side trigger, webhook, and `action_requested`/`action_status` fields have been deactivated. The detail below is kept for historical context only.

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

> **Retired (#103).** This inbound moderation-execution endpoint (Zendesk sidebar) has been removed from the worker. The detail below is kept for historical context only.

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

Delete all decisions for a target (reopen a dismissed report), and remove the
target's relay-side resolution labels (kind 1985, `L=moderation/resolution`).

**Query parameters:**

| Name | Values | Default |
|------|--------|---------|
| `targetType` | `event` \| `pubkey` | both label tags are queried |

A resolution label carries an `e` tag for an event target or a `p` tag for a
pubkey target, never both, so naming the type skips the query that could not
match. Any other value — absent, empty, wrong case, junk — falls back to
querying both, which is what an older frontend gets.

**Response:**
```json
{
  "success": true,
  "deleted": 2,
  "labelsDeleted": 1,
  "labelCleanupFailed": false
}
```

The D1 decision rows are deleted unconditionally; the relay-side label cleanup
is best-effort. `labelCleanupFailed: true` means at least one resolution label
may have survived — the label read failed, it filled its page so there may be
more beyond it, or a label was read but could not be removed. A surviving label
keeps the report hidden even though its decisions are gone, so callers must
surface this rather than reporting a clean reopen.

---

## Setting Up Zendesk Webhooks

> **Retired (#103).** The inbound moderation-execution wiring described below (the `action_requested`/`action_status` fields, the `relay moderation action` trigger, and the `relay-management` webhook) has been deactivated in Zendesk and removed from the worker. This section is kept for historical context only. The decision-reporting direction (Relay Manager → Zendesk auto-solve + internal notes) and the still-active `parse-report` / `age-review-reply` integrations are unaffected.

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

- **Endpoint URL:** `https://api-relay-prod.divine.video/api/zendesk/webhook`
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

In the per-environment `worker/wrangler.{local,staging,prod}.toml` or the
Cloudflare dashboard:

```bash
npx wrangler secret put ZENDESK_WEBHOOK_SECRET --config wrangler.prod.toml
# Enter the signing secret from Zendesk webhook settings

npx wrangler secret put ZENDESK_JWT_SECRET --config wrangler.prod.toml
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
curl -X POST https://api-relay-prod.divine.video/api/moderate \
  -H "Content-Type: application/json" \
  -H "CF-Access-Client-Id: $CF_CLIENT_ID" \
  -H "CF-Access-Client-Secret: $CF_CLIENT_SECRET" \
  -d '{"action": "ban_pubkey", "pubkey": "abc123...", "reason": "Spam"}'
```

**Check media status:**
```bash
curl https://api-relay-prod.divine.video/api/check-result/abc123... \
  -H "CF-Access-Client-Id: $CF_CLIENT_ID" \
  -H "CF-Access-Client-Secret: $CF_CLIENT_SECRET"
```

**Delete an event:**
```bash
curl -X POST https://api-relay-prod.divine.video/api/moderate \
  -H "Content-Type: application/json" \
  -H "CF-Access-Client-Id: $CF_CLIENT_ID" \
  -H "CF-Access-Client-Secret: $CF_CLIENT_SECRET" \
  -d '{"action": "delete_event", "eventId": "def456..."}'
```
