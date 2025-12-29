// ABOUTME: Generates deterministic, human-readable names from Nostr pubkeys
// ABOUTME: Uses a word list to create consistent names like "Swift Falcon" from pubkey hashes

const ADJECTIVES = [
  'Swift', 'Bold', 'Bright', 'Calm', 'Clever', 'Cool', 'Dark', 'Fast', 'Fierce', 'Gentle',
  'Golden', 'Great', 'Happy', 'Kind', 'Lucky', 'Mighty', 'Noble', 'Proud', 'Quick', 'Quiet',
  'Rapid', 'Sharp', 'Silent', 'Smart', 'Smooth', 'Solid', 'Steady', 'Strong', 'Swift', 'Wise',
  'Wild', 'Witty', 'Young', 'Ancient', 'Brave', 'Clever', 'Daring', 'Eager', 'Fierce', 'Gentle'
];

const NOUNS = [
  'Falcon', 'Eagle', 'Wolf', 'Lion', 'Tiger', 'Bear', 'Fox', 'Hawk', 'Raven', 'Owl',
  'Shark', 'Dolphin', 'Whale', 'Stag', 'Deer', 'Horse', 'Panther', 'Jaguar', 'Leopard', 'Lynx',
  'Phoenix', 'Dragon', 'Griffin', 'Unicorn', 'Sphinx', 'Pegasus', 'Kraken', 'Basilisk', 'Hydra', 'Chimera',
  'Storm', 'Thunder', 'Lightning', 'Blaze', 'Flame', 'Shadow', 'Star', 'Moon', 'Sun', 'Comet'
];

/**
 * Generates a deterministic, human-readable name from a Nostr pubkey.
 * Uses the pubkey hash to select words from predefined lists.
 * 
 * @param pubkey - Hex-encoded Nostr public key
 * @returns A name like "Swift Falcon" or "Bold Eagle"
 */
export function genUserName(pubkey: string): string {
  // Convert pubkey to a number for deterministic selection
  // Use first 8 characters of pubkey as seed
  const seed = parseInt(pubkey.slice(0, 8), 16);
  
  // Select adjective and noun deterministically
  const adjectiveIndex = seed % ADJECTIVES.length;
  const nounIndex = Math.floor(seed / ADJECTIVES.length) % NOUNS.length;
  
  return `${ADJECTIVES[adjectiveIndex]} ${NOUNS[nounIndex]}`;
}

