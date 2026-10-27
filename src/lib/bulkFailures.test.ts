import { describe, expect, it } from 'vitest';
import { describeBulkFailure } from './bulkFailures';
import {
  ABANDONED_REASON, enumerationWarning, eventFailure, formatOverflowMarker, jobFailure, mediaFailure,
  unpaginatedGapWarning,
} from '../../shared/bulk-moderation';

const ACCOUNT = 'a'.repeat(64);
const FILE = '1'.repeat(64);

describe('describeBulkFailure', () => {
  it.each([
    ['an abandoned job', jobFailure(ABANDONED_REASON), 'the server stopped reporting progress'],
    ['a job that stopped for another reason', jobFailure('Relay query timed out before EOSE'), 'Relay query timed out before EOSE'],
    ['an event', eventFailure('e'.repeat(64), 'banevent failed'), `event ${'e'.repeat(64)} failed: banevent failed`],
    ['a file', mediaFailure(FILE, 'Moderation service returned 500'), `file ${FILE} could not be changed: Moderation service returned 500`],
    ['one more problem past the cap', formatOverflowMarker(1), '1 more problem was not stored'],
    ['more problems past the cap', formatOverflowMarker(12), '12 more problems were not stored'],
    ['events outside the account or kind',
      enumerationWarning(ACCOUNT, 'relay returned 3 event(s) outside the requested author or kind; ignored them'),
      'the relay returned 3 event(s) from another account or of another kind; they were left alone'],
    ['a relay list read in part',
      unpaginatedGapWarning(ACCOUNT, 'some events may be unprocessed'),
      "the relay's list of events could not be read in full; some events may be unprocessed"],
    ['any other listing line, as written',
      enumerationWarning(ACCOUNT, 'still finding events after 20 sweeps; older versions may remain'),
      'still finding events after 20 sweeps; older versions may remain'],
    ['a line of no known kind, as written', 'something new', 'something new'],
  ])('says %s in plain words', (_label, failure, words) => {
    expect(describeBulkFailure(failure)).toBe(words);
  });
});
