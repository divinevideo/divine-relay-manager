import { getAdminPubkey, banEvent, publishKind5Deletion, type Nip86Env } from './nip86';
import { syncZendeskAfterAction, type ZendeskSyncEnv } from './zendesk-sync';
import { VALID_BULK_ACTIONS, type BulkAction, type BulkModerateResult } from '../../shared/bulk-moderation';
import { extractMediaHashes as extractSharedMediaHashes } from '../../shared/media-hashes';

const BULK_ACTION_CONCURRENCY = 5;
const RELAY_QUERY_LIMIT = 500;
const RELAY_QUERY_FETCH_LIMIT = RELAY_QUERY_LIMIT + 1;
const RELAY_QUERY_TIMEOUT_MS = 10000;

export interface BulkModerateEnv extends Nip86Env, ZendeskSyncEnv {
  DB?: D1Database;
  MODERATION_API?: Fetcher;
  MODERATION_ADMIN_URL?: string;
  SERVICE_API_TOKEN?: string | { get(): Promise<string> };
}

interface RelayEventSummary {
  id: string;
  kind: number;
  content: string;
  tags: string[][];
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
  const moderatorPubkey = await getAdminPubkey(env);
  const result: BulkModerateResult = { success: true, eventsProcessed: 0, mediaProcessed: 0, failures: [] };

  if (action === 'delete-all') {
    const successfulEventIds: string[] = [];

    await runWithConcurrency(events, BULK_ACTION_CONCURRENCY, async (event) => {
      try {
        const banResult = await banEvent(event.id, reason, env);
        if (!banResult.success) {
          throw new Error(banResult.error || 'banevent failed');
        }

        const deleteResult = await publishKind5Deletion(event.id, reason, env);
        if (!deleteResult.success) {
          throw new Error(deleteResult.error || 'kind 5 deletion failed');
        }

        result.eventsProcessed++;
        successfulEventIds.push(event.id);
      } catch (error) {
        result.failures.push(`event:${event.id}:${formatError(error)}`);
      }
    });

    if (env.DB && successfulEventIds.length > 0) {
      await env.DB.batch(
        successfulEventIds.map((eventId) => env.DB!.prepare(
          `INSERT INTO moderation_decisions (target_type, target_id, action, reason, moderator_pubkey, created_at) VALUES (?, ?, ?, ?, ?, datetime('now'))`
        ).bind('event', eventId, 'delete_event', reason, moderatorPubkey))
      );
    }

    await runWithConcurrency(successfulEventIds, BULK_ACTION_CONCURRENCY, async (eventId) => {
      await syncZendeskAfterAction(env, 'delete_event', 'event', eventId, moderatorPubkey);
    });

    if (successfulEventIds.length > 0) {
      await syncZendeskAfterAction(env, 'delete_event', 'pubkey', body.pubkey, moderatorPubkey);
    }

    await runWithConcurrency(mediaHashes, BULK_ACTION_CONCURRENCY, async (sha256) => {
      try {
        await callModerateMedia(sha256, 'DELETE', reason, env);
        result.mediaProcessed++;
      } catch (error) {
        result.failures.push(`media:${sha256}:${formatError(error)}`);
      }
    });
  } else {
    result.eventsProcessed = events.length;
    const mediaAction = action === 'age-restrict-all' ? 'AGE_RESTRICTED' : 'SAFE';
    await runWithConcurrency(mediaHashes, BULK_ACTION_CONCURRENCY, async (sha256) => {
      try {
        await callModerateMedia(sha256, mediaAction, reason, env);
        result.mediaProcessed++;
      } catch (error) {
        result.failures.push(`media:${sha256}:${formatError(error)}`);
      }
    });
  }

  result.success = result.failures.length === 0;
  return json(result, 200, corsHeaders);
}

export async function queryRelayEvents(
  pubkey: string,
  env: Pick<BulkModerateEnv, 'RELAY_URL'>,
): Promise<RelayEventSummary[]> {
  return new Promise((resolve, reject) => {
    try {
      const ws = new WebSocket(env.RELAY_URL);
      let resolved = false;
      const events: RelayEventSummary[] = [];
      const subId = `bulk-${Date.now()}`;

      // `resolve` expects RelayEventSummary[]; `reject` expects an Error. The helper
      // accepts whichever terminator and its matching value as a single union, so the
      // settle path (close socket, clear timeout, guard against double-settle) is shared.
      type Settle =
        | { fn: typeof resolve; value: RelayEventSummary[] }
        | { fn: typeof reject; value: Error };
      const finish = (fn: Settle['fn'], value: RelayEventSummary[] | Error) => {
        if (resolved) return;
        resolved = true;
        clearTimeout(timeout);
        ws.close();
        (fn as (value: RelayEventSummary[] | Error) => void)(value);
      };

      const timeout = setTimeout(() => {
        finish(reject, new Error('Relay query timed out before EOSE'));
      }, RELAY_QUERY_TIMEOUT_MS);

      ws.addEventListener('open', () => {
        ws.send(JSON.stringify(['REQ', subId, { authors: [pubkey], limit: RELAY_QUERY_FETCH_LIMIT }]));
      });

      ws.addEventListener('message', (msg) => {
        try {
          const data = JSON.parse(msg.data as string);
          if (data[0] === 'EVENT' && data[1] === subId) {
            const event = data[2] as { id: string; kind: number; content?: string; tags: string[][] };
            events.push({ id: event.id, kind: event.kind, content: event.content || '', tags: event.tags });
          } else if (data[0] === 'EOSE' && data[1] === subId) {
            if (events.length > RELAY_QUERY_LIMIT) {
              finish(reject, new Error(`Bulk moderation matched more than ${RELAY_QUERY_LIMIT} events; narrow the scope or add pagination`));
              return;
            }
            finish(resolve, events);
          }
        } catch {
          // Ignore malformed relay frames and continue collecting.
        }
      });

      ws.addEventListener('error', () => {
        finish(reject, new Error('Relay query failed'));
      });

      ws.addEventListener('close', () => {
        finish(reject, new Error('Relay query closed before EOSE'));
      });
    } catch (error) {
      reject(error);
    }
  });
}

export function extractMediaHashes(events: RelayEventSummary[]): string[] {
  const hashes = new Set<string>();
  for (const event of events) {
    const eventHashes = extractSharedMediaHashes(event.content, event.tags);
    eventHashes.forEach((hash) => hashes.add(hash));
  }
  return Array.from(hashes);
}

async function runWithConcurrency<T>(
  items: T[],
  concurrency: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  for (let i = 0; i < items.length; i += concurrency) {
    await Promise.all(items.slice(i, i + concurrency).map(worker));
  }
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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
    const response = await env.MODERATION_API.fetch('https://moderation-api.divine.video/api/v1/moderate', {
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
