import { describe, expect, it } from 'vitest';
import { describeBulkFailure } from './bulkFailures';
import {
  ABANDONED_REASON, bulkLegStoppedWarning, enumerationWarning, eventFailure, formatOverflowMarker, jobFailure,
  mediaFailure, notesNotStoredWarning, notesOverflowWarning, notSavedWarning, unpaginatedGapWarning,
} from '../../shared/bulk-moderation';

const ACCOUNT = 'a'.repeat(64);
const FILE = '1'.repeat(64);

describe('describeBulkFailure', () => {
  it.each([
    ['an abandoned job', jobFailure(ABANDONED_REASON), 'the server stopped reporting progress'],
    ['a job that stopped for another reason', jobFailure('Relay query timed out before EOSE'), 'Relay query timed out before EOSE'],
    ['an event', eventFailure('e'.repeat(64), 'banevent failed'), `event ${'e'.repeat(64)} failed: banevent failed`],
    ['a file', mediaFailure(FILE, 'Moderation service returned 500'), `file ${FILE} could not be changed: Moderation service returned 500`],
    ['a file whose two status sources disagree',
      mediaFailure(FILE, 'status sources disagree (blossom restricted, moderation-service SAFE), left unchanged'),
      `file ${FILE} was left unchanged: the media server shows it as hidden but the moderation record says public`],
    ['a file whose sources disagree the other way',
      mediaFailure(FILE, 'status sources disagree (blossom active, moderation-service permanent_ban), left unchanged'),
      `file ${FILE} was left unchanged: the media server shows it as public but the moderation record says blocked`],
    ['a file with no moderation decision',
      mediaFailure(FILE, 'status sources disagree (blossom banned, moderation-service unknown), left unchanged'),
      `file ${FILE} was left unchanged: the media server shows it as blocked but the moderation record has no decision`],
    ['a file whose status could not be read',
      mediaFailure(FILE, 'could not read current status, left unchanged: blossom returned 503'),
      `file ${FILE} was left unchanged: its current status could not be read (blossom returned 503)`],
    ['one more problem past the cap', formatOverflowMarker(1), '1 more problem was not stored'],
    ['more problems past the cap', formatOverflowMarker(12), '12 more problems were not stored'],
    ['rows age review did not save', notSavedWarning(ACCOUNT, 4321), '4321 more files or problems from this step were not saved'],
    ['a queued job\'s fallback to the relay list',
      enumerationWarning(ACCOUNT, "could not list this account's files: media server returned 500; files were chosen from the relay's list only, so the count of files left as they were may be off"),
      "the media server's list of this account's files could not be read (media server returned 500), so its files were chosen from the relay's list only, and the count of files left as they were may be off"],
    ['an age-review step\'s fallback to the relay list, whose count is exact',
      enumerationWarning(ACCOUNT, "could not list this account's files: media server returned 500; files were chosen from the relay's list only"),
      "the media server's list of this account's files could not be read (media server returned 500), so its files were chosen from the relay's list only"],
    ['a fallback part-way through',
      enumerationWarning(ACCOUNT, "could not list this account's files: The operation was aborted due to timeout; the rest were chosen from the relay's list only, so the count of files left as they were may be off"),
      "the media server's list of this account's files could not be read (The operation was aborted due to timeout), so the rest of its files were chosen from the relay's list only, and the count of files left as they were may be off"],
    ['an end-of-walk check that could not run',
      enumerationWarning(ACCOUNT, "could not list this account's files: media server returned 502; could not check for files left unchanged"),
      'could not check for files left unchanged at the end (media server returned 502)'],
    ['files the walk left',
      enumerationWarning(ACCOUNT, '5 more owned video files still listed unchanged after the walk'),
      "5 of this account's videos were still unchanged after the walk"],
    ['a still-hidden report that could not run',
      enumerationWarning(ACCOUNT, "could not list this account's files: media server returned 500; the files still hidden could not be listed"),
      'could not list the files still hidden (media server returned 500)'],
    ['more files to check than one run stores',
      notesOverflowWarning(ACCOUNT, 1203),
      '1203 more files to check than one run can store; act on these, then run the same action again to list the rest'],
    ['files to check that could not be saved',
      notesNotStoredWarning(ACCOUNT, 313, 'D1_ERROR: too many SQL variables'),
      '313 files to check could not be saved (D1_ERROR: too many SQL variables)'],
    ['events outside the account or kind',
      enumerationWarning(ACCOUNT, 'relay returned 3 event(s) outside the requested author or kind; ignored them'),
      'the relay returned 3 event(s) from another account or of another kind; they were left alone'],
    ['a relay list read in part',
      unpaginatedGapWarning(ACCOUNT, 'some events may be unprocessed'),
      "the relay's list of events could not be read in full; some events may be unprocessed"],
    ['a bulk run that threw', bulkLegStoppedWarning(ACCOUNT, 'HTTP 503'), 'the content step stopped before it finished: HTTP 503'],
    ['any other listing line, as written',
      enumerationWarning(ACCOUNT, 'still finding events after 20 sweeps; older versions may remain'),
      'still finding events after 20 sweeps; older versions may remain'],
    ['a line of no known kind, as written', 'something new', 'something new'],
  ])('says %s in plain words', (_label, failure, words) => {
    expect(describeBulkFailure(failure)).toBe(words);
  });
});
