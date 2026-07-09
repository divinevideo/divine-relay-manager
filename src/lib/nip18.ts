// ABOUTME: NIP-18 repost helpers — kind 6/16 events carry the reposted event
// ABOUTME: as stringified JSON in their content field (or empty content)

import { hasDisplayableContent } from '@/lib/kindNames';

// Local, not exported: PR #161 adds a shared isHex64 to lib/constants and
// #160 tracks consolidating hex-id validation — this stays private until
// that lands to avoid two exported definitions colliding at merge time.
const HEX_64 = /^[0-9a-f]{64}$/i;

export function isRepostKind(kind: number): boolean {
  return kind === 6 || kind === 16;
}

export interface RepostedEvent {
  content: string;
  tags: string[][];
  pubkey: string;
  /** Present when the inner JSON carried a numeric kind. */
  kind?: number;
}

/** The reposted event's id from a repost's `e` tag (NIP-18 MUST for kind 6). */
export function getRepostTargetId(tags: string[][]): string | undefined {
  return tags.find(t => t[0] === 'e')?.[1];
}

/** The reposted event's kind from a kind-16 repost's `k` tag (NIP-18 SHOULD). */
export function getRepostKind(tags: string[][]): number | undefined {
  const value = tags.find(t => t[0] === 'k')?.[1];
  return value !== undefined && /^\d+$/.test(value) ? Number(value) : undefined;
}

/**
 * The reposted event's coordinate from a kind-16 repost's `a` tag — per
 * NIP-18, addressable-event reposts SHOULD carry one, and empty content plus
 * an `a` tag means "the latest version". Tags are reposter-authored, so only
 * a well-formed `kind:pubkey:d-tag` shape is returned.
 */
export function getRepostTargetCoordinate(tags: string[][]): string | undefined {
  const value = tags.find(t => t[0] === 'a')?.[1];
  if (typeof value !== 'string') return undefined;
  const parts = value.split(':');
  return parts.length >= 3 && /^\d+$/.test(parts[0]) && HEX_64.test(parts[1])
    ? value
    : undefined;
}

/**
 * Human-readable "what was reposted": `event <id>`, else the coordinate.
 * Values are reposter-authored — the e tag is only used when it is a
 * well-formed 64-hex event id (NIP-18 MUST), so hostile tags can't inject
 * arbitrary text into moderation UI.
 */
export function describeRepostTarget(tags: string[][]): string | undefined {
  const id = getRepostTargetId(tags);
  if (id !== undefined && HEX_64.test(id)) return `event ${id}`;
  return getRepostTargetCoordinate(tags);
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
      ...(typeof o.kind === 'number' ? { kind: o.kind } : {}),
    };
  } catch {
    return null;
  }
}

export interface RepostDisplay {
  isRepost: boolean;
  /** Parsed inner event for spec-conformant reposts (media/attribution). */
  inner: RepostedEvent | null;
  /** Text safe to render or summarize; '' when nothing is displayable. */
  displayContent: string;
  /** True when displayContent is '' because the (inner) kind's content is
   * non-displayable (file data), as opposed to genuinely empty content. */
  contentSuppressed: boolean;
  /** Set for reposts with no displayable content: what was reposted. */
  targetDescription?: string;
}

/**
 * One place for "what text does a recent-content row show for this event":
 * - non-reposts show their content unless the kind's content isn't text
 *   (kind 1064 carries raw base64 — see hasDisplayableContent)
 * - parsed reposts show the inner event's content, with the same
 *   non-displayable-kind guard applied to the INNER kind (from the parsed
 *   JSON, falling back to the NIP-18 `k` tag)
 * - out-of-spec reposts (unparseable content) show their raw content rather
 *   than discarding moderation evidence — bounded by the caller's clamping
 * - reposts with nothing displayable get a target description instead
 */
export function parseRepostForDisplay(
  event: { kind: number; content: string; tags: string[][] }
): RepostDisplay {
  if (!isRepostKind(event.kind)) {
    const suppressed = !hasDisplayableContent(event.kind);
    return {
      isRepost: false,
      inner: null,
      displayContent: suppressed ? '' : event.content,
      contentSuppressed: suppressed,
    };
  }
  const inner = parseRepostedEvent(event.content);
  const innerKind = inner?.kind ?? getRepostKind(event.tags);
  const suppressed = innerKind !== undefined && !hasDisplayableContent(innerKind);
  const displayContent = suppressed ? '' : (inner ? inner.content : event.content);
  return {
    isRepost: true,
    inner,
    displayContent,
    contentSuppressed: suppressed,
    ...(displayContent ? {} : { targetDescription: describeRepostTarget(event.tags) }),
  };
}
