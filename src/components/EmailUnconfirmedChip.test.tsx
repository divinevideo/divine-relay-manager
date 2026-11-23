// ABOUTME: Pins when the "Email not confirmed" chip shows: only for an explicit true
// ABOUTME: from Keycast. Absent, false, non-boolean or a failed lookup show nothing.

import { act, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { EmailUnconfirmedChip, EMAIL_UNCONFIRMED_LABEL, EMAIL_UNCONFIRMED_TITLE } from './EmailUnconfirmedChip';
import type { AccountStatusResponse } from '@/lib/adminApi';

describe('EmailUnconfirmedChip', () => {
  it('shows the chip for an explicit true', () => {
    render(<EmailUnconfirmedChip accountStatus={{ success: true, status: 'active', email_unconfirmed: true }} />);
    expect(screen.getByText('Email not confirmed')).toBeInTheDocument();
  });

  it('uses the agreed copy and never numeric limits', () => {
    expect(EMAIL_UNCONFIRMED_LABEL).toBe('Email not confirmed');
    expect(EMAIL_UNCONFIRMED_TITLE).toBe(
      "This account hasn't confirmed its email. Until it does, Keycast limits how much it can post and report, and it can only send direct messages to Divine HQ and Moderation.",
    );
    expect(EMAIL_UNCONFIRMED_TITLE).not.toMatch(/\d/);
  });

  it('opens the explanation on keyboard focus', () => {
    render(<EmailUnconfirmedChip accountStatus={{ success: true, email_unconfirmed: true }} />);
    act(() => { fireEvent.focus(screen.getByText('Email not confirmed').closest('[tabindex="0"]')!); });
    expect(screen.getAllByText(EMAIL_UNCONFIRMED_TITLE).length).toBeGreaterThan(0);
  });

  it.each<[string, AccountStatusResponse | undefined]>([
    ['false', { success: true, status: 'active', email_unconfirmed: false }],
    ['absent', { success: true, status: 'active' }],
    ['a non-boolean', { success: true, email_unconfirmed: 'true' as unknown as boolean }],
    ['null', { success: true, email_unconfirmed: null as unknown as boolean }],
    ['a failed lookup', { success: false, error: 'unavailable' }],
    ['a failed lookup that still carries the flag', { success: false, email_unconfirmed: true }],
    ['self-custody (not found)', { success: false, not_found: true }],
    ['no data yet', undefined],
  ])('shows nothing for %s', (_label, accountStatus) => {
    const { container } = render(<EmailUnconfirmedChip accountStatus={accountStatus} />);
    expect(container).toBeEmptyDOMElement();
  });
});
