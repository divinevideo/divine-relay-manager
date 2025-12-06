# Zendesk Integration Design

## Overview

Bidirectional integration between the ManVRelay moderation worker and Zendesk, enabling:
- **Push to Zendesk**: Automatic ticket creation for reports, AI flags, and moderation activity
- **Pull from Zendesk**: Agent-triggered moderation actions that execute on the Nostr relay

## Goals

1. Give Zendesk support agents full context on Nostr users/content without leaving Zendesk
2. Enable one-click moderation actions from within Zendesk
3. Maintain complete audit trail of all moderation decisions
4. Support configurable thresholds to control ticket volume

## Integration Mechanisms

We use all three Zendesk integration patterns for maximum reliability and UX:

| Mechanism | Purpose |
|-----------|---------|
| **Zendesk API** | Push tickets, update status, add internal notes |
| **Webhooks** | Primary action trigger - fires when agents set action fields |
| **Sidebar App** | Rich context display + quick action buttons |
| **Polling (fallback)** | Backup sync in case webhooks fail; batch processing |

## Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                        CF Worker (existing + new)                    │
│                                                                      │
│  NEW ENDPOINTS:                                                      │
│  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────────┐  │
│  │ POST            │  │ POST            │  │ GET                 │  │
│  │ /api/zendesk/   │  │ /api/zendesk/   │  │ /api/zendesk/       │  │
│  │ create-ticket   │  │ webhook         │  │ pending-actions     │  │
│  └────────┬────────┘  └────────┬────────┘  └──────────┬──────────┘  │
│           │                    │                      │              │
│  ┌────────┴────────────────────┴──────────────────────┴───────────┐ │
│  │                  Zendesk Service Layer                         │ │
│  │  - ZendeskClient class (API wrapper)                           │ │
│  │  - Ticket creation with Nostr context enrichment               │ │
│  │  - Webhook signature verification                              │ │
│  │  - Action execution + ticket status updates                    │ │
│  │  - Threshold configuration (KV-backed)                         │ │
│  └────────────────────────────────────────────────────────────────┘ │
│           │                    │                      │              │
│           ▼                    ▼                      ▼              │
│  ┌────────────────────────────────────────────────────────────────┐ │
│  │              Existing Moderation Logic                         │ │
│  │  handleModerate(), handleRelayRpc(), handleSummarizeUser()     │ │
│  └────────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────────┘
              │              ▲                    ▲
              │              │                    │
              ▼              │                    │
┌─────────────────────────────────────────────────────────────────────┐
│                            Zendesk                                   │
│                                                                      │
│  ┌─────────────────┐  ┌──────────────────┐  ┌────────────────────┐  │
│  │ Tickets         │  │ Triggers/Webhooks│  │ Sidebar App        │  │
│  │                 │  │                  │  │ (Cloudflare Pages) │  │
│  │ - Custom fields │  │ - On field change│  │                    │  │
│  │ - Internal notes│  │ - Calls worker   │  │ - Fetches context  │  │
│  │ - Audit trail   │  │   webhook        │  │ - Action buttons   │  │
│  └─────────────────┘  └──────────────────┘  └────────────────────┘  │
└─────────────────────────────────────────────────────────────────────┘
```

## Worker Environment Additions

```typescript
interface Env {
  // Existing...
  NOSTR_NSEC: string;
  RELAY_URL: string;
  // ...

  // New Zendesk config
  ZENDESK_SUBDOMAIN: string;      // e.g., "divine" for divine.zendesk.com
  ZENDESK_EMAIL: string;          // API user email
  ZENDESK_API_TOKEN: string;      // API token (not password)
  ZENDESK_WEBHOOK_SECRET: string; // For webhook signature verification
}
```

## Zendesk Custom Ticket Fields

Create these custom fields in Zendesk Admin:

| Field ID | Name | Type | Values |
|----------|------|------|--------|
| `nostr_pubkey` | Nostr Pubkey | Text | Hex pubkey of reported user |
| `nostr_event_id` | Event ID | Text | Specific event if applicable |
| `nostr_npub` | Nostr npub | Text | Bech32 npub for display |
| `report_type` | Report Type | Dropdown | spam, illegal, impersonation, nudity, harassment, other |
| `risk_level` | Risk Level | Dropdown | low, medium, high, critical |
| `action_requested` | Action Requested | Dropdown | none, ban_user, allow_user, delete_event, mark_safe, age_restrict |
| `action_status` | Action Status | Dropdown | pending, in_progress, executed, failed |
| `nostr_context_url` | Context URL | Text | Link to njump.me or relay admin panel |

## Ticket Creation Flow

### Triggers

Tickets are created when:

1. **NIP-56 Report Received** (kind 1984)
   - Always create ticket (or based on threshold)
   - Include reporter info, reported content, report reason

2. **AI Risk Flag**
   - When `handleSummarizeUser` returns `riskLevel: "high" | "critical"`
   - Include AI summary, recent posts, existing labels

3. **Media Flagged**
   - When `handleModerateMedia` processes flagged content
   - Include media hash, moderation result, associated events

4. **Manual Moderation Action** (optional, for audit)
   - When `handleModerate` or `handleRelayRpc` executes
   - Creates ticket as record/audit trail

### Threshold Configuration

Stored in KV namespace:

```typescript
interface ZendeskThresholds {
  // Report thresholds
  createTicketOnFirstReport: boolean;      // Immediate ticket on first report?
  reportCountThreshold: number;            // Or wait for N reports against same user?

  // AI thresholds
  aiRiskLevelThreshold: 'low' | 'medium' | 'high' | 'critical';

  // Media thresholds
  mediaFlaggedAutoTicket: boolean;

  // Audit logging
  logAllModActionsToZendesk: boolean;      // Create tickets for all mod actions?
}
```

### Ticket Content Template

```markdown
## Nostr Moderation Report

**Reported User:** {display_name} ({npub})
**Risk Level:** {risk_level}
**Report Type:** {report_type}

### AI Summary
{ai_summary}

### Recent Posts
{recent_posts_formatted}

### Report Details
- **Reporter:** {reporter_npub}
- **Reason:** {report_reason}
- **Event:** {event_id}

### Moderation History
{existing_labels}
{previous_decisions}

### Quick Links
- [View on njump.me]({njump_url})
- [View in Relay Admin]({admin_url})
```

## Webhook Handler

### Endpoint: `POST /api/zendesk/webhook`

```typescript
interface ZendeskWebhookPayload {
  ticket_id: number;
  ticket_url: string;
  current_user_id: number;
  current_user_email: string;
  custom_fields: {
    nostr_pubkey?: string;
    nostr_event_id?: string;
    action_requested?: string;
    action_status?: string;
  };
}
```

### Verification

Zendesk webhooks can be verified via:
1. Webhook signing secret (recommended)
2. IP allowlist (Zendesk IPs)
3. Basic auth header

### Action Execution

```typescript
async function handleZendeskWebhook(payload: ZendeskWebhookPayload, env: Env) {
  // 1. Verify webhook signature
  // 2. Extract action details
  const { nostr_pubkey, nostr_event_id, action_requested } = payload.custom_fields;

  if (!action_requested || action_requested === 'none') return;

  // 3. Update ticket to in_progress
  await updateTicketStatus(payload.ticket_id, 'in_progress');

  try {
    // 4. Execute action using existing handlers
    switch (action_requested) {
      case 'ban_user':
        await executeBan(nostr_pubkey, env);
        break;
      case 'allow_user':
        await executeAllow(nostr_pubkey, env);
        break;
      case 'delete_event':
        await executeDelete(nostr_event_id, env);
        break;
      // etc.
    }

    // 5. Update ticket to executed + add internal note
    await updateTicketStatus(payload.ticket_id, 'executed');
    await addTicketNote(payload.ticket_id, `Action "${action_requested}" executed successfully`);

    // 6. Log to D1 with Zendesk ticket reference
    await logDecision({
      targetType: action_requested.includes('event') ? 'event' : 'pubkey',
      targetId: nostr_event_id || nostr_pubkey,
      action: action_requested,
      zendeskTicketId: payload.ticket_id,
      moderatorEmail: payload.current_user_email,
    });

  } catch (error) {
    await updateTicketStatus(payload.ticket_id, 'failed');
    await addTicketNote(payload.ticket_id, `Action failed: ${error.message}`);
  }
}
```

## Polling Fallback

### Endpoint: `GET /api/zendesk/pending-actions`

For cron-triggered or manual sync:

```typescript
async function pollPendingActions(env: Env) {
  // Query Zendesk for tickets where:
  // - action_requested != 'none'
  // - action_status = 'pending'

  const pendingTickets = await zendeskClient.search(
    'type:ticket custom_field:action_status:pending'
  );

  for (const ticket of pendingTickets) {
    await processTicketAction(ticket, env);
  }
}
```

Can be triggered by:
- Cloudflare Cron Trigger (every 5 min)
- Manual API call
- After webhook failure detection

## Zendesk Sidebar App

Separate mini-application living in `zendesk-app/` subdirectory for now. Will be extracted to its own repository once the integration stabilizes.

### Directory Structure

```
ManVRelay/
├── worker/           # Existing CF Worker
├── zendesk-app/      # NEW: Zendesk sidebar app
│   ├── src/
│   ├── public/
│   ├── manifest.json # Zendesk app manifest
│   ├── package.json
│   └── README.md
├── src/              # Existing React admin UI
└── docs/
```

### Features

1. **User Context Panel**
   - Profile picture, display name, npub
   - Risk level badge (color-coded)
   - AI summary

2. **Recent Activity**
   - Last 10 posts with timestamps
   - Media thumbnails (if applicable)
   - Engagement metrics

3. **Moderation History**
   - Previous labels applied
   - Past decisions from D1
   - Report count

4. **Quick Actions**
   - Ban User button
   - Allow User button
   - Delete Event button
   - Mark Safe button
   - Each updates ticket custom field, triggering webhook

### Tech Stack

- React + TypeScript
- Zendesk Apps Framework (ZAF SDK)
- Calls worker API for data
- Hosted on Cloudflare Pages

### Authentication

- App configured with worker API key in Zendesk app settings
- Worker validates API key on context fetch requests
- Zendesk user identity passed for audit logging

## Security

### Webhook Verification

```typescript
function verifyZendeskWebhook(request: Request, secret: string): boolean {
  const signature = request.headers.get('X-Zendesk-Webhook-Signature');
  const timestamp = request.headers.get('X-Zendesk-Webhook-Signature-Timestamp');

  const payload = await request.text();
  const signedPayload = `${timestamp}.${payload}`;

  const expectedSig = await hmacSha256(secret, signedPayload);
  return signature === expectedSig;
}
```

### API Authentication

- Zendesk API: Email + API token (Base64 encoded)
- Worker API for sidebar app: API key in header
- All actions logged with Zendesk user email for accountability

### Rate Limiting

- Webhook endpoint: Max 100 requests/minute
- Ticket creation: Max 10 tickets/minute per pubkey
- Context API: Max 60 requests/minute per Zendesk agent

## Database Schema Updates

Add Zendesk reference to moderation_decisions:

```sql
ALTER TABLE moderation_decisions
ADD COLUMN zendesk_ticket_id INTEGER;

ALTER TABLE moderation_decisions
ADD COLUMN moderator_email TEXT;

CREATE INDEX idx_decisions_zendesk ON moderation_decisions(zendesk_ticket_id);
```

## Implementation Phases

### Phase 1: Core Integration
- ZendeskClient class with API wrapper
- Ticket creation endpoint
- Basic webhook handler
- Environment configuration

### Phase 2: Enriched Tickets
- AI summary integration
- Recent posts inclusion
- Moderation history
- Threshold configuration

### Phase 3: Sidebar App
- React app scaffolding
- Context fetching APIs
- Action buttons
- Zendesk app packaging

### Phase 4: Reliability
- Polling fallback
- Error handling + retries
- Monitoring + alerting
- Rate limiting

## Open Questions

1. **Ticket assignment**: Auto-assign to specific group/agent, or round-robin?
2. **SLA**: Should high-risk tickets have different SLA policies?
3. **Escalation**: Auto-escalate if action not taken within X hours?
4. **Batch actions**: Support bulk operations from Zendesk views?

## Success Metrics

- Time from report to resolution
- Agent actions per session
- Webhook success rate
- Polling fallback frequency
- False positive rate (safe users banned)
