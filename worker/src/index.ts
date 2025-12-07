// ABOUTME: CF Worker that signs and publishes Nostr events for Divine Relay Admin
// ABOUTME: Holds the relay admin nsec in secrets and handles NIP-86 moderation actions

import { finalizeEvent, nip19, getPublicKey } from 'nostr-tools';

interface Env {
  NOSTR_NSEC: string;
  RELAY_URL: string;
  ALLOWED_ORIGIN: string;
  ANTHROPIC_API_KEY?: string;
  MODERATION_API_KEY?: string;
  // Cloudflare Access Service Token for moderation.admin.divine.video
  CF_ACCESS_CLIENT_ID?: string;
  CF_ACCESS_CLIENT_SECRET?: string;
  KV?: KVNamespace;
  DB?: D1Database;
}

const MODERATION_SERVICE_URL = 'https://moderation.admin.divine.video';

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

    // CORS headers
    const corsHeaders = {
      'Access-Control-Allow-Origin': env.ALLOWED_ORIGIN || '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
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

      if (path.startsWith('/api/check-result/') && request.method === 'GET') {
        const sha256 = path.replace('/api/check-result/', '');
        return handleCheckResult(sha256, env, corsHeaders);
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

function getSecretKey(env: Env): Uint8Array {
  if (!env.NOSTR_NSEC) {
    throw new Error('NOSTR_NSEC secret not configured');
  }

  const decoded = nip19.decode(env.NOSTR_NSEC);
  if (decoded.type !== 'nsec') {
    throw new Error('Invalid NOSTR_NSEC format - must be nsec1...');
  }

  return decoded.data as Uint8Array;
}

async function handleInfo(env: Env, corsHeaders: Record<string, string>): Promise<Response> {
  try {
    const secretKey = getSecretKey(env);
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
  } catch (error) {
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

  const secretKey = getSecretKey(env);

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

  const secretKey = getSecretKey(env);

  // Build NIP-86 moderation event (kind 10000 + action-specific kinds)
  let kind: number;
  let content: string;
  const tags: string[][] = [];

  switch (body.action) {
    case 'delete_event':
      if (!body.eventId) {
        return jsonResponse({ success: false, error: 'Missing eventId for delete_event' }, 400, corsHeaders);
      }
      kind = 5; // NIP-09 deletion
      content = body.reason || 'Deleted by relay admin';
      tags.push(['e', body.eventId]);
      break;

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

  const secretKey = getSecretKey(env);
  const pubkey = getPublicKey(secretKey);

  // Build NIP-98 auth event
  const httpUrl = env.RELAY_URL.replace(/^wss?:\/\//, 'https://');
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

    const response = await fetch(`${MODERATION_SERVICE_URL}/check-result/${sha256}`, {
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

    if (!env.MODERATION_API_KEY) {
      return jsonResponse({ success: false, error: 'MODERATION_API_KEY not configured' }, 500, corsHeaders);
    }

    // Build headers including Cloudflare Access service token if available
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'X-API-Key': env.MODERATION_API_KEY,
    };

    // Add Cloudflare Access headers if configured
    if (env.CF_ACCESS_CLIENT_ID && env.CF_ACCESS_CLIENT_SECRET) {
      headers['CF-Access-Client-Id'] = env.CF_ACCESS_CLIENT_ID;
      headers['CF-Access-Client-Secret'] = env.CF_ACCESS_CLIENT_SECRET;
    }

    const response = await fetch(`${MODERATION_SERVICE_URL}/api/v1/moderate`, {
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

      ws.addEventListener('error', (err) => {
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
