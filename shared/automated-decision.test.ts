import { describe, it, expect } from 'vitest';
import { isAutomatedDecision } from './automated-decision';

const MODERATOR = '7e'.repeat(32);

describe('isAutomatedDecision', () => {
  // A literal 'auto', not the constant: rows already in D1 carry this value.
  it('is true for a decision the worker wrote itself', () => {
    expect(isAutomatedDecision({ action: 'age_review_case_created', moderator_pubkey: 'auto' })).toBe(true);
  });

  it("is false for a moderator's decision", () => {
    expect(isAutomatedDecision({ action: 'reviewed', moderator_pubkey: MODERATOR })).toBe(false);
  });

  it('is false for a decision with no moderator recorded', () => {
    expect(isAutomatedDecision({ action: 'reviewed', moderator_pubkey: null })).toBe(false);
    expect(isAutomatedDecision({ action: 'reviewed' })).toBe(false);
  });

  // ReportWatcher also writes 'auto' when it records a person's confirm or
  // restore of an auto-hide, so an auto-hide row never counts, whoever wrote it.
  it.each([
    'auto_hidden',
    'auto_hide_pending',
    'auto_hide_skipped',
    'auto_hide_failed',
    'auto_hide_unresolved',
    'auto_hide_restore_failed',
    'auto_hide_reversed',
    'auto_hide_restored',
    'auto_hide_confirmed',
  ])('is false for the auto-hide action %s', (action) => {
    expect(isAutomatedDecision({ action, moderator_pubkey: 'auto' })).toBe(false);
  });
});
