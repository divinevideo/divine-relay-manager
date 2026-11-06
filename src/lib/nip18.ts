// ABOUTME: NIP-18 repost helpers — kind 6/16 events carry the reposted event
// ABOUTME: as stringified JSON in their content field (or empty content)

import type { NostrEvent } from '@nostrify/nostrify';
import { verifyEvent } from 'nostr-tools';

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
}

/** The reposted event's id from a repost's `e` tag (NIP-18 MUST for kind 6). */
export function getRepostTargetId(tags: string[][]): string | undefined {
  return tags.find(t => t[0] === 'e')?.[1];
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
 * True only for a whole, signed Nostr event whose id is `id`: the shape, the id
 * hash and the signature all check. Anything a repost or a fetch hands over as
 * "the original" is weighed with this before the media buttons act on its
 * files (#337).
 */
export function isEventWithId(event: unknown, id: string): event is NostrEvent {
  if (!event || typeof event !== 'object') return false;
  const e = event as Record<string, unknown>;
  // Ids are compared and verified in lower case: an id is a hex hash, and a
  // source that upper-cases it has not changed the event.
  const wanted = id.toLowerCase();
  if (typeof e.id !== 'string' || e.id.toLowerCase() !== wanted) return false;
  if (typeof e.pubkey !== 'string' || typeof e.sig !== 'string' || typeof e.content !== 'string') return false;
  if (typeof e.kind !== 'number' || typeof e.created_at !== 'number') return false;
  if (!Array.isArray(e.tags) || !e.tags.every(t => Array.isArray(t) && t.every(x => typeof x === 'string'))) return false;
  // A fresh object: verifyEvent marks what it checks as verified and trusts that
  // mark next time, and a spread copies it, so a copy of a verified event with
  // its files changed would otherwise pass unchecked.
  const fields = {
    id: wanted, pubkey: e.pubkey, created_at: e.created_at, kind: e.kind,
    tags: e.tags as string[][], content: e.content, sig: e.sig,
  };
  try {
    return verifyEvent(fields);
  } catch {
    return false;
  }
}

/**
 * The event a repost names, read from its embedded copy only when the copy is
 * that event: its id is the repost's `e` tag and its signature verifies. The
 * copy is the reposter's own writing, so unchecked it would let the reposter
 * choose which files a moderator's buttons act on, Delete Media included.
 */
export function verifiedRepostedEvent(repost: { content: string; tags: string[][] }): NostrEvent | null {
  const target = getRepostTargetId(repost.tags);
  if (!target || !HEX_64.test(target)) return null;
  let copy: unknown;
  try {
    copy = JSON.parse(repost.content);
  } catch {
    return null;
  }
  return isEventWithId(copy, target) ? { ...copy, id: copy.id.toLowerCase() } : null;
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

export interface RepostDisplay {
  isRepost: boolean;
  /** Parsed inner event for spec-conformant reposts (media/attribution). */
  inner: RepostedEvent | null;
  /** Text safe to render or summarize; '' when there's nothing to show. */
  displayContent: string;
  /** Set for reposts with no displayable content: what was reposted. */
  targetDescription?: string;
}

/** True when the string parses to a JSON *object* — a serialized-event
 * envelope. Arrays, primitives, and plain text are not envelopes: they may
 * carry human-readable text a moderator needs, so they are shown, not blanked. */
/**
 * True when a repost's content looks like JSON, and so is taken as its copy of
 * the original, well formed or not. The media buttons read such a copy only
 * once it checks out (verifiedRepostedEvent): a cut-off or malformed one would
 * otherwise slip the reposter's files past the check as plain text (#337).
 */
export function looksLikeEventCopy(content: string): boolean {
  return /^\s*[[{]/.test(content);
}

function isJsonObjectEnvelope(content: string): boolean {
  try {
    const value: unknown = JSON.parse(content);
    return typeof value === 'object' && value !== null && !Array.isArray(value);
  } catch {
    return false;
  }
}

/**
 * One place for "what text does a recent-content row show for this event".
 * We never suppress based on a claimed content kind: for reposts every kind
 * signal (the `k` tag, the inner JSON's `kind`) is authored by the account
 * under review, so trusting one to blank content lets it hide its own
 * evidence from the card and the AI summary. Bias is to SHOW; consumers clamp
 * length, so any noise is bounded, never a wall.
 * - non-reposts: show their content
 * - parsed reposts: show the inner event's content
 * - out-of-spec reposts (content is not a valid inner event): show the plain
 *   text as moderation evidence, but a raw serialized-event *object* envelope
 *   renders as the target label instead of the raw JSON blob (never-raw-JSON)
 * - reposts with nothing displayable: a target description
 */
export function parseRepostForDisplay(
  event: { kind: number; content: string; tags: string[][] }
): RepostDisplay {
  if (!isRepostKind(event.kind)) {
    return { isRepost: false, inner: null, displayContent: event.content };
  }
  const inner = parseRepostedEvent(event.content);
  const displayContent = inner
    ? inner.content
    : isJsonObjectEnvelope(event.content) ? '' : event.content;
  return {
    isRepost: true,
    inner,
    displayContent,
    ...(displayContent ? {} : { targetDescription: describeRepostTarget(event.tags) }),
  };
}
