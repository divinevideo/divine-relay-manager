// ABOUTME: Events signed once with throwaway keys, for tests that need a real
// ABOUTME: signature: jsdom cannot sign (nostr-tools rejects its Uint8Array)

import type { NostrEvent } from '@nostrify/nostrify';

// Signed with the secret key 0x01 repeated 32 times. Its video and thumbnail
// are the VIDEO and THUMB hashes the media tests use.
export const SIGNED_VIDEO: NostrEvent = {
  kind: 34236,
  created_at: 1751000000,
  tags: [
    ['d', 'clip'],
    ['imeta',
      'url https://media.divine.video/81661ca024bec2be842557ff7e07c833660038f134203f10293568f5ea11863f',
      'm video/mp4',
      'image https://media.divine.video/b06e68dbec25463be257e44b06b0bcbb376d3cd1d5fa47e41747ead9e290e068',
      'x 81661ca024bec2be842557ff7e07c833660038f134203f10293568f5ea11863f'],
  ],
  content: '',
  pubkey: '1b84c5567b126440995d3ed5aaba0565d71e1834604819ff9c17f5e9d5dd078f',
  id: '9c3648df52fb7ebe86b8911a43b69908f268b5dd62d4c2b20409c007ef3dfbc3',
  sig: '44d187215d86304c08dcbab34727f577497c252ca1bcc55b466dea23bdbf0dac8d164f8847e137633b0c048a1308f779c022cf6e615866fb7d035bec505a50da',
};

// For jsdom tests, in place of nostr-tools' verifyEvent, which cannot run there:
// true only for an event identical, field by field, to one signed above. Real
// signature checks are tested under the node environment (src/lib/nip18.test.ts).
export function verifyKnownSignedEvent(event: NostrEvent): boolean {
  return [SIGNED_VIDEO, SIGNED_NOTE].some((signed) =>
    signed.id === event.id && signed.pubkey === event.pubkey && signed.sig === event.sig
    && signed.kind === event.kind && signed.created_at === event.created_at
    && signed.content === event.content && JSON.stringify(signed.tags) === JSON.stringify(event.tags));
}

// Signed with the secret key 0x02 repeated 32 times.
export const SIGNED_NOTE: NostrEvent = {
  kind: 1,
  created_at: 1751000001,
  tags: [],
  content: 'other',
  pubkey: '4d4b6cd1361032ca9bd2aeb9d900aa4d45d9ead80ac9423374c451a7254d0766',
  id: 'ceef0c21195a624f82d75eba24969f15fa66990305892e283ce536183295a7ff',
  sig: 'db1d8fa7ded13ce1ed10d85d860308c79800481be15f73f91bc57908196a90e8153dbcd85278cdc9e8600f1dd04b501c9ebc09a22b9d18981ef611399202f357',
};
