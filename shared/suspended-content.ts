// ABOUTME: The suspended-content viewer's contract, shared by the worker and the client.
// ABOUTME: Request shapes and parsers, response shapes, error codes and page limits.

// Where a moderator opened the content. 'sexual-quarantine' is written only by
// the worker's quarantine-snapshot guard; the viewer endpoints refuse it.
export const SUSPENDED_VIEW_SURFACES = ['report', 'user', 'age-review', 'sexual-quarantine'] as const;
export type SuspendedViewSurface = (typeof SUSPENDED_VIEW_SURFACES)[number];

// Surfaces a viewer request may name. The quarantine surface is excluded: only
// the worker's own snapshot guard writes it.
const VIEWER_SURFACES: ReadonlySet<string> = new Set(['report', 'user', 'age-review']);

// Every non-200 viewer answer carries one of these. The client maps by code,
// never by status alone, so an old worker's bare 404 is not mistaken for one.
export const SUSPENDED_CONTENT_CODE = {
  notSuspended: 'not_suspended', // 409
  hiddenForAnotherReason: 'hidden_for_another_reason', // 404
  viewerUnsupported: 'viewer_unsupported', // 501
  relayError: 'relay_error', // 502
  auditUnavailable: 'audit_unavailable', // 503
  invalidRequest: 'invalid_request', // 400
} as const;

export const SUSPENDED_PAGE_DEFAULT = 50;
export const SUSPENDED_PAGE_MAX = 100;

// The relay's limits on listsuspendedpubkeyevents options (funnelcake #1406):
// `until` is a u32 of seconds, kinds are u16, and at most 64 of them.
const U32_MAX = 4294967295;
const KIND_MAX = 65535;
const KINDS_MAX = 64;

export interface NostrEventJson { id: string; pubkey: string; created_at: number; kind: number; tags: string[][]; content: string; sig: string }
export interface SuspendedEventRequest { eventId: string; surface: SuspendedViewSurface }
export interface SuspendedAccountRequest { pubkey: string; surface: SuspendedViewSurface; until?: number; untilId?: string; kinds?: number[]; limit?: number }
export interface SuspendedEventResponse { success: true; event: NostrEventJson }
export interface SuspendedAccountResponse {
  success: true;
  pubkey: string;
  /** The account's kind-0 profile. First page only; null on later pages, when it has none, or when its read failed. */
  profile: NostrEventJson | null;
  profileError?: string;
  events: NostrEventJson[];
  nextUntil: number | null;
  nextUntilId: string | null;
}

function hex64(value: unknown): string | null {
  return typeof value === 'string' && /^[0-9a-f]{64}$/i.test(value) ? value.toLowerCase() : null;
}

function intIn(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max;
}

function asObject(body: unknown): Record<string, unknown> | null {
  return body && typeof body === 'object' && !Array.isArray(body) ? body as Record<string, unknown> : null;
}

function viewerSurface(value: unknown): SuspendedViewSurface | null {
  return typeof value === 'string' && VIEWER_SURFACES.has(value) ? value as SuspendedViewSurface : null;
}

export function parseSuspendedEventRequest(body: unknown): SuspendedEventRequest | { error: string } {
  const input = asObject(body);
  if (!input) return { error: 'Body must be a JSON object' };
  const eventId = hex64(input.eventId);
  if (!eventId) return { error: 'eventId must be 64 hex characters' };
  const surface = viewerSurface(input.surface);
  if (!surface) return { error: 'surface must be report, user or age-review' };
  return { eventId, surface };
}

export function parseSuspendedAccountRequest(body: unknown): SuspendedAccountRequest | { error: string } {
  const input = asObject(body);
  if (!input) return { error: 'Body must be a JSON object' };
  const pubkey = hex64(input.pubkey);
  if (!pubkey) return { error: 'pubkey must be 64 hex characters' };
  const surface = viewerSurface(input.surface);
  if (!surface) return { error: 'surface must be report, user or age-review' };
  const request: SuspendedAccountRequest = { pubkey, surface };

  if (input.until !== undefined) {
    if (!intIn(input.until, 0, U32_MAX)) return { error: `until must be an integer from 0 to ${U32_MAX}` };
    request.until = input.until;
  }
  if (input.untilId !== undefined) {
    if (request.until === undefined) return { error: 'untilId requires until' };
    const untilId = hex64(input.untilId);
    if (!untilId) return { error: 'untilId must be 64 hex characters' };
    request.untilId = untilId;
  }
  if (input.kinds !== undefined) {
    const kinds = input.kinds;
    if (!Array.isArray(kinds) || kinds.length === 0 || kinds.length > KINDS_MAX
      || !kinds.every(kind => intIn(kind, 0, KIND_MAX))) {
      return { error: `kinds must list 1 to ${KINDS_MAX} event kinds` };
    }
    request.kinds = kinds as number[];
  }
  if (input.limit !== undefined) {
    if (!intIn(input.limit, 1, SUSPENDED_PAGE_MAX)) return { error: `limit must be an integer from 1 to ${SUSPENDED_PAGE_MAX}` };
    request.limit = input.limit;
  }
  return request;
}
