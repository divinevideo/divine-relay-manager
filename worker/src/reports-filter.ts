// ABOUTME: Decides which of the three GET /api/reports modes a request is, and
// ABOUTME: the relay filter each one reads.

export const REPORT_KIND = 1984;

// Legacy bulk mode only. Kept exactly as it was so a frontend that does not ask
// for the needs-attention mode -- an old bundle during a deploy, or after a
// Pages-only rollback -- gets today's behaviour.
const LEGACY_BULK_LIMIT = 200;

// Page size for every walked report read. Large enough that a full walk of
// today's corpus takes only a couple of round trips, while staying well
// inside the relay's per-request limits. The filter's `limit` and the
// pager's `pageSize` are this one value in each code path; if they drifted,
// every page would read as short.
export const REPORTS_PAGE_SIZE = 2000;
export const REPORTS_MAX_PAGES = 20;

export type ReportsMode =
  | { kind: 'target'; filter: { kinds: number[]; '#e'?: string[]; '#p'?: string[] } }
  | { kind: 'needs-attention' }
  | { kind: 'legacy-bulk'; filter: { kinds: number[]; limit: number } };

// Targeted lookups win over everything: they exist to find reports for targets
// the queue has dropped, including resolved ones, so they are never filtered.
// Nostr ids are lowercase hex and relay filters match exactly, so normalize.
export function reportsMode(params: URLSearchParams): ReportsMode {
  const event = params.get('event');
  if (event) return { kind: 'target', filter: { kinds: [REPORT_KIND], '#e': [event.toLowerCase()] } };
  const pubkey = params.get('pubkey');
  if (pubkey) return { kind: 'target', filter: { kinds: [REPORT_KIND], '#p': [pubkey.toLowerCase()] } };
  if (params.get('needs_attention') === '1') return { kind: 'needs-attention' };
  return { kind: 'legacy-bulk', filter: { kinds: [REPORT_KIND], limit: LEGACY_BULK_LIMIT } };
}
