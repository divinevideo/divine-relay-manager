// ABOUTME: The canonical form of a 64-character hex id (event id, pubkey), for the worker and the client.
// ABOUTME: Reporter-authored tags can spell an id in any case; it is lowercased where it enters.

// NIP-01 ids and pubkeys are lowercase hex, and decisions, cases, labels and
// relay bans are now written that way. A report's tags are written by the
// reporter's client, so a valid id may arrive in uppercase. Null for
// anything that is not 64 hex characters, which callers leave as written or
// skip: lowercasing a malformed value would not make it an id.
export function canonicalHex64(value: unknown): string | null {
  return typeof value === 'string' && /^[0-9a-f]{64}$/i.test(value) ? value.toLowerCase() : null;
}

// The values a relay `#e` or `#p` filter asks for, to find tags spelling an id
// however a reporter wrote it. Relay tag filters match exactly, so the
// lowercase id alone never returns a tag written in uppercase (#315). A
// mixed-case spelling can't be enumerated and isn't asked for. Any other value
// is asked for as written, the spelling getReportTarget keys it by.
export function hexTagFilterValues(value: string): string[] {
  const hex = canonicalHex64(value);
  if (!hex) return [value];
  const upper = hex.toUpperCase();
  return upper === hex ? [hex] : [hex, upper];
}
