import { describe, it, expect } from 'vitest';
import { deriveGoneCause, type GoneCauseInput } from './goneCause';

// A post the relay's live check says is gone, with every status answered and
// none explaining it. Each test changes the fields it is about.
const base: GoneCauseInput = {
  eventGone: true,
  recordedDelete: false,
  autoHidden: false,
  decisionsUnread: null,
  userBanned: false,
  userBannedStale: false,
  eventBanned: false,
  eventBannedStale: false,
  suspended: false,
  suspendedStale: false,
  checking: { suspension: false, accountBan: false, eventBan: false },
};
const checking = (over: Partial<GoneCauseInput['checking']>) => ({ ...base.checking, ...over });
const line = (over: Partial<GoneCauseInput>) => (deriveGoneCause({ ...base, ...over }) as { line: string }).line;
const badge = (over: Partial<GoneCauseInput>) => (deriveGoneCause({ ...base, ...over }) as { badge: string }).badge;

describe('deriveGoneCause causes', () => {
  it('has nothing to explain for a post that is not gone', () => {
    expect(deriveGoneCause({ ...base, eventGone: false }).kind).toBe('not-gone');
  });

  it('leaves a recorded delete to the badge', () => {
    expect(deriveGoneCause({ ...base, recordedDelete: true, suspended: null })).toMatchObject({ kind: 'explained', by: 'delete' });
  });

  it('leaves an auto-hide to the badge', () => {
    expect(deriveGoneCause({ ...base, autoHidden: true, suspended: null })).toMatchObject({ kind: 'explained', by: 'auto-hide' });
  });

  it('leaves a confirmed ban to the badge', () => {
    expect(deriveGoneCause({ ...base, userBanned: true, suspended: null })).toMatchObject({ kind: 'explained', by: 'ban' });
  });

  it('leaves a confirmed event ban to the badge', () => {
    expect(deriveGoneCause({ ...base, eventBanned: true, suspended: null })).toMatchObject({ kind: 'explained', by: 'event-ban' });
  });

  // Only a confirmed account ban outranks a confirmed event ban.
  it('names the account ban when both bans are confirmed', () => {
    expect(deriveGoneCause({ ...base, userBanned: true, eventBanned: true })).toMatchObject({ kind: 'explained', by: 'ban' });
  });

  it('names a confirmed event ban beside a stale account ban', () => {
    expect(deriveGoneCause({ ...base, userBanned: true, userBannedStale: true, eventBanned: true })).toMatchObject({ kind: 'explained', by: 'event-ban' });
  });

  // A ban from a copy of the list that could not be refreshed is last known,
  // not confirmed: it may have been lifted. It cannot explain the post.
  it('does not treat a stale ban as explaining the post', () => {
    expect(deriveGoneCause({ ...base, userBanned: true, userBannedStale: true, suspended: true }).kind).toBe('unknown');
  });

  // The banned-events list also keeps a positive after a failed refresh.
  it('does not treat a stale event ban as explaining the post', () => {
    expect(deriveGoneCause({ ...base, eventBanned: true, eventBannedStale: true, suspended: true }).kind).toBe('unknown');
  });

  it('names a suspension when both bans are confirmed absent', () => {
    expect(deriveGoneCause({ ...base, suspended: true })).toMatchObject({ kind: 'suspended', stale: false });
  });

  it('marks a suspension from a list that could not be refreshed', () => {
    expect(deriveGoneCause({ ...base, suspended: true, suspendedStale: true })).toMatchObject({ kind: 'suspended', stale: true });
  });

  it('does not credit a suspension while the account ban is unknown', () => {
    expect(deriveGoneCause({ ...base, suspended: true, userBanned: null }).kind).toBe('unknown');
  });

  it('does not credit a suspension while the event ban is unknown', () => {
    expect(deriveGoneCause({ ...base, suspended: true, eventBanned: null }).kind).toBe('unknown');
  });

  it('does not credit a suspension while the decision log is unread', () => {
    expect(deriveGoneCause({ ...base, suspended: true, decisionsUnread: 'failed' }).kind).toBe('unknown');
  });

  it('calls the cause unknown while the suspension is unknown', () => {
    expect(deriveGoneCause({ ...base, suspended: null }).kind).toBe('unknown');
  });

  it('still leaves a delete it did read to the badge', () => {
    expect(deriveGoneCause({ ...base, recordedDelete: true, decisionsUnread: 'failed' })).toMatchObject({ kind: 'explained', by: 'delete' });
  });

  // Funnelcake also withholds quarantined posts and deactivated or vanished
  // accounts, none of which the relay manager reads. So "every status answered
  // and none explains it" is not "deleted".
  it('does not call a post deleted when every status answered and none explains it', () => {
    expect(deriveGoneCause(base)).toMatchObject({
      kind: 'none-found',
      line: 'Not returned by the relay. It may have been self-deleted, held for review, or never stored here.',
    });
  });
});

// The unknown-cause line names only what is actually unknown, says per status
// whether its read is still out or failed, and states a suspension the list
// did confirm.
describe('deriveGoneCause unknown-cause wording', () => {
  it('names an unknown suspension alone', () => {
    expect(line({ suspended: null })).toBe("Not found on the relay. Couldn't check whether the account is suspended. That would hide it.");
  });

  it('says still checking for a read still out', () => {
    expect(line({ suspended: null, checking: checking({ suspension: true }) }))
      .toBe('Not found on the relay. Still checking whether the account is suspended. That would hide it.');
  });

  it('joins an unknown suspension and account ban in the same state', () => {
    expect(line({ suspended: null, userBanned: null }))
      .toBe("Not found on the relay. Couldn't check whether the account is suspended or banned. Any of these would hide it.");
  });

  // The thread panel says "Last known: banned. Checking now." from the same
  // isUserBanChecking, so the two must agree status by status.
  it('says still checking for one status and could not check for another', () => {
    expect(line({ suspended: null, userBanned: null, checking: checking({ suspension: true }) }))
      .toBe("Not found on the relay. Still checking whether the account is suspended. Couldn't check whether the account is banned. Any of these would hide it.");
  });

  it('names all three when none answered', () => {
    expect(line({ suspended: null, userBanned: null, eventBanned: null }))
      .toBe("Not found on the relay. Couldn't check whether the account is suspended or banned, or whether the event is banned. Any of these would hide it.");
  });

  it('says a stale account ban was in force at the last good read', () => {
    expect(line({ userBanned: true, userBannedStale: true }))
      .toBe("Not found on the relay. Couldn't check whether the account is still banned, as it was at the last good read. That would hide it.");
  });

  it('says a stale account ban is being checked while the ban check is out', () => {
    expect(line({ userBanned: true, userBannedStale: true, checking: checking({ accountBan: true }) }))
      .toBe('Not found on the relay. Still checking whether the account is still banned, as it was at the last good read. That would hide it.');
  });

  it('says a stale event ban was in force at the last good read', () => {
    expect(line({ eventBanned: true, eventBannedStale: true }))
      .toBe("Not found on the relay. Couldn't check whether the event is still banned, as it was at the last good read. That would hide it.");
  });

  it('says still checking while the decision log is loading', () => {
    expect(line({ decisionsUnread: 'checking' }))
      .toBe('Not found on the relay. Still checking whether a moderator removed it. That would hide it.');
  });

  it('counts the decision log among several unknowns', () => {
    expect(line({ suspended: null, decisionsUnread: 'failed' }))
      .toBe("Not found on the relay. Couldn't check whether the account is suspended, or whether a moderator removed it. Any of these would hide it.");
  });

  it('states a confirmed suspension and asks only about the ban that is unknown', () => {
    expect(line({ suspended: true, userBanned: null }))
      .toBe("The reported account is suspended, which hides its posts. Couldn't check whether the account is also banned.");
  });

  it('asks about both bans beside a confirmed suspension', () => {
    expect(line({ suspended: true, userBanned: null, eventBanned: null }))
      .toBe("The reported account is suspended, which hides its posts. Couldn't check whether the account or the event is also banned.");
  });

  it('names a stale account ban apart from an unknown event ban beside a confirmed suspension', () => {
    expect(line({ suspended: true, userBanned: true, userBannedStale: true, eventBanned: null }))
      .toBe("The reported account is suspended, which hides its posts. Couldn't check whether the account is also still banned, as it was at the last good read, or whether the event is also banned.");
  });

  it('asks about a stale event ban beside a confirmed suspension', () => {
    expect(line({ suspended: true, eventBanned: true, eventBannedStale: true }))
      .toBe("The reported account is suspended, which hides its posts. Couldn't check whether the event is also still banned, as it was at the last good read.");
  });

  it('asks about the decision log beside a confirmed suspension', () => {
    expect(line({ suspended: true, decisionsUnread: 'checking' }))
      .toBe('The reported account is suspended, which hides its posts. Still checking whether a moderator also removed it.');
  });

  it('marks a last-known suspension as last known', () => {
    expect(line({ suspended: true, suspendedStale: true, userBanned: true, userBannedStale: true }))
      .toBe("Last known: the reported account is suspended, which hides its posts. Couldn't check whether the account is also still banned, as it was at the last good read.");
  });
});

// The badge label and tone come from the same derivation as the line, so the
// badge, its tooltip and the thread panel cannot disagree.
describe('deriveGoneCause badge', () => {
  it.each([
    [{ recordedDelete: true }, 'Removed by Moderation', 'removal'],
    [{ autoHidden: true }, 'Hidden automatically', 'removal'],
    [{ userBanned: true }, 'User Banned', 'removal'],
    [{ eventBanned: true }, 'Event Banned', 'removal'],
    [{ suspended: true }, 'Account Suspended', 'withheld'],
    [{ suspended: true, suspendedStale: true }, 'Suspended (last known)', 'withheld'],
    // Nothing here says it was removed: funnelcake withholds things none of
    // these lists report.
    [{}, 'Not Found on Relay', 'unknown'],
  ] as const)('labels %o as %s', (over, label, tone) => {
    expect(deriveGoneCause({ ...base, ...over })).toMatchObject({ badge: label, tone });
  });

  // A confirmed suspension is still the headline when only the event-ban list
  // or the decision log is unread.
  it('labels a confirmed suspension with an unread decision log as suspended', () => {
    expect(deriveGoneCause({ ...base, suspended: true, decisionsUnread: 'failed' })).toMatchObject({ badge: 'Account Suspended', tone: 'unknown' });
  });

  it('labels a confirmed suspension with an unknown event ban as suspended', () => {
    expect(badge({ suspended: true, eventBanned: null })).toBe('Account Suspended');
  });

  it('labels a stale suspension with an unknown cause as last known', () => {
    expect(badge({ suspended: true, suspendedStale: true, eventBanned: null })).toBe('Suspended (last known)');
  });

  it('labels a stale account ban as last known', () => {
    expect(deriveGoneCause({ ...base, userBanned: true, userBannedStale: true })).toMatchObject({ badge: 'Banned (last known)', tone: 'unknown' });
  });

  it('labels a stale event ban as last known', () => {
    expect(badge({ eventBanned: true, eventBannedStale: true })).toBe('Event Banned (last known)');
  });

  it('labels an otherwise unknown cause as not found', () => {
    expect(deriveGoneCause({ ...base, decisionsUnread: 'failed' })).toMatchObject({ badge: 'Not Found on Relay', tone: 'unknown' });
  });
});
