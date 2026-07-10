// ABOUTME: Pure helpers to parse a NIP-22 comment's parent target (id or address),
// ABOUTME: encode it for an internal link, extract a display title, and batch-fetch

import { nip19 } from 'nostr-tools';
import type { NostrEvent, NostrFilter } from '@nostrify/nostrify';
import { isHex64 } from '@/lib/constants';

export type ParsedTarget =
  | { kind: 'id'; id: string }
  | { kind: 'address'; addressKind: number; pubkey: string; identifier: string };

/**
 * Parse a comment target (from getCommentTarget): a 64-hex event id, or a
 * `kind:pubkey:d` address coordinate. Targets come from commenter-authored
 * tags, so both shapes are validated (numeric kind, 64-hex pubkey) before use.
 */
export function parseCommentTarget(target: string): ParsedTarget | null {
  // isHex64 is a `value is string` guard; using it in a ternary (not `if`) keeps
  // `target` typed as `string` for the address branch below rather than `never`.
  const id = isHex64(target) ? target : null;
  if (id !== null) return { kind: 'id', id };
  const parts = target.split(':');
  if (parts.length >= 3 && /^\d+$/.test(parts[0]) && isHex64(parts[1])) {
    return {
      kind: 'address',
      addressKind: Number(parts[0]),
      pubkey: parts[1],
      // d-tags may contain ':' — rejoin the remainder
      identifier: parts.slice(2).join(':'),
    };
  }
  return null;
}

/** nevent for an id target, naddr for an address target — for /events?event= links. */
export function encodeTarget(parsed: ParsedTarget): string {
  return parsed.kind === 'id'
    ? nip19.neventEncode({ id: parsed.id })
    : nip19.naddrEncode({ kind: parsed.addressKind, pubkey: parsed.pubkey, identifier: parsed.identifier });
}

/** Human title for a parent event: title tag, else a trimmed 60-char content snippet. */
export function extractEventTitle(event: Pick<NostrEvent, 'kind' | 'content' | 'tags'>): string {
  const title = event.tags.find(t => t[0] === 'title')?.[1];
  if (title && title.trim()) return title.trim();
  const snippet = event.content.trim();
  if (!snippet) return '';
  return snippet.length > 60 ? snippet.slice(0, 60) + '…' : snippet;
}

/** One batched query for a set of targets: ids grouped, each address its own filter. */
export function buildTitleFilters(targets: string[]): NostrFilter[] {
  const ids: string[] = [];
  const filters: NostrFilter[] = [];
  for (const target of targets) {
    const parsed = parseCommentTarget(target);
    if (!parsed) continue;
    if (parsed.kind === 'id') {
      ids.push(parsed.id);
    } else {
      filters.push({ kinds: [parsed.addressKind], authors: [parsed.pubkey], '#d': [parsed.identifier], limit: 1 });
    }
  }
  if (ids.length) filters.unshift({ ids });
  return filters;
}
