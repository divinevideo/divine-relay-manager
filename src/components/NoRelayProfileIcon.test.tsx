// ABOUTME: Tests that the bare globe shown for an account with no relay profile says
// ABOUTME: what it means on hover and to assistive tech, instead of being unlabelled (#132).

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { RELAY_PROFILE_BADGE } from '@/lib/constants';
import { NoRelayProfileIcon } from './NoRelayProfileIcon';

describe('NoRelayProfileIcon', () => {
  it('carries the absent-profile wording as its accessible name and hover title', () => {
    render(<NoRelayProfileIcon />);
    const icon = screen.getByRole('img', { name: RELAY_PROFILE_BADGE.absent.title });
    expect(icon.querySelector('title')).toHaveTextContent(RELAY_PROFILE_BADGE.absent.title);
  });
});
