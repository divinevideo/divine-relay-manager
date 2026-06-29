import { getAdminPubkey, banEvent, publishKind5Deletion, type Nip86Env } from './nip86';
import { syncZendeskAfterAction, type ZendeskSyncEnv } from './zendesk-sync';
import { VALID_BULK_ACTIONS, type BulkAction, type BulkModerateResult } from '../../shared/bulk-moderation';
import { deriveFunnelcakeApiUrl } from './funnelcake-proxy';

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
  // Explicit Funnelcake REST API URL; derived from RELAY_URL when unset.
  FUNNELCAKE_API_URL?: string;
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

  const moderatorPubkey = await getAdminPubkey(env);
  const result: BulkModerateResult = { success: true, eventsProcessed: 0, mediaProcessed: 0, failures: [] };

  if (action === 'delete-all') {
    // Events come from the relay (WebSocket, paginated) because delete needs the
    // event IDs for banevent + kind-5. Media hashes come from the Funnelcake REST
    // API, which routes through the dedup-correct view and returns ALL of a user's
    // videos -- the WebSocket REQ returns ~1 video/kind (funnelcake#471). Fetch
    // both in parallel.
    const [{ events, complete }, mediaHashes] = await Promise.all([
      queryRelayEvents(body.pubkey, env),
      queryUserMediaHashes(body.pubkey, env),
    ]);

    // If the relay could not be fully paginated (e.g. more than one page of events
    // share a single created_at second, which an until-cursor cannot subdivide),
    // surface it rather than silently enforcing over a partial set. The events we
    // did gather are still actioned below (best effort).
    if (!complete) {
      result.failures.push(`enumeration:${body.pubkey}:relay could not be fully paginated; actioned a partial set`);
    }

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
    // age-restrict-all / un-age-restrict-all are media-only: no event IDs needed,
    // so we skip the WebSocket entirely and enumerate media from the REST API
    // (dedup-correct, all videos -- funnelcake#471).
    const mediaHashes = await queryUserMediaHashes(body.pubkey, env);
    // REST returns one entry per video, so video count == event count for video
    // kinds; report it so the UI's "across N events" stays meaningful.
    result.eventsProcessed = mediaHashes.length;
    // Age-review restriction must WITHHOLD the media, not adult-gate it.
    // QUARANTINE -> (moderation-service) RESTRICT -> blossom BlobStatus::Restricted,
    // which 404s to everyone except the owner and is reversible to Active. The
    // old 'AGE_RESTRICTED' -> BlobStatus::AgeRestricted serves full bytes to ANY
    // signed-in viewer (a throwaway key), so it does not hide a minor's content.
    // Clear ('un-age-restrict-all') sends 'SAFE' -> Active to restore.
    const mediaAction = action === 'age-restrict-all' ? 'QUARANTINE' : 'SAFE';
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

const SHA256_HEX = /^[a-f0-9]{64}$/i;
const VIDEO_QUERY_TIMEOUT_MS = 10000; // per page
// The funnelcake videos endpoint defaults to limit=25 and caps at 100, so we MUST
// page explicitly: without ?limit + offset paging, bulk delete/age-restrict would
// silently action only the first 25 videos and leave the rest live (a withhold
// gap on a child-safety path). Page at the max size, with a safety bound.
const VIDEO_PAGE_SIZE = 100;
const VIDEO_MAX_PAGES = 100;
const VIDEO_MAX_TOTAL = VIDEO_MAX_PAGES * VIDEO_PAGE_SIZE; // ~10k videos; throws if exceeded rather than under-enforcing

// Enumerate a user's video media hashes via the Funnelcake REST API instead of a
// WebSocket REQ. Funnelcake's `relay_events_by_kind_time` materialized view
// deduplicates addressable video events by (pubkey, kind) rather than
// (pubkey, kind, d_tag), so a REQ returns only ~1 video/kind (funnelcake#471).
// The REST endpoint routes through the correct `events_deduped` view and returns
// `sha256` directly, so every video is actioned. The base URL goes through the
// shared deriveFunnelcakeApiUrl so it honors FUNNELCAKE_API_URL when the REST and
// relay hosts diverge. Bounded by a timeout so a hung endpoint can't stall bulk
// moderation (for age-restrict this is the only upstream); throws on failure so
// the caller fails closed rather than reporting a false "withheld everything".
export async function queryUserMediaHashes(
  pubkey: string,
  env: Pick<BulkModerateEnv, 'RELAY_URL' | 'FUNNELCAKE_API_URL'>,
): Promise<string[]> {
  const baseUrl = deriveFunnelcakeApiUrl(env.RELAY_URL, env.FUNNELCAKE_API_URL);
  const hashes = new Set<string>();

  // Page until an EMPTY page (the true end of the list), not a short one. The
  // server may cap a page below the requested limit; reading a short page as
  // end-of-data would stop after page 0 and leave the rest of an account's media
  // live on a withhold path. Advance the offset by the actual row count returned
  // so a server-side cap below VIDEO_PAGE_SIZE can't skip rows. The <= bound gives
  // one page of headroom so an account whose count exactly fills VIDEO_MAX_TOTAL
  // terminates via the empty page instead of false-throwing.
  let offset = 0;
  while (offset <= VIDEO_MAX_TOTAL) {
    const res = await fetch(
      `${baseUrl}/api/users/${pubkey}/videos?limit=${VIDEO_PAGE_SIZE}&offset=${offset}`,
      { signal: AbortSignal.timeout(VIDEO_QUERY_TIMEOUT_MS) },
    );
    if (!res.ok) {
      throw new Error(`Video query failed: ${res.status}`);
    }
    const body = await res.json();
    if (!Array.isArray(body)) {
      // A pagination wrapper, null, or an error envelope: don't blindly iterate a
      // non-array (which would throw an opaque "not iterable"). Fail closed loudly.
      throw new Error(`Video query returned a non-array body for ${pubkey} (got ${body === null ? 'null' : typeof body})`);
    }
    const videos = body as Array<{ sha256?: string }>;
    if (videos.length === 0) {
      return Array.from(hashes); // true end of the list
    }
    let validInPage = 0;
    for (const v of videos) {
      if (v.sha256 && SHA256_HEX.test(v.sha256)) {
        hashes.add(v.sha256.toLowerCase());
        validInPage++;
      }
    }
    if (validInPage === 0) {
      // Rows present but none carried a usable sha256: the response shape drifted
      // (field renamed / non-string). Treating zero hashes as a clean success
      // would report "withheld everything" having withheld nothing. Fail closed.
      throw new Error(`Video query returned ${videos.length} rows with no valid sha256 for ${pubkey}; response shape may have changed`);
    }
    offset += videos.length;
  }

  // Past the anti-runaway ceiling without ever seeing an empty page: fail closed
  // rather than silently enforcing over a partial set on a withhold path.
  throw new Error(`More than ${VIDEO_MAX_TOTAL} videos for ${pubkey}; narrow the scope or add deeper pagination`);
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
