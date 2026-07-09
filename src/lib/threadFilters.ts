// ABOUTME: Builds relay filters for an event's replies and NIP-22 comments —
// ABOUTME: kind-1 NIP-10 replies plus kind-1111 comments scoped by root E/A tag

import type { NostrEvent, NostrFilter } from "@nostrify/nostrify";

// NIP-01 addressable (parameterized replaceable) range.
const ADDRESSABLE_MIN = 30000;
const ADDRESSABLE_MAX = 40000;

/**
 * The `kind:pubkey:d-tag` coordinate for an addressable event, else undefined.
 * NIP-22 comments on addressable content (e.g. Divine videos 34235/34236)
 * scope to it by this address rather than by event id.
 */
export function eventAddress(
  event: Pick<NostrEvent, 'kind' | 'pubkey' | 'tags'>,
): string | undefined {
  if (event.kind < ADDRESSABLE_MIN || event.kind >= ADDRESSABLE_MAX) return undefined;
  const d = event.tags.find(t => t[0] === 'd')?.[1] ?? '';
  return `${event.kind}:${event.pubkey}:${d}`;
}

/**
 * Relay filters for everything threaded under `event`:
 * - NIP-10 kind-1 replies referencing it by lowercase `e`
 * - NIP-22 kind-1111 comments scoped to it as root by uppercase `E` (event id),
 *   and for addressable events also by uppercase `A` (address coordinate)
 *
 * Divine comments are kind 1111, so a `kinds:[1]` query alone misses them —
 * this is the query foundation for #164 B (show a video's comments on its
 * report). Uppercase `E`/`A` catch the whole comment tree (top-level + nested,
 * which all carry the root scope), not just direct children.
 */
export function buildThreadReplyFilters(
  event: Pick<NostrEvent, 'id' | 'kind' | 'pubkey' | 'tags'>,
  limit = 100,
): NostrFilter[] {
  const filters: NostrFilter[] = [
    { kinds: [1], '#e': [event.id], limit },
    { kinds: [1111], '#E': [event.id], limit },
  ];
  const address = eventAddress(event);
  if (address) {
    filters.push({ kinds: [1111], '#A': [address], limit });
  }
  return filters;
}
