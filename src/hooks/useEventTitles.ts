// ABOUTME: Batch-resolves NIP-22 comment parents to titles + encoded internal links,
// ABOUTME: degrading unresolved targets to their id/coordinate (#164 A)

import { useNostr } from '@nostrify/react';
import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';
import type { NostrEvent } from '@nostrify/nostrify';
import { parseCommentTarget, encodeTarget, extractEventTitle, buildTitleFilters, type ParsedTarget } from '@/lib/eventTitles';
import { eventAddress } from '@/lib/threadFilters';
import { useAppContext } from '@/hooks/useAppContext';

export interface ResolvedTarget {
  target: string;
  title: string;
  encoded: string;
  kind?: number;
}

function fallbackTitle(parsed: ParsedTarget, target: string): string {
  return parsed.kind === 'id' ? `${parsed.id.slice(0, 8)}…` : target;
}

/** Build the target→ResolvedTarget map from fetched events. Pure; exported for tests. */
export function buildResolvedMap(targets: string[], events: NostrEvent[]): Map<string, ResolvedTarget> {
  const byId = new Map(events.map(e => [e.id, e]));
  const byAddress = new Map<string, NostrEvent>();
  for (const e of events) {
    const addr = eventAddress(e);
    if (addr) byAddress.set(addr, e);
  }

  const map = new Map<string, ResolvedTarget>();
  for (const target of targets) {
    const parsed = parseCommentTarget(target);
    if (!parsed) continue;
    const encoded = encodeTarget(parsed);
    // Look up by the parsed (case-normalized) form, not the raw tag value
    const found = parsed.kind === 'id'
      ? byId.get(parsed.id)
      : byAddress.get(`${parsed.addressKind}:${parsed.pubkey}:${parsed.identifier}`);
    if (found) {
      const title = extractEventTitle(found);
      map.set(target, { target, encoded, kind: found.kind, title: title || fallbackTitle(parsed, target) });
    } else {
      map.set(target, { target, encoded, title: fallbackTitle(parsed, target) });
    }
  }
  return map;
}

const NO_EVENTS: NostrEvent[] = [];

/**
 * Resolve a set of comment targets to display titles + internal-link encodings.
 * Distinct targets are fetched in one batched query; results degrade gracefully
 * so every parseable target is always linkable.
 */
export function useEventTitles(targets: string[]): { titles: Map<string, ResolvedTarget>; isLoading: boolean } {
  const { nostr } = useNostr();
  const { config } = useAppContext();
  // Environment key (useAuthor pattern): the query hits the relay, but relay
  // and API switch together — keying on apiUrl stops cached titles from one
  // environment being served in another across the long-lived QueryClient.
  const apiUrl = config.apiUrl;
  // Stabilize identity at the hook boundary: some callers derive targets from
  // filtered rows (new array every render), so memoize off the content, not
  // the reference — no per-render map rebuilds, no caller memo requirement
  const distinctKey = JSON.stringify(Array.from(new Set(targets)).sort());
  const distinct = useMemo(() => JSON.parse(distinctKey) as string[], [distinctKey]);

  const { data, isLoading } = useQuery<NostrEvent[]>({
    queryKey: ['event-titles', apiUrl ?? '', distinct],
    queryFn: async ({ signal }) => {
      const filters = buildTitleFilters(distinct);
      if (filters.length === 0) return [];
      return nostr.query(filters, { signal: AbortSignal.any([signal, AbortSignal.timeout(5000)]) });
    },
    enabled: distinct.length > 0,
    staleTime: 5 * 60_000,
  });

  // Stable empty fallback — an inline `= []` default would re-defeat the
  // identity stabilization above for the whole pending/disabled window
  const events = data ?? NO_EVENTS;
  const titles = useMemo(() => buildResolvedMap(distinct, events), [distinct, events]);
  return { titles, isLoading };
}
