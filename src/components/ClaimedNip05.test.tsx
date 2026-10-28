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
    expect(claim.getAttribute('title')).toMatch(/^\u2068synthetic@example\.test\u2069: /);
  });

  // The claim is self-declared and can carry direction controls, including a
  // stray isolate terminator; isolated, it can't reorder "(unverified)" or the note.
  it('isolates the claim on screen and in the hover text', () => {
    const { container } = render(<ClaimedNip05 nip05={'x\u2069\u202E@example.test'} />);
    expect(container.querySelector('bdi')?.textContent).toBe('x\u2068\u2069\u202E@example.test');
    expect(container.firstElementChild!.getAttribute('title'))
      .toMatch(/^\u2068x\u2068\u2069\u202E@example\.test\u2069: /);
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

  it('wraps instead of cutting the claim off, for tooltip bodies', () => {
    const { container } = render(<ClaimedNip05 nip05="synthetic@example.test" wrap />);
    const claim = container.querySelector('bdi')!;
    expect(claim.className).toContain('break-all');
    expect(claim.className).not.toContain('truncate');
  });

  it('leaves out its own hover text inside something that already has a tooltip', () => {
    const { container } = render(<ClaimedNip05 nip05="synthetic@example.test" hoverNote={false} />);
    expect(container.firstElementChild).not.toHaveAttribute('title');
    expect(container.firstElementChild).toHaveTextContent('(unverified)');
  });

  it('shows a line break in the claim as ¶, on screen and in the hover text', () => {
    const { container } = render(<ClaimedNip05 nip05={'x\n\u202E@example.test'} />);
    expect(container.querySelector('bdi')?.textContent).toBe('x¶\u202E@example.test');
    expect(container.firstElementChild!.getAttribute('title')).toMatch(/^\u2068x¶\u202E@example\.test\u2069: /);
  });
});
