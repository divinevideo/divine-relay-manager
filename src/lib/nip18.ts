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

/** The reposted event's id from a repost's `e` tag (NIP-18 says it MUST exist). */
export function getRepostTargetId(tags: string[][]): string | undefined {
  return tags.find(t => t[0] === 'e')?.[1];
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
      // Full element validation: hostile inner JSON can put non-arrays in tags,
      // or non-strings inside a tag — either would crash consumers like
      // MediaPreview that call string methods on tag members.
      tags: Array.isArray(o.tags)
        ? o.tags.filter((t): t is string[] => Array.isArray(t) && t.every(x => typeof x === 'string'))
        : [],
      pubkey: typeof o.pubkey === 'string' ? o.pubkey : '',
    };
  } catch {
    return null;
  }
}
