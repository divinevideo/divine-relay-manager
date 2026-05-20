import { banEvent, publishKind5Deletion, type Nip86Env } from './nip86';

type BulkAction = 'age-restrict-all' | 'un-age-restrict-all' | 'delete-all';
const VALID_BULK_ACTIONS: BulkAction[] = ['age-restrict-all', 'un-age-restrict-all', 'delete-all'];
const VIDEO_KINDS = [34235, 34236];

export interface BulkModerateEnv extends Nip86Env {
  DB?: D1Database;
  MODERATION_API?: Fetcher;
  MODERATION_ADMIN_URL?: string;
  SERVICE_API_TOKEN?: string | { get(): Promise<string> };
}

interface BulkResult {
  success: boolean;
  eventsProcessed: number;
  mediaProcessed: number;
  failures: string[];
}

function json(data: unknown, status: number, corsHeaders: Record<string, string>): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders },
  });
}

export async function handleBulkModerate(
  request: Request,
  env: BulkModerateEnv,
  corsHeaders: Record<string, string>,
): Promise<Response> {
  const body = await request.json() as { pubkey?: string; action?: string; reason?: string };

  if (!body.pubkey || !/^[0-9a-f]{64}$/.test(body.pubkey)) {
    return json({ error: 'Valid 64-char hex pubkey required' }, 400, corsHeaders);
  }
  if (!body.action || !VALID_BULK_ACTIONS.includes(body.action as BulkAction)) {
    return json({ error: `Invalid action. Must be one of: ${VALID_BULK_ACTIONS.join(', ')}` }, 400, corsHeaders);
  }

  const action = body.action as BulkAction;
  const reason = body.reason || `Bulk ${action} by moderator`;

  const events = await queryRelayEvents(body.pubkey, env);
  const mediaHashes = extractMediaHashes(events);

  const result: BulkResult = { success: true, eventsProcessed: 0, mediaProcessed: 0, failures: [] };

  if (action === 'delete-all') {
    for (const event of events) {
      try {
        await banEvent(event.id, reason, env);
        await publishKind5Deletion(event.id, reason, env);
        result.eventsProcessed++;
        if (env.DB) {
          await env.DB.prepare(
            `INSERT INTO moderation_decisions (target_type, target_id, action, reason, created_at) VALUES (?, ?, ?, ?, datetime('now'))`
          ).bind('event', event.id, 'delete_event', reason).run();
        }
      } catch (error) {
        result.failures.push(`event:${event.id}:${error}`);
      }
    }
    for (const sha256 of mediaHashes) {
      try {
        await callModerateMedia(sha256, 'DELETE', reason, env);
        result.mediaProcessed++;
      } catch (error) {
        result.failures.push(`media:${sha256}:${error}`);
      }
    }
  } else {
    const mediaAction = action === 'age-restrict-all' ? 'AGE_RESTRICTED' : 'SAFE';
    for (const sha256 of mediaHashes) {
      try {
        await callModerateMedia(sha256, mediaAction, reason, env);
        result.mediaProcessed++;
      } catch (error) {
        result.failures.push(`media:${sha256}:${error}`);
      }
    }
  }

  result.success = result.failures.length === 0;
  return json(result, 200, corsHeaders);
}

export async function queryRelayEvents(
  pubkey: string,
  env: Pick<BulkModerateEnv, 'RELAY_URL'>,
): Promise<Array<{ id: string; kind: number; tags: string[][] }>> {
  return new Promise((resolve) => {
    try {
      const ws = new WebSocket(env.RELAY_URL);
      let resolved = false;
      const events: Array<{ id: string; kind: number; tags: string[][] }> = [];
      const subId = `bulk-${Date.now()}`;

      const timeout = setTimeout(() => {
        if (!resolved) {
          resolved = true;
          ws.close();
          resolve(events);
        }
      }, 10000);

      ws.addEventListener('open', () => {
        ws.send(JSON.stringify(['REQ', subId, { authors: [pubkey], limit: 5000 }]));
      });

      ws.addEventListener('message', (msg) => {
        try {
          const data = JSON.parse(msg.data as string);
          if (data[0] === 'EVENT' && data[1] === subId) {
            const event = data[2] as { id: string; kind: number; tags: string[][] };
            events.push({ id: event.id, kind: event.kind, tags: event.tags });
          } else if (data[0] === 'EOSE' && data[1] === subId) {
            clearTimeout(timeout);
            resolved = true;
            ws.close();
            resolve(events);
          }
        } catch {
          // Ignore parse errors
        }
      });

      ws.addEventListener('error', () => {
        if (!resolved) {
          clearTimeout(timeout);
          resolved = true;
          resolve(events);
        }
      });

      ws.addEventListener('close', () => {
        if (!resolved) {
          clearTimeout(timeout);
          resolved = true;
          resolve(events);
        }
      });
    } catch {
      resolve([]);
    }
  });
}

export function extractMediaHashes(events: Array<{ id: string; kind: number; tags: string[][] }>): string[] {
  const hashes = new Set<string>();
  for (const event of events) {
    if (!VIDEO_KINDS.includes(event.kind)) continue;
    for (const tag of event.tags) {
      if (tag[0] === 'imeta') {
        for (let i = 1; i < tag.length; i++) {
          if (tag[i].startsWith('sha256 ')) {
            hashes.add(tag[i].split(' ')[1]);
          }
        }
      }
      if (tag[0] === 'x') hashes.add(tag[1]);
    }
  }
  return Array.from(hashes);
}

async function callModerateMedia(
  sha256: string,
  action: string,
  reason: string,
  env: BulkModerateEnv,
): Promise<void> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };

  if (env.SERVICE_API_TOKEN) {
    const token = typeof env.SERVICE_API_TOKEN === 'string'
      ? env.SERVICE_API_TOKEN
      : await env.SERVICE_API_TOKEN.get();
    if (token) headers['Authorization'] = `Bearer ${token}`;
  }

  const body = JSON.stringify({ sha256, action, reason, source: 'relay-manager-bulk' });

  if (env.MODERATION_API) {
    const response = await env.MODERATION_API.fetch('https://internal/api/v1/moderate', {
      method: 'POST', headers, body,
    });
    if (!response.ok) throw new Error(`Moderation service returned ${response.status}`);
  } else if (env.MODERATION_ADMIN_URL) {
    const response = await fetch(`${env.MODERATION_ADMIN_URL}/api/v1/moderate`, {
      method: 'POST', headers, body,
    });
    if (!response.ok) throw new Error(`Moderation service returned ${response.status}`);
  } else {
    throw new Error('No moderation service configured');
  }
}
