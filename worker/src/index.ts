// ABOUTME: CF Worker that signs and publishes Nostr events for Divine Relay Admin
// ABOUTME: Holds the relay admin nsec in secrets and handles NIP-86 moderation actions

import { finalizeEvent, nip19, getPublicKey } from 'nostr-tools';

// Secrets Store secret object (for account-level secrets)
interface SecretStoreSecret {
  get(): Promise<string>;
}

interface Env {
  NOSTR_NSEC: string | SecretStoreSecret;
  RELAY_URL: string;
  ALLOWED_ORIGINS: string;
  ANTHROPIC_API_KEY?: string;
  // Cloudflare Access Service Token for moderation.admin.divine.video
  CF_ACCESS_CLIENT_ID?: string;
  CF_ACCESS_CLIENT_SECRET?: string;
  // Service binding to divine-realness worker (bypasses CF Access)
  REALNESS?: Fetcher;
  // Zendesk integration
  ZENDESK_SUBDOMAIN?: string;
  ZENDESK_JWT_SECRET?: string;
  ZENDESK_WEBHOOK_SECRET?: string;  // For /api/zendesk/webhook
  ZENDESK_PARSE_REPORT_SECRET?: string;  // For /api/zendesk/parse-report
  ZENDESK_API_TOKEN?: string;
  ZENDESK_EMAIL?: string;
  ZENDESK_FIELD_ACTION_STATUS?: string;
  ZENDESK_FIELD_ACTION_REQUESTED?: string;
  KV?: KVNamespace;
  DB?: D1Database;
  // Relay management configuration
  MANAGEMENT_PATH?: string;  // Path for NIP-86 management API, defaults to "/management"
  MANAGEMENT_URL?: string;   // Full URL override for NIP-86 management API (for local dev with HTTP)
  MODERATION_SERVICE_URL?: string;  // URL for media moderation service
  REALNESS_API_URL?: string;  // URL for AI detection/realness service
}

// Zendesk JWT payload structure
interface ZendeskJWTPayload {
  iss: string;
  iat: number;
  exp: number;
  email: string;
  name: string;
  external_id?: string;
}

const DEFAULT_MODERATION_SERVICE_URL = 'https://moderation.admin.divine.video';
const DEFAULT_REALNESS_API_URL = 'https://realness.admin.divine.video';

/**
 * Get the NIP-86 management API URL for the configured relay.
 * If MANAGEMENT_URL is set (for local dev with HTTP), use it directly.
 * Otherwise, converts WSS relay URL to HTTPS and appends the management path.
 */
function getManagementUrl(env: Env): string {
  if (env.MANAGEMENT_URL) {
    return env.MANAGEMENT_URL;
  }
  const baseUrl = env.RELAY_URL.replace(/^wss?:\/\//, 'https://');
  const managementPath = env.MANAGEMENT_PATH || '/management';
  return `${baseUrl}${managementPath}`;
}

/**
 * Get the moderation service URL from env or use default.
 */
function getModerationServiceUrl(env: Env): string {
  return env.MODERATION_SERVICE_URL || DEFAULT_MODERATION_SERVICE_URL;
}

function getAllowedOrigin(requestOrigin: string | null, allowedOriginsEnv: string | undefined): string {
  if (!allowedOriginsEnv?.trim()) return '';

  const allowedOrigins = allowedOriginsEnv.split(',').map(o => o.trim());
  if (!requestOrigin) return allowedOrigins[0] || '';

  for (const allowed of allowedOrigins) {
    if (allowed.startsWith('*.') && requestOrigin.endsWith(allowed.slice(1))) {
      return requestOrigin;
    }
    if (requestOrigin === allowed) {
      return requestOrigin;
    }
  }

  return allowedOrigins[0] || '';
}

interface UnsignedEvent {
  kind: number;
  content: string;
  tags: string[][];
  created_at?: number;
}

interface ApiResponse {
  success: boolean;
  event?: object;
  error?: string;
  pubkey?: string;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    const requestOrigin = request.headers.get('Origin');
    const allowedOrigin = getAllowedOrigin(requestOrigin, env.ALLOWED_ORIGINS);

    const corsHeaders = {
      'Access-Control-Allow-Origin': allowedOrigin,
      'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    };

    // Handle preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    try {
      // Route handling
      if (path === '/api/info' && request.method === 'GET') {
        return handleInfo(env, corsHeaders);
      }

      if (path === '/api/publish' && request.method === 'POST') {
        return handlePublish(request, env, corsHeaders);
      }

      if (path === '/api/moderate' && request.method === 'POST') {
        return handleModerate(request, env, corsHeaders);
      }

      if (path === '/api/relay-rpc' && request.method === 'POST') {
        return handleRelayRpc(request, env, corsHeaders);
      }

      if (path === '/api/summarize-user' && request.method === 'POST') {
        return handleSummarizeUser(request, env, corsHeaders);
      }

      if (path === '/api/moderate-media' && request.method === 'POST') {
        return handleModerateMedia(request, env, corsHeaders);
      }

      if (path === '/api/decisions' && request.method === 'POST') {
        return handleLogDecision(request, env, corsHeaders);
      }

      if (path === '/api/decisions' && request.method === 'GET') {
        return handleGetAllDecisions(env, corsHeaders);
      }

      if (path.startsWith('/api/decisions/') && request.method === 'GET') {
        const targetId = path.replace('/api/decisions/', '');
        return handleGetDecisions(targetId, env, corsHeaders);
      }

      if (path.startsWith('/api/decisions/') && request.method === 'DELETE') {
        const targetId = path.replace('/api/decisions/', '');
        return handleDeleteDecisions(targetId, env, corsHeaders);
      }

      if (path.startsWith('/api/check-result/') && request.method === 'GET') {
        const sha256 = path.replace('/api/check-result/', '');
        return handleCheckResult(sha256, env, corsHeaders);
      }

      // Realness API proxy (for AI detection behind CF Access)
      if (path.startsWith('/api/realness/')) {
        return handleRealnessProxy(request, path, env, corsHeaders);
      }

      // Zendesk integration endpoints (require JWT auth)
      if (path.startsWith('/api/zendesk/')) {
        return handleZendeskRoutes(request, path, env, corsHeaders);
      }

      // 404 for unknown routes
      return jsonResponse({ success: false, error: 'Not found' }, 404, corsHeaders);
    } catch (error) {
      console.error('Worker error:', error);
      return jsonResponse(
        { success: false, error: error instanceof Error ? error.message : 'Internal error' },
        500,
        corsHeaders
      );
    }
  },
};

function jsonResponse(data: ApiResponse, status: number, headers: Record<string, string>): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...headers,
    },
  });
}

async function getSecretKey(env: Env): Promise<Uint8Array> {
  const nsec = typeof env.NOSTR_NSEC === 'string'
    ? env.NOSTR_NSEC
    : await env.NOSTR_NSEC.get();

  if (!nsec) {
    throw new Error('NOSTR_NSEC secret not configured');
  }

  const decoded = nip19.decode(nsec);
  if (decoded.type !== 'nsec') {
    throw new Error('Invalid NOSTR_NSEC format - must be nsec1...');
  }

  return decoded.data as Uint8Array;
}

async function handleInfo(env: Env, corsHeaders: Record<string, string>): Promise<Response> {
  try {
    const secretKey = await getSecretKey(env);
    const pubkey = getPublicKey(secretKey);
    const npub = nip19.npubEncode(pubkey);

    return jsonResponse(
      {
        success: true,
        pubkey,
        npub,
        relay: env.RELAY_URL,
      } as ApiResponse & { npub: string; relay: string },
      200,
      corsHeaders
    );
  } catch {
    return jsonResponse(
      { success: false, error: 'Secret key not configured' },
      500,
      corsHeaders
    );
  }
}

async function handlePublish(
  request: Request,
  env: Env,
  corsHeaders: Record<string, string>
): Promise<Response> {
  const body = (await request.json()) as UnsignedEvent;

  if (!body.kind || body.content === undefined) {
    return jsonResponse({ success: false, error: 'Missing required fields: kind, content' }, 400, corsHeaders);
  }

  const secretKey = await getSecretKey(env);

  const event = finalizeEvent(
    {
      kind: body.kind,
      content: body.content,
      tags: body.tags || [],
      created_at: body.created_at || Math.floor(Date.now() / 1000),
    },
    secretKey
  );

  // Publish to relay
  const publishResult = await publishToRelay(event, env.RELAY_URL);

  if (!publishResult.success) {
    return jsonResponse({ success: false, error: publishResult.error }, 500, corsHeaders);
  }

  return jsonResponse({ success: true, event }, 200, corsHeaders);
}

async function handleModerate(
  request: Request,
  env: Env,
  corsHeaders: Record<string, string>
): Promise<Response> {
  const body = (await request.json()) as {
    action: string;
    eventId?: string;
    pubkey?: string;
    reason?: string;
  };

  if (!body.action) {
    return jsonResponse({ success: false, error: 'Missing action' }, 400, corsHeaders);
  }

  const secretKey = await getSecretKey(env);

  // Build NIP-86 moderation event (kind 10000 + action-specific kinds)
  let kind: number;
  let content: string;
  const tags: string[][] = [];

  switch (body.action) {
    case 'delete_event': {
      // Use banevent RPC directly instead of publishing kind 5 events.
      // NIP-09 kind 5 deletion only allows authors to delete their own events.
      // Admin moderation requires NIP-86 banevent RPC method instead.
      if (!body.eventId) {
        return jsonResponse({ success: false, error: 'Missing eventId for delete_event' }, 400, corsHeaders);
      }

      try {
        const rpcRequest = new Request(request.url.replace(/\/api\/moderate$/, '/api/relay-rpc'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            method: 'banevent',
            params: [body.eventId, body.reason || 'Deleted by relay admin'],
          }),
        });

        const rpcResponse = await handleRelayRpc(rpcRequest, env, corsHeaders);
        const rpcResult = await rpcResponse.json() as { success: boolean; error?: string };

        if (!rpcResult.success) {
          return jsonResponse({ success: false, error: rpcResult.error || 'banevent RPC failed' }, 500, corsHeaders);
        }

        // Sync any linked Zendesk tickets
        syncZendeskAfterAction(
          env,
          body.action,
          'event',
          body.eventId,
          getPublicKey(secretKey)
        ).catch((err) => console.error('[handleModerate] Zendesk sync error:', err));

        return jsonResponse({ success: true, eventId: body.eventId }, 200, corsHeaders);
      } catch (error) {
        console.error('[handleModerate] delete_event error:', error);
        return jsonResponse({ success: false, error: error instanceof Error ? error.message : 'Unknown error' }, 500, corsHeaders);
      }
    }

    case 'ban_pubkey':
      if (!body.pubkey) {
        return jsonResponse({ success: false, error: 'Missing pubkey for ban_pubkey' }, 400, corsHeaders);
      }
      // NIP-86 relay management event
      kind = 10000;
      content = JSON.stringify({
        method: 'banpubkey',
        params: [body.pubkey, body.reason || ''],
      });
      break;

    case 'allow_pubkey':
      if (!body.pubkey) {
        return jsonResponse({ success: false, error: 'Missing pubkey for allow_pubkey' }, 400, corsHeaders);
      }
      kind = 10000;
      content = JSON.stringify({
        method: 'allowpubkey',
        params: [body.pubkey],
      });
      break;

    default:
      return jsonResponse({ success: false, error: `Unknown action: ${body.action}` }, 400, corsHeaders);
  }

  const event = finalizeEvent(
    {
      kind,
      content,
      tags,
      created_at: Math.floor(Date.now() / 1000),
    },
    secretKey
  );

  // Publish to relay
  const publishResult = await publishToRelay(event, env.RELAY_URL);

  if (!publishResult.success) {
    return jsonResponse({ success: false, error: publishResult.error }, 500, corsHeaders);
  }

  // Sync any linked Zendesk tickets
  syncZendeskAfterAction(
    env,
    body.action,
    body.eventId ? 'event' : 'pubkey',
    body.eventId || body.pubkey || '',
    getPublicKey(secretKey)
  ).catch((err) => console.error('[handleModerate] Zendesk sync error:', err));

  return jsonResponse({ success: true, event }, 200, corsHeaders);
}

async function handleRelayRpc(
  request: Request,
  env: Env,
  corsHeaders: Record<string, string>
): Promise<Response> {
  const body = (await request.json()) as {
    method: string;
    params?: (string | number | undefined)[];
  };

  if (!body.method) {
    return jsonResponse({ success: false, error: 'Missing method' }, 400, corsHeaders);
  }

  const secretKey = await getSecretKey(env);

  // Build NIP-98 auth event
  const httpUrl = getManagementUrl(env);
  const payload = JSON.stringify({ method: body.method, params: body.params || [] });
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

  // Call relay RPC
  const response = await fetch(httpUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/nostr+json+rpc',
      'Authorization': authHeader,
    },
    body: payload,
  });

  if (!response.ok) {
    return jsonResponse(
      { success: false, error: `Relay error: ${response.status} ${response.statusText}` },
      response.status,
      corsHeaders
    );
  }

  const result = await response.json() as { result?: unknown; error?: string };

  if (result.error) {
    return jsonResponse({ success: false, error: result.error }, 400, corsHeaders);
  }

  return new Response(JSON.stringify({ success: true, result: result.result }), {
    status: 200,
    headers: { 'Content-Type': 'application/json', ...corsHeaders },
  });
}

async function handleSummarizeUser(
  request: Request,
  env: Env,
  corsHeaders: Record<string, string>
): Promise<Response> {
  try {
    const body = await request.json() as {
      pubkey: string;
      recentPosts: Array<{ content: string; created_at: number }>;
      existingLabels: Array<{ tags: string[][]; created_at: number }>;
      reportHistory: Array<{ content: string; tags: string[][]; created_at: number }>;
    };

    // Check cache first
    const cacheKey = `summary:${body.pubkey}`;
    const cached = await env.KV?.get(cacheKey);
    if (cached) {
      return new Response(cached, {
        headers: { 'Content-Type': 'application/json', ...corsHeaders },
      });
    }

    // Build context for Claude
    const postSummary = body.recentPosts
      .map(p => `- "${p.content.slice(0, 200)}"`)
      .join('\n');

    const labelSummary = body.existingLabels
      .map(l => {
        const label = l.tags.find(t => t[0] === 'l')?.[1] || 'unknown';
        return `- ${label}`;
      })
      .join('\n') || 'None';

    const reportSummary = body.reportHistory
      .map(r => {
        const category = r.tags.find(t => t[0] === 'report')?.[1] || 'unknown';
        return `- ${category}: ${r.content?.slice(0, 100) || 'no details'}`;
      })
      .join('\n') || 'None';

    const prompt = `You are a trust & safety analyst. Analyze this Nostr user and provide a brief 2-3 sentence summary of their behavior patterns and risk level.

Recent posts (${body.recentPosts.length} total):
${postSummary}

Existing moderation labels:
${labelSummary}

Previous reports against them:
${reportSummary}

Respond with JSON only:
{
  "summary": "2-3 sentence behavioral summary",
  "riskLevel": "low|medium|high|critical"
}`;

    if (!env.ANTHROPIC_API_KEY) {
      throw new Error('ANTHROPIC_API_KEY not configured');
    }

    const claudeResponse = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-3-haiku-20240307',
        max_tokens: 256,
        messages: [{ role: 'user', content: prompt }],
      }),
    });

    if (!claudeResponse.ok) {
      throw new Error(`Claude API error: ${claudeResponse.status}`);
    }

    const claudeData = await claudeResponse.json() as {
      content: Array<{ type: string; text: string }>;
    };

    const responseText = claudeData.content[0]?.text || '';
    const jsonMatch = responseText.match(/\{[\s\S]*\}/);

    if (!jsonMatch) {
      throw new Error('Invalid response format');
    }

    const result = JSON.parse(jsonMatch[0]);

    // Cache for 1 hour
    await env.KV?.put(cacheKey, JSON.stringify(result), { expirationTtl: 3600 });

    return new Response(JSON.stringify(result), {
      headers: { 'Content-Type': 'application/json', ...corsHeaders },
    });
  } catch (error) {
    console.error('Summarize error:', error);
    return new Response(JSON.stringify({
      error: 'Failed to generate summary',
      summary: 'Unable to analyze user behavior at this time.',
      riskLevel: 'medium'
    }), {
      status: 200, // Return 200 with fallback to not break UI
      headers: { 'Content-Type': 'application/json', ...corsHeaders },
    });
  }
}

// Ensure moderation_decisions table exists
async function ensureDecisionsTable(db: D1Database): Promise<void> {
  // Run each statement separately to avoid issues with D1's exec
  await db.prepare(`
    CREATE TABLE IF NOT EXISTS moderation_decisions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      target_type TEXT NOT NULL,
      target_id TEXT NOT NULL,
      action TEXT NOT NULL,
      reason TEXT,
      moderator_pubkey TEXT,
      report_id TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `).run();

  // Create indexes in separate statements
  try {
    await db.prepare(`CREATE INDEX IF NOT EXISTS idx_decisions_target ON moderation_decisions(target_type, target_id)`).run();
  } catch {
    // Index might already exist
  }

  try {
    await db.prepare(`CREATE INDEX IF NOT EXISTS idx_decisions_report ON moderation_decisions(report_id)`).run();
  } catch {
    // Index might already exist
  }
}

// Ensure zendesk_tickets table exists for tracking Zendesk ↔ Nostr mappings
async function ensureZendeskTable(db: D1Database): Promise<void> {
  await db.prepare(`
    CREATE TABLE IF NOT EXISTS zendesk_tickets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ticket_id INTEGER NOT NULL UNIQUE,
      event_id TEXT,
      author_pubkey TEXT,
      violation_type TEXT,
      status TEXT DEFAULT 'open',
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      resolved_at TEXT,
      resolution_action TEXT,
      resolution_moderator TEXT
    )
  `).run();

  try {
    await db.prepare(`CREATE INDEX IF NOT EXISTS idx_zendesk_event ON zendesk_tickets(event_id)`).run();
  } catch {
    // Index might already exist
  }

  try {
    await db.prepare(`CREATE INDEX IF NOT EXISTS idx_zendesk_pubkey ON zendesk_tickets(author_pubkey)`).run();
  } catch {
    // Index might already exist
  }

  try {
    await db.prepare(`CREATE INDEX IF NOT EXISTS idx_zendesk_status ON zendesk_tickets(status)`).run();
  } catch {
    // Index might already exist
  }
}

async function handleLogDecision(
  request: Request,
  env: Env,
  corsHeaders: Record<string, string>
): Promise<Response> {
  try {
    if (!env.DB) {
      return jsonResponse({ success: false, error: 'Database not configured' }, 500, corsHeaders);
    }

    const body = await request.json() as {
      targetType: 'event' | 'pubkey' | 'media';
      targetId: string;
      action: string;
      reason?: string;
      moderatorPubkey?: string;
      reportId?: string;
    };

    if (!body.targetType || !body.targetId || !body.action) {
      return jsonResponse({ success: false, error: 'Missing required fields' }, 400, corsHeaders);
    }

    await ensureDecisionsTable(env.DB);

    await env.DB.prepare(`
      INSERT INTO moderation_decisions (target_type, target_id, action, reason, moderator_pubkey, report_id)
      VALUES (?, ?, ?, ?, ?, ?)
    `).bind(
      body.targetType,
      body.targetId,
      body.action,
      body.reason || null,
      body.moderatorPubkey || null,
      body.reportId || null
    ).run();

    return new Response(JSON.stringify({ success: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json', ...corsHeaders },
    });
  } catch (error) {
    console.error('Log decision error:', error);
    return jsonResponse(
      { success: false, error: error instanceof Error ? error.message : 'Unknown error' },
      500,
      corsHeaders
    );
  }
}

async function handleGetAllDecisions(
  env: Env,
  corsHeaders: Record<string, string>
): Promise<Response> {
  try {
    if (!env.DB) {
      return jsonResponse({ success: false, error: 'Database not configured' }, 500, corsHeaders);
    }

    await ensureDecisionsTable(env.DB);

    // Get all decisions, ordered by most recent first
    const decisions = await env.DB.prepare(`
      SELECT * FROM moderation_decisions
      ORDER BY created_at DESC
      LIMIT 1000
    `).all();

    return new Response(JSON.stringify({
      success: true,
      decisions: decisions.results || [],
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json', ...corsHeaders },
    });
  } catch (error) {
    console.error('Get all decisions error:', error);
    return jsonResponse(
      { success: false, error: error instanceof Error ? error.message : 'Unknown error' },
      500,
      corsHeaders
    );
  }
}

async function handleGetDecisions(
  targetId: string,
  env: Env,
  corsHeaders: Record<string, string>
): Promise<Response> {
  try {
    if (!env.DB) {
      return jsonResponse({ success: false, error: 'Database not configured' }, 500, corsHeaders);
    }

    await ensureDecisionsTable(env.DB);

    // Get all decisions for this target (could be event ID, pubkey, or media hash)
    const decisions = await env.DB.prepare(`
      SELECT * FROM moderation_decisions
      WHERE target_id = ?
      ORDER BY created_at DESC
    `).bind(targetId).all();

    return new Response(JSON.stringify({
      success: true,
      decisions: decisions.results || [],
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json', ...corsHeaders },
    });
  } catch (error) {
    console.error('Get decisions error:', error);
    return jsonResponse(
      { success: false, error: error instanceof Error ? error.message : 'Unknown error' },
      500,
      corsHeaders
    );
  }
}

async function handleDeleteDecisions(
  targetId: string,
  env: Env,
  corsHeaders: Record<string, string>
): Promise<Response> {
  try {
    if (!env.DB) {
      return jsonResponse({ success: false, error: 'Database not configured' }, 500, corsHeaders);
    }

    await ensureDecisionsTable(env.DB);

    let labelsDeleted = 0;

    // First, query for and delete any resolution labels (kind 1985) on the relay
    // Try both 'e' tag (event target) and 'p' tag (pubkey target)
    const labelFilters = [
      { kinds: [1985], '#e': [targetId], '#L': ['moderation/resolution'], limit: 10 },
      { kinds: [1985], '#p': [targetId], '#L': ['moderation/resolution'], limit: 10 },
    ];

    for (const filter of labelFilters) {
      const queryResult = await queryRelay(filter, env.RELAY_URL);
      if (queryResult.success && queryResult.events && queryResult.events.length > 0) {
        for (const labelEvent of queryResult.events) {
          const eventId = (labelEvent as { id?: string }).id;
          if (eventId) {
            // Ban the label event to remove it from the relay
            const rpcRequest = new Request(`https://placeholder/api/relay-rpc`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                method: 'banevent',
                params: [eventId, 'Removed by reopen action'],
              }),
            });

            try {
              const rpcResponse = await handleRelayRpc(rpcRequest, env, corsHeaders);
              const rpcResult = await rpcResponse.json() as { success: boolean };
              if (rpcResult.success) {
                labelsDeleted++;
              }
            } catch (err) {
              console.error('Failed to delete resolution label:', eventId, err);
            }
          }
        }
      }
    }

    // Delete all decisions for this target from D1 (reopens the report)
    const result = await env.DB.prepare(`
      DELETE FROM moderation_decisions
      WHERE target_id = ?
    `).bind(targetId).run();

    return jsonResponse({
      success: true,
      deleted: result.meta.changes || 0,
      labelsDeleted,
    }, 200, corsHeaders);
  } catch (error) {
    console.error('Delete decisions error:', error);
    return jsonResponse(
      { success: false, error: error instanceof Error ? error.message : 'Unknown error' },
      500,
      corsHeaders
    );
  }
}

async function handleCheckResult(
  sha256: string,
  env: Env,
  corsHeaders: Record<string, string>
): Promise<Response> {
  try {
    if (!sha256 || !/^[a-f0-9]{64}$/i.test(sha256)) {
      return jsonResponse({ success: false, error: 'Invalid sha256' }, 400, corsHeaders);
    }

    // Build headers including Cloudflare Access service token if available
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };

    if (env.CF_ACCESS_CLIENT_ID && env.CF_ACCESS_CLIENT_SECRET) {
      headers['CF-Access-Client-Id'] = env.CF_ACCESS_CLIENT_ID;
      headers['CF-Access-Client-Secret'] = env.CF_ACCESS_CLIENT_SECRET;
    }

    const response = await fetch(`${getModerationServiceUrl(env)}/check-result/${sha256}`, {
      method: 'GET',
      headers,
    });

    if (!response.ok) {
      if (response.status === 404) {
        return new Response(JSON.stringify(null), {
          status: 200,
          headers: { 'Content-Type': 'application/json', ...corsHeaders },
        });
      }
      return jsonResponse(
        { success: false, error: `Moderation service error: ${response.status}` },
        response.status,
        corsHeaders
      );
    }

    const result = await response.json();
    return new Response(JSON.stringify(result), {
      status: 200,
      headers: { 'Content-Type': 'application/json', ...corsHeaders },
    });
  } catch (error) {
    console.error('Check result error:', error);
    return jsonResponse(
      { success: false, error: error instanceof Error ? error.message : 'Unknown error' },
      500,
      corsHeaders
    );
  }
}

async function handleModerateMedia(
  request: Request,
  env: Env,
  corsHeaders: Record<string, string>
): Promise<Response> {
  try {
    const body = await request.json() as {
      sha256: string;
      action: 'SAFE' | 'REVIEW' | 'AGE_RESTRICTED' | 'PERMANENT_BAN';
      reason?: string;
    };

    if (!body.sha256) {
      return jsonResponse({ success: false, error: 'Missing sha256' }, 400, corsHeaders);
    }

    if (!body.action) {
      return jsonResponse({ success: false, error: 'Missing action' }, 400, corsHeaders);
    }

    // Require Zero Trust credentials for moderation service
    if (!env.CF_ACCESS_CLIENT_ID || !env.CF_ACCESS_CLIENT_SECRET) {
      return jsonResponse({ success: false, error: 'CF_ACCESS credentials not configured' }, 500, corsHeaders);
    }

    // Build headers with Cloudflare Access service token
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'CF-Access-Client-Id': env.CF_ACCESS_CLIENT_ID,
      'CF-Access-Client-Secret': env.CF_ACCESS_CLIENT_SECRET,
    };

    const response = await fetch(`${getModerationServiceUrl(env)}/api/v1/moderate`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        sha256: body.sha256,
        action: body.action,
        reason: body.reason || 'Moderated via Divine Relay Admin',
        source: 'relay-manager',
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      return jsonResponse(
        { success: false, error: `Moderation service error: ${response.status} - ${errorText}` },
        response.status,
        corsHeaders
      );
    }

    const result = await response.json() as { success: boolean; sha256: string; action: string };

    // Sync any linked Zendesk tickets
    // Note: media actions use sha256, but current ticket mapping is by event_id/pubkey
    // This will be a no-op unless ticket mapping is enhanced to track media hashes
    syncZendeskAfterAction(
      env,
      body.action,
      'media',
      body.sha256,
      'relay-manager'
    ).catch((err) => console.error('[handleModerateMedia] Zendesk sync error:', err));

    return new Response(JSON.stringify({ success: true, result }), {
      status: 200,
      headers: { 'Content-Type': 'application/json', ...corsHeaders },
    });
  } catch (error) {
    console.error('Moderate media error:', error);
    return jsonResponse(
      { success: false, error: error instanceof Error ? error.message : 'Unknown error' },
      500,
      corsHeaders
    );
  }
}

// Query relay for events matching a filter
async function queryRelay(
  filter: object,
  relayUrl: string
): Promise<{ success: boolean; events?: object[]; error?: string }> {
  return new Promise((resolve) => {
    try {
      const ws = new WebSocket(relayUrl);
      let resolved = false;
      const events: object[] = [];
      const subId = `query-${Date.now()}`;

      const timeout = setTimeout(() => {
        if (!resolved) {
          resolved = true;
          ws.close();
          resolve({ success: true, events });
        }
      }, 5000);

      ws.addEventListener('open', () => {
        ws.send(JSON.stringify(['REQ', subId, filter]));
      });

      ws.addEventListener('message', (msg) => {
        try {
          const data = JSON.parse(msg.data as string);
          if (data[0] === 'EVENT' && data[1] === subId) {
            events.push(data[2]);
          } else if (data[0] === 'EOSE' && data[1] === subId) {
            clearTimeout(timeout);
            resolved = true;
            ws.close();
            resolve({ success: true, events });
          }
        } catch {
          // Ignore parse errors
        }
      });

      ws.addEventListener('error', () => {
        if (!resolved) {
          clearTimeout(timeout);
          resolved = true;
          resolve({ success: false, error: 'WebSocket error' });
        }
      });

      ws.addEventListener('close', () => {
        if (!resolved) {
          clearTimeout(timeout);
          resolved = true;
          resolve({ success: true, events });
        }
      });
    } catch (error) {
      resolve({ success: false, error: error instanceof Error ? error.message : 'Unknown error' });
    }
  });
}

async function publishToRelay(
  event: object,
  relayUrl: string
): Promise<{ success: boolean; error?: string }> {
  return new Promise((resolve) => {
    try {
      const ws = new WebSocket(relayUrl);
      let resolved = false;

      const timeout = setTimeout(() => {
        if (!resolved) {
          resolved = true;
          ws.close();
          resolve({ success: false, error: 'Timeout connecting to relay' });
        }
      }, 10000);

      ws.addEventListener('open', () => {
        ws.send(JSON.stringify(['EVENT', event]));
      });

      ws.addEventListener('message', (msg) => {
        try {
          const data = JSON.parse(msg.data as string);
          if (data[0] === 'OK') {
            clearTimeout(timeout);
            resolved = true;
            ws.close();
            if (data[2] === true) {
              resolve({ success: true });
            } else {
              resolve({ success: false, error: data[3] || 'Relay rejected event' });
            }
          }
        } catch {
          // Ignore parse errors for other messages
        }
      });

      ws.addEventListener('error', (_err) => {
        if (!resolved) {
          clearTimeout(timeout);
          resolved = true;
          resolve({ success: false, error: 'WebSocket error' });
        }
      });

      ws.addEventListener('close', () => {
        if (!resolved) {
          clearTimeout(timeout);
          resolved = true;
          resolve({ success: false, error: 'Connection closed before OK received' });
        }
      });
    } catch (error) {
      resolve({ success: false, error: error instanceof Error ? error.message : 'Unknown error' });
    }
  });
}

// ============================================================================
// Zendesk Integration
// ============================================================================

// Base64URL decode (handles URL-safe base64)
function base64UrlDecode(str: string): string {
  // Convert base64url to base64
  let base64 = str.replace(/-/g, '+').replace(/_/g, '/');
  // Add padding if needed
  while (base64.length % 4) {
    base64 += '=';
  }
  return atob(base64);
}

// Verify Zendesk JWT token
async function verifyZendeskJWT(
  request: Request,
  env: Env
): Promise<{ valid: true; payload: ZendeskJWTPayload } | { valid: false; error: string }> {
  const authHeader = request.headers.get('Authorization');

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return { valid: false, error: 'Missing or invalid Authorization header' };
  }

  if (!env.ZENDESK_JWT_SECRET) {
    return { valid: false, error: 'ZENDESK_JWT_SECRET not configured' };
  }

  const token = authHeader.slice(7); // Remove 'Bearer '

  try {
    const [headerB64, payloadB64, signatureB64] = token.split('.');

    if (!headerB64 || !payloadB64 || !signatureB64) {
      return { valid: false, error: 'Invalid JWT format' };
    }

    // Decode and parse payload
    const payloadJson = base64UrlDecode(payloadB64);
    const payload = JSON.parse(payloadJson) as ZendeskJWTPayload;

    // Check expiration
    const now = Math.floor(Date.now() / 1000);
    if (payload.exp && payload.exp < now) {
      return { valid: false, error: 'Token expired' };
    }

    // Check not-before (iat - issued at)
    if (payload.iat && payload.iat > now + 60) {
      // Allow 60s clock skew
      return { valid: false, error: 'Token not yet valid' };
    }

    // Verify signature using HMAC-SHA256
    const data = new TextEncoder().encode(`${headerB64}.${payloadB64}`);
    const key = await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(env.ZENDESK_JWT_SECRET),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['verify']
    );

    // Decode signature from base64url
    const signatureBytes = Uint8Array.from(
      base64UrlDecode(signatureB64),
      (c) => c.charCodeAt(0)
    );

    const valid = await crypto.subtle.verify('HMAC', key, signatureBytes, data);

    if (!valid) {
      return { valid: false, error: 'Invalid signature' };
    }

    return { valid: true, payload };
  } catch (error) {
    console.error('JWT verification error:', error);
    return { valid: false, error: 'JWT verification failed' };
  }
}

// Verify Zendesk webhook signature
async function verifyZendeskWebhook(
  request: Request,
  body: string,
  secret: string | undefined
): Promise<boolean> {
  if (!secret) {
    console.warn('Zendesk webhook secret not configured');
    return false;
  }

  // Option 1: Simple API key header (X-Webhook-Key)
  const apiKey = request.headers.get('X-Webhook-Key');
  if (apiKey && apiKey === secret) {
    return true;
  }

  // Option 2: Zendesk native webhook signing (X-Zendesk-Webhook-Signature)
  const signature = request.headers.get('X-Zendesk-Webhook-Signature');
  const timestamp = request.headers.get('X-Zendesk-Webhook-Signature-Timestamp');

  if (!signature || !timestamp) {
    return false;
  }

  // Zendesk signs: timestamp + "." + body
  const signedPayload = `${timestamp}.${body}`;

  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );

  const signatureBytes = await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(signedPayload)
  );

  const expectedSig = btoa(String.fromCharCode(...new Uint8Array(signatureBytes)));

  return signature === expectedSig;
}

// Update Zendesk ticket with action result and internal note
async function updateZendeskTicket(
  ticketId: number,
  success: boolean,
  actionRequested: string,
  note: string,
  env: Env
): Promise<void> {
  if (!env.ZENDESK_SUBDOMAIN || !env.ZENDESK_API_TOKEN || !env.ZENDESK_EMAIL) {
    console.warn('[updateZendeskTicket] Missing Zendesk API credentials, skipping callback');
    return;
  }

  if (!env.ZENDESK_FIELD_ACTION_STATUS || !env.ZENDESK_FIELD_ACTION_REQUESTED) {
    console.warn('[updateZendeskTicket] Missing Zendesk field IDs, skipping callback');
    return;
  }

  try {
    const auth = btoa(`${env.ZENDESK_EMAIL}/token:${env.ZENDESK_API_TOKEN}`);
    const url = `https://${env.ZENDESK_SUBDOMAIN}.zendesk.com/api/v2/tickets/${ticketId}`;

    const customFields = [
      { id: parseInt(env.ZENDESK_FIELD_ACTION_STATUS, 10), value: success ? 'success' : 'failed' },
    ];

    // Only reset action_requested to 'none' on success
    if (success) {
      customFields.push({ id: parseInt(env.ZENDESK_FIELD_ACTION_REQUESTED, 10), value: 'none' });
    }

    const response = await fetch(url, {
      method: 'PUT',
      headers: {
        'Authorization': `Basic ${auth}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        ticket: {
          custom_fields: customFields,
          comment: {
            body: note,
            public: false,
          },
        },
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`[updateZendeskTicket] Failed to update ticket ${ticketId}: ${response.status} - ${errorText}`);
    }
  } catch (error) {
    console.error('[updateZendeskTicket] Error:', error);
  }
}

// Add internal note to Zendesk ticket (simpler than updateZendeskTicket - just adds comment, optionally solves)
async function addZendeskInternalNote(
  ticketId: number,
  note: string,
  env: Env,
  solve: boolean = false
): Promise<void> {
  if (!env.ZENDESK_SUBDOMAIN || !env.ZENDESK_API_TOKEN || !env.ZENDESK_EMAIL) {
    console.warn('[addZendeskInternalNote] Missing Zendesk credentials, skipping');
    return;
  }

  try {
    const auth = btoa(`${env.ZENDESK_EMAIL}/token:${env.ZENDESK_API_TOKEN}`);
    const url = `https://${env.ZENDESK_SUBDOMAIN}.zendesk.com/api/v2/tickets/${ticketId}`;

    const payload: { ticket: { comment: { body: string; public: boolean }; status?: string } } = {
      ticket: {
        comment: {
          body: note,
          public: false,
        },
      },
    };

    if (solve) {
      payload.ticket.status = 'solved';
    }

    const response = await fetch(url, {
      method: 'PUT',
      headers: {
        'Authorization': `Basic ${auth}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`[addZendeskInternalNote] Failed: ${response.status} - ${errorText}`);
    }
  } catch (error) {
    console.error('[addZendeskInternalNote] Error:', error);
  }
}

// Proxy handler for realness API (AI detection)
// Uses service binding if available (preferred), falls back to HTTP with CF Access
async function handleRealnessProxy(
  request: Request,
  path: string,
  env: Env,
  corsHeaders: Record<string, string>
): Promise<Response> {
  const subPath = path.replace('/api/realness', '');

  // Prefer service binding (bypasses CF Access, no 522 issues)
  if (env.REALNESS) {
    return handleRealnessViaBinding(request, subPath, env.REALNESS, corsHeaders);
  }

  // Fallback to HTTP with CF Access credentials
  return handleRealnessViaHTTP(request, subPath, env, corsHeaders);
}

// Service binding path (preferred)
async function handleRealnessViaBinding(
  request: Request,
  subPath: string,
  realness: Fetcher,
  corsHeaders: Record<string, string>
): Promise<Response> {
  // GET /api/realness/jobs/:id -> GET realness/api/jobs/:id
  if (subPath.startsWith('/jobs/') && request.method === 'GET') {
    const jobId = subPath.replace('/jobs/', '');
    try {
      // Service binding uses a dummy URL - the host is ignored
      const response = await realness.fetch(`https://realness/api/jobs/${jobId}`, {
        headers: { 'Accept': 'application/json' },
      });
      const data = await response.json();
      return jsonResponse(data, response.status, corsHeaders);
    } catch (error) {
      console.error('[realness proxy/binding] jobs error:', error);
      return jsonResponse({ success: false, error: 'Failed to fetch job', details: String(error) }, 500, corsHeaders);
    }
  }

  // POST /api/realness/analyze -> POST realness/analyze
  if (subPath === '/analyze' && request.method === 'POST') {
    try {
      const body = await request.text();
      const response = await realness.fetch('https://realness/analyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
      });
      const data = await response.json();
      return jsonResponse(data, response.status, corsHeaders);
    } catch (error) {
      console.error('[realness proxy/binding] analyze error:', error);
      return jsonResponse({ success: false, error: 'Failed to submit analysis', details: String(error) }, 500, corsHeaders);
    }
  }

  return jsonResponse({ success: false, error: 'Unknown realness endpoint' }, 404, corsHeaders);
}

// HTTP fallback path (legacy, kept for backwards compatibility)
async function handleRealnessViaHTTP(
  request: Request,
  subPath: string,
  env: Env,
  corsHeaders: Record<string, string>
): Promise<Response> {
  const realnessUrl = env.REALNESS_API_URL || DEFAULT_REALNESS_API_URL;

  // Check CF Access credentials
  if (!env.CF_ACCESS_CLIENT_ID || !env.CF_ACCESS_CLIENT_SECRET) {
    return jsonResponse({ success: false, error: 'CF_ACCESS credentials not configured (and no service binding)' }, 500, corsHeaders);
  }

  // Build headers with CF Access auth
  const headers: Record<string, string> = {
    'CF-Access-Client-Id': env.CF_ACCESS_CLIENT_ID,
    'CF-Access-Client-Secret': env.CF_ACCESS_CLIENT_SECRET,
    'Accept': 'application/json',
  };

  // GET /api/realness/jobs/:id -> GET realness/api/jobs/:id
  if (subPath.startsWith('/jobs/') && request.method === 'GET') {
    const jobId = subPath.replace('/jobs/', '');
    try {
      const response = await fetch(`${realnessUrl}/api/jobs/${jobId}`, { headers });
      const text = await response.text();
      try {
        const data = JSON.parse(text);
        return jsonResponse(data, response.status, corsHeaders);
      } catch {
        console.error('[realness proxy/http] jobs non-JSON response:', response.status, text.slice(0, 500));
        return jsonResponse({ success: false, error: `Upstream error: ${response.status}`, details: text.slice(0, 200) }, response.status, corsHeaders);
      }
    } catch (error) {
      console.error('[realness proxy/http] jobs error:', error);
      return jsonResponse({ success: false, error: 'Failed to fetch job', details: String(error) }, 500, corsHeaders);
    }
  }

  // POST /api/realness/analyze -> POST realness/analyze
  if (subPath === '/analyze' && request.method === 'POST') {
    try {
      const body = await request.text();
      const response = await fetch(`${realnessUrl}/analyze`, {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body,
      });
      const text = await response.text();
      try {
        const data = JSON.parse(text);
        return jsonResponse(data, response.status, corsHeaders);
      } catch {
        console.error('[realness proxy/http] analyze non-JSON response:', response.status, text.slice(0, 500));
        return jsonResponse({ success: false, error: `Upstream error: ${response.status}`, details: text.slice(0, 200) }, response.status, corsHeaders);
      }
    } catch (error) {
      console.error('[realness proxy/http] analyze error:', error);
      return jsonResponse({ success: false, error: 'Failed to submit analysis', details: String(error) }, 500, corsHeaders);
    }
  }

  return jsonResponse({ success: false, error: 'Unknown realness endpoint' }, 404, corsHeaders);
}

// Route handler for all /api/zendesk/* endpoints
async function handleZendeskRoutes(
  request: Request,
  path: string,
  env: Env,
  corsHeaders: Record<string, string>
): Promise<Response> {
  const subPath = path.replace('/api/zendesk', '');

  // Webhook endpoint uses signature verification instead of JWT
  if (subPath === '/webhook' && request.method === 'POST') {
    return handleZendeskWebhook(request, env, corsHeaders);
  }

  // Parse report endpoint - extracts Nostr IDs from ticket description, stores mapping, adds links
  if (subPath === '/parse-report' && request.method === 'POST') {
    return handleParseReport(request, env, corsHeaders);
  }

  // All other Zendesk endpoints require JWT auth
  const authResult = await verifyZendeskJWT(request, env);
  if (!authResult.valid) {
    return jsonResponse({ success: false, error: authResult.error }, 401, corsHeaders);
  }

  const user = authResult.payload;

  // Route to specific handlers
  switch (subPath) {
    case '/context':
      if (request.method === 'GET') {
        return handleZendeskContext(request, user, env, corsHeaders);
      }
      break;

    case '/action':
      if (request.method === 'POST') {
        return handleZendeskAction(request, user, env, corsHeaders);
      }
      break;

    case '/verify':
      // Simple endpoint to verify JWT is valid
      if (request.method === 'GET') {
        return new Response(JSON.stringify({
          success: true,
          user: { email: user.email, name: user.name },
        }), {
          status: 200,
          headers: { 'Content-Type': 'application/json', ...corsHeaders },
        });
      }
      break;
  }

  return jsonResponse({ success: false, error: 'Not found' }, 404, corsHeaders);
}

// Handle Zendesk webhook (triggered by ticket field changes)
async function handleZendeskWebhook(
  request: Request,
  env: Env,
  corsHeaders: Record<string, string>
): Promise<Response> {
  try {
    const bodyText = await request.text();

    // Verify webhook signature
    const isValid = await verifyZendeskWebhook(request, bodyText, env.ZENDESK_WEBHOOK_SECRET);
    if (!isValid) {
      return jsonResponse({ success: false, error: 'Invalid webhook signature' }, 401, corsHeaders);
    }

    const body = JSON.parse(bodyText) as {
      ticket_id: number;
      action_requested?: string;
      nostr_pubkey?: string;
      nostr_event_id?: string;
      agent_email?: string;
    };

    if (!body.action_requested || body.action_requested === 'none') {
      return new Response(JSON.stringify({ success: true, message: 'No action requested' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json', ...corsHeaders },
      });
    }

    // Execute the moderation action
    const secretKey = await getSecretKey(env);

    let actionResult: { success: boolean; error?: string } = { success: false, error: 'Unknown action' };

    switch (body.action_requested) {
      case 'ban_user':
        if (body.nostr_pubkey) {
          // Use relay RPC to ban
          const _pubkey = getPublicKey(secretKey);
          const httpUrl = getManagementUrl(env);
          const payload = JSON.stringify({ method: 'banpubkey', params: [body.nostr_pubkey, `Zendesk ticket #${body.ticket_id}`] });
          const payloadHash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(payload));
          const payloadHashHex = Array.from(new Uint8Array(payloadHash)).map(b => b.toString(16).padStart(2, '0')).join('');

          const authEvent = finalizeEvent({
            kind: 27235,
            content: '',
            tags: [['u', httpUrl], ['method', 'POST'], ['payload', payloadHashHex]],
            created_at: Math.floor(Date.now() / 1000),
          }, secretKey);

          const response = await fetch(httpUrl, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/nostr+json+rpc',
              'Authorization': `Nostr ${btoa(JSON.stringify(authEvent))}`,
            },
            body: payload,
          });

          actionResult = response.ok ? { success: true } : { success: false, error: `Relay error: ${response.status}` };
        }
        break;

      case 'delete_event':
        if (body.nostr_event_id) {
          const event = finalizeEvent({
            kind: 5,
            content: `Zendesk ticket #${body.ticket_id}`,
            tags: [['e', body.nostr_event_id]],
            created_at: Math.floor(Date.now() / 1000),
          }, secretKey);
          actionResult = await publishToRelay(event, env.RELAY_URL);
        }
        break;

      case 'allow_user':
        if (body.nostr_pubkey) {
          const httpUrl = getManagementUrl(env);
          const payload = JSON.stringify({ method: 'allowpubkey', params: [body.nostr_pubkey] });
          const payloadHash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(payload));
          const payloadHashHex = Array.from(new Uint8Array(payloadHash)).map(b => b.toString(16).padStart(2, '0')).join('');

          const authEvent = finalizeEvent({
            kind: 27235,
            content: '',
            tags: [['u', httpUrl], ['method', 'POST'], ['payload', payloadHashHex]],
            created_at: Math.floor(Date.now() / 1000),
          }, secretKey);

          const response = await fetch(httpUrl, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/nostr+json+rpc',
              'Authorization': `Nostr ${btoa(JSON.stringify(authEvent))}`,
            },
            body: payload,
          });

          actionResult = response.ok ? { success: true } : { success: false, error: `Relay error: ${response.status}` };
        }
        break;
    }

    // Log the decision
    if (env.DB && actionResult.success) {
      await ensureDecisionsTable(env.DB);
      await env.DB.prepare(`
        INSERT INTO moderation_decisions (target_type, target_id, action, reason, moderator_pubkey, report_id)
        VALUES (?, ?, ?, ?, ?, ?)
      `).bind(
        body.nostr_event_id ? 'event' : 'pubkey',
        body.nostr_event_id || body.nostr_pubkey || '',
        body.action_requested,
        `Zendesk ticket #${body.ticket_id}`,
        body.agent_email || null,
        `zendesk:${body.ticket_id}`
      ).run();

      // Sync any linked Zendesk tickets (via our mapping table)
      syncZendeskAfterAction(
        env,
        body.action_requested,
        body.nostr_event_id ? 'event' : 'pubkey',
        body.nostr_event_id || body.nostr_pubkey || '',
        body.agent_email || 'webhook'
      ).catch((err) => console.error('[handleZendeskWebhook] Zendesk sync error:', err));
    }

    // Callback to Zendesk to update ticket status and add internal note
    // TODO: allow_user case skipped until semantics of allow_user vs unban are clarified
    if (body.action_requested !== 'allow_user') {
      const agentInfo = body.agent_email ? ` by ${body.agent_email}` : '';
      let zendeskNote: string;

      if (actionResult.success) {
        switch (body.action_requested) {
          case 'ban_user':
            zendeskNote = `✅ Ban executed successfully for pubkey ${body.nostr_pubkey}${agentInfo}`;
            break;
          case 'delete_event':
            zendeskNote = `✅ Delete event executed successfully for event ${body.nostr_event_id}${agentInfo}`;
            break;
          default:
            zendeskNote = `✅ Action "${body.action_requested}" executed successfully${agentInfo}`;
        }
      } else {
        switch (body.action_requested) {
          case 'ban_user':
            zendeskNote = `❌ Ban failed for pubkey ${body.nostr_pubkey}: ${actionResult.error}`;
            break;
          case 'delete_event':
            zendeskNote = `❌ Delete event failed for event ${body.nostr_event_id}: ${actionResult.error}`;
            break;
          default:
            zendeskNote = `❌ Action "${body.action_requested}" failed: ${actionResult.error}`;
        }
      }

      // Fire-and-forget: don't await, don't let errors break the response
      updateZendeskTicket(body.ticket_id, actionResult.success, body.action_requested, zendeskNote, env)
        .catch((err) => console.error('[handleZendeskWebhook] Zendesk callback error:', err));
    }

    return new Response(JSON.stringify({
      success: actionResult.success,
      action: body.action_requested,
      error: actionResult.error,
    }), {
      status: actionResult.success ? 200 : 500,
      headers: { 'Content-Type': 'application/json', ...corsHeaders },
    });
  } catch (error) {
    console.error('Zendesk webhook error:', error);
    return jsonResponse(
      { success: false, error: error instanceof Error ? error.message : 'Unknown error' },
      500,
      corsHeaders
    );
  }
}

// Parse content report ticket and store mapping, add helpful links as internal note
async function handleParseReport(
  request: Request,
  env: Env,
  corsHeaders: Record<string, string>
): Promise<Response> {
  try {
    const bodyText = await request.text();

    // Debug: log what headers we're receiving
    const debugHeaders: Record<string, string> = {};
    request.headers.forEach((value, key) => {
      if (key.toLowerCase().includes('webhook') || key.toLowerCase().includes('zendesk') || key.toLowerCase() === 'x-webhook-key') {
        debugHeaders[key] = value.substring(0, 20) + '...';  // Truncate for safety
      }
    });
    console.log('[handleParseReport] Headers received:', JSON.stringify(debugHeaders));
    console.log('[handleParseReport] Secret configured:', env.ZENDESK_PARSE_REPORT_SECRET ? 'yes' : 'no');

    // Verify webhook signature
    if (!await verifyZendeskWebhook(request, bodyText, env.ZENDESK_PARSE_REPORT_SECRET)) {
      return jsonResponse({ success: false, error: 'Invalid webhook signature' }, 401, corsHeaders);
    }

    const { ticket_id, description } = JSON.parse(bodyText) as {
      ticket_id: number;
      description: string;
    };

    if (!ticket_id || !description) {
      return jsonResponse({ success: false, error: 'Missing ticket_id or description' }, 400, corsHeaders);
    }

    // Parse description with regex
    const eventMatch = description.match(/Event ID:\s*([a-f0-9]{64})/i);
    const pubkeyMatch = description.match(/Author Pubkey:\s*([a-f0-9]{64})/i);
    const violationMatch = description.match(/Violation Type:\s*(\w+)/i);

    const event_id = eventMatch?.[1] || null;
    const author_pubkey = pubkeyMatch?.[1] || null;
    const violation_type = violationMatch?.[1] || null;

    if (!event_id && !author_pubkey) {
      return jsonResponse({ success: false, error: 'Could not parse event_id or author_pubkey from description' }, 400, corsHeaders);
    }

    // Store mapping in D1 (skip if already processed)
    if (env.DB) {
      await ensureZendeskTable(env.DB);

      // Check if we've already processed this ticket
      const existing = await env.DB.prepare(
        `SELECT id FROM zendesk_tickets WHERE ticket_id = ?`
      ).bind(ticket_id).first();

      if (existing) {
        console.log(`[handleParseReport] Ticket ${ticket_id} already processed, skipping`);
        return jsonResponse({ success: true, ticket_id, event_id, author_pubkey, violation_type, skipped: true }, 200, corsHeaders);
      }

      await env.DB.prepare(`
        INSERT INTO zendesk_tickets (ticket_id, event_id, author_pubkey, violation_type, status)
        VALUES (?, ?, ?, ?, 'open')
      `).bind(ticket_id, event_id, author_pubkey, violation_type).run();
    }

    // Generate internal note with links
    const lines = ['📋 **Content Report Links**', ''];
    if (violation_type) {
      lines.push(`**Violation Type:** ${violation_type}`, '');
    }
    if (event_id) {
      lines.push('**Reported Event:**');
      lines.push(`• [View in Relay Admin](https://relay.admin.divine.video/reports?event=${event_id})`);
      lines.push(`• Event ID: \`${event_id}\``);
      lines.push('');
    }
    if (author_pubkey) {
      lines.push('**Reported Author:**');
      lines.push(`• [View in Relay Admin](https://relay.admin.divine.video/reports?pubkey=${author_pubkey})`);
      lines.push(`• Pubkey: \`${author_pubkey}\``);
    }

    const note = lines.join('\n');

    // Add internal note to Zendesk
    await addZendeskInternalNote(ticket_id, note, env);

    return jsonResponse({ success: true, ticket_id, event_id, author_pubkey, violation_type }, 200, corsHeaders);
  } catch (error) {
    console.error('[handleParseReport] Error:', error);
    return jsonResponse(
      { success: false, error: error instanceof Error ? error.message : 'Unknown error' },
      500,
      corsHeaders
    );
  }
}

// Sync Zendesk ticket after moderation action in relay-manager
async function syncZendeskAfterAction(
  env: Env,
  action: string,
  targetType: 'event' | 'pubkey' | 'media',
  targetId: string,
  moderator: string
): Promise<void> {
  if (!env.DB) return;

  try {
    await ensureZendeskTable(env.DB);

    // Find linked open ticket
    let linked: { ticket_id: number } | null = null;

    if (targetType === 'event') {
      linked = await env.DB.prepare(
        `SELECT ticket_id FROM zendesk_tickets WHERE event_id = ? AND status = 'open'`
      ).bind(targetId).first();
    } else if (targetType === 'pubkey') {
      linked = await env.DB.prepare(
        `SELECT ticket_id FROM zendesk_tickets WHERE author_pubkey = ? AND status = 'open'`
      ).bind(targetId).first();
    }

    if (!linked?.ticket_id) return;

    // Determine if this is a resolution action (should solve ticket)
    const resolutionActions = ['reviewed', 'dismissed', 'no-action', 'false-positive'];
    const isResolution = resolutionActions.includes(action);

    // Build note
    const actionDisplay = action.replace(/_/g, ' ').replace(/([A-Z])/g, ' $1').trim();
    const timestamp = new Date().toISOString();

    const note = [
      '📋 **Moderation Action Taken**',
      '',
      `**Action:** ${actionDisplay}`,
      `**Target:** \`${targetId}\``,
      `**Moderator:** ${moderator}`,
      `**Time:** ${timestamp}`,
    ].join('\n');

    // Add note (and solve if resolution action)
    await addZendeskInternalNote(linked.ticket_id, note, env, isResolution);

    // Update our tracking if resolved
    if (isResolution) {
      await env.DB.prepare(`
        UPDATE zendesk_tickets
        SET status = 'resolved',
            resolved_at = CURRENT_TIMESTAMP,
            resolution_action = ?,
            resolution_moderator = ?
        WHERE ticket_id = ?
      `).bind(action, moderator, linked.ticket_id).run();
    }

    console.log(`[syncZendeskAfterAction] Updated ticket #${linked.ticket_id} with action: ${action}`);
  } catch (error) {
    console.error('[syncZendeskAfterAction] Error:', error);
    // Don't throw - Zendesk sync failure shouldn't break moderation
  }
}

// Get context for Zendesk sidebar app
async function handleZendeskContext(
  request: Request,
  user: ZendeskJWTPayload,
  env: Env,
  corsHeaders: Record<string, string>
): Promise<Response> {
  const url = new URL(request.url);
  const pubkey = url.searchParams.get('pubkey');
  const eventId = url.searchParams.get('event_id');

  if (!pubkey && !eventId) {
    return jsonResponse({ success: false, error: 'Missing pubkey or event_id parameter' }, 400, corsHeaders);
  }

  try {
    const context: Record<string, unknown> = {
      requested_by: user.email,
    };

    // Get decision history
    if (env.DB) {
      await ensureDecisionsTable(env.DB);
      const targetId = eventId || pubkey;
      const decisions = await env.DB.prepare(`
        SELECT * FROM moderation_decisions
        WHERE target_id = ?
        ORDER BY created_at DESC
        LIMIT 20
      `).bind(targetId).all();

      context.decisions = decisions.results || [];
    }

    // Check if user is banned (via relay RPC)
    if (pubkey) {
      try {
        const secretKey = await getSecretKey(env);
        const httpUrl = getManagementUrl(env);
        const payload = JSON.stringify({ method: 'listbannedpubkeys', params: [] });
        const payloadHash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(payload));
        const payloadHashHex = Array.from(new Uint8Array(payloadHash)).map(b => b.toString(16).padStart(2, '0')).join('');

        const authEvent = finalizeEvent({
          kind: 27235,
          content: '',
          tags: [['u', httpUrl], ['method', 'POST'], ['payload', payloadHashHex]],
          created_at: Math.floor(Date.now() / 1000),
        }, secretKey);

        const response = await fetch(httpUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/nostr+json+rpc',
            'Authorization': `Nostr ${btoa(JSON.stringify(authEvent))}`,
          },
          body: payload,
        });

        if (response.ok) {
          const result = await response.json() as { result?: Array<{ pubkey: string }> };
          const bannedList = result.result || [];
          context.is_banned = bannedList.some((b) => b.pubkey === pubkey);
        }
      } catch {
        context.is_banned = null; // Unknown
      }
    }

    return new Response(JSON.stringify({ success: true, context }), {
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

// Execute moderation action from Zendesk sidebar
async function handleZendeskAction(
  request: Request,
  user: ZendeskJWTPayload,
  env: Env,
  corsHeaders: Record<string, string>
): Promise<Response> {
  try {
    const body = await request.json() as {
      action: string;
      pubkey?: string;
      event_id?: string;
      reason?: string;
      ticket_id?: number;
    };

    if (!body.action) {
      return jsonResponse({ success: false, error: 'Missing action' }, 400, corsHeaders);
    }

    const secretKey = await getSecretKey(env);
    let actionResult: { success: boolean; error?: string } = { success: false, error: 'Unknown action' };

    const reason = body.reason || `Via Zendesk by ${user.email}${body.ticket_id ? ` (ticket #${body.ticket_id})` : ''}`;

    switch (body.action) {
      case 'ban_user':
        if (body.pubkey) {
          const httpUrl = getManagementUrl(env);
          const payload = JSON.stringify({ method: 'banpubkey', params: [body.pubkey, reason] });
          const payloadHash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(payload));
          const payloadHashHex = Array.from(new Uint8Array(payloadHash)).map(b => b.toString(16).padStart(2, '0')).join('');

          const authEvent = finalizeEvent({
            kind: 27235,
            content: '',
            tags: [['u', httpUrl], ['method', 'POST'], ['payload', payloadHashHex]],
            created_at: Math.floor(Date.now() / 1000),
          }, secretKey);

          const response = await fetch(httpUrl, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/nostr+json+rpc',
              'Authorization': `Nostr ${btoa(JSON.stringify(authEvent))}`,
            },
            body: payload,
          });

          actionResult = response.ok ? { success: true } : { success: false, error: `Relay error: ${response.status}` };
        } else {
          actionResult = { success: false, error: 'Missing pubkey' };
        }
        break;

      case 'allow_user':
        if (body.pubkey) {
          const httpUrl = getManagementUrl(env);
          const payload = JSON.stringify({ method: 'allowpubkey', params: [body.pubkey] });
          const payloadHash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(payload));
          const payloadHashHex = Array.from(new Uint8Array(payloadHash)).map(b => b.toString(16).padStart(2, '0')).join('');

          const authEvent = finalizeEvent({
            kind: 27235,
            content: '',
            tags: [['u', httpUrl], ['method', 'POST'], ['payload', payloadHashHex]],
            created_at: Math.floor(Date.now() / 1000),
          }, secretKey);

          const response = await fetch(httpUrl, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/nostr+json+rpc',
              'Authorization': `Nostr ${btoa(JSON.stringify(authEvent))}`,
            },
            body: payload,
          });

          actionResult = response.ok ? { success: true } : { success: false, error: `Relay error: ${response.status}` };
        } else {
          actionResult = { success: false, error: 'Missing pubkey' };
        }
        break;

      case 'delete_event':
        if (body.event_id) {
          const event = finalizeEvent({
            kind: 5,
            content: reason,
            tags: [['e', body.event_id]],
            created_at: Math.floor(Date.now() / 1000),
          }, secretKey);
          actionResult = await publishToRelay(event, env.RELAY_URL);
        } else {
          actionResult = { success: false, error: 'Missing event_id' };
        }
        break;

      default:
        actionResult = { success: false, error: `Unknown action: ${body.action}` };
    }

    // Log the decision
    if (env.DB && actionResult.success) {
      await ensureDecisionsTable(env.DB);
      await env.DB.prepare(`
        INSERT INTO moderation_decisions (target_type, target_id, action, reason, moderator_pubkey, report_id)
        VALUES (?, ?, ?, ?, ?, ?)
      `).bind(
        body.event_id ? 'event' : 'pubkey',
        body.event_id || body.pubkey || '',
        body.action,
        reason,
        user.email,
        body.ticket_id ? `zendesk:${body.ticket_id}` : null
      ).run();
    }

    // Sync any linked Zendesk tickets
    if (actionResult.success) {
      syncZendeskAfterAction(
        env,
        body.action,
        body.event_id ? 'event' : 'pubkey',
        body.event_id || body.pubkey || '',
        user.email
      ).catch((err) => console.error('[handleZendeskAction] Zendesk sync error:', err));
    }

    return new Response(JSON.stringify({
      success: actionResult.success,
      action: body.action,
      error: actionResult.error,
      moderator: user.email,
    }), {
      status: actionResult.success ? 200 : 500,
      headers: { 'Content-Type': 'application/json', ...corsHeaders },
    });
  } catch (error) {
    console.error('Zendesk action error:', error);
    return jsonResponse(
      { success: false, error: error instanceof Error ? error.message : 'Unknown error' },
      500,
      corsHeaders
    );
  }
}
