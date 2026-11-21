// ABOUTME: Pins the toast for every way an unban can leave a timed suspension, so a
// ABOUTME: toast never says the suspension ended or resumed when the worker said otherwise.
import { describe, expect, it } from 'vitest';
import { unbanAuditFailedToast, unbanOutcomeNote, unbanOutcomeToast } from './unbanOutcomeToast';
import { SUSPENSION_END_UNAVAILABLE } from './suspensionEndText';
import { formatSuspensionEnd } from '../../shared/suspension';

const NOW = new Date('2026-11-20T12:00:00.000Z');
const FUTURE = '2026-11-23T12:00:00.000Z';
const PAST = '2026-11-19T12:00:00.000Z';

describe('unbanOutcomeToast', () => {
  it('ended', () => {
    expect(unbanOutcomeToast({ suspension: { state: 'ended', endsAt: null } }, NOW))
      .toEqual({ title: 'User unbanned and unsuspended' });
  });

  it('end_failed is destructive and points to Unsuspend', () => {
    expect(unbanOutcomeToast({ suspension: { state: 'end_failed' } }, NOW)).toEqual({
      title: 'User unbanned, but the suspension could not be lifted',
      description: 'It is still suspended. Try Unsuspend.',
      variant: 'destructive',
    });
  });

  it('resumed with a future end names it', () => {
    expect(unbanOutcomeToast({ suspension: { state: 'resumed', endsAt: FUTURE } }, NOW))
      .toEqual({ title: `User unbanned. Still suspended until ${formatSuspensionEnd(FUTURE)}` });
  });

  it('resumed with no end', () => {
    expect(unbanOutcomeToast({ suspension: { state: 'resumed', endsAt: null } }, NOW))
      .toEqual({ title: 'User unbanned. Still suspended, no end date' });
  });

  // "Still suspended until <yesterday>" would be untrue: the next check lifts it.
  it('resumed with an end that has passed says it lifts at the next check', () => {
    expect(unbanOutcomeToast({ suspension: { state: 'resumed', endsAt: PAST } }, NOW))
      .toEqual({ title: 'User unbanned. The end date has passed, so the suspension lifts at the next check' });
  });

  // An end the UI cannot read is unknown, never "no end date" and never NaN.
  it('resumed with an unreadable end says the end is unavailable', () => {
    expect(unbanOutcomeToast({ suspension: { state: 'resumed', endsAt: 'garbage' } }, NOW))
      .toEqual({ title: 'User unbanned', description: SUSPENSION_END_UNAVAILABLE });
  });

  it('open_ended', () => {
    expect(unbanOutcomeToast({ suspension: { state: 'open_ended', endsAt: null } }, NOW))
      .toEqual({ title: 'User unbanned. Still suspended, no end date' });
  });

  it('unknown asks for a check before acting again', () => {
    expect(unbanOutcomeToast({ suspension: { state: 'unknown' } }, NOW)).toEqual({
      title: 'User unbanned, but the suspension status could not be checked',
      description: 'Check the account before acting again.',
    });
  });

  // The timer moved during the unban (ask again if it changed): the unban landed but the
  // choice was not applied, so the toast must not read as any outcome of that choice.
  it('changed says the choice was not applied and the suspension was left as it was', () => {
    expect(unbanOutcomeToast({ suspension: { state: 'changed' } }, NOW)).toEqual({
      title: 'User unbanned, but the suspension changed before your choice was saved',
      description: 'The suspension was left as it was. Check the account before acting again.',
    });
  });

  it('changed outranks a failed audit write', () => {
    expect(unbanAuditFailedToast({ suspension: { state: 'changed' } }, NOW)).toEqual({
      title: 'User unbanned, but the suspension changed before your choice was saved',
      description: 'The suspension was left as it was. Check the account before acting again. Audit log not recorded.',
    });
  });

  it.each(['not_suspended', 'none'] as const)('%s is a plain unban', (state) => {
    expect(unbanOutcomeToast({ suspension: { state } }, NOW)).toEqual({ title: 'User unbanned' });
  });

  // The worker skipped the moderator's choice (non-canonical pubkey) and left
  // the suspension as it was: the toast must not read as a plain unban.
  it('a skipped choice says the choice was not applied', () => {
    expect(unbanOutcomeToast({ suspension: { state: 'none' }, choiceSkipped: 'non_canonical_pubkey' }, NOW)).toEqual({
      title: 'User unbanned, but the suspension choice was not applied',
      description: 'Check the account before acting again.',
    });
  });

  // The worker writes the suspension's decision row for an explicit choice and
  // reports whether it did. The change happened either way; a missing row is
  // the thing to say, with what happened as the description.
  it.each([
    ['ended', null, 'User unbanned and unsuspended'],
    ['resumed', FUTURE, `User unbanned. Still suspended until ${formatSuspensionEnd(FUTURE)}`],
    ['open_ended', null, 'User unbanned. Still suspended, no end date'],
  ] as const)('%s with no decision row says the audit log was not recorded', (state, endsAt, done) => {
    expect(unbanOutcomeToast({ suspension: { state, endsAt, decisionRecorded: false } }, NOW))
      .toEqual({ title: 'Action applied; audit log not recorded', description: done });
  });

  it('a recorded decision is a plain success', () => {
    expect(unbanOutcomeToast({ suspension: { state: 'ended', endsAt: null, decisionRecorded: true } }, NOW))
      .toEqual({ title: 'User unbanned and unsuspended' });
  });

  it('reads the clock when no now is given', () => {
    const ahead = new Date(Date.now() + 3 * 86_400_000).toISOString();
    expect(unbanOutcomeToast({ suspension: { state: 'resumed', endsAt: ahead } }).title)
      .toBe(`User unbanned. Still suspended until ${formatSuspensionEnd(ahead)}`);
  });
});

// The audit warning replaces whatever toast is up (one at a time), so it
// carries the outcome as its description.
describe('unbanOutcomeNote', () => {
  it('is the title alone when there is no description', () => {
    expect(unbanOutcomeNote({ title: 'User unbanned' })).toBe('User unbanned');
  });

  it('joins the title and the description', () => {
    expect(unbanOutcomeNote({ title: 'User unbanned, but the suspension could not be lifted', description: 'It is still suspended. Try Unsuspend.' }))
      .toBe('User unbanned, but the suspension could not be lifted. It is still suspended. Try Unsuspend.');
  });
});

// The browser's own audit write failed after the unban landed. One toast shows at a
// time, so this toast replaces the outcome's and must follow the same ranking: a failure
// or an unknown keeps its title and severity; anything else leads with the warning.
describe('unbanAuditFailedToast', () => {
  it.each([
    [{ suspension: { state: 'end_failed' } }, {
      title: 'User unbanned, but the suspension could not be lifted',
      description: 'It is still suspended. Try Unsuspend. Audit log not recorded.',
      variant: 'destructive',
    }],
    [{ suspension: { state: 'unknown' } }, {
      title: 'User unbanned, but the suspension status could not be checked',
      description: 'Check the account before acting again. Audit log not recorded.',
    }],
    [{ suspension: { state: 'none' }, choiceSkipped: 'non_canonical_pubkey' }, {
      title: 'User unbanned, but the suspension choice was not applied',
      description: 'Check the account before acting again. Audit log not recorded.',
    }],
  ] as const)('keeps an outcome that outranks the audit warning (%#)', (outcome, expected) => {
    expect(unbanAuditFailedToast(outcome, NOW)).toEqual(expected);
  });

  it.each([
    [{ suspension: { state: 'ended', endsAt: null } }, 'User unbanned and unsuspended'],
    [{ suspension: { state: 'not_suspended' } }, 'User unbanned'],
  ] as const)('leads with the warning and carries the outcome otherwise (%#)', (outcome, done) => {
    expect(unbanAuditFailedToast(outcome, NOW)).toEqual({ title: 'Action applied; audit log not recorded', description: done });
  });

  // The worker's decision row is missing too: the toast already says so, once.
  it('does not repeat the warning when the outcome already carries it', () => {
    expect(unbanAuditFailedToast({ suspension: { state: 'ended', endsAt: null, decisionRecorded: false } }, NOW))
      .toEqual({ title: 'Action applied; audit log not recorded', description: 'User unbanned and unsuspended' });
  });
});
