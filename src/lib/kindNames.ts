// ABOUTME: Comprehensive mapping of Nostr event kind numbers to human-readable names
// ABOUTME: Based on NIPs and common usage patterns in the Nostr ecosystem

export const KIND_NAMES: Record<number, { name: string; description: string; nip?: string }> = {
  // Core Protocol (NIP-01)
  0: { name: 'Profile Metadata', description: 'User profile information (name, about, picture)', nip: 'NIP-01' },
  1: { name: 'Text Note', description: 'Short text note (like a tweet)', nip: 'NIP-01' },
  2: { name: 'Relay List', description: 'Recommend relay (deprecated)', nip: 'NIP-01' },
  3: { name: 'Contact List', description: 'Follow list and relay preferences', nip: 'NIP-02' },
  4: { name: 'Encrypted DM', description: 'NIP-04 encrypted direct message', nip: 'NIP-04' },
  5: { name: 'Deletion', description: 'Event deletion request', nip: 'NIP-09' },
  6: { name: 'Repost', description: 'Repost/boost of another note', nip: 'NIP-18' },
  7: { name: 'Reaction', description: 'Like/reaction to another event', nip: 'NIP-25' },
  8: { name: 'Badge Award', description: 'Award a badge to a user', nip: 'NIP-58' },
  9: { name: 'Group Chat Message', description: 'Message in a group chat', nip: 'NIP-29' },
  10: { name: 'Group Chat Threaded', description: 'Threaded reply in group chat', nip: 'NIP-29' },
  11: { name: 'Group Thread', description: 'Thread starter in group', nip: 'NIP-29' },
  12: { name: 'Group Thread Reply', description: 'Reply in group thread', nip: 'NIP-29' },
  13: { name: 'Seal', description: 'Sealed/encrypted wrapper', nip: 'NIP-59' },
  14: { name: 'DM (NIP-17)', description: 'Direct message (NIP-17 style)', nip: 'NIP-17' },
  16: { name: 'Generic Repost', description: 'Repost of any event kind', nip: 'NIP-18' },
  17: { name: 'Reaction to Website', description: 'Reaction to external URL', nip: 'NIP-25' },

  // Channels
  40: { name: 'Channel Creation', description: 'Create a public channel', nip: 'NIP-28' },
  41: { name: 'Channel Metadata', description: 'Update channel metadata', nip: 'NIP-28' },
  42: { name: 'Channel Message', description: 'Message in a channel', nip: 'NIP-28' },
  43: { name: 'Channel Hide Message', description: 'Hide a channel message', nip: 'NIP-28' },
  44: { name: 'Channel Mute User', description: 'Mute user in channel', nip: 'NIP-28' },

  // Public Chats (NIP-29 Groups)
  1021: { name: 'Bid', description: 'Auction bid', nip: '' },
  1022: { name: 'Bid Confirmation', description: 'Auction bid confirmation', nip: '' },
  1040: { name: 'OpenTimestamps', description: 'OpenTimestamps attestation', nip: 'NIP-03' },
  1059: { name: 'Gift Wrap', description: 'Gift wrapped encrypted event', nip: 'NIP-59' },
  1063: { name: 'File Metadata', description: 'File/media metadata', nip: 'NIP-94' },
  1111: { name: 'Comment', description: 'Comment on any event', nip: 'NIP-22' },

  // Reports and Moderation
  1984: { name: 'Report', description: 'Report user or content', nip: 'NIP-56' },
  1985: { name: 'Label', description: 'Content label/tag', nip: 'NIP-32' },

  // Relay and Management
  10000: { name: 'Mute List', description: 'List of muted pubkeys', nip: 'NIP-51' },
  10001: { name: 'Pin List', description: 'List of pinned events', nip: 'NIP-51' },
  10002: { name: 'Relay List', description: 'User relay list (NIP-65)', nip: 'NIP-65' },
  10003: { name: 'Bookmark List', description: 'Bookmarked events', nip: 'NIP-51' },
  10004: { name: 'Communities List', description: 'Joined communities', nip: 'NIP-51' },
  10005: { name: 'Public Chats List', description: 'Public chat subscriptions', nip: 'NIP-51' },
  10006: { name: 'Blocked Relays', description: 'Blocked relay list', nip: 'NIP-51' },
  10007: { name: 'Search Relays', description: 'Search relay preferences', nip: 'NIP-51' },
  10009: { name: 'User Groups', description: 'User group memberships', nip: 'NIP-51' },
  10015: { name: 'Interests List', description: 'User interests/topics', nip: 'NIP-51' },
  10030: { name: 'Emoji List', description: 'Custom emoji list', nip: 'NIP-51' },
  10050: { name: 'DM Relays', description: 'Preferred DM relays', nip: 'NIP-17' },
  10096: { name: 'File Storage Servers', description: 'File storage preferences', nip: 'NIP-96' },

  // Wallet and Lightning
  13194: { name: 'Wallet Info', description: 'NWC wallet info', nip: 'NIP-47' },

  // Long-form Content
  30000: { name: 'Follow Sets', description: 'Categorized follow lists', nip: 'NIP-51' },
  30001: { name: 'Generic Lists', description: 'Generic list container', nip: 'NIP-51' },
  30002: { name: 'Relay Sets', description: 'Relay list sets', nip: 'NIP-51' },
  30003: { name: 'Bookmark Sets', description: 'Bookmark categories', nip: 'NIP-51' },
  30004: { name: 'Curation Sets', description: 'Curated content sets', nip: 'NIP-51' },
  30008: { name: 'Profile Badges', description: 'Badges on profile', nip: 'NIP-58' },
  30009: { name: 'Badge Definition', description: 'Define a badge', nip: 'NIP-58' },
  30015: { name: 'Interest Sets', description: 'Interest categories', nip: 'NIP-51' },
  30017: { name: 'Stall', description: 'Marketplace stall', nip: 'NIP-15' },
  30018: { name: 'Product', description: 'Marketplace product', nip: 'NIP-15' },
  30019: { name: 'Marketplace UI', description: 'Marketplace UI/UX', nip: 'NIP-15' },
  30023: { name: 'Long-form Article', description: 'Blog post/article', nip: 'NIP-23' },
  30024: { name: 'Draft Article', description: 'Draft long-form content', nip: 'NIP-23' },
  30030: { name: 'Emoji Set', description: 'Custom emoji pack', nip: 'NIP-30' },
  30040: { name: 'Modular Article Header', description: 'Article with modular content', nip: '' },
  30041: { name: 'Modular Article Content', description: 'Modular content block', nip: '' },
  30063: { name: 'Release Artifact Set', description: 'Software release set', nip: '' },
  30078: { name: 'App-Specific Data', description: 'Application-specific data', nip: 'NIP-78' },
  30311: { name: 'Live Event', description: 'Live streaming event', nip: 'NIP-53' },
  30315: { name: 'User Status', description: 'User status (music, etc)', nip: 'NIP-38' },
  30402: { name: 'Classified Listing', description: 'Classified ad', nip: 'NIP-99' },
  30403: { name: 'Draft Classified', description: 'Draft classified', nip: 'NIP-99' },
  30617: { name: 'Git Repository', description: 'Git repo announcement', nip: '' },
  30618: { name: 'Git Repository State', description: 'Git repo state', nip: '' },

  // DVMs (Data Vending Machines) - NIP-90
  5000: { name: 'DVM Text Generation', description: 'Request text generation', nip: 'NIP-90' },
  5001: { name: 'DVM Summarization', description: 'Request summarization', nip: 'NIP-90' },
  5002: { name: 'DVM Translation', description: 'Request translation', nip: 'NIP-90' },
  5050: { name: 'DVM Text-to-Speech', description: 'Request TTS', nip: 'NIP-90' },
  5100: { name: 'DVM Image Generation', description: 'Request image generation', nip: 'NIP-90' },
  5250: { name: 'DVM Video Generation', description: 'Request video generation', nip: 'NIP-90' },
  5300: { name: 'DVM Content Discovery', description: 'Content discovery', nip: 'NIP-90' },
  5301: { name: 'DVM People Discovery', description: 'People discovery', nip: 'NIP-90' },
  5900: { name: 'DVM Generic Request', description: 'Generic DVM request', nip: 'NIP-90' },
  6000: { name: 'DVM Text Result', description: 'DVM text result', nip: 'NIP-90' },
  6001: { name: 'DVM Summary Result', description: 'DVM summary result', nip: 'NIP-90' },
  6002: { name: 'DVM Translation Result', description: 'DVM translation result', nip: 'NIP-90' },
  6050: { name: 'DVM TTS Result', description: 'DVM TTS result', nip: 'NIP-90' },
  6100: { name: 'DVM Image Result', description: 'DVM image result', nip: 'NIP-90' },
  6250: { name: 'DVM Video Result', description: 'DVM video result', nip: 'NIP-90' },
  6300: { name: 'DVM Content Result', description: 'DVM content result', nip: 'NIP-90' },
  6301: { name: 'DVM People Result', description: 'DVM people result', nip: 'NIP-90' },
  6900: { name: 'DVM Generic Result', description: 'DVM generic result', nip: 'NIP-90' },
  7000: { name: 'DVM Feedback', description: 'DVM job feedback', nip: 'NIP-90' },

  // NWC (Nostr Wallet Connect)
  23194: { name: 'NWC Request', description: 'Wallet connect request', nip: 'NIP-47' },
  23195: { name: 'NWC Response', description: 'Wallet connect response', nip: 'NIP-47' },

  // HTTP Auth
  27235: { name: 'HTTP Auth', description: 'HTTP authentication', nip: 'NIP-98' },

  // Zaps
  9734: { name: 'Zap Request', description: 'Lightning zap request', nip: 'NIP-57' },
  9735: { name: 'Zap Receipt', description: 'Lightning zap receipt', nip: 'NIP-57' },

  // Client Authentication
  22242: { name: 'Client Auth', description: 'Client authentication', nip: 'NIP-42' },

  // Highlights
  9802: { name: 'Highlight', description: 'Text highlight', nip: 'NIP-84' },

  // Communities
  34550: { name: 'Community Definition', description: 'Define a community', nip: 'NIP-72' },

  // Calendar Events
  31922: { name: 'Calendar Date Event', description: 'Date-based calendar event', nip: 'NIP-52' },
  31923: { name: 'Calendar Time Event', description: 'Time-based calendar event', nip: 'NIP-52' },
  31924: { name: 'Calendar', description: 'Calendar container', nip: 'NIP-52' },
  31925: { name: 'Calendar RSVP', description: 'Calendar event RSVP', nip: 'NIP-52' },

  // Handler Recommendations
  31989: { name: 'Handler Recommendation', description: 'Recommend event handler', nip: 'NIP-89' },
  31990: { name: 'Handler Information', description: 'Handler app info', nip: 'NIP-89' },

  // Wiki
  30818: { name: 'Wiki Article', description: 'Wiki page', nip: 'NIP-54' },

  // Video Events (Divine Video specific)
  21: { name: 'Video Note', description: 'Short-form video', nip: '' },
  34235: { name: 'Video', description: 'Video event', nip: 'NIP-71' },
  34236: { name: 'Video View', description: 'Video view record', nip: 'NIP-71' },
  34237: { name: 'Short Video', description: 'Short-form video', nip: 'NIP-71' },

  // What's Hot (custom)
  11998: { name: "What's Hot", description: 'Trending/hot content aggregation', nip: '' },
};

// Get kind name with fallback
export function getKindName(kind: number): string {
  return KIND_NAMES[kind]?.name || `Kind ${kind}`;
}

// Get kind info
export function getKindInfo(kind: number): { name: string; description: string; nip?: string } {
  return KIND_NAMES[kind] || {
    name: `Kind ${kind}`,
    description: `Unknown event kind ${kind}`
  };
}

// Get category for a kind
export function getKindCategory(kind: number): string {
  if (kind === 0) return 'Profile';
  if (kind >= 1 && kind <= 2) return 'Notes';
  if (kind === 3) return 'Social Graph';
  if (kind >= 4 && kind <= 14) return 'Messaging';
  if (kind >= 40 && kind <= 44) return 'Channels';
  if (kind >= 1000 && kind < 2000) return 'Misc';
  if (kind === 1984 || kind === 1985) return 'Moderation';
  if (kind >= 5000 && kind < 8000) return 'DVM';
  if (kind >= 9000 && kind < 10000) return 'Lightning';
  if (kind >= 10000 && kind < 20000) return 'Replaceable';
  if (kind >= 20000 && kind < 30000) return 'Ephemeral';
  if (kind >= 30000 && kind < 40000) return 'Addressable';
  return 'Other';
}
