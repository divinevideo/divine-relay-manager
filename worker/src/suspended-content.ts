/**
 * Suspended-account content: the relay's admin reads that return a suspended
 * account's hidden events (funnelcake `getsuspendedevent` and
 * `listsuspendedpubkeyevents`).
 *
 * Those reads expose content the account's suspension hides from everyone else,
 * so they may be reached only through an audited moderator viewer: one that
 * checks a verified moderator and writes an audit row per read. /api/relay-rpc
 * does neither, so it refuses both methods outright; see runRelayRpc.
 *
 * `getbannedevent` is a second way in. The relay serves any individually banned
 * or held event without asking whether its author is suspended, so a caller
 * could ban a suspended account's post and then read it back. Moderators rely on
 * getbannedevent to see banned posts, so it is not refused outright: relay-rpc
 * checks the returned event's author instead (checkBannedEventAuthor).
 */

import { callNip86Rpc, getManagementUrl, type Nip86Env, type Nip86RpcResult } from './nip86';
import { SUSPENDED_READ_REFUSED } from '../../shared/suspended-read';
import { listAccountVideos, type MediaServerEnv } from './media-server';
import { requireVerifiedModerator } from './moderator-identity';
import {
  SUSPENDED_CONTENT_CODE,
  SUSPENDED_PAGE_DEFAULT,
  parseSuspendedAccountRequest,
  parseSuspendedEventRequest,
  type NostrEventJson,
  type SuspendedAccountRequest,
  type SuspendedAccountResponse,
  type SuspendedEventResponse,
  type SuspendedViewSurface,
} from '../../shared/suspended-content';

export { SUSPENDED_READ_REFUSED };

export const SUSPENDED_READ_METHODS: ReadonlySet<string> = new Set([
  'getsuspendedevent',
  'listsuspendedpubkeyevents',
]);

export const SUSPENSION_STATUS_UNAVAILABLE = 'suspension_status_unavailable';

// The author check runs after getbannedevent has already used up to its own
// 15 s bound, and the client gives the whole relay-rpc call 30 s. A shorter
// bound here keeps a slow suspension list from turning into a client timeout.
const SUSPENDED_LIST_TIMEOUT_MS = 5_000;

/**
 * Whether a caller-supplied NIP-86 method names one of the suspended reads.
 *
 * The relay matches method names exactly, so a variant such as
 * `GetSuspendedEvent` would not dispatch there today. The match is deliberately
 * looser than the relay's (trimmed, case-insensitive) so that a relay which ever
 * normalises method names cannot quietly reopen this path.
 *
 * A non-string answers false: the relay's request type holds the method as a
 * string, so a non-string method never dispatches to these reads.
 */
export function isSuspendedReadMethod(method: unknown): boolean {
  if (typeof method !== 'string') return false;
  return SUSPENDED_READ_METHODS.has(method.trim().toLowerCase());
}

/** Whether a caller-supplied method is getbannedevent, matched like isSuspendedReadMethod. */
export function isBannedEventRead(method: unknown): boolean {
  return typeof method === 'string' && method.trim().toLowerCase() === 'getbannedevent';
}

export interface SuspendedReadRefusal {
  status: 403 | 503;
  code: string;
  error: string;
}

const AUTHOR_SUSPENDED: SuspendedReadRefusal = {
  status: 403,
  code: SUSPENDED_READ_REFUSED,
  error: "This event's author is suspended, so its content is not served here",
};

const STATUS_UNAVAILABLE: SuspendedReadRefusal = {
  status: 503,
  code: SUSPENSION_STATUS_UNAVAILABLE,
  error: "Could not confirm the author's suspension status",
};

/**
 * Decide whether a banned event the relay returned may go back to the caller.
 * Null means it may; otherwise the refusal to send instead.
 *
 * Fails closed: an event with no readable author, or a suspension list that
 * cannot be read, is refused, because neither proves the author is not
 * suspended. The list is read after the event, so a suspension landing while the
 * event was being fetched is still seen.
 *
 * Deliberately uncached. A cache in one isolate cannot be invalidated by a
 * suspension made through another isolate (moderation-service, age review, the
 * UI all reach different ones), so any TTL would be a window in which a fresh
 * suspension reads through. getbannedevent is a per-view moderator read, so one
 * extra relay call per view costs little.
 *
 * Both sides are lowercased. Event pubkeys are lowercase hex, but suspensions
 * written before canonical-hex enforcement may be stored in uppercase; matching
 * them over-refuses at worst, which is the safe direction.
 */
export async function checkBannedEventAuthor(
  event: unknown,
  env: Nip86Env,
): Promise<SuspendedReadRefusal | null> {
  const pubkey = (event as { pubkey?: unknown } | null | undefined)?.pubkey;
  if (typeof pubkey !== 'string' || !pubkey) return STATUS_UNAVAILABLE;
  const suspended = await readAuthorSuspension(pubkey, env);
  if (suspended === 'unknown') return STATUS_UNAVAILABLE;
  return suspended ? AUTHOR_SUSPENDED : null;
}

// The background quarantine poll may reuse a suspended-list read this old
// (Matt, 2026-11-09). That poll returns the snapshot when the cached list says
// the author is not suspended, so for up to this long after a fresh suspension
// it can still show the snapshot, unaudited; Matt accepted that window. No
// other path uses the cache.
export const SUSPENDED_LIST_POLL_MAX_AGE_MS = 30_000;

// Management URL -> the last successful listsuspendedpubkeys result, per
// isolate. Every successful read refreshes it; a failed read leaves it alone.
const suspendedListCache = new Map<string, { at: number; list: unknown[] }>();

/** Test-only: forget cached suspended-list reads. */
export function __clearSuspendedListCache(): void {
  suspendedListCache.clear();
}

/**
 * Whether the relay's suspended list names this pubkey, or 'unknown' when that
 * cannot be told: the list could not be read, was not a list, or held an entry
 * with no readable pubkey before any match. Callers fail closed on 'unknown'.
 * Case-insensitive, for the reason given on checkBannedEventAuthor.
 *
 * Reads fresh by default, which every path that serves content relies on: a
 * cache in one isolate cannot see a suspension made through another, so any
 * age would be a window in which a fresh suspension reads through.
 * `maxAgeMs` lets the quarantine poll reuse a recent read instead of fetching
 * the whole list every 15 s per open tab. Its cost is the accepted window in
 * SUSPENDED_LIST_POLL_MAX_AGE_MS: a just-suspended author's snapshot can reach
 * the poll, unaudited, until the cached read ages out.
 */
export async function readAuthorSuspension(
  pubkey: string,
  env: Nip86Env,
  opts: { maxAgeMs?: number } = {},
): Promise<boolean | 'unknown'> {
  const author = pubkey.toLowerCase();

  let list: unknown[] | undefined;
  try {
    const key = getManagementUrl(env);
    const hit = suspendedListCache.get(key);
    if (opts.maxAgeMs !== undefined && hit && Date.now() - hit.at <= opts.maxAgeMs) {
      list = hit.list;
    } else {
      const read = await callNip86Rpc('listsuspendedpubkeys', [], env, SUSPENDED_LIST_TIMEOUT_MS);
      // A failed call carries no `result`, so this one check covers both a
      // failed read and a successful one that is not a list.
      if (!Array.isArray(read.result)) return 'unknown';
      list = read.result;
      suspendedListCache.set(key, { at: Date.now(), list });
    }
  } catch (err) {
    // callNip86Rpc throws on an unreadable response body or a missing signing key.
    console.error('[suspended-content] suspension list read threw:', err instanceof Error ? err.name : typeof err);
    return 'unknown';
  }

  // funnelcake sends SuspendedPubkey objects whose `pubkey` is always a string
  // (fixed_to_string over a FixedString(64)). An entry without one is unreadable
  // and could be this author, so it answers 'unknown' rather than being skipped.
  // A string that is not hex (a legacy row) is still a readable value: it can
  // never equal an event pubkey, so it is compared, not refused, and cannot
  // block every view.
  for (const entry of list) {
    const listed = (entry as { pubkey?: unknown } | null)?.pubkey;
    if (typeof listed !== 'string') return 'unknown';
    if (listed.toLowerCase() === author) return true;
  }
  return false;
}

/**
 * Whether a request opens suspended content and so must have its moderator
 * login verified fresh rather than from the 60 s cache: a POST to the viewer
 * endpoints, or a sexual-quarantine case read that asks for a suspended
 * author's snapshot (`?snapshot=1`, see guardQuarantineSnapshot). The quarantine
 * test is deliberately broad (any GET under the prefix): a needless fresh check
 * costs one Keycast call, a missed one would let a revoked login through.
 */
export function needsFreshModeratorLogin(method: string, url: URL): boolean {
  if (method === 'POST' && url.pathname.startsWith('/api/suspended-content/')) return true;
  return method === 'GET'
    && url.pathname.startsWith('/api/report-watcher/sexual-quarantine/')
    && url.searchParams.get('snapshot') === '1';
}

// ============================================================================
// Viewer reads: getsuspendedevent and listsuspendedpubkeyevents
// ============================================================================

export type SuspendedRead<T> =
  | { ok: true; value: T }
  | { ok: false; status: 404 | 409 | 501 | 502; code: string };

// funnelcake #1406's exact error strings, crates/clickhouse/src/management.rs
// (the GetSuspendedEvent and ListSuspendedPubkeyEvents arms, and
// SUSPENDED_READS_UNAVAILABLE for the REST endpoint).
const RELAY_EVENT_NOT_SUSPENDED = 'Event author is not suspended';
const RELAY_PUBKEY_NOT_SUSPENDED = 'Pubkey is not suspended';
const RELAY_NOT_FOUND_PREFIX = 'Event not found';
const RELAY_UNKNOWN_METHOD_PREFIX = 'Unknown method:';
const RELAY_READS_UNAVAILABLE_PREFIX = 'This endpoint does not serve suspended-account reads';

const RELAY_ERROR = { ok: false, status: 502, code: SUSPENDED_CONTENT_CODE.relayError } as const;

/**
 * Map a failed relay call to the viewer's answer. Only the relay's own refusals
 * get a specific code; a timeout, an HTTP error or any other relay error is a
 * relay_error, since none of them says anything about the content.
 */
function mapRelayFailure(result: Nip86RpcResult): SuspendedRead<never> {
  const error = typeof result.error === 'string' ? result.error : '';
  if (error === RELAY_EVENT_NOT_SUSPENDED || error === RELAY_PUBKEY_NOT_SUSPENDED) {
    return { ok: false, status: 409, code: SUSPENDED_CONTENT_CODE.notSuspended };
  }
  if (error.startsWith(RELAY_NOT_FOUND_PREFIX)) {
    return { ok: false, status: 404, code: SUSPENDED_CONTENT_CODE.hiddenForAnotherReason };
  }
  if (error.startsWith(RELAY_UNKNOWN_METHOD_PREFIX) || error.startsWith(RELAY_READS_UNAVAILABLE_PREFIX)) {
    return { ok: false, status: 501, code: SUSPENDED_CONTENT_CODE.viewerUnsupported };
  }
  return RELAY_ERROR;
}

const LOWER_HEX_64 = /^[0-9a-f]{64}$/;

/**
 * Whether a relay result is a NIP-01 event in canonical form. The pubkey must
 * already be lowercase, since it becomes the audit row's target; the relay
 * always sends lowercase, so anything else means the answer is not what it
 * claims to be.
 */
export function isNostrEventJson(value: unknown): value is NostrEventJson {
  const e = value as Partial<NostrEventJson> | null;
  return !!e && typeof e === 'object' && !Array.isArray(e)
    && typeof e.id === 'string' && LOWER_HEX_64.test(e.id)
    && typeof e.pubkey === 'string' && LOWER_HEX_64.test(e.pubkey)
    && Number.isInteger(e.created_at) && (e.created_at as number) >= 0
    && Number.isInteger(e.kind) && (e.kind as number) >= 0 && (e.kind as number) <= 65535
    && Array.isArray(e.tags) && e.tags.every(tag => Array.isArray(tag) && tag.every(part => typeof part === 'string'))
    && typeof e.content === 'string'
    && typeof e.sig === 'string';
}

// callNip86Rpc throws, rather than returns, on an unreadable body or a missing
// signing key. Either is a relay_error here. Only the error's name is logged,
// never a message, which could echo the body.
async function callRelay(method: string, params: Parameters<typeof callNip86Rpc>[1], env: Nip86Env): Promise<Nip86RpcResult | null> {
  try {
    return await callNip86Rpc(method, params, env);
  } catch (err) {
    console.error(`[suspended-content] ${method} threw:`, err instanceof Error ? err.name : typeof err);
    return null;
  }
}

/**
 * Read one suspended author's event by id. The returned id may differ from the
 * requested one: funnelcake returns the live version of an addressable event.
 */
export async function readSuspendedEvent(eventId: string, env: Nip86Env): Promise<SuspendedRead<NostrEventJson>> {
  const result = await callRelay('getsuspendedevent', [eventId], env);
  if (!result) return RELAY_ERROR;
  if (!result.success) return mapRelayFailure(result);
  if (!isNostrEventJson(result.result)) return RELAY_ERROR;
  return { ok: true, value: result.result };
}

/**
 * Read one page of a suspended account's events, newest first. Every event
 * must be the requested account's: an event by anyone else means the answer
 * cannot be trusted (a relay bug or a proxy mix-up), and serving it would audit
 * the view against the wrong account, so the whole page is a relay_error.
 */
export async function readSuspendedAccountPage(
  req: Pick<SuspendedAccountRequest, 'pubkey' | 'until' | 'untilId' | 'kinds' | 'limit'>,
  env: Nip86Env,
): Promise<SuspendedRead<{ events: NostrEventJson[]; nextUntil: number | null; nextUntilId: string | null }>> {
  // The relay refuses unknown option keys, so only the fields given are sent.
  const options: Record<string, unknown> = {};
  if (req.kinds !== undefined) options.kinds = req.kinds;
  if (req.until !== undefined) options.until = req.until;
  if (req.untilId !== undefined) options.until_id = req.untilId;
  if (req.limit !== undefined) options.limit = req.limit;
  const params = Object.keys(options).length > 0 ? [req.pubkey, options] : [req.pubkey];

  const result = await callRelay('listsuspendedpubkeyevents', params, env);
  if (!result) return RELAY_ERROR;
  if (!result.success) return mapRelayFailure(result);

  const page = result.result as { events?: unknown; next_until?: unknown; next_until_id?: unknown } | null;
  if (!page || typeof page !== 'object' || Array.isArray(page) || !Array.isArray(page.events)) return RELAY_ERROR;
  const events = page.events;
  if (!events.every(e => isNostrEventJson(e) && e.pubkey === req.pubkey)) return RELAY_ERROR;
  const nextUntil = page.next_until ?? null;
  const nextUntilId = page.next_until_id ?? null;
  if (nextUntil !== null && !(Number.isInteger(nextUntil) && (nextUntil as number) >= 0)) return RELAY_ERROR;
  if (nextUntilId !== null && !(typeof nextUntilId === 'string' && LOWER_HEX_64.test(nextUntilId))) return RELAY_ERROR;
  return { ok: true, value: { events: events as NostrEventJson[], nextUntil: nextUntil as number | null, nextUntilId: nextUntilId as string | null } };
}

// ============================================================================
// Audit log: suspended_content_views
// ============================================================================

/** One moderator view of suspended content, as the audit log records it. */
export interface SuspendedContentViewRow {
  moderatorPubkey: string;
  targetPubkey: string;
  scope: 'event' | 'account';
  /** The requested event id for an event view; null for an account page. */
  eventId: string | null;
  /** An account page's requested `until` cursor; null for the first page and for event views. */
  pageUntil: number | null;
  surface: SuspendedViewSurface;
  eventsServed: number;
}

// Append-only: the triggers refuse UPDATE and DELETE, so a row, once written,
// is the record of that view. A retention policy would drop them in a
// migration. The CHECKs hold every id to canonical lowercase 64-hex. The
// event_id check spells out IS NOT NULL because a CHECK that evaluates to NULL
// passes in SQLite, and length(NULL) = 64 is NULL, not false.
const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS suspended_content_views (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    viewed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    moderator_pubkey TEXT NOT NULL CHECK (length(moderator_pubkey) = 64 AND moderator_pubkey NOT GLOB '*[^0-9a-f]*'),
    target_pubkey TEXT NOT NULL CHECK (length(target_pubkey) = 64 AND target_pubkey NOT GLOB '*[^0-9a-f]*'),
    scope TEXT NOT NULL CHECK (scope IN ('event', 'account')),
    event_id TEXT CHECK (
      (scope = 'event' AND event_id IS NOT NULL AND length(event_id) = 64 AND event_id NOT GLOB '*[^0-9a-f]*')
      OR (scope = 'account' AND event_id IS NULL)
    ),
    page_until INTEGER,
    surface TEXT NOT NULL CHECK (surface IN ('report', 'user', 'age-review', 'sexual-quarantine')),
    events_served INTEGER NOT NULL CHECK (events_served >= 0)
  )`,
  'CREATE INDEX IF NOT EXISTS idx_scv_target ON suspended_content_views(target_pubkey, id DESC)',
  'CREATE INDEX IF NOT EXISTS idx_scv_moderator ON suspended_content_views(moderator_pubkey, id DESC)',
  `CREATE TRIGGER IF NOT EXISTS suspended_content_views_no_update BEFORE UPDATE ON suspended_content_views
    BEGIN SELECT RAISE(ABORT, 'suspended_content_views is append-only'); END`,
  `CREATE TRIGGER IF NOT EXISTS suspended_content_views_no_delete BEFORE DELETE ON suspended_content_views
    BEGIN SELECT RAISE(ABORT, 'suspended_content_views is append-only'); END`,
  // INSERT OR REPLACE deletes the row it replaces without firing the delete
  // trigger (SQLite fires delete triggers on REPLACE only with
  // recursive_triggers on), so an insert naming an existing id is refused too.
  `CREATE TRIGGER IF NOT EXISTS suspended_content_views_no_replace BEFORE INSERT ON suspended_content_views
    WHEN NEW.id IS NOT NULL AND EXISTS (SELECT 1 FROM suspended_content_views WHERE id = NEW.id)
    BEGIN SELECT RAISE(ABORT, 'suspended_content_views is append-only'); END`,
];

// Databases whose schema this isolate has already ensured. Only a full success
// is remembered, so a failed ensure is tried again on the next request.
let schemaReady = new WeakSet<D1Database>();

/** Test-only: forget which databases have been ensured. */
export function __resetSuspendedContentViewsSchema(): void {
  schemaReady = new WeakSet<D1Database>();
}

/** Create the audit table, its indexes and its append-only triggers, once per isolate. Throws on failure. */
export async function ensureSuspendedContentViewsTable(db: D1Database): Promise<void> {
  if (schemaReady.has(db)) return;
  for (const sql of SCHEMA) await db.prepare(sql).run();
  schemaReady.add(db);
}

/**
 * Write one audit row. Throws unless D1 reports exactly one row changed, so a
 * caller that serves content only after this resolves can never serve an
 * unrecorded view.
 */
export async function recordSuspendedContentView(db: D1Database, row: SuspendedContentViewRow): Promise<void> {
  const result = await db.prepare(
    `INSERT INTO suspended_content_views
      (moderator_pubkey, target_pubkey, scope, event_id, page_until, surface, events_served)
      VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    row.moderatorPubkey, row.targetPubkey, row.scope, row.eventId, row.pageUntil, row.surface, row.eventsServed,
  ).run();
  const changes = result?.meta?.changes;
  if (changes !== 1) throw new Error(`audit insert changed ${String(changes)} rows`);
}

// ============================================================================
// Viewer endpoints: POST /api/suspended-content/event and /account
// ============================================================================
//
// Every answer that carries suspended content follows the same order, and no
// path skips a step:
//   1. a moderator login verified fresh (requireVerifiedModerator);
//   2. a parsed request;
//   3. an audit table that exists (checked before the relay is read, so an
//      audit outage costs no relay read);
//   4. the relay read;
//   5. the audit row, naming the verified moderator and the content's author;
//   6. the content, with Cache-Control: no-store.
// A failure at any step answers without content. The moderator pubkey that is
// written is the one verified for this request, passed in by value; nothing
// re-reads the login after an await.

export type SuspendedContentEnv = Nip86Env & MediaServerEnv & { DB?: D1Database };

const NO_STORE = { 'Cache-Control': 'no-store' };

function viewerJson(body: unknown, status: number, corsHeaders: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json', ...NO_STORE },
  });
}

const FAILURE_TEXT: Record<string, string> = {
  [SUSPENDED_CONTENT_CODE.notSuspended]: 'This account is not suspended',
  [SUSPENDED_CONTENT_CODE.hiddenForAnotherReason]: 'Hidden for another reason, such as deleted or banned',
  [SUSPENDED_CONTENT_CODE.viewerUnsupported]: 'The relay does not serve suspended-account reads',
  [SUSPENDED_CONTENT_CODE.relayError]: 'Could not read from the relay',
  [SUSPENDED_CONTENT_CODE.auditUnavailable]: 'Could not record this view, so nothing is shown',
};

// A refusal body never carries content: only the code and fixed text. The log
// line carries the code, never the request or the relay's answer.
function viewerFailure(route: string, status: number, code: string, corsHeaders: Record<string, string>, error?: string): Response {
  if (status >= 500) console.error(`[suspended-content] ${route}: ${code}`);
  return viewerJson({ success: false, error: error ?? FAILURE_TEXT[code] ?? code, code }, status, corsHeaders);
}

/** The audit database with its table ensured, or the 503 to send instead. */
async function openAuditLog(
  route: string,
  env: { DB?: D1Database },
  corsHeaders: Record<string, string>,
): Promise<D1Database | Response> {
  const db = env.DB;
  if (!db) return viewerFailure(route, 503, SUSPENDED_CONTENT_CODE.auditUnavailable, corsHeaders);
  try {
    await ensureSuspendedContentViewsTable(db);
    return db;
  } catch (err) {
    console.error(`[suspended-content] ${route}: audit table unavailable:`, err instanceof Error ? err.name : typeof err);
    return viewerFailure(route, 503, SUSPENDED_CONTENT_CODE.auditUnavailable, corsHeaders);
  }
}

/** Steps 1 to 3. Returns the verified moderator and the audit database, or the refusal. */
async function openViewerRequest<T>(
  route: string,
  request: Request,
  env: SuspendedContentEnv,
  corsHeaders: Record<string, string>,
  moderator: string | undefined,
  parse: (body: unknown) => T | { error: string },
): Promise<{ moderator: string; db: D1Database; req: T } | Response> {
  const gate = requireVerifiedModerator(moderator, corsHeaders);
  if (gate instanceof Response) {
    gate.headers.set('Cache-Control', 'no-store');
    return gate;
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return viewerFailure(route, 400, SUSPENDED_CONTENT_CODE.invalidRequest, corsHeaders, 'Body must be JSON');
  }
  const req = parse(body);
  if (req && typeof req === 'object' && 'error' in req) {
    return viewerFailure(route, 400, SUSPENDED_CONTENT_CODE.invalidRequest, corsHeaders, (req as { error: string }).error);
  }

  const db = await openAuditLog(route, env, corsHeaders);
  if (db instanceof Response) return db;
  return { moderator: gate.pubkey, db, req: req as T };
}

/** Step 5. False when the row could not be written; the caller then serves nothing. */
async function auditView(route: string, db: D1Database, row: SuspendedContentViewRow): Promise<boolean> {
  try {
    await recordSuspendedContentView(db, row);
    return true;
  } catch (err) {
    console.error(`[suspended-content] ${route}: audit insert failed:`, err instanceof Error ? err.name : typeof err);
    return false;
  }
}

export async function handleViewSuspendedEvent(
  request: Request,
  env: SuspendedContentEnv,
  corsHeaders: Record<string, string>,
  moderator: string | undefined,
): Promise<Response> {
  const route = 'event view';
  const opened = await openViewerRequest(route, request, env, corsHeaders, moderator, parseSuspendedEventRequest);
  if (opened instanceof Response) return opened;
  const { req, db } = opened;

  // A post hidden for another reason as well, such as one also individually
  // banned, answers hidden_for_another_reason. v1 has no getbannedevent
  // fallback: that read applies none of the relay's visibility filters
  // (deletion, vanish, withheld DM kinds), so serving through it could show
  // what getsuspendedevent rightly hides. divinevideo/divine-funnelcake#1445
  // tracks getsuspendedevent returning such posts with those filters kept.
  const read = await readSuspendedEvent(req.eventId, env);
  if (!read.ok) return viewerFailure(route, read.status, read.code, corsHeaders);
  const event = read.value;

  const recorded = await auditView(route, db, {
    moderatorPubkey: opened.moderator,
    targetPubkey: event.pubkey,
    scope: 'event',
    eventId: req.eventId,
    pageUntil: null,
    surface: req.surface,
    eventsServed: 1,
  });
  if (!recorded) return viewerFailure(route, 503, SUSPENDED_CONTENT_CODE.auditUnavailable, corsHeaders);

  const body: SuspendedEventResponse = { success: true, event };
  return viewerJson(body, 200, corsHeaders);
}

export async function handleViewSuspendedAccount(
  request: Request,
  env: SuspendedContentEnv,
  corsHeaders: Record<string, string>,
  moderator: string | undefined,
): Promise<Response> {
  const route = 'account view';
  const opened = await openViewerRequest(route, request, env, corsHeaders, moderator, parseSuspendedAccountRequest);
  if (opened instanceof Response) return opened;
  const { req, db } = opened;
  const firstPage = req.until === undefined;
  const pageRequest = { ...req, limit: req.limit ?? SUSPENDED_PAGE_DEFAULT };

  // The first page also carries the profile and the media list, read in
  // parallel with it. Neither of their failures decides the answer.
  const [page, profileRead, mediaRead] = await Promise.all([
    readSuspendedAccountPage(pageRequest, env),
    firstPage ? readSuspendedAccountPage({ pubkey: req.pubkey, kinds: [0], limit: 1 }, env) : null,
    firstPage ? readAccountMedia(req.pubkey, env) : null,
  ]);
  // The page read is what confirms the suspension. Without it, nothing else
  // read here (the profile, the media list) is returned.
  if (!page.ok) return viewerFailure(route, page.status, page.code, corsHeaders);

  let profile: NostrEventJson | null = null;
  let profileError: string | undefined;
  if (profileRead) {
    if (!profileRead.ok) profileError = profileRead.code;
    else profile = profileRead.value.events.find(e => e.kind === 0) ?? null;
  }

  const recorded = await auditView(route, db, {
    moderatorPubkey: opened.moderator,
    targetPubkey: req.pubkey,
    scope: 'account',
    eventId: null,
    pageUntil: req.until ?? null,
    surface: req.surface,
    eventsServed: page.value.events.length + (profile ? 1 : 0),
  });
  if (!recorded) return viewerFailure(route, 503, SUSPENDED_CONTENT_CODE.auditUnavailable, corsHeaders);

  const body: SuspendedAccountResponse = {
    success: true,
    pubkey: req.pubkey,
    profile,
    ...(profileError ? { profileError } : {}),
    events: page.value.events,
    nextUntil: page.value.nextUntil,
    nextUntilId: page.value.nextUntilId,
    media: mediaRead && 'media' in mediaRead ? mediaRead.media : null,
    ...(mediaRead && 'error' in mediaRead ? { mediaError: mediaRead.error } : {}),
  };
  return viewerJson(body, 200, corsHeaders);
}

// The account's video files, as hash and level. Videos only, a known limit of
// listAccountVideos. Its failure is reported by a fixed code; the reason is
// logged, not returned.
async function readAccountMedia(
  pubkey: string,
  env: MediaServerEnv,
): Promise<{ media: Array<{ sha256: string; level: string | null }> } | { error: string }> {
  try {
    const videos = await listAccountVideos(pubkey, env);
    return { media: videos.map(v => ({ sha256: v.sha256, level: v.level })) };
  } catch (err) {
    console.warn('[suspended-content] account view: media list failed:', err instanceof Error ? err.message : typeof err);
    return { error: 'media_unavailable' };
  }
}

// ============================================================================
// GET /api/suspended-content/views (the audit read)
// ============================================================================

const VIEWS_LIMIT_DEFAULT = 50;
const VIEWS_LIMIT_MAX = 200;

interface ViewRowDb {
  id: number; viewed_at: string; moderator_pubkey: string; target_pubkey: string; scope: string;
  event_id: string | null; page_until: number | null; surface: string; events_served: number;
}

/**
 * List audit rows, newest first, optionally for one target account or one
 * moderator, paged by id. Open to anyone past the access gate (Matt's Q5, v1);
 * it needs no Divine login.
 */
export async function handleListSuspendedContentViews(
  url: URL,
  env: { DB?: D1Database },
  corsHeaders: Record<string, string>,
): Promise<Response> {
  const route = 'views list';
  const invalid = (error: string) => viewerFailure(route, 400, SUSPENDED_CONTENT_CODE.invalidRequest, corsHeaders, error);
  const params = url.searchParams;

  const hexParam = (name: string): string | null | undefined => {
    const value = params.get(name);
    if (value === null) return undefined;
    return /^[0-9a-f]{64}$/i.test(value) ? value.toLowerCase() : null;
  };
  const target = hexParam('pubkey');
  if (target === null) return invalid('pubkey must be 64 hex characters');
  const moderatorFilter = hexParam('moderator');
  if (moderatorFilter === null) return invalid('moderator must be 64 hex characters');

  let before: number | undefined;
  const beforeRaw = params.get('before');
  if (beforeRaw !== null) {
    before = /^[1-9][0-9]{0,15}$/.test(beforeRaw) ? Number(beforeRaw) : NaN;
    if (!Number.isSafeInteger(before)) return invalid('before must be a positive integer');
  }
  let limit = VIEWS_LIMIT_DEFAULT;
  const limitRaw = params.get('limit');
  if (limitRaw !== null) {
    limit = /^[0-9]{1,3}$/.test(limitRaw) ? Number(limitRaw) : NaN;
    if (!(limit >= 1 && limit <= VIEWS_LIMIT_MAX)) return invalid(`limit must be an integer from 1 to ${VIEWS_LIMIT_MAX}`);
  }

  const db = env.DB;
  if (!db) return viewerFailure(route, 503, SUSPENDED_CONTENT_CODE.auditUnavailable, corsHeaders);
  try {
    await ensureSuspendedContentViewsTable(db);
    // Built from fixed fragments only; every value is bound. Each filter is a
    // plain equality so the (target, id) and (moderator, id) indexes apply.
    const where: string[] = [];
    const binds: unknown[] = [];
    if (target) { where.push('target_pubkey = ?'); binds.push(target); }
    if (moderatorFilter) { where.push('moderator_pubkey = ?'); binds.push(moderatorFilter); }
    if (before !== undefined) { where.push('id < ?'); binds.push(before); }
    const sql = `SELECT id, viewed_at, moderator_pubkey, target_pubkey, scope, event_id, page_until, surface, events_served
      FROM suspended_content_views ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY id DESC LIMIT ?`;
    const { results } = await db.prepare(sql).bind(...binds, limit + 1).all<ViewRowDb>();
    const rows = results.slice(0, limit);
    return viewerJson({
      success: true,
      views: rows.map(r => ({
        id: r.id,
        viewedAt: r.viewed_at,
        moderatorPubkey: r.moderator_pubkey,
        targetPubkey: r.target_pubkey,
        scope: r.scope,
        eventId: r.event_id,
        pageUntil: r.page_until,
        surface: r.surface,
        eventsServed: r.events_served,
      })),
      nextBefore: results.length > limit ? rows[rows.length - 1].id : null,
    }, 200, corsHeaders);
  } catch (err) {
    console.error(`[suspended-content] ${route}: read failed:`, err instanceof Error ? err.name : typeof err);
    return viewerFailure(route, 503, SUSPENDED_CONTENT_CODE.auditUnavailable, corsHeaders);
  }
}

// ============================================================================
// Sexual-quarantine snapshots of suspended authors
// ============================================================================

/**
 * Audit a suspended author's sexual-quarantine snapshot the way the viewer
 * audits a post (Matt, 2026-11-09). The case stores the full target event as
 * its snapshot, and the single-case GET returns it to anyone past the access
 * gate.
 *
 * Applied to every sexual-quarantine answer from the Durable Object that
 * carries a snapshot event, whatever the path: the Durable Object answers with
 * the whole case for /<id>, /<id>/ and /<id>/<anything but history>, and with
 * it again after a decision POST, so keying on the path shape could miss one.
 * The case list already drops snapshots and history entries carry none, so
 * they pass through untouched.
 *
 * For a GET:
 *  - author not suspended: unchanged;
 *  - author suspended, no `?snapshot=1` (the 15 s poll): the snapshot is
 *    withheld (`snapshotWithheld: 'suspended'`) and the rest of the case served;
 *  - author suspended, `?snapshot=1` (a moderator's click): a verified login,
 *    then one audit row, then the full case. Either failing serves no case;
 *  - suspension unknown (the list can't be read, or the event has no readable
 *    author): a poll withholds the snapshot like a suspended author's; a
 *    `?snapshot=1` open answers 503 with no case, failing closed.
 * The poll may decide from a suspended-list read up to 30 s old; the open
 * and the decision POST always read fresh.
 * For the decision POST, whose 202 is the saved case: the snapshot is withheld
 * when the author is suspended or that can't be told. The decision is already
 * saved, so refusing the answer would only hide that it worked; the moderator
 * opens the snapshot through the audited GET.
 *
 * Returns the body to send, or the refusal to send instead.
 */
export async function guardQuarantineSnapshot(
  data: unknown,
  status: number,
  request: Request,
  env: SuspendedContentEnv,
  corsHeaders: Record<string, string>,
  moderator: string | undefined,
): Promise<{ data: unknown } | Response> {
  if (status < 200 || status >= 300 || !data || typeof data !== 'object') return { data };
  // History and the case list name no author, so their media identifiers go
  // for every case: the screen shows neither field, and keeping them only for
  // authors known not to be suspended would cost a case read per entry.
  if (Array.isArray(data)) return { data: data.map(withoutHistoryMedia) };
  const body = data as {
    cases?: unknown; snapshot?: { event?: unknown }; mediaHoldAssets?: unknown; firstReport?: { source?: unknown };
  };
  if (Array.isArray(body.cases)) return { data: { ...body, cases: body.cases.map(withoutCaseMedia) } };
  if (body.snapshot === undefined && body.mediaHoldAssets === undefined) {
    // No snapshot yet, so no target author can be read, but the first report's
    // own event can still name the media (a hydrated legacy sourceRef). It goes,
    // as for an unknown author. There is no snapshot to withhold, so no
    // snapshotWithheld: the screen keeps saying the snapshot isn't available yet.
    return { data: body.firstReport?.source === undefined ? body : withoutCaseMedia(body) };
  }

  const route = 'quarantine snapshot';
  const withheld = (why: 'suspended' | 'unknown') => ({ data: { ...withoutCaseMedia(body), snapshotWithheld: why } });
  const event = (body.snapshot?.event ?? {}) as { id?: unknown; pubkey?: unknown };
  const author = typeof event.pubkey === 'string' && LOWER_HEX_64.test(event.pubkey) ? event.pubkey : null;
  const eventId = typeof event.id === 'string' && LOWER_HEX_64.test(event.id) ? event.id : null;
  const opensSnapshot = request.method === 'GET' && new URL(request.url).searchParams.get('snapshot') === '1';
  // Only the background poll may reuse a recent list read. That is not
  // withhold-only: for up to 30 s after a fresh suspension, a cached "not
  // suspended" lets the poll return the snapshot, unaudited. Matt accepted
  // that window (2026-11-09) to keep the poll from reading the whole list every
  // 15 s per tab. The audited open and the decision POST always read fresh.
  const poll = request.method === 'GET' && !opensSnapshot;
  const suspended = author && eventId
    ? await readAuthorSuspension(author, env, poll ? { maxAgeMs: SUSPENDED_LIST_POLL_MAX_AGE_MS } : {})
    : 'unknown';

  // The poll and the decision POST never reveal a snapshot whose author is,
  // or may be, suspended: they withhold it and keep the rest of the case, so
  // the page stays usable through a relay outage.
  if (!opensSnapshot) return suspended === false ? { data } : withheld(suspended === true ? 'suspended' : 'unknown');

  if (suspended === 'unknown') {
    return viewerFailure(route, 503, SUSPENSION_STATUS_UNAVAILABLE, corsHeaders, "Could not confirm the author's suspension status");
  }
  if (!suspended) return { data };

  const gate = requireVerifiedModerator(moderator, corsHeaders);
  if (gate instanceof Response) {
    gate.headers.set('Cache-Control', 'no-store');
    return gate;
  }
  const db = await openAuditLog(route, env, corsHeaders);
  if (db instanceof Response) return db;
  const recorded = await auditView(route, db, {
    moderatorPubkey: gate.pubkey,
    targetPubkey: author as string,
    scope: 'event',
    eventId: eventId as string,
    pageUntil: null,
    surface: 'sexual-quarantine',
    eventsServed: 1,
  });
  if (!recorded) return viewerFailure(route, 503, SUSPENDED_CONTENT_CODE.auditUnavailable, corsHeaders);
  return { data };
}

// Every field of a case that carries the target's media identifiers or
// content: the snapshot (the event and its asset hashes), the hold list built
// from it, and the first report's own event, whose tags can name the media.
function withoutCaseMedia<T>(sexualCase: T): T | Record<string, unknown> {
  if (!sexualCase || typeof sexualCase !== 'object') return sexualCase;
  const { snapshot: _snapshot, mediaHoldAssets: _holds, ...rest } = sexualCase as Record<string, unknown>;
  const report = rest.firstReport;
  if (report && typeof report === 'object') {
    const { source: _source, ...withoutSource } = report as Record<string, unknown>;
    rest.firstReport = withoutSource;
  }
  return rest;
}

// A history entry's media identifiers: a hold intent's hash, and a report
// entry's own event.
function withoutHistoryMedia(entry: unknown): unknown {
  if (!entry || typeof entry !== 'object') return entry;
  const { sha256: _sha256, source: _source, ...rest } = entry as Record<string, unknown>;
  return rest;
}
