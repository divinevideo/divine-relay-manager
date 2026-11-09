/**
 * Suspended-account content: the relay's admin reads that return a suspended
 * account's hidden events (funnelcake `getsuspendedevent` and
 * `listsuspendedpubkeyevents`).
 *
 * Those reads expose content the account's suspension hides from everyone else,
 * so they may be reached only through an audited moderator viewer: one that
 * checks a verified moderator and writes an audit row per read. /api/relay-rpc
 * does neither, so it refuses both methods outright; see runRelayRpc.
 *
 * `getbannedevent` is a second way in. The relay serves any individually banned
 * or held event without asking whether its author is suspended, so a caller
 * could ban a suspended account's post and then read it back. Moderators rely on
 * getbannedevent to see banned posts, so it is not refused outright: relay-rpc
 * checks the returned event's author instead (checkBannedEventAuthor).
 */

import { callNip86Rpc, type Nip86Env } from './nip86';
import { SUSPENDED_READ_REFUSED } from '../../shared/suspended-read';

export { SUSPENDED_READ_REFUSED };

export const SUSPENDED_READ_METHODS: ReadonlySet<string> = new Set([
  'getsuspendedevent',
  'listsuspendedpubkeyevents',
]);

export const SUSPENSION_STATUS_UNAVAILABLE = 'suspension_status_unavailable';

// The author check runs after getbannedevent has already used up to its own
// 15 s bound, and the client gives the whole relay-rpc call 30 s. A shorter
// bound here keeps a slow suspension list from turning into a client timeout.
const SUSPENDED_LIST_TIMEOUT_MS = 5_000;

/**
 * Whether a caller-supplied NIP-86 method names one of the suspended reads.
 *
 * The relay matches method names exactly, so a variant such as
 * `GetSuspendedEvent` would not dispatch there today. The match is deliberately
 * looser than the relay's (trimmed, case-insensitive) so that a relay which ever
 * normalises method names cannot quietly reopen this path.
 *
 * A non-string answers false: the relay's request type holds the method as a
 * string, so a non-string method never dispatches to these reads.
 */
export function isSuspendedReadMethod(method: unknown): boolean {
  if (typeof method !== 'string') return false;
  return SUSPENDED_READ_METHODS.has(method.trim().toLowerCase());
}

/** Whether a caller-supplied method is getbannedevent, matched like isSuspendedReadMethod. */
export function isBannedEventRead(method: unknown): boolean {
  return typeof method === 'string' && method.trim().toLowerCase() === 'getbannedevent';
}

export interface SuspendedReadRefusal {
  status: 403 | 503;
  code: string;
  error: string;
}

const AUTHOR_SUSPENDED: SuspendedReadRefusal = {
  status: 403,
  code: SUSPENDED_READ_REFUSED,
  error: "This event's author is suspended, so its content is not served here",
};

const STATUS_UNAVAILABLE: SuspendedReadRefusal = {
  status: 503,
  code: SUSPENSION_STATUS_UNAVAILABLE,
  error: "Could not confirm the author's suspension status",
};

/**
 * Decide whether a banned event the relay returned may go back to the caller.
 * Null means it may; otherwise the refusal to send instead.
 *
 * Fails closed: an event with no readable author, or a suspension list that
 * cannot be read, is refused, because neither proves the author is not
 * suspended. The list is read after the event, so a suspension landing while the
 * event was being fetched is still seen.
 *
 * Deliberately uncached. A cache in one isolate cannot be invalidated by a
 * suspension made through another isolate (moderation-service, age review, the
 * UI all reach different ones), so any TTL would be a window in which a fresh
 * suspension reads through. getbannedevent is a per-view moderator read, so one
 * extra relay call per view costs little.
 *
 * Both sides are lowercased. Event pubkeys are lowercase hex, but suspensions
 * written before canonical-hex enforcement may be stored in uppercase; matching
 * them over-refuses at worst, which is the safe direction.
 */
export async function checkBannedEventAuthor(
  event: unknown,
  env: Nip86Env,
): Promise<SuspendedReadRefusal | null> {
  const pubkey = (event as { pubkey?: unknown } | null | undefined)?.pubkey;
  if (typeof pubkey !== 'string' || !pubkey) return STATUS_UNAVAILABLE;
  const author = pubkey.toLowerCase();

  let list: Awaited<ReturnType<typeof callNip86Rpc>>;
  try {
    list = await callNip86Rpc('listsuspendedpubkeys', [], env, SUSPENDED_LIST_TIMEOUT_MS);
  } catch (err) {
    // callNip86Rpc throws on an unreadable response body or a missing signing key.
    console.error('[relay-rpc] suspension list read threw:', err instanceof Error ? err.name : typeof err);
    return STATUS_UNAVAILABLE;
  }
  // A failed call carries no `result`, so this one check refuses both a failed
  // read and a successful one that is not a list.
  if (!Array.isArray(list.result)) return STATUS_UNAVAILABLE;

  // funnelcake sends SuspendedPubkey objects whose `pubkey` is always a string
  // (fixed_to_string over a FixedString(64)). An entry without one is unreadable
  // and could be this author, so it refuses rather than being skipped. A string
  // that is not hex (a legacy row) is still a readable value: it can never equal
  // an event pubkey, so it is compared, not refused, and cannot block every view.
  for (const entry of list.result) {
    const listed = (entry as { pubkey?: unknown } | null)?.pubkey;
    if (typeof listed !== 'string') return STATUS_UNAVAILABLE;
    if (listed.toLowerCase() === author) return AUTHOR_SUSPENDED;
  }
  return null;
}
