import { getAdminPubkey, banEvent, publishKind5Deletion, type Nip86Env } from './nip86';
import { syncZendeskAfterAction, type ZendeskSyncEnv } from './zendesk-sync';
import { VALID_BULK_ACTIONS, type BulkAction, type BulkModerateResult } from '../../shared/bulk-moderation';
import { extractMediaHashes as extractSharedMediaHashes } from '../../shared/media-hashes';

const BULK_ACTION_CONCURRENCY = 5;
// Page through ALL of an author's events via `until` cursoring instead of
// rejecting accounts with more than one page. The old reject left prolific
// accounts entirely un-enforced (the throw was swallowed upstream).
const RELAY_QUERY_PAGE_SIZE = 500;
const RELAY_QUERY_MAX_PAGES = 100; // safety bound (~50k events); logged if hit, never silent
const RELAY_QUERY_TIMEOUT_MS = 10000; // per-page (reset each page)

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

  const { events, complete } = await queryRelayEvents(body.pubkey, env);
  const mediaHashes = extractMediaHashes(events);
  const moderatorPubkey = await getAdminPubkey(env);
  const result: BulkModerateResult = { success: true, eventsProcessed: 0, mediaProcessed: 0, failures: [] };

  // If the relay could not be fully paginated (e.g. more than one page of events
  // share a single created_at second, which an until-cursor cannot subdivide),
  // surface it rather than silently enforcing over a partial set. The events we
  // did gather are still actioned below (best effort).
  if (!complete) {
    result.failures.push(`enumeration:${body.pubkey}:relay could not be fully paginated; actioned a partial set`);
  }

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
): Promise<{ events: RelayEventSummary[]; complete: boolean }> {
  type Result = { events: RelayEventSummary[]; complete: boolean };
  return new Promise((resolve, reject) => {
    try {
      const ws = new WebSocket(env.RELAY_URL);
      let resolved = false;
      const byId = new Map<string, RelayEventSummary>(); // dedup across pages (until boundary overlaps)
      let page = 0;
      let currentSub = '';
      let pageEvents = 0;        // events seen in the current page
      let pageStartSize = 0;     // byId.size at page start -> detects whether the page added anything new
      let pageOldest = Infinity; // min created_at in the current page -> next `until`
      let incomplete = false;    // true if the relay could not be fully paginated (surfaced to caller)
      let timeout: ReturnType<typeof setTimeout>;

      const finish = (fn: ((v: Result) => void) | ((e: Error) => void), value: Result | Error) => {
        if (resolved) return;
        resolved = true;
        clearTimeout(timeout);
        ws.close();
        (fn as (value: Result | Error) => void)(value);
      };
      const done = () => finish(resolve, { events: Array.from(byId.values()), complete: !incomplete });

      const armTimeout = () => {
        clearTimeout(timeout);
        // Per-page: a prolific account legitimately needs many pages; only a
        // stalled page (no EOSE within the window) is a failure.
        timeout = setTimeout(() => finish(reject, new Error('Relay query timed out before EOSE')), RELAY_QUERY_TIMEOUT_MS);
      };

      const sendPage = (until?: number) => {
        page += 1;
        currentSub = `bulk-${Date.now()}-${page}`;
        pageEvents = 0;
        pageOldest = Infinity;
        pageStartSize = byId.size;
        const filter: { authors: string[]; limit: number; until?: number } = { authors: [pubkey], limit: RELAY_QUERY_PAGE_SIZE };
        if (until !== undefined) filter.until = until;
        armTimeout();
        ws.send(JSON.stringify(['REQ', currentSub, filter]));
      };

      ws.addEventListener('open', () => sendPage());

      ws.addEventListener('message', (msg) => {
        try {
          const data = JSON.parse(msg.data as string);
          if (data[0] === 'EVENT' && data[1] === currentSub) {
            const event = data[2] as { id: string; kind: number; content?: string; tags: string[][]; created_at?: number };
            pageEvents += 1;
            if (!byId.has(event.id)) {
              byId.set(event.id, { id: event.id, kind: event.kind, content: event.content || '', tags: event.tags });
            }
            if (typeof event.created_at === 'number' && event.created_at < pageOldest) pageOldest = event.created_at;
          } else if (data[0] === 'EOSE' && data[1] === currentSub) {
            ws.send(JSON.stringify(['CLOSE', currentSub]));
            // Last page reached: a partial page means the relay has no more events.
            if (pageEvents < RELAY_QUERY_PAGE_SIZE) {
              done();
              return;
            }
            if (page >= RELAY_QUERY_MAX_PAGES) {
              // Bound coverage rather than loop forever; surface it (not silent).
              incomplete = true;
              console.warn(`[bulk-moderate] hit RELAY_QUERY_MAX_PAGES (${RELAY_QUERY_MAX_PAGES}, ~${page * RELAY_QUERY_PAGE_SIZE} events) for ${pubkey}; returning a partial set`);
              done();
              return;
            }
            // Progress guard: a full page that added no new ids means the `until`
            // cursor is stuck -- more than one page of events share a single
            // created_at second (an inclusive `until` cannot subdivide a second),
            // or the events carry no created_at. Surface incompleteness, and where
            // we can, step strictly past the saturated second so we still
            // enumerate everything older instead of looping to the page bound.
            if (byId.size === pageStartSize) {
              incomplete = true;
              if (pageOldest === Infinity) {
                console.warn(`[bulk-moderate] relay events lack created_at; cannot paginate further for ${pubkey}; returning a partial set`);
                done();
                return;
              }
              console.warn(`[bulk-moderate] more than one page of events share created_at=${pageOldest} for ${pubkey}; skipping past that second (some events at it may be unprocessed)`);
              sendPage(pageOldest - 1);
              return;
            }
            // Page through older events. `until` is inclusive so the boundary
            // timestamp may repeat; the byId map dedups it.
            sendPage(pageOldest === Infinity ? undefined : pageOldest);
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
