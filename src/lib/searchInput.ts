// ABOUTME: Parses the Events search input into a typed search mode —
// ABOUTME: NIP-19 identifiers (note/nevent/npub/nprofile/naddr), hex ids, or text

import { nip19 } from "nostr-tools";

export type SearchMode =
  | { type: 'none' }
  | { type: 'event_id'; hex: string }
  | { type: 'pubkey'; hex: string }
  | { type: 'address'; addressKind: number; pubkey: string; identifier: string }
  | { type: 'text'; query: string };

export function parseSearchInput(input: string): SearchMode {
  const trimmed = input.trim();
  if (!trimmed) return { type: 'none' };

  // NIP-19 encoded identifiers
  if (trimmed.startsWith('note1') || trimmed.startsWith('nevent1')) {
    try {
      const decoded = nip19.decode(trimmed);
      if (decoded.type === 'note') {
        return { type: 'event_id', hex: decoded.data };
      } else if (decoded.type === 'nevent') {
        return { type: 'event_id', hex: decoded.data.id };
      }
    } catch {
      // Invalid encoding, fall through to text search
    }
  }

  if (trimmed.startsWith('npub1') || trimmed.startsWith('nprofile1')) {
    try {
      const decoded = nip19.decode(trimmed);
      if (decoded.type === 'npub') {
        return { type: 'pubkey', hex: decoded.data };
      } else if (decoded.type === 'nprofile') {
        return { type: 'pubkey', hex: decoded.data.pubkey };
      }
    } catch {
      // Invalid encoding, fall through to text search
    }
  }

  // Addressable coordinate (naddr) — an internal parent link for an addressable
  // video routes here, so resolve it to a kind+author+d lookup (#164 A)
  if (trimmed.startsWith('naddr1')) {
    try {
      const decoded = nip19.decode(trimmed);
      if (decoded.type === 'naddr') {
        return {
          type: 'address',
          addressKind: decoded.data.kind,
          pubkey: decoded.data.pubkey,
          identifier: decoded.data.identifier,
        };
      }
    } catch {
      // Invalid encoding, fall through to text search
    }
  }

  // 64-char hex defaults to event ID lookup
  if (/^[0-9a-f]{64}$/i.test(trimmed)) {
    return { type: 'event_id', hex: trimmed.toLowerCase() };
  }

  return { type: 'text', query: trimmed };
}
