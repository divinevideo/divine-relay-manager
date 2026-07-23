// ABOUTME: Builds the relay filter for GET /api/reports, honoring optional
// ABOUTME: ?event=/?pubkey= deep-link target params for scoped lookups.

const REPORT_KIND = 1984;
const BULK_LIMIT = 200;

export function buildReportsFilter(params: URLSearchParams): {
  kinds: number[];
  limit?: number;
  '#e'?: string[];
  '#p'?: string[];
} {
  // Nostr event ids and pubkeys are lowercase hex; relay filters match exactly.
  // Normalize so an uppercase-hex deep link still resolves instead of false-'gone'.
  const event = params.get('event');
  if (event) {
    return { kinds: [REPORT_KIND], '#e': [event.toLowerCase()], limit: BULK_LIMIT };
  }
  const pubkey = params.get('pubkey');
  if (pubkey) {
    return { kinds: [REPORT_KIND], '#p': [pubkey.toLowerCase()], limit: BULK_LIMIT };
  }
  return { kinds: [REPORT_KIND], limit: BULK_LIMIT };
}

// A targeted deep-link lookup (?event=/?pubkey=) that came back empty without the relay
// confirming end-of-stored-events (no EOSE — a timeout or early close) is ambiguous, not
// proof of absence. The caller should surface it as "unavailable" (retry), never as a
// deletion. Bulk requests (no target param) are exempt: they self-correct on the next poll.
export function isUnconfirmedTargetedMiss(
  params: URLSearchParams,
  result: { events?: unknown[]; complete?: boolean }
): boolean {
  const isTargeted = params.has('event') || params.has('pubkey');
  return isTargeted && !result.complete && (result.events?.length ?? 0) === 0;
}
