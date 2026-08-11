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
