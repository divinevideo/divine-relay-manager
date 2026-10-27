// ABOUTME: Tests that the bare globe shown for an account with no relay profile says
// ABOUTME: what it means on hover and to assistive tech, instead of being unlabelled (#132).

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { RELAY_PROFILE_BADGE } from '@/lib/constants';
import { NoRelayProfileIcon } from './NoRelayProfileIcon';

describe('NoRelayProfileIcon', () => {
  it('is announced by the short badge label, with the full explanation on hover', () => {
    render(<NoRelayProfileIcon />);
    const icon = screen.getByRole('img', { name: RELAY_PROFILE_BADGE.absent.label });
    expect(icon.querySelector('title')).toHaveTextContent(RELAY_PROFILE_BADGE.absent.title);
  });

  it('is neutral grey, like the badges, so it reads as information, not a judgment', () => {
    render(<NoRelayProfileIcon />);
    const icon = screen.getByRole('img', { name: RELAY_PROFILE_BADGE.absent.label });
    expect(icon.getAttribute('class')).toContain('text-muted-foreground');
    expect(icon.getAttribute('class')).not.toMatch(/purple|green/);
  });
});
