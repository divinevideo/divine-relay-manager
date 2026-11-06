// ABOUTME: Wording for a reported post the relay won't return because its account is suspended.
// ABOUTME: One copy, so report detail's badge and its thread panel say the same thing.

// Funnelcake hides a suspended account's posts from every read the relay
// manager makes, including the live check that marks a post "gone". So a
// missing post from a suspended account may still exist, and nothing we read
// can tell. The account is also the one the report names, which for a post we
// could not fetch comes from the report's own p tag, so it is "the reported
// account", not a confirmed author.

export function suspendedBadgeLabel(stale: boolean): string {
  return stale ? 'Suspended (last known)' : 'Account Suspended';
}

type ReadState = 'checking' | 'failed';

/**
 * A gone post where a status that would explain it has not answered. Names
 * only the statuses that are actually unknown, says for each whether its read
 * is still out ("Still checking") or failed ("Couldn't check"), and states a
 * suspension the list did confirm. The post may still exist, so this never
 * reads as a removal. A ban kept from a list that could not be refreshed is
 * named as such ("still banned, as it was at the last good read").
 */
export function goneCauseUnknownLine(opts: {
  /** true confirmed, false confirmed absent, null unknown. */
  suspended: boolean | null;
  suspendedStale: boolean;
  /** The suspension's read state when it is unknown, else null. */
  suspension: ReadState | null;
  accountBan: { state: ReadState; stale: boolean } | null;
  eventBan: { state: ReadState; stale: boolean } | null;
  /** The decision log, the only record of a moderator's delete, if unread. */
  decisions: ReadState | null;
}): string {
  const { suspended, suspendedStale, suspension, accountBan, eventBan, decisions } = opts;
  const lastGood = ', as it was at the last good read';
  type Item = { state: ReadState; phrase: string };
  const items: Item[] = [];

  if (suspended === true) {
    // Beside a confirmed suspension: what else might also be in force.
    const freshBans = accountBan && eventBan && !accountBan.stale && !eventBan.stale && accountBan.state === eventBan.state;
    if (freshBans) {
      items.push({ state: accountBan.state, phrase: 'the account or the event is also banned' });
    } else {
      if (accountBan) items.push({ state: accountBan.state, phrase: accountBan.stale ? `the account is also still banned${lastGood}` : 'the account is also banned' });
      if (eventBan) items.push({ state: eventBan.state, phrase: eventBan.stale ? `the event is also still banned${lastGood}` : 'the event is also banned' });
    }
    if (decisions) items.push({ state: decisions, phrase: 'a moderator also removed it' });
    const status = suspendedStale
      ? 'Last known: the reported account is suspended, which hides its posts.'
      : 'The reported account is suspended, which hides its posts.';
    return [status, ...sentences(items)].join(' ');
  }

  const atoms = [suspension, accountBan, eventBan, decisions].filter(Boolean).length;
  if (suspension && accountBan && !accountBan.stale && suspension === accountBan.state) {
    items.push({ state: suspension, phrase: 'the account is suspended or banned' });
  } else {
    if (suspension) items.push({ state: suspension, phrase: 'the account is suspended' });
    if (accountBan) items.push({ state: accountBan.state, phrase: accountBan.stale ? `the account is still banned${lastGood}` : 'the account is banned' });
  }
  if (eventBan) items.push({ state: eventBan.state, phrase: eventBan.stale ? `the event is still banned${lastGood}` : 'the event is banned' });
  if (decisions) items.push({ state: decisions, phrase: 'a moderator removed it' });
  const tail = atoms > 1 ? 'Any of these would hide it.' : 'That would hide it.';
  return ['Not found on the relay.', ...sentences(items), tail].join(' ');
}

/** One sentence per read state, the reads still out first. */
function sentences(items: Array<{ state: ReadState; phrase: string }>): string[] {
  const out: string[] = [];
  for (const [state, verb] of [['checking', 'Still checking'], ['failed', "Couldn't check"]] as const) {
    const phrases = items.filter(i => i.state === state).map(i => i.phrase);
    if (phrases.length > 0) out.push(`${verb} whether ${phrases.join(', or whether ')}.`);
  }
  return out;
}

/**
 * A gone post where every status the relay manager reads answered and none
 * explains it. Not a deletion: funnelcake also withholds quarantined posts and
 * deactivated or vanished accounts, which nothing here reads.
 */
export const GONE_NO_CAUSE_LINE = 'Not returned by the relay. It may have been self-deleted, held for review, or never stored here.';

/** `stale`: the suspension is from a copy of the list that could not be refreshed. */
export function suspendedMissingPostLine(stale: boolean): string {
  const status = stale ? 'Last known: the reported account is suspended.' : 'The reported account is suspended.';
  return `${status} The relay hides a suspended account's posts, so this event may still exist.`;
}
