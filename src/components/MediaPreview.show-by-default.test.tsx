// ABOUTME: Tests the real MediaPreview and InlineMediaPreview (not stubs) hide media
// ABOUTME: until the show control is clicked, and follow showByDefault as it changes

import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { MediaPreview, InlineMediaPreview } from './MediaPreview';

vi.mock('@/hooks/useAdminApi', () => ({
  useApiUrl: () => 'https://api.example.invalid',
}));

const IMG = 'https://example.invalid/pic.png';
const CONTENT = `look ${IMG}`;
const hasImg = (c: HTMLElement) => c.querySelector(`img[src="${IMG}"]`) !== null;

describe('MediaPreview showByDefault (real component)', () => {
  it('renders no media until Show is clicked when showByDefault is false', () => {
    const { container } = render(<MediaPreview content={CONTENT} tags={[]} showByDefault={false} />);
    expect(hasImg(container)).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: /show/i }));
    expect(hasImg(container)).toBe(true);
  });
});

// The effect-based re-sync runs before RTL's assertions, so a DOM check alone
// cannot see an element that was created on first render and then hidden. A
// created <img>/<video> is already a network request in a real browser.
function mediaElementsCreatedBy(ui: React.ReactElement): string[] {
  const spy = vi.spyOn(document, 'createElement');
  render(ui);
  const media = spy.mock.calls.map(c => String(c[0]).toLowerCase()).filter(t => t === 'img' || t === 'video');
  spy.mockRestore();
  return media;
}

describe('first render when hidden by default', () => {
  it('MediaPreview never creates a media element', () => {
    expect(mediaElementsCreatedBy(<MediaPreview content={CONTENT} tags={[]} showByDefault={false} />)).toEqual([]);
  });

  it('InlineMediaPreview never creates a media element', () => {
    expect(mediaElementsCreatedBy(<InlineMediaPreview content={CONTENT} tags={[]} showByDefault={false} />)).toEqual([]);
  });
});

describe('InlineMediaPreview showByDefault', () => {
  it('shows media by default (existing behavior)', () => {
    const { container } = render(<InlineMediaPreview content={CONTENT} tags={[]} />);
    expect(hasImg(container)).toBe(true);
  });

  it('renders no media until Show is clicked when showByDefault is false', () => {
    const { container } = render(<InlineMediaPreview content={CONTENT} tags={[]} showByDefault={false} />);
    expect(hasImg(container)).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: /show 1 media/i }));
    expect(hasImg(container)).toBe(true);
  });

  it('follows showByDefault when it changes after mount, until the moderator toggles', () => {
    const { container, rerender } = render(<InlineMediaPreview content={CONTENT} tags={[]} showByDefault={false} />);
    expect(hasImg(container)).toBe(false);
    rerender(<InlineMediaPreview content={CONTENT} tags={[]} showByDefault={true} />);
    expect(hasImg(container)).toBe(true);
    rerender(<InlineMediaPreview content={CONTENT} tags={[]} showByDefault={false} />);
    expect(hasImg(container)).toBe(false);
  });

  it('does not override a moderator toggle when showByDefault changes', () => {
    const { container, rerender } = render(<InlineMediaPreview content={CONTENT} tags={[]} showByDefault={false} />);
    fireEvent.click(screen.getByRole('button', { name: /show 1 media/i }));
    expect(hasImg(container)).toBe(true);
    rerender(<InlineMediaPreview content={CONTENT} tags={[]} showByDefault={false} />);
    rerender(<InlineMediaPreview content={CONTENT} tags={[]} showByDefault={true} />);
    rerender(<InlineMediaPreview content={CONTENT} tags={[]} showByDefault={false} />);
    expect(hasImg(container)).toBe(true);
  });
});
