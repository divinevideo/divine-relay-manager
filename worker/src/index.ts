// ABOUTME: CF Worker that signs and publishes Nostr events for Divine Relay Admin
// ABOUTME: Holds the relay admin nsec in secrets and handles NIP-86 moderation actions

import { finalizeEvent, nip19, getPublicKey } from 'nostr-tools';

interface Env {
  NOSTR_NSEC: string;
  RELAY_URL: string;
  ALLOWED_ORIGIN: string;
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
