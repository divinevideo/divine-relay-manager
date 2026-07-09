// ABOUTME: NIP-18 repost helpers — kind 6/16 events carry the reposted event
// ABOUTME: as stringified JSON in their content field (or empty content)

export function isRepostKind(kind: number): boolean {
  return kind === 6 || kind === 16;
}

export interface RepostedEvent {
  content: string;
  tags: string[][];
  pubkey: string;
}

/**
 * Parse the inner (reposted) event out of a NIP-18 repost's content.
 * Returns null when content is empty, malformed JSON, or not event-shaped —
 * callers should treat that as "no inner content to show".
 */
export function parseRepostedEvent(content: string): RepostedEvent | null {
  try {
    const inner: unknown = JSON.parse(content);
    if (!inner || typeof inner !== 'object') return null;
    const o = inner as Record<string, unknown>;
    if (typeof o.content !== 'string') return null;
    return {
      content: o.content,
      // Element-level check too: a hostile inner event can put non-arrays in tags
      tags: Array.isArray(o.tags) ? (o.tags.filter(Array.isArray) as string[][]) : [],
      pubkey: typeof o.pubkey === 'string' ? o.pubkey : '',
    };
  } catch {
    return null;
  }
}
