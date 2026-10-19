// ABOUTME: Tests that a claimed nip05 renders only as a real string and always
// ABOUTME: carries its unverified note, since nothing here runs the NIP-05 check (#132).

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ClaimedNip05 } from './ClaimedNip05';

describe('ClaimedNip05', () => {
  it('marks the claim unverified and says why on hover', () => {
    render(<ClaimedNip05 nip05="synthetic@example.test" />);
    const claim = screen.getByText('synthetic@example.test').parentElement!;
    expect(claim).toHaveTextContent('(unverified)');
    expect(claim).toHaveAttribute('title', expect.stringContaining('Nothing has checked it with the domain'));
    expect(claim.getAttribute('title')).toMatch(/^synthetic@example\.test: /);
  });

  it('renders nothing for a whitespace-only nip05', () => {
    const { container } = render(<ClaimedNip05 nip05={'  \n '} />);
    expect(container).toBeEmptyDOMElement();
  });

  // Profile JSON is author-written: a non-string must not reach React as a child.
  it('renders nothing for a non-string nip05', () => {
    const { container } = render(<ClaimedNip05 nip05={{ name: 'synthetic' }} />);
    expect(container).toBeEmptyDOMElement();
  });
});
