// ABOUTME: Tests EventsList search parsing incl. naddr internal-nav (#164 A)

import { describe, it, expect } from 'vitest';
import { nip19 } from 'nostr-tools';
import { parseSearchInput } from './EventsList';

const PK = 'b'.repeat(64);

describe('parseSearchInput naddr', () => {
  it('parses an naddr into an address search mode', () => {
    const naddr = nip19.naddrEncode({ kind: 34236, pubkey: PK, identifier: 'vid1' });
    expect(parseSearchInput(naddr)).toEqual({
      type: 'address', addressKind: 34236, pubkey: PK, identifier: 'vid1',
    });
  });

  it('still parses nevent as event_id', () => {
    const nevent = nip19.neventEncode({ id: 'c'.repeat(64) });
    expect(parseSearchInput(nevent)).toEqual({ type: 'event_id', hex: 'c'.repeat(64) });
  });

  it('still parses npub as pubkey', () => {
    const npub = nip19.npubEncode(PK);
    expect(parseSearchInput(npub)).toEqual({ type: 'pubkey', hex: PK });
  });
});
