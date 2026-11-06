import { describe, expect, it } from 'vitest';
import { ApiError } from './adminApi';
import { describeStateRefusal, expectedStateOf, stateInWords } from './mediaState';

describe('expectedStateOf', () => {
  it('names the stored action', () => {
    expect(expectedStateOf({ action: 'AGE_RESTRICTED' })).toBe('AGE_RESTRICTED');
  });

  it('names UNKNOWN for a file with no moderation record, as the worker reads it', () => {
    expect(expectedStateOf({ action: null })).toBe('UNKNOWN');
    expect(expectedStateOf({})).toBe('UNKNOWN');
  });

  it('names nothing when the status could not be read or never arrived', () => {
    expect(expectedStateOf({ action: null, unreadable: true })).toBeUndefined();
    expect(expectedStateOf(undefined)).toBeUndefined();
  });
});

describe('describeStateRefusal', () => {
  const changed = (current?: string) =>
    new ApiError('Refusing SAFE: expected current state PERMANENT_BAN, found X', 409, 'Conflict', 'state_mismatch', undefined, current);

  it('says what the record shows now', () => {
    expect(describeStateRefusal(changed('AGE_RESTRICTED')))
      .toBe("The file's moderation record changed after this screen loaded and now shows it behind the 18+ gate");
    expect(describeStateRefusal(changed('UNKNOWN')))
      .toBe("The file's moderation record was removed after this screen loaded");
  });

  it('says only that it changed when the worker did not say to what', () => {
    expect(describeStateRefusal(changed()))
      .toBe("The file's moderation record changed after this screen loaded");
  });

  it('says the state could not be checked', () => {
    expect(describeStateRefusal(new ApiError('Could not read current media state; refusing to act', 503, 'Service Unavailable', 'state_unreadable')))
      .toBe("The file's moderation record could not be checked just now, so it was left as it is");
  });

  // EventActions joins a refusal with '; ' into thumbnail warnings, notes and
  // audit reasons, so a sentence of its own would read "...Try again.; ...".
  it('words every refusal as a fragment, with no closing punctuation', () => {
    const refusals = [
      changed('PERMANENT_BAN'),
      changed('UNKNOWN'),
      changed(),
      new ApiError('Could not read current media state; refusing to act', 503, 'Service Unavailable', 'state_unreadable'),
    ].map(describeStateRefusal);
    for (const refusal of refusals) {
      expect(typeof refusal).toBe('string');
      expect(refusal).not.toMatch(/[.!?]$/);
    }
  });

  it('leaves every other error alone', () => {
    expect(describeStateRefusal(new ApiError('nope', 409, 'Conflict', 'owner_mismatch'))).toBeUndefined();
    expect(describeStateRefusal(new Error('state_mismatch'))).toBeUndefined();
  });
});

describe('stateInWords', () => {
  it('uses moderation words, and falls back to the name', () => {
    expect(stateInWords('QUARANTINE')).toBe('hidden');
    expect(stateInWords('SOME_NEW_STATE')).toBe('some new state');
  });
});
