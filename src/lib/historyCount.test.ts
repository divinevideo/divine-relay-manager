import { describe, it, expect } from 'vitest';
import { authoredContentStat, historyCount, historyStat, reportsFiledLabel } from './historyCount';

describe('historyCount', () => {
  it('prints a complete count as it is', () => {
    expect(historyCount(80, false)).toBe('80');
  });

  it('marks a count that stopped early as a floor', () => {
    expect(historyCount(991, true)).toBe('991+');
  });
});

describe('historyStat', () => {
  it('does not print a failed read as zero', () => {
    expect(historyStat(0, false, true, 'reports')).toBe('reports unavailable');
  });

  it('keeps a floor mark when the read finished at its bound', () => {
    expect(historyStat(991, true, false, 'labels')).toBe('991+ labels');
  });
});

describe('reportsFiledLabel', () => {
  it('prints a count under the read limit exactly', () => {
    expect(reportsFiledLabel(42, 100)).toBe('42 reports filed');
  });

  it('uses the singular for one report', () => {
    expect(reportsFiledLabel(1, 100)).toBe('1 report filed');
  });

  it('prints zero as zero', () => {
    expect(reportsFiledLabel(0, 100)).toBe('0 reports filed');
  });

  // A read that filled its limit may have stopped there: the count is a floor.
  it('marks a count that reached the read limit as a floor', () => {
    expect(reportsFiledLabel(100, 100)).toBe('100+ reports filed');
  });
});

describe('authoredContentStat', () => {
  const base = { incomplete: false, suspended: false as boolean | null, suspendedStale: false, suspensionChecking: false, noun: 'events', limit: 20 };

  it('prints a completed read as its count', () => {
    expect(authoredContentStat({ ...base, count: 3 })).toBe('3 events');
  });

  it('prints a completed empty read as zero', () => {
    expect(authoredContentStat({ ...base, count: 0 })).toBe('0 events');
  });

  it('does not print a failed read as zero', () => {
    expect(authoredContentStat({ ...base, count: 0, incomplete: true })).toBe('events unavailable');
  });

  it('does not print a read that has not answered yet as zero', () => {
    expect(authoredContentStat({ ...base, count: undefined })).toBe('checking events');
  });

  // The relay hides a suspended account's content from every read we make, so
  // an empty read is the suspension, not an empty account.
  it('says an empty read is hidden by a suspension', () => {
    expect(authoredContentStat({ ...base, count: 0, suspended: true })).toBe('events hidden (account suspended)');
  });

  it('attributes a failed read to a known suspension rather than to the relay', () => {
    expect(authoredContentStat({ ...base, count: 0, incomplete: true, suspended: true })).toBe('events hidden (account suspended)');
  });

  it('says hidden by suspension before the read answers when the suspension is known', () => {
    expect(authoredContentStat({ ...base, count: undefined, suspended: true })).toBe('events hidden (account suspended)');
  });

  it('marks a suspension carried over from a list that could not be refreshed', () => {
    expect(authoredContentStat({ ...base, count: 0, suspended: true, suspendedStale: true })).toBe('events hidden (last known: suspended)');
  });

  // The relay hides a suspended account's content at once, so content beside a
  // current suspension was read before it (a cached count).
  it('marks content beside a current suspension as from before it', () => {
    expect(authoredContentStat({ ...base, count: 2, suspended: true })).toBe('2 events (before suspension)');
  });

  // A suspension from a list that could not be refreshed may have been lifted,
  // so the content may be current.
  it('prints content beside a last-known suspension as is', () => {
    expect(authoredContentStat({ ...base, count: 2, suspended: true, suspendedStale: true })).toBe('2 events');
  });

  // The authored-content read asks for at most `limit` events, so a full page
  // is a floor: the account may have more.
  it('marks a read that came back at its limit as a floor', () => {
    expect(authoredContentStat({ ...base, count: 20 })).toBe('20+ events');
  });

  it('prints a read under its limit exactly', () => {
    expect(authoredContentStat({ ...base, count: 19 })).toBe('19 events');
  });

  // An empty read only means an empty account once the suspension is known
  // absent: the relay hides a suspended account's content.
  it('qualifies an empty read while the suspension is still being checked', () => {
    expect(authoredContentStat({ ...base, count: 0, suspended: null, suspensionChecking: true })).toBe('0 events (checking suspension)');
  });

  it('qualifies an empty read when the suspension could not be checked', () => {
    expect(authoredContentStat({ ...base, count: 0, suspended: null })).toBe("0 events (couldn't check suspension)");
  });

  it('prints returned content as is while the suspension is unknown', () => {
    expect(authoredContentStat({ ...base, count: 3, suspended: null })).toBe('3 events');
  });

  // Funnelcake drops the account from the suspended list at once, but its read
  // filter catches up on a periodic refresh (about five minutes), so a read
  // right after an Unsuspend can still come back empty.
  it('qualifies an empty read just after an unsuspend', () => {
    expect(authoredContentStat({ ...base, count: 0, justRestored: true }))
      .toBe('0 events (just restored; posts can take a few minutes to reappear)');
  });

  // Unban and allow lift a read filter that can lag the same way, and with a
  // deferred purge some content can survive the ban: what comes back is shown.
  it('prints content that survived a ban as is just after it was lifted', () => {
    expect(authoredContentStat({ ...base, count: 2, justRestored: true })).toBe('2 events');
  });

  it('prints returned content as is just after an unsuspend', () => {
    expect(authoredContentStat({ ...base, count: 4, justRestored: true })).toBe('4 events');
  });

  it('lets a current suspension outrank the unsuspend window', () => {
    expect(authoredContentStat({ ...base, count: 0, suspended: true, justRestored: true })).toBe('events hidden (account suspended)');
  });

  it('marks a count kept from an earlier read as last known', () => {
    expect(authoredContentStat({ ...base, count: 0, lastKnown: true })).toBe('0 events (last known)');
  });

  it('does not mark a suspension as last known: it holds whatever the read did', () => {
    expect(authoredContentStat({ ...base, count: 0, suspended: true, lastKnown: true })).toBe('events hidden (account suspended)');
  });

  it('keeps the caller\'s noun', () => {
    expect(authoredContentStat({ ...base, count: 0, incomplete: true, noun: 'events on relay' })).toBe('events on relay unavailable');
  });
});
