# Zendesk Integration Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Bidirectional integration between ManVRelay moderation worker and Zendesk for ticket creation, agent actions, and full context display.

**Architecture:** CF Worker gets new endpoints for Zendesk API calls (create tickets, handle webhooks, serve context). Zendesk sidebar app (separate React app in `zendesk-app/`) displays Nostr user context and provides action buttons. All three integration mechanisms: API push, webhooks, polling fallback.

**Tech Stack:** Cloudflare Workers (existing), Zendesk API v2, React + TypeScript (sidebar app), Zendesk Apps Framework (ZAF SDK)

---

## Phase 1: Core Worker Integration

### Task 1: Add Zendesk Environment Variables

**Files:**
- Modify: `worker/src/index.ts:5-17`
- Modify: `worker/wrangler.toml` (add vars section if needed)

**Step 1: Update Env interface**

Add to the existing `Env` interface in `worker/src/index.ts`:

```typescript
interface Env {
  // Existing...
  NOSTR_NSEC: string;
  RELAY_URL: string;
  ALLOWED_ORIGIN: string;
  ANTHROPIC_API_KEY?: string;
  MODERATION_API_KEY?: string;
  CF_ACCESS_CLIENT_ID?: string;
  CF_ACCESS_CLIENT_SECRET?: string;
  KV?: KVNamespace;
  DB?: D1Database;

  // NEW: Zendesk integration
  ZENDESK_SUBDOMAIN?: string;      // e.g., "divine" for divine.zendesk.com
  ZENDESK_EMAIL?: string;          // API user email
  ZENDESK_API_TOKEN?: string;      // API token
  ZENDESK_WEBHOOK_SECRET?: string; // For webhook signature verification
}
```

**Step 2: Commit**

```bash
git add worker/src/index.ts
git commit -m "feat(worker): add Zendesk environment variables to Env interface"
```

---

### Task 2: Create ZendeskClient Class

**Files:**
- Create: `worker/src/zendesk/client.ts`

**Step 1: Create zendesk directory**

```bash
mkdir -p worker/src/zendesk
```

**Step 2: Write ZendeskClient**

Create `worker/src/zendesk/client.ts`:

```typescript
// ABOUTME: Zendesk API client for creating/updating tickets and handling webhooks
// ABOUTME: Uses Zendesk API v2 with email/token authentication

interface ZendeskEnv {
  ZENDESK_SUBDOMAIN?: string;
  ZENDESK_EMAIL?: string;
  ZENDESK_API_TOKEN?: string;
}

interface ZendeskTicket {
  id?: number;
  subject: string;
  description: string;
  priority?: 'low' | 'normal' | 'high' | 'urgent';
  tags?: string[];
  custom_fields?: Array<{ id: number; value: string }>;
}

interface ZendeskTicketResponse {
  ticket: {
    id: number;
    url: string;
    subject: string;
    status: string;
  };
}

interface ZendeskError {
  error: string;
  description?: string;
}

export class ZendeskClient {
  private baseUrl: string;
  private authHeader: string;

  constructor(env: ZendeskEnv) {
    if (!env.ZENDESK_SUBDOMAIN || !env.ZENDESK_EMAIL || !env.ZENDESK_API_TOKEN) {
      throw new Error('Zendesk configuration incomplete: need ZENDESK_SUBDOMAIN, ZENDESK_EMAIL, ZENDESK_API_TOKEN');
    }

    this.baseUrl = `https://${env.ZENDESK_SUBDOMAIN}.zendesk.com/api/v2`;
    // Zendesk uses email/token:api_token for basic auth
    const credentials = `${env.ZENDESK_EMAIL}/token:${env.ZENDESK_API_TOKEN}`;
    this.authHeader = `Basic ${btoa(credentials)}`;
  }

  async createTicket(ticket: ZendeskTicket): Promise<ZendeskTicketResponse> {
    const response = await fetch(`${this.baseUrl}/tickets.json`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': this.authHeader,
      },
      body: JSON.stringify({ ticket }),
    });

    if (!response.ok) {
      const error = await response.json() as ZendeskError;
      throw new Error(`Zendesk API error: ${response.status} - ${error.error || error.description || 'Unknown error'}`);
    }

    return response.json() as Promise<ZendeskTicketResponse>;
  }

  async updateTicket(ticketId: number, updates: Partial<ZendeskTicket>): Promise<ZendeskTicketResponse> {
    const response = await fetch(`${this.baseUrl}/tickets/${ticketId}.json`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': this.authHeader,
      },
      body: JSON.stringify({ ticket: updates }),
    });

    if (!response.ok) {
      const error = await response.json() as ZendeskError;
      throw new Error(`Zendesk API error: ${response.status} - ${error.error || error.description || 'Unknown error'}`);
    }

    return response.json() as Promise<ZendeskTicketResponse>;
  }

  async addTicketComment(ticketId: number, comment: string, isPublic: boolean = false): Promise<void> {
    await this.updateTicket(ticketId, {
      // @ts-expect-error - comment is a valid update field but not in our interface
      comment: {
        body: comment,
        public: isPublic,
      },
    });
  }

  async getTicket(ticketId: number): Promise<ZendeskTicketResponse> {
    const response = await fetch(`${this.baseUrl}/tickets/${ticketId}.json`, {
      method: 'GET',
      headers: {
        'Authorization': this.authHeader,
      },
    });

    if (!response.ok) {
      throw new Error(`Zendesk API error: ${response.status}`);
    }

    return response.json() as Promise<ZendeskTicketResponse>;
  }

  async searchTickets(query: string): Promise<{ results: Array<{ id: number }> }> {
    const response = await fetch(
      `${this.baseUrl}/search.json?query=${encodeURIComponent(query)}`,
      {
        method: 'GET',
        headers: {
          'Authorization': this.authHeader,
        },
      }
    );

    if (!response.ok) {
      throw new Error(`Zendesk search error: ${response.status}`);
    }

    return response.json() as Promise<{ results: Array<{ id: number }> }>;
  }
}

export type { ZendeskTicket, ZendeskTicketResponse, ZendeskEnv };
```

**Step 3: Commit**

```bash
git add worker/src/zendesk/client.ts
git commit -m "feat(worker): add ZendeskClient class for API interactions"
```

---

### Task 3: Create Zendesk Types and Constants

**Files:**
- Create: `worker/src/zendesk/types.ts`

**Step 1: Write types file**

Create `worker/src/zendesk/types.ts`:

```typescript
// ABOUTME: Type definitions for Zendesk integration
// ABOUTME: Includes custom field IDs, webhook payloads, and threshold config

// Custom field IDs - these need to be configured in Zendesk Admin
// and the actual IDs filled in after creation
export const ZENDESK_CUSTOM_FIELDS = {
  NOSTR_PUBKEY: 0,        // TODO: Replace with actual field ID
  NOSTR_EVENT_ID: 0,      // TODO: Replace with actual field ID
  NOSTR_NPUB: 0,          // TODO: Replace with actual field ID
  REPORT_TYPE: 0,         // TODO: Replace with actual field ID
  RISK_LEVEL: 0,          // TODO: Replace with actual field ID
  ACTION_REQUESTED: 0,    // TODO: Replace with actual field ID
  ACTION_STATUS: 0,       // TODO: Replace with actual field ID
  CONTEXT_URL: 0,         // TODO: Replace with actual field ID
} as const;

export type ReportType = 'spam' | 'illegal' | 'impersonation' | 'nudity' | 'harassment' | 'other';
export type RiskLevel = 'low' | 'medium' | 'high' | 'critical';
export type ActionRequested = 'none' | 'ban_user' | 'allow_user' | 'delete_event' | 'mark_safe' | 'age_restrict';
export type ActionStatus = 'pending' | 'in_progress' | 'executed' | 'failed';

export interface ZendeskWebhookPayload {
  ticket_id: number;
  ticket_url: string;
  current_user_id: number;
  current_user_email: string;
  custom_fields: {
    nostr_pubkey?: string;
    nostr_event_id?: string;
    action_requested?: ActionRequested;
    action_status?: ActionStatus;
  };
}

export interface ThresholdConfig {
  createTicketOnFirstReport: boolean;
  reportCountThreshold: number;
  aiRiskLevelThreshold: RiskLevel;
  mediaFlaggedAutoTicket: boolean;
  logAllModActionsToZendesk: boolean;
}

export const DEFAULT_THRESHOLDS: ThresholdConfig = {
  createTicketOnFirstReport: true,
  reportCountThreshold: 1,
  aiRiskLevelThreshold: 'high',
  mediaFlaggedAutoTicket: true,
  logAllModActionsToZendesk: false,
};

export interface ModerationTicketData {
  pubkey: string;
  npub: string;
  eventId?: string;
  reportType?: ReportType;
  riskLevel?: RiskLevel;
  reporterPubkey?: string;
  reportReason?: string;
  aiSummary?: string;
  recentPosts?: Array<{ content: string; created_at: number }>;
  existingLabels?: string[];
  previousDecisions?: Array<{ action: string; created_at: string }>;
}
```

**Step 2: Commit**

```bash
git add worker/src/zendesk/types.ts
git commit -m "feat(worker): add Zendesk types and constants"
```

---

### Task 4: Create Ticket Builder

**Files:**
- Create: `worker/src/zendesk/ticketBuilder.ts`

**Step 1: Write ticket builder**

Create `worker/src/zendesk/ticketBuilder.ts`:

```typescript
// ABOUTME: Builds formatted Zendesk tickets from Nostr moderation data
// ABOUTME: Converts Nostr context into readable ticket content

import { nip19 } from 'nostr-tools';
import type { ZendeskTicket } from './client';
import type { ModerationTicketData, RiskLevel } from './types';
import { ZENDESK_CUSTOM_FIELDS } from './types';

export function buildModerationTicket(data: ModerationTicketData): ZendeskTicket {
  const subject = buildSubject(data);
  const description = buildDescription(data);
  const priority = riskToPriority(data.riskLevel);
  const tags = buildTags(data);
  const customFields = buildCustomFields(data);

  return {
    subject,
    description,
    priority,
    tags,
    custom_fields: customFields,
  };
}

function buildSubject(data: ModerationTicketData): string {
  const riskBadge = data.riskLevel ? `[${data.riskLevel.toUpperCase()}]` : '';
  const reportType = data.reportType || 'moderation';
  const shortPubkey = data.pubkey.slice(0, 8);

  return `${riskBadge} Nostr ${reportType} report - ${shortPubkey}`.trim();
}

function buildDescription(data: ModerationTicketData): string {
  const sections: string[] = [];

  // Header
  sections.push('## Nostr Moderation Report\n');

  // User info
  sections.push(`**Reported User:** ${data.npub}`);
  sections.push(`**Pubkey:** \`${data.pubkey}\``);
  if (data.riskLevel) {
    sections.push(`**Risk Level:** ${data.riskLevel}`);
  }
  if (data.reportType) {
    sections.push(`**Report Type:** ${data.reportType}`);
  }
  sections.push('');

  // AI Summary
  if (data.aiSummary) {
    sections.push('### AI Analysis');
    sections.push(data.aiSummary);
    sections.push('');
  }

  // Report details
  if (data.reporterPubkey || data.reportReason) {
    sections.push('### Report Details');
    if (data.reporterPubkey) {
      try {
        const reporterNpub = nip19.npubEncode(data.reporterPubkey);
        sections.push(`- **Reporter:** ${reporterNpub}`);
      } catch {
        sections.push(`- **Reporter:** ${data.reporterPubkey}`);
      }
    }
    if (data.reportReason) {
      sections.push(`- **Reason:** ${data.reportReason}`);
    }
    if (data.eventId) {
      sections.push(`- **Event ID:** \`${data.eventId}\``);
    }
    sections.push('');
  }

  // Recent posts
  if (data.recentPosts && data.recentPosts.length > 0) {
    sections.push('### Recent Posts');
    const postsToShow = data.recentPosts.slice(0, 5);
    for (const post of postsToShow) {
      const date = new Date(post.created_at * 1000).toISOString();
      const content = post.content.slice(0, 200) + (post.content.length > 200 ? '...' : '');
      sections.push(`- [${date}] "${content}"`);
    }
    sections.push('');
  }

  // Existing labels
  if (data.existingLabels && data.existingLabels.length > 0) {
    sections.push('### Existing Labels');
    sections.push(data.existingLabels.map(l => `- ${l}`).join('\n'));
    sections.push('');
  }

  // Previous decisions
  if (data.previousDecisions && data.previousDecisions.length > 0) {
    sections.push('### Previous Moderation Decisions');
    for (const decision of data.previousDecisions.slice(0, 5)) {
      sections.push(`- [${decision.created_at}] ${decision.action}`);
    }
    sections.push('');
  }

  // Quick links
  sections.push('### Quick Links');
  sections.push(`- [View on njump.me](https://njump.me/${data.npub})`);
  if (data.eventId) {
    try {
      const nevent = nip19.neventEncode({ id: data.eventId });
      sections.push(`- [View Event](https://njump.me/${nevent})`);
    } catch {
      // Skip if encoding fails
    }
  }

  return sections.join('\n');
}

function riskToPriority(risk?: RiskLevel): 'low' | 'normal' | 'high' | 'urgent' {
  switch (risk) {
    case 'critical': return 'urgent';
    case 'high': return 'high';
    case 'medium': return 'normal';
    case 'low':
    default: return 'low';
  }
}

function buildTags(data: ModerationTicketData): string[] {
  const tags = ['nostr', 'moderation'];

  if (data.reportType) {
    tags.push(`report_${data.reportType}`);
  }
  if (data.riskLevel) {
    tags.push(`risk_${data.riskLevel}`);
  }

  return tags;
}

function buildCustomFields(data: ModerationTicketData): Array<{ id: number; value: string }> {
  const fields: Array<{ id: number; value: string }> = [];

  if (ZENDESK_CUSTOM_FIELDS.NOSTR_PUBKEY && data.pubkey) {
    fields.push({ id: ZENDESK_CUSTOM_FIELDS.NOSTR_PUBKEY, value: data.pubkey });
  }
  if (ZENDESK_CUSTOM_FIELDS.NOSTR_NPUB && data.npub) {
    fields.push({ id: ZENDESK_CUSTOM_FIELDS.NOSTR_NPUB, value: data.npub });
  }
  if (ZENDESK_CUSTOM_FIELDS.NOSTR_EVENT_ID && data.eventId) {
    fields.push({ id: ZENDESK_CUSTOM_FIELDS.NOSTR_EVENT_ID, value: data.eventId });
  }
  if (ZENDESK_CUSTOM_FIELDS.REPORT_TYPE && data.reportType) {
    fields.push({ id: ZENDESK_CUSTOM_FIELDS.REPORT_TYPE, value: data.reportType });
  }
  if (ZENDESK_CUSTOM_FIELDS.RISK_LEVEL && data.riskLevel) {
    fields.push({ id: ZENDESK_CUSTOM_FIELDS.RISK_LEVEL, value: data.riskLevel });
  }
  // Default action status to pending
  if (ZENDESK_CUSTOM_FIELDS.ACTION_STATUS) {
    fields.push({ id: ZENDESK_CUSTOM_FIELDS.ACTION_STATUS, value: 'pending' });
  }
  // Default action requested to none
  if (ZENDESK_CUSTOM_FIELDS.ACTION_REQUESTED) {
    fields.push({ id: ZENDESK_CUSTOM_FIELDS.ACTION_REQUESTED, value: 'none' });
  }

  return fields;
}
```

**Step 2: Commit**

```bash
git add worker/src/zendesk/ticketBuilder.ts
git commit -m "feat(worker): add ticket builder for Nostr moderation context"
```

---

### Task 5: Create Zendesk Index Export

**Files:**
- Create: `worker/src/zendesk/index.ts`

**Step 1: Write index file**

Create `worker/src/zendesk/index.ts`:

```typescript
// ABOUTME: Re-exports all Zendesk integration modules
// ABOUTME: Single import point for Zendesk functionality

export { ZendeskClient } from './client';
export type { ZendeskTicket, ZendeskTicketResponse, ZendeskEnv } from './client';

export { buildModerationTicket } from './ticketBuilder';

export {
  ZENDESK_CUSTOM_FIELDS,
  DEFAULT_THRESHOLDS,
} from './types';

export type {
  ZendeskWebhookPayload,
  ThresholdConfig,
  ModerationTicketData,
  ReportType,
  RiskLevel,
  ActionRequested,
  ActionStatus,
} from './types';
```

**Step 2: Commit**

```bash
git add worker/src/zendesk/index.ts
git commit -m "feat(worker): add zendesk module index"
```

---

### Task 6: Add Create Ticket Endpoint

**Files:**
- Modify: `worker/src/index.ts`

**Step 1: Add import at top of file**

Add after existing imports (around line 3):

```typescript
import { ZendeskClient, buildModerationTicket, type ModerationTicketData } from './zendesk';
```

**Step 2: Add route handler in fetch function**

Add new route in the try block (around line 93, before the 404):

```typescript
      if (path === '/api/zendesk/create-ticket' && request.method === 'POST') {
        return handleZendeskCreateTicket(request, env, corsHeaders);
      }
```

**Step 3: Add handler function**

Add before the `publishToRelay` function (around line 728):

```typescript
async function handleZendeskCreateTicket(
  request: Request,
  env: Env,
  corsHeaders: Record<string, string>
): Promise<Response> {
  try {
    if (!env.ZENDESK_SUBDOMAIN || !env.ZENDESK_EMAIL || !env.ZENDESK_API_TOKEN) {
      return jsonResponse(
        { success: false, error: 'Zendesk not configured' },
        500,
        corsHeaders
      );
    }

    const body = await request.json() as ModerationTicketData;

    if (!body.pubkey) {
      return jsonResponse(
        { success: false, error: 'Missing required field: pubkey' },
        400,
        corsHeaders
      );
    }

    const client = new ZendeskClient(env);
    const ticket = buildModerationTicket(body);
    const result = await client.createTicket(ticket);

    // Log to D1 if available
    if (env.DB) {
      try {
        await env.DB.prepare(`
          INSERT INTO moderation_decisions (target_type, target_id, action, reason)
          VALUES (?, ?, ?, ?)
        `).bind(
          'pubkey',
          body.pubkey,
          'zendesk_ticket_created',
          `Zendesk ticket #${result.ticket.id}`
        ).run();
      } catch (dbError) {
        console.error('Failed to log Zendesk ticket creation:', dbError);
      }
    }

    return new Response(JSON.stringify({
      success: true,
      ticketId: result.ticket.id,
      ticketUrl: result.ticket.url,
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json', ...corsHeaders },
    });
  } catch (error) {
    console.error('Zendesk create ticket error:', error);
    return jsonResponse(
      { success: false, error: error instanceof Error ? error.message : 'Unknown error' },
      500,
      corsHeaders
    );
  }
}
```

**Step 4: Commit**

```bash
git add worker/src/index.ts
git commit -m "feat(worker): add /api/zendesk/create-ticket endpoint"
```

---

### Task 7: Add Webhook Handler Endpoint

**Files:**
- Modify: `worker/src/index.ts`

**Step 1: Add webhook route**

Add after the create-ticket route (around line 96):

```typescript
      if (path === '/api/zendesk/webhook' && request.method === 'POST') {
        return handleZendeskWebhook(request, env, corsHeaders);
      }
```

**Step 2: Add webhook handler function**

Add after `handleZendeskCreateTicket`:

```typescript
async function handleZendeskWebhook(
  request: Request,
  env: Env,
  corsHeaders: Record<string, string>
): Promise<Response> {
  try {
    // Verify webhook signature if secret is configured
    if (env.ZENDESK_WEBHOOK_SECRET) {
      const signature = request.headers.get('X-Zendesk-Webhook-Signature');
      const timestamp = request.headers.get('X-Zendesk-Webhook-Signature-Timestamp');

      if (!signature || !timestamp) {
        return jsonResponse(
          { success: false, error: 'Missing webhook signature' },
          401,
          corsHeaders
        );
      }

      const bodyText = await request.text();
      const isValid = await verifyZendeskSignature(bodyText, signature, timestamp, env.ZENDESK_WEBHOOK_SECRET);

      if (!isValid) {
        return jsonResponse(
          { success: false, error: 'Invalid webhook signature' },
          401,
          corsHeaders
        );
      }

      // Parse the body we already read
      const payload = JSON.parse(bodyText);
      return processZendeskWebhook(payload, env, corsHeaders);
    }

    // No signature verification - parse body directly
    const payload = await request.json();
    return processZendeskWebhook(payload, env, corsHeaders);
  } catch (error) {
    console.error('Zendesk webhook error:', error);
    return jsonResponse(
      { success: false, error: error instanceof Error ? error.message : 'Unknown error' },
      500,
      corsHeaders
    );
  }
}

async function verifyZendeskSignature(
  payload: string,
  signature: string,
  timestamp: string,
  secret: string
): Promise<boolean> {
  const signedPayload = `${timestamp}.${payload}`;
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(signedPayload));
  const expectedSig = Array.from(new Uint8Array(sig))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');

  return signature === expectedSig;
}

async function processZendeskWebhook(
  payload: { ticket_id: number; current_user_email?: string; custom_fields?: Record<string, string> },
  env: Env,
  corsHeaders: Record<string, string>
): Promise<Response> {
  const { ticket_id, current_user_email, custom_fields } = payload;

  if (!custom_fields) {
    return jsonResponse({ success: true, message: 'No custom fields to process' }, 200, corsHeaders);
  }

  const actionRequested = custom_fields.action_requested;
  const pubkey = custom_fields.nostr_pubkey;
  const eventId = custom_fields.nostr_event_id;

  if (!actionRequested || actionRequested === 'none') {
    return jsonResponse({ success: true, message: 'No action requested' }, 200, corsHeaders);
  }

  // Update ticket status to in_progress
  if (env.ZENDESK_SUBDOMAIN && env.ZENDESK_EMAIL && env.ZENDESK_API_TOKEN) {
    const client = new ZendeskClient(env);
    await client.addTicketComment(ticket_id, `Processing action: ${actionRequested}`, false);
  }

  try {
    // Execute the requested action
    let actionResult: { success: boolean; error?: string };

    switch (actionRequested) {
      case 'ban_user':
        if (!pubkey) throw new Error('Missing pubkey for ban_user action');
        actionResult = await executeRelayRpc(env, 'banpubkey', [pubkey, `Banned via Zendesk ticket #${ticket_id}`]);
        break;

      case 'allow_user':
        if (!pubkey) throw new Error('Missing pubkey for allow_user action');
        actionResult = await executeRelayRpc(env, 'allowpubkey', [pubkey]);
        break;

      case 'delete_event':
        if (!eventId) throw new Error('Missing eventId for delete_event action');
        actionResult = await executeRelayRpc(env, 'deleteevent', [eventId, `Deleted via Zendesk ticket #${ticket_id}`]);
        break;

      case 'mark_safe':
        // Mark as safe - no relay action needed, just update ticket
        actionResult = { success: true };
        break;

      default:
        throw new Error(`Unknown action: ${actionRequested}`);
    }

    // Log decision to D1
    if (env.DB && pubkey) {
      await env.DB.prepare(`
        INSERT INTO moderation_decisions (target_type, target_id, action, reason, moderator_email)
        VALUES (?, ?, ?, ?, ?)
      `).bind(
        eventId ? 'event' : 'pubkey',
        eventId || pubkey,
        actionRequested,
        `Executed via Zendesk ticket #${ticket_id}`,
        current_user_email || null
      ).run();
    }

    // Update ticket with result
    if (env.ZENDESK_SUBDOMAIN && env.ZENDESK_EMAIL && env.ZENDESK_API_TOKEN) {
      const client = new ZendeskClient(env);
      if (actionResult.success) {
        await client.addTicketComment(ticket_id, `Action "${actionRequested}" executed successfully`, false);
      } else {
        await client.addTicketComment(ticket_id, `Action "${actionRequested}" failed: ${actionResult.error}`, false);
      }
    }

    return jsonResponse({
      success: actionResult.success,
      action: actionRequested,
      ticketId: ticket_id,
    }, 200, corsHeaders);

  } catch (error) {
    // Update ticket with error
    if (env.ZENDESK_SUBDOMAIN && env.ZENDESK_EMAIL && env.ZENDESK_API_TOKEN) {
      const client = new ZendeskClient(env);
      await client.addTicketComment(
        ticket_id,
        `Action failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
        false
      );
    }

    throw error;
  }
}

async function executeRelayRpc(
  env: Env,
  method: string,
  params: (string | number)[]
): Promise<{ success: boolean; error?: string }> {
  // Reuse existing relay RPC logic
  const secretKey = getSecretKey(env);
  const httpUrl = env.RELAY_URL.replace(/^wss?:\/\//, 'https://');
  const payload = JSON.stringify({ method, params });
  const payloadHash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(payload));
  const payloadHashHex = Array.from(new Uint8Array(payloadHash)).map(b => b.toString(16).padStart(2, '0')).join('');

  const authEvent = finalizeEvent(
    {
      kind: 27235,
      content: '',
      tags: [
        ['u', httpUrl],
        ['method', 'POST'],
        ['payload', payloadHashHex],
      ],
      created_at: Math.floor(Date.now() / 1000),
    },
    secretKey
  );

  const authHeader = `Nostr ${btoa(JSON.stringify(authEvent))}`;

  const response = await fetch(httpUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/nostr+json+rpc',
      'Authorization': authHeader,
    },
    body: payload,
  });

  if (!response.ok) {
    return { success: false, error: `Relay error: ${response.status}` };
  }

  const result = await response.json() as { result?: unknown; error?: string };

  if (result.error) {
    return { success: false, error: result.error };
  }

  return { success: true };
}
```

**Step 3: Commit**

```bash
git add worker/src/index.ts
git commit -m "feat(worker): add /api/zendesk/webhook endpoint for action execution"
```

---

### Task 8: Add Context API Endpoint for Sidebar App

**Files:**
- Modify: `worker/src/index.ts`

**Step 1: Add context route**

Add after the webhook route:

```typescript
      if (path === '/api/zendesk/context' && request.method === 'GET') {
        return handleZendeskContext(request, env, corsHeaders);
      }
```

**Step 2: Add context handler**

Add after `executeRelayRpc`:

```typescript
async function handleZendeskContext(
  request: Request,
  env: Env,
  corsHeaders: Record<string, string>
): Promise<Response> {
  try {
    const url = new URL(request.url);
    const pubkey = url.searchParams.get('pubkey');
    const eventId = url.searchParams.get('eventId');

    if (!pubkey) {
      return jsonResponse(
        { success: false, error: 'Missing pubkey parameter' },
        400,
        corsHeaders
      );
    }

    // Build context response
    const context: {
      pubkey: string;
      npub: string;
      eventId?: string;
      decisions: unknown[];
      summary?: { summary: string; riskLevel: string };
    } = {
      pubkey,
      npub: nip19.npubEncode(pubkey),
      decisions: [],
    };

    if (eventId) {
      context.eventId = eventId;
    }

    // Get decisions from D1
    if (env.DB) {
      try {
        const decisions = await env.DB.prepare(`
          SELECT * FROM moderation_decisions
          WHERE target_id = ? OR target_id = ?
          ORDER BY created_at DESC
          LIMIT 20
        `).bind(pubkey, eventId || '').all();

        context.decisions = decisions.results || [];
      } catch {
        // D1 might not be available
      }
    }

    // Get cached AI summary if available
    if (env.KV) {
      const cached = await env.KV.get(`summary:${pubkey}`);
      if (cached) {
        try {
          context.summary = JSON.parse(cached);
        } catch {
          // Ignore parse errors
        }
      }
    }

    return new Response(JSON.stringify(context), {
      status: 200,
      headers: { 'Content-Type': 'application/json', ...corsHeaders },
    });
  } catch (error) {
    console.error('Zendesk context error:', error);
    return jsonResponse(
      { success: false, error: error instanceof Error ? error.message : 'Unknown error' },
      500,
      corsHeaders
    );
  }
}
```

**Step 3: Add nip19 import at top if not present**

Check if `nip19` is imported. If not, ensure the import line includes it:

```typescript
import { finalizeEvent, nip19, getPublicKey } from 'nostr-tools';
```

**Step 4: Commit**

```bash
git add worker/src/index.ts
git commit -m "feat(worker): add /api/zendesk/context endpoint for sidebar app"
```

---

### Task 9: Add Pending Actions Polling Endpoint

**Files:**
- Modify: `worker/src/index.ts`

**Step 1: Add route**

Add after context route:

```typescript
      if (path === '/api/zendesk/pending-actions' && request.method === 'GET') {
        return handleZendeskPendingActions(env, corsHeaders);
      }
```

**Step 2: Add handler**

Add after `handleZendeskContext`:

```typescript
async function handleZendeskPendingActions(
  env: Env,
  corsHeaders: Record<string, string>
): Promise<Response> {
  try {
    if (!env.ZENDESK_SUBDOMAIN || !env.ZENDESK_EMAIL || !env.ZENDESK_API_TOKEN) {
      return jsonResponse(
        { success: false, error: 'Zendesk not configured' },
        500,
        corsHeaders
      );
    }

    const client = new ZendeskClient(env);

    // Search for tickets with pending actions
    // Note: This requires custom field IDs to be configured
    const searchQuery = 'type:ticket status:open tags:nostr tags:moderation';
    const results = await client.searchTickets(searchQuery);

    return new Response(JSON.stringify({
      success: true,
      pendingCount: results.results.length,
      tickets: results.results,
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json', ...corsHeaders },
    });
  } catch (error) {
    console.error('Zendesk pending actions error:', error);
    return jsonResponse(
      { success: false, error: error instanceof Error ? error.message : 'Unknown error' },
      500,
      corsHeaders
    );
  }
}
```

**Step 3: Commit**

```bash
git add worker/src/index.ts
git commit -m "feat(worker): add /api/zendesk/pending-actions polling endpoint"
```

---

## Phase 2: Zendesk Sidebar App

### Task 10: Scaffold Zendesk App

**Files:**
- Create: `zendesk-app/package.json`
- Create: `zendesk-app/manifest.json`
- Create: `zendesk-app/tsconfig.json`
- Create: `zendesk-app/vite.config.ts`
- Create: `zendesk-app/index.html`

**Step 1: Create directory**

```bash
mkdir -p zendesk-app/src
```

**Step 2: Create package.json**

Create `zendesk-app/package.json`:

```json
{
  "name": "manvrelay-zendesk-app",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "tsc && vite build",
    "preview": "vite preview"
  },
  "dependencies": {
    "react": "^18.2.0",
    "react-dom": "^18.2.0"
  },
  "devDependencies": {
    "@types/react": "^18.2.0",
    "@types/react-dom": "^18.2.0",
    "@vitejs/plugin-react": "^4.2.0",
    "typescript": "^5.3.0",
    "vite": "^5.0.0"
  }
}
```

**Step 3: Create manifest.json**

Create `zendesk-app/manifest.json`:

```json
{
  "name": "Nostr Moderation Context",
  "author": {
    "name": "ManVRelay",
    "email": "support@divine.video"
  },
  "defaultLocale": "en",
  "private": true,
  "location": {
    "support": {
      "ticket_sidebar": {
        "url": "assets/index.html"
      }
    }
  },
  "version": "0.1.0",
  "frameworkVersion": "2.0",
  "parameters": [
    {
      "name": "workerApiUrl",
      "type": "text",
      "required": true,
      "default": "https://your-worker.workers.dev"
    },
    {
      "name": "apiKey",
      "type": "text",
      "required": false,
      "secure": true
    }
  ]
}
```

**Step 4: Create tsconfig.json**

Create `zendesk-app/tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2020",
    "useDefineForClassFields": true,
    "lib": ["ES2020", "DOM", "DOM.Iterable"],
    "module": "ESNext",
    "skipLibCheck": true,
    "moduleResolution": "bundler",
    "allowImportingTsExtensions": true,
    "resolveJsonModule": true,
    "isolatedModules": true,
    "noEmit": true,
    "jsx": "react-jsx",
    "strict": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "noFallthroughCasesInSwitch": true
  },
  "include": ["src"]
}
```

**Step 5: Create vite.config.ts**

Create `zendesk-app/vite.config.ts`:

```typescript
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  base: './',
  build: {
    outDir: 'dist/assets',
    assetsDir: '.',
  },
});
```

**Step 6: Create index.html**

Create `zendesk-app/index.html`:

```html
<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Nostr Context</title>
    <script src="https://static.zdassets.com/zendesk_app_framework_sdk/2.0/zaf_sdk.min.js"></script>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

**Step 7: Commit**

```bash
git add zendesk-app/
git commit -m "feat(zendesk-app): scaffold Zendesk sidebar app"
```

---

### Task 11: Create Zendesk App Entry Point

**Files:**
- Create: `zendesk-app/src/main.tsx`
- Create: `zendesk-app/src/App.tsx`
- Create: `zendesk-app/src/index.css`
- Create: `zendesk-app/src/vite-env.d.ts`

**Step 1: Create main.tsx**

Create `zendesk-app/src/main.tsx`:

```tsx
// ABOUTME: Entry point for Zendesk sidebar app
// ABOUTME: Initializes ZAF SDK and renders React app

import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './index.css';

declare global {
  interface Window {
    ZAFClient: {
      init: () => ZAFClientInstance;
    };
  }
}

interface ZAFClientInstance {
  get: (path: string) => Promise<Record<string, unknown>>;
  invoke: (action: string, ...args: unknown[]) => Promise<unknown>;
  metadata: () => Promise<{ settings: Record<string, string> }>;
}

// Initialize ZAF client
const client = window.ZAFClient.init();

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App client={client} />
  </React.StrictMode>
);
```

**Step 2: Create App.tsx**

Create `zendesk-app/src/App.tsx`:

```tsx
// ABOUTME: Main Zendesk sidebar app component
// ABOUTME: Displays Nostr user context and action buttons

import { useState, useEffect } from 'react';

interface ZAFClientInstance {
  get: (path: string) => Promise<Record<string, unknown>>;
  invoke: (action: string, ...args: unknown[]) => Promise<unknown>;
  metadata: () => Promise<{ settings: Record<string, string> }>;
}

interface AppProps {
  client: ZAFClientInstance;
}

interface ContextData {
  pubkey: string;
  npub: string;
  eventId?: string;
  decisions: Array<{ action: string; created_at: string; reason?: string }>;
  summary?: { summary: string; riskLevel: string };
}

export default function App({ client }: AppProps) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [context, setContext] = useState<ContextData | null>(null);
  const [settings, setSettings] = useState<{ workerApiUrl: string; apiKey?: string } | null>(null);

  useEffect(() => {
    async function init() {
      try {
        // Get app settings
        const metadata = await client.metadata();
        const appSettings = {
          workerApiUrl: metadata.settings.workerApiUrl || '',
          apiKey: metadata.settings.apiKey,
        };
        setSettings(appSettings);

        // Get ticket custom fields
        const ticketData = await client.get('ticket.customField:nostr_pubkey');
        const pubkey = ticketData['ticket.customField:nostr_pubkey'] as string;

        if (!pubkey) {
          setError('No Nostr pubkey found on this ticket');
          setLoading(false);
          return;
        }

        // Fetch context from worker
        const url = new URL(`${appSettings.workerApiUrl}/api/zendesk/context`);
        url.searchParams.set('pubkey', pubkey);

        const headers: Record<string, string> = {};
        if (appSettings.apiKey) {
          headers['X-API-Key'] = appSettings.apiKey;
        }

        const response = await fetch(url.toString(), { headers });
        if (!response.ok) {
          throw new Error(`Failed to fetch context: ${response.status}`);
        }

        const data = await response.json() as ContextData;
        setContext(data);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Unknown error');
      } finally {
        setLoading(false);
      }
    }

    init();
  }, [client]);

  if (loading) {
    return <div className="loading">Loading...</div>;
  }

  if (error) {
    return <div className="error">{error}</div>;
  }

  if (!context) {
    return <div className="empty">No context available</div>;
  }

  return (
    <div className="app">
      <header>
        <h2>Nostr Context</h2>
        {context.summary && (
          <span className={`risk-badge risk-${context.summary.riskLevel}`}>
            {context.summary.riskLevel}
          </span>
        )}
      </header>

      <section className="user-info">
        <div className="npub" title={context.pubkey}>
          {context.npub.slice(0, 20)}...
        </div>
        <a
          href={`https://njump.me/${context.npub}`}
          target="_blank"
          rel="noopener noreferrer"
        >
          View Profile
        </a>
      </section>

      {context.summary && (
        <section className="summary">
          <h3>AI Summary</h3>
          <p>{context.summary.summary}</p>
        </section>
      )}

      {context.decisions.length > 0 && (
        <section className="decisions">
          <h3>Moderation History</h3>
          <ul>
            {context.decisions.slice(0, 5).map((d, i) => (
              <li key={i}>
                <span className="action">{d.action}</span>
                <span className="date">{d.created_at}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="actions">
        <h3>Quick Actions</h3>
        <div className="button-group">
          <ActionButton client={client} action="ban_user" label="Ban User" variant="danger" />
          <ActionButton client={client} action="allow_user" label="Allow User" variant="success" />
          <ActionButton client={client} action="mark_safe" label="Mark Safe" variant="neutral" />
        </div>
      </section>
    </div>
  );
}

interface ActionButtonProps {
  client: ZAFClientInstance;
  action: string;
  label: string;
  variant: 'danger' | 'success' | 'neutral';
}

function ActionButton({ client, action, label, variant }: ActionButtonProps) {
  const [loading, setLoading] = useState(false);

  async function handleClick() {
    setLoading(true);
    try {
      // Update ticket custom field - this will trigger webhook
      await client.invoke('ticket.customField:action_requested', action);
      await client.invoke('ticket.customField:action_status', 'pending');
    } catch (err) {
      console.error('Failed to set action:', err);
    } finally {
      setLoading(false);
    }
  }

  return (
    <button
      className={`action-btn ${variant}`}
      onClick={handleClick}
      disabled={loading}
    >
      {loading ? '...' : label}
    </button>
  );
}
```

**Step 3: Create index.css**

Create `zendesk-app/src/index.css`:

```css
/* ABOUTME: Styles for Zendesk sidebar app */
/* ABOUTME: Minimal, compact design for sidebar constraints */

* {
  box-sizing: border-box;
  margin: 0;
  padding: 0;
}

body {
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
  font-size: 13px;
  line-height: 1.4;
  color: #2f3941;
  background: #fff;
}

.app {
  padding: 12px;
}

header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 12px;
  padding-bottom: 8px;
  border-bottom: 1px solid #d8dcde;
}

header h2 {
  font-size: 14px;
  font-weight: 600;
}

.risk-badge {
  font-size: 11px;
  font-weight: 500;
  padding: 2px 6px;
  border-radius: 3px;
  text-transform: uppercase;
}

.risk-low { background: #e6f4ea; color: #137333; }
.risk-medium { background: #fef7e0; color: #b45309; }
.risk-high { background: #fce8e6; color: #c5221f; }
.risk-critical { background: #c5221f; color: #fff; }

section {
  margin-bottom: 16px;
}

section h3 {
  font-size: 12px;
  font-weight: 600;
  color: #68737d;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  margin-bottom: 6px;
}

.user-info {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.npub {
  font-family: monospace;
  font-size: 12px;
  color: #49545c;
}

.user-info a {
  font-size: 12px;
  color: #1f73b7;
  text-decoration: none;
}

.user-info a:hover {
  text-decoration: underline;
}

.summary p {
  font-size: 13px;
  color: #49545c;
}

.decisions ul {
  list-style: none;
}

.decisions li {
  display: flex;
  justify-content: space-between;
  padding: 4px 0;
  font-size: 12px;
  border-bottom: 1px solid #f3f4f5;
}

.decisions .action {
  font-weight: 500;
}

.decisions .date {
  color: #87929d;
}

.button-group {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}

.action-btn {
  flex: 1;
  min-width: 80px;
  padding: 6px 10px;
  font-size: 12px;
  font-weight: 500;
  border: 1px solid;
  border-radius: 4px;
  cursor: pointer;
  transition: background-color 0.15s;
}

.action-btn:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.action-btn.danger {
  background: #fff;
  border-color: #cc3340;
  color: #cc3340;
}

.action-btn.danger:hover:not(:disabled) {
  background: #cc3340;
  color: #fff;
}

.action-btn.success {
  background: #fff;
  border-color: #038153;
  color: #038153;
}

.action-btn.success:hover:not(:disabled) {
  background: #038153;
  color: #fff;
}

.action-btn.neutral {
  background: #fff;
  border-color: #68737d;
  color: #68737d;
}

.action-btn.neutral:hover:not(:disabled) {
  background: #68737d;
  color: #fff;
}

.loading, .error, .empty {
  padding: 20px;
  text-align: center;
  color: #68737d;
}

.error {
  color: #cc3340;
}
```

**Step 4: Create vite-env.d.ts**

Create `zendesk-app/src/vite-env.d.ts`:

```typescript
/// <reference types="vite/client" />
```

**Step 5: Commit**

```bash
git add zendesk-app/src/
git commit -m "feat(zendesk-app): add main app component with context display and actions"
```

---

### Task 12: Add Zendesk App README

**Files:**
- Create: `zendesk-app/README.md`

**Step 1: Create README**

Create `zendesk-app/README.md`:

```markdown
# ManVRelay Zendesk Sidebar App

Zendesk sidebar app that displays Nostr user context for moderation tickets.

## Features

- Displays Nostr user profile info (npub, pubkey)
- Shows AI-generated risk assessment
- Lists moderation history
- Quick action buttons (Ban, Allow, Mark Safe)

## Setup

### 1. Install Dependencies

```bash
cd zendesk-app
npm install
```

### 2. Configure Custom Fields in Zendesk

Create these custom ticket fields in Zendesk Admin > Objects and rules > Tickets > Fields:

| Field Name | Field Type | Field ID |
|------------|------------|----------|
| nostr_pubkey | Text | (note the ID) |
| nostr_event_id | Text | (note the ID) |
| action_requested | Dropdown | (note the ID) |
| action_status | Dropdown | (note the ID) |

For dropdown fields, add these options:
- action_requested: none, ban_user, allow_user, delete_event, mark_safe
- action_status: pending, in_progress, executed, failed

### 3. Update Field IDs

Update the field IDs in `worker/src/zendesk/types.ts` with the actual IDs from Zendesk.

### 4. Create Webhook in Zendesk

Go to Zendesk Admin > Apps and integrations > Webhooks:

1. Create webhook pointing to: `https://your-worker.workers.dev/api/zendesk/webhook`
2. Create trigger that fires webhook when `action_requested` field changes

### 5. Build and Deploy App

```bash
npm run build
```

Then package and upload to Zendesk:
1. Copy `manifest.json` to `dist/`
2. Zip the `dist/` folder
3. Upload in Zendesk Admin > Apps and integrations > Zendesk apps > Manage

### 6. Configure App Settings

When installing the app, configure:
- `workerApiUrl`: Your CF Worker URL (e.g., https://divine-relay-admin.workers.dev)
- `apiKey`: Optional API key for authentication

## Development

```bash
npm run dev
```

Note: The ZAF SDK only works when loaded inside Zendesk, so local development requires using ZCLI or uploading a dev build.
```

**Step 2: Commit**

```bash
git add zendesk-app/README.md
git commit -m "docs(zendesk-app): add setup instructions"
```

---

## Phase 3: Integration Points

### Task 13: Add Zendesk Ticket Creation to Existing Handlers

**Files:**
- Modify: `worker/src/index.ts`

**Step 1: Create helper function**

Add after the imports, before `export default`:

```typescript
// Helper to optionally create Zendesk ticket
async function maybeCreateZendeskTicket(
  env: Env,
  data: ModerationTicketData
): Promise<{ ticketId?: number; error?: string }> {
  if (!env.ZENDESK_SUBDOMAIN || !env.ZENDESK_EMAIL || !env.ZENDESK_API_TOKEN) {
    return {}; // Zendesk not configured, skip silently
  }

  try {
    const client = new ZendeskClient(env);
    const ticket = buildModerationTicket(data);
    const result = await client.createTicket(ticket);
    return { ticketId: result.ticket.id };
  } catch (error) {
    console.error('Failed to create Zendesk ticket:', error);
    return { error: error instanceof Error ? error.message : 'Unknown error' };
  }
}
```

**Step 2: Modify handleSummarizeUser to create tickets for high-risk users**

Find the `handleSummarizeUser` function and add ticket creation after caching:

```typescript
    // After: await env.KV?.put(cacheKey, JSON.stringify(result), { expirationTtl: 3600 });

    // Create Zendesk ticket for high/critical risk users
    if (result.riskLevel === 'high' || result.riskLevel === 'critical') {
      await maybeCreateZendeskTicket(env, {
        pubkey: body.pubkey,
        npub: nip19.npubEncode(body.pubkey),
        riskLevel: result.riskLevel,
        aiSummary: result.summary,
        recentPosts: body.recentPosts,
      });
    }
```

**Step 3: Commit**

```bash
git add worker/src/index.ts
git commit -m "feat(worker): auto-create Zendesk tickets for high-risk users"
```

---

### Task 14: Update D1 Schema for Zendesk References

**Files:**
- Modify: `worker/src/index.ts`

**Step 1: Update ensureDecisionsTable**

Modify the `ensureDecisionsTable` function to include new columns:

```typescript
async function ensureDecisionsTable(db: D1Database): Promise<void> {
  await db.prepare(`
    CREATE TABLE IF NOT EXISTS moderation_decisions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      target_type TEXT NOT NULL,
      target_id TEXT NOT NULL,
      action TEXT NOT NULL,
      reason TEXT,
      moderator_pubkey TEXT,
      moderator_email TEXT,
      report_id TEXT,
      zendesk_ticket_id INTEGER,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `).run();

  // Create indexes
  try {
    await db.prepare(`CREATE INDEX IF NOT EXISTS idx_decisions_target ON moderation_decisions(target_type, target_id)`).run();
  } catch { /* Index might already exist */ }

  try {
    await db.prepare(`CREATE INDEX IF NOT EXISTS idx_decisions_report ON moderation_decisions(report_id)`).run();
  } catch { /* Index might already exist */ }

  try {
    await db.prepare(`CREATE INDEX IF NOT EXISTS idx_decisions_zendesk ON moderation_decisions(zendesk_ticket_id)`).run();
  } catch { /* Index might already exist */ }
}
```

**Step 2: Commit**

```bash
git add worker/src/index.ts
git commit -m "feat(worker): add zendesk columns to moderation_decisions table"
```

---

### Task 15: Add Frontend API Client

**Files:**
- Create: `src/lib/zendeskApi.ts`

**Step 1: Create Zendesk API client for frontend**

Create `src/lib/zendeskApi.ts`:

```typescript
// ABOUTME: Frontend API client for Zendesk integration endpoints
// ABOUTME: Used by React admin UI to trigger Zendesk ticket creation

import { getWorkerUrl } from './adminApi';

interface CreateTicketParams {
  pubkey: string;
  npub: string;
  eventId?: string;
  reportType?: string;
  riskLevel?: string;
  reporterPubkey?: string;
  reportReason?: string;
  aiSummary?: string;
}

interface CreateTicketResponse {
  success: boolean;
  ticketId?: number;
  ticketUrl?: string;
  error?: string;
}

export async function createZendeskTicket(params: CreateTicketParams): Promise<CreateTicketResponse> {
  const workerUrl = getWorkerUrl();

  const response = await fetch(`${workerUrl}/api/zendesk/create-ticket`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(params),
  });

  return response.json();
}

export async function checkZendeskConfig(): Promise<boolean> {
  const workerUrl = getWorkerUrl();

  try {
    const response = await fetch(`${workerUrl}/api/zendesk/pending-actions`);
    const data = await response.json();
    return data.success === true;
  } catch {
    return false;
  }
}
```

**Step 2: Commit**

```bash
git add src/lib/zendeskApi.ts
git commit -m "feat(frontend): add Zendesk API client for ticket creation"
```

---

## Phase 4: Testing & Documentation

### Task 16: Add Worker Tests for Zendesk Endpoints

**Files:**
- Create: `worker/src/zendesk/client.test.ts`

**Step 1: Create test file**

Create `worker/src/zendesk/client.test.ts`:

```typescript
// ABOUTME: Tests for ZendeskClient API wrapper
// ABOUTME: Uses mock fetch to verify API calls

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ZendeskClient } from './client';

describe('ZendeskClient', () => {
  const mockEnv = {
    ZENDESK_SUBDOMAIN: 'test',
    ZENDESK_EMAIL: 'test@example.com',
    ZENDESK_API_TOKEN: 'test-token',
  };

  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('throws error if configuration is incomplete', () => {
    expect(() => new ZendeskClient({})).toThrow('Zendesk configuration incomplete');
  });

  it('constructs correct base URL', () => {
    const client = new ZendeskClient(mockEnv);
    // Access private property for testing
    expect((client as unknown as { baseUrl: string }).baseUrl).toBe('https://test.zendesk.com/api/v2');
  });

  it('creates ticket with correct payload', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ ticket: { id: 123, url: 'https://test.zendesk.com/tickets/123' } }),
    });
    global.fetch = mockFetch;

    const client = new ZendeskClient(mockEnv);
    const result = await client.createTicket({
      subject: 'Test ticket',
      description: 'Test description',
    });

    expect(result.ticket.id).toBe(123);
    expect(mockFetch).toHaveBeenCalledWith(
      'https://test.zendesk.com/api/v2/tickets.json',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          'Content-Type': 'application/json',
        }),
      })
    );
  });
});
```

**Step 2: Commit**

```bash
git add worker/src/zendesk/client.test.ts
git commit -m "test(worker): add ZendeskClient unit tests"
```

---

### Task 17: Update Design Document with Implementation Notes

**Files:**
- Modify: `docs/plans/2025-12-07-zendesk-integration-design.md`

**Step 1: Add implementation status section**

Add at the end of the design document:

```markdown

---

## Implementation Status

### Completed
- [ ] Worker: ZendeskClient class
- [ ] Worker: Ticket builder
- [ ] Worker: Create ticket endpoint
- [ ] Worker: Webhook handler
- [ ] Worker: Context API endpoint
- [ ] Worker: Polling endpoint
- [ ] Sidebar App: Scaffold
- [ ] Sidebar App: Context display
- [ ] Sidebar App: Action buttons
- [ ] Frontend: API client
- [ ] Tests: ZendeskClient

### Zendesk Setup Required
After deploying, complete these manual steps in Zendesk Admin:

1. Create custom ticket fields (see zendesk-app/README.md)
2. Note field IDs and update `worker/src/zendesk/types.ts`
3. Create webhook trigger for action_requested field changes
4. Upload and install sidebar app
5. Configure app settings with worker URL

### Environment Variables Required
Add to wrangler.toml or Cloudflare dashboard:
- `ZENDESK_SUBDOMAIN`
- `ZENDESK_EMAIL`
- `ZENDESK_API_TOKEN`
- `ZENDESK_WEBHOOK_SECRET` (optional, for signature verification)
```

**Step 2: Commit**

```bash
git add docs/plans/2025-12-07-zendesk-integration-design.md
git commit -m "docs: add implementation status to design document"
```

---

## Summary

**Total Tasks:** 17

**Phase 1 (Worker Core):** Tasks 1-9
- Environment variables
- ZendeskClient class
- Types and constants
- Ticket builder
- Create ticket endpoint
- Webhook handler
- Context API
- Polling endpoint

**Phase 2 (Sidebar App):** Tasks 10-12
- App scaffold
- Main component
- Documentation

**Phase 3 (Integration):** Tasks 13-15
- Auto-ticket on high-risk users
- D1 schema updates
- Frontend API client

**Phase 4 (Testing/Docs):** Tasks 16-17
- Unit tests
- Design doc updates

Each task is 2-5 minutes of focused work with a commit checkpoint.
