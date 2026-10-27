import { describe, it, expect } from 'vitest';
import {
  ABANDONED_REASON,
  ageReviewNotesJobId,
  ageReviewNotesStep,
  ageReviewNotesJobRange,
  autoDeletePendingWarning,
  bulkLegStoppedWarning,
  countIssues,
  enumerationWarning,
  eventFailure,
  formatOverflowMarker,
  isListingGapWarning,
  notSavedWarning,
  jobFailure,
  mediaFailure,
  parseFailure,
  parseOverflowMarker,
  sameSecondGapWarning,
  unpaginatedGapWarning,
} from './bulk-moderation';

// The worker writes these strings and the dialog reads them back. Each builder
// must round-trip through its parser, so rewording one can't silently stop the
// other side from recognising it.
const PUBKEY = 'a'.repeat(64);
const EVENT_ID = '1'.repeat(64);

describe('bulk failure strings', () => {
  it('round-trips the overflow marker', () => {
    expect(parseOverflowMarker(formatOverflowMarker(61))).toBe(61);
    expect(parseOverflowMarker(eventFailure(EVENT_ID, '+1 more'))).toBeNull();
  });

  it('round-trips an event failure, keeping the whole id and an error with colons', () => {
    expect(parseFailure(eventFailure(EVENT_ID, 'Error: relay: rejected'))).toEqual({
      type: 'event', id: EVENT_ID, error: 'Error: relay: rejected',
    });
  });

  it('round-trips a media failure, including the status-check failures (#291)', () => {
    const sha256 = 'f'.repeat(64);
    for (const error of [
      'Moderation service returned 500',
      'could not read current status, left unchanged: blossom returned 500',
      'status sources disagree (blossom active, moderation-service permanent_ban), left unchanged',
    ]) {
      expect(parseFailure(mediaFailure(sha256, error))).toEqual({ type: 'media', sha256, error });
    }
  });

  it('round-trips an enumeration warning', () => {
    expect(parseFailure(enumerationWarning(PUBKEY, 'relay returned 2 event(s); ignored them'))).toEqual({
      type: 'enumeration', pubkey: PUBKEY, warning: 'relay returned 2 event(s); ignored them',
    });
  });

  it('round-trips a job failure, and recognises an abandoned job', () => {
    expect(parseFailure(jobFailure('Relay closed the query: error: x'))).toEqual({
      type: 'job', reason: 'Relay closed the query: error: x', abandoned: false,
    });
    expect(parseFailure(jobFailure(ABANDONED_REASON))).toEqual({
      type: 'job', reason: ABANDONED_REASON, abandoned: true,
    });
  });

  it('round-trips the overflow marker through parseFailure', () => {
    expect(parseFailure(formatOverflowMarker(3))).toEqual({ type: 'overflow', count: 3 });
  });

  it('leaves any other string as it is', () => {
    expect(parseFailure('blob:abc:boom')).toEqual({ type: 'other', text: 'blob:abc:boom' });
  });

  it('recognises both listing-gap warnings it builds, and nothing else', () => {
    expect(isListingGapWarning(sameSecondGapWarning(PUBKEY, 200))).toBe(true);
    expect(isListingGapWarning(unpaginatedGapWarning(PUBKEY, 'some events may be unprocessed'))).toBe(true);
    expect(isListingGapWarning(unpaginatedGapWarning(PUBKEY, 'actioned a partial set'))).toBe(true);
    expect(isListingGapWarning(enumerationWarning(PUBKEY, 'relay returned 1 event(s) outside the requested author or kind; ignored them'))).toBe(false);
    expect(isListingGapWarning(eventFailure(EVENT_ID, 'relay could not be fully paginated'))).toBe(false);
  });
});

describe('countIssues', () => {
  it('counts each stored failure once and an overflow marker as the failures it stands for', () => {
    expect(countIssues([])).toBe(0);
    expect(countIssues(['event:e1:refused', 'media:m1:nope'])).toBe(2);
    expect(countIssues(['event:e1:refused', formatOverflowMarker(10)])).toBe(11);
  });

  // Age review keeps at most one write of rows; the marker for the rest
  // counts as the rows it stands for, like "+N more".
  it('counts a "not saved" marker as the rows it stands for', () => {
    const marker = notSavedWarning('a'.repeat(64), 4321);
    expect(marker).toBe(`enumeration:${'a'.repeat(64)}:4321 more file(s) or problem(s) from this step were not saved`);
    expect(countIssues(['event:e1:refused', marker])).toBe(4322);
  });

  it('counts an ordinary listing warning that merely mentions "more" as one', () => {
    expect(countIssues([enumerationWarning('a'.repeat(64), '5 more owned video files still listed unchanged after the walk')])).toBe(1);
  });
});

describe('bulkLegStoppedWarning', () => {
  it('records a bulk run that threw as a listing line naming the error', () => {
    expect(bulkLegStoppedWarning('a'.repeat(64), 'Funnelcake API error: 503'))
      .toBe(`enumeration:${'a'.repeat(64)}:the content step stopped before it finished: Funnelcake API error: 503`);
  });
});

describe('age review notes keys', () => {
  it('keys a transition by its case, the case version it wrote, and its state', () => {
    expect(ageReviewNotesJobId('case-1', 7, 'cleared')).toBe('age-review:case-1:7:cleared');
  });

  it('reads the step back out of a key, and nothing out of another kind of key', () => {
    expect(ageReviewNotesStep(ageReviewNotesJobId('case-1', 7, 'restricted_pending_user_response'))).toBe('restricted_pending_user_response');
    expect(ageReviewNotesStep('job-1')).toBeNull();
  });

  // A state added later in another shape still reads back, rather than
  // quietly hiding the step's kept results.
  it('reads back a state of any shape', () => {
    expect(ageReviewNotesStep('age-review:case-1:7:Restricted_v2')).toBe('Restricted_v2');
  });

  // The case's notes are read back as every key in [prefix, end): a key must
  // fall inside its own case's range and outside every other case's.
  it("gives each case a range that holds its own keys and no other case's", () => {
    const { start, end } = ageReviewNotesJobRange('case-1');
    const inRange = (key: string) => key >= start && key < end;
    expect(inRange(ageReviewNotesJobId('case-1', 7, 'cleared'))).toBe(true);
    expect(inRange(ageReviewNotesJobId('case-1', 12, 'denied_closed'))).toBe(true);
    expect(inRange(ageReviewNotesJobId('case-10', 7, 'cleared'))).toBe(false);
    expect(inRange(ageReviewNotesJobId('case', 7, 'cleared'))).toBe(false);
    expect(inRange('job-1')).toBe(false);
  });

  it('refuses a case id that could reach into another case\'s range', () => {
    expect(() => ageReviewNotesJobRange('case-1:7')).toThrow();
    expect(() => ageReviewNotesJobId('', 7, 'cleared')).toThrow();
  });
});

// The case screen shows this line in its own words (an enumeration line whose
// text no listing pattern rewrites), so its wording is pinned here.
describe('autoDeletePendingWarning', () => {
  it("says what the moderator should do, under the account's pubkey", () => {
    const pubkey = 'a'.repeat(64);
    expect(autoDeletePendingWarning(pubkey)).toBe(
      `enumeration:${pubkey}:Auto-delete was not confirmed for this account: the expiry run may have stopped before deleting its content. Unless someone has done it since, open the account in the Users tab and run Delete All Content.`,
    );
  });
});
