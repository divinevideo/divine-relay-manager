import { describe, it, expect } from 'vitest';
import {
  ABANDONED_REASON,
  enumerationWarning,
  eventFailure,
  formatOverflowMarker,
  isListingGapWarning,
  jobFailure,
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
    expect(parseFailure('media:abc:boom')).toEqual({ type: 'other', text: 'media:abc:boom' });
  });

  it('recognises both listing-gap warnings it builds, and nothing else', () => {
    expect(isListingGapWarning(sameSecondGapWarning(PUBKEY, 200))).toBe(true);
    expect(isListingGapWarning(unpaginatedGapWarning(PUBKEY, 'some events may be unprocessed'))).toBe(true);
    expect(isListingGapWarning(unpaginatedGapWarning(PUBKEY, 'actioned a partial set'))).toBe(true);
    expect(isListingGapWarning(enumerationWarning(PUBKEY, 'relay returned 1 event(s) outside the requested author or kind; ignored them'))).toBe(false);
    expect(isListingGapWarning(eventFailure(EVENT_ID, 'relay could not be fully paginated'))).toBe(false);
  });
});
