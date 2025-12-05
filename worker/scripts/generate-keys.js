// ABOUTME: Script to generate a new Nostr keypair for the Worker
// ABOUTME: Run with: node scripts/generate-keys.js

import { generateSecretKey, getPublicKey, nip19 } from 'nostr-tools';

const secretKey = generateSecretKey();
const pubkey = getPublicKey(secretKey);

const nsec = nip19.nsecEncode(secretKey);
const npub = nip19.npubEncode(pubkey);

console.log('=== Generated Nostr Keypair for Worker ===\n');
console.log('NSEC (SECRET - add to Worker secrets):');
console.log(nsec);
console.log('\nNPUB (PUBLIC - authorize on relay):');
console.log(npub);
console.log('\nHex pubkey:');
console.log(pubkey);
console.log('\n=== Instructions ===');
console.log('1. Copy the NPUB and authorize it on relay.divine.video');
console.log('2. Run: cd worker && wrangler secret put NOSTR_NSEC');
console.log('3. Paste the NSEC when prompted');
