// ABOUTME: Tests for the toast copy shared by every account-ban button
// ABOUTME: A ban that may have landed must never read as a destructive "failed"

import { describe, it, expect } from 'vitest';
import { ApiError, BanNotConfirmedError } from './adminApi';
import { banFailureToast, banSuccessNote } from './banFeedback';

describe('banFailureToast', () => {
  it('presents an unconfirmed ban as not confirmed, not as a destructive failure', () => {
    const toast = banFailureToast(new BanNotConfirmedError('Ban not confirmed: timed out'));

    expect(toast.title).toBe('Ban not confirmed');
    expect(toast.variant).toBeUndefined();
    expect(toast.description).toContain('Re-check the account before retrying.');
  });

  it('keeps a refused ban a destructive failure', () => {
    const toast = banFailureToast(new ApiError('Missing pubkey for ban_pubkey', 400));

    expect(toast).toEqual({
      title: 'Failed to ban user',
      description: 'Missing pubkey for ban_pubkey',
      variant: 'destructive',
    });
  });

  // Callers that do more than ban (label + ban) keep their own titles.
  it('uses the caller titles for both kinds of failure', () => {
    const titles = { failure: 'Failed to publish label', notConfirmed: 'Label published; ban not confirmed' };

    expect(banFailureToast(new Error('relay down'), titles).title).toBe('Failed to publish label');
    const notConfirmed = banFailureToast(new BanNotConfirmedError('x'), titles);
    expect(notConfirmed.title).toBe('Label published; ban not confirmed');
    expect(notConfirmed.variant).toBeUndefined();
  });
});

describe('banSuccessNote', () => {
  it('adds nothing to a fully confirmed ban', () => {
    expect(banSuccessNote({ unconfirmed: null })).toBeUndefined();
  });

  // Each unconfirmed case says what is certain and why the rest is not.
  it.each([
    ['removal_error', "we couldn't confirm their content was removed"],
    ['removal_running', "hadn't finished removing their content"],
    ['follow_ups', 'may not have happened'],
    ['follow_ups_skipped', 'did not run'],
  ] as const)('explains %s', (unconfirmed, phrase) => {
    const note = banSuccessNote({ unconfirmed });

    expect(note).toMatch(/^The ban is in effect/);
    expect(note).toContain(phrase);
  });

  // Only the cases that may still resolve point the moderator at a later
  // check. A relay error will not change its answer, and skipped follow-ups
  // will not run by themselves, so those route to a person instead.
  it.each([
    ['removal_running', true],
    ['follow_ups', true],
    ['removal_error', false],
    ['follow_ups_skipped', false],
  ] as const)('%s suggests checking back later: %s', (unconfirmed, suggests) => {
    expect(banSuccessNote({ unconfirmed })?.includes('in a few minutes')).toBe(suggests);
  });

  it('routes skipped follow-ups to T&S Engineering', () => {
    expect(banSuccessNote({ unconfirmed: 'follow_ups_skipped' })).toContain('Let T&S Engineering know');
  });
});
