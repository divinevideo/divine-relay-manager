// ABOUTME: Tests the real MediaPreview and InlineMediaPreview (not stubs) hide media until the
// ABOUTME: show control is clicked, follow showByDefault, and re-hide when it turns sensitive

import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import type { NostrEvent } from '@nostrify/nostrify';
import { MediaPreview, InlineMediaPreview } from './MediaPreview';

vi.mock('@/hooks/useAdminApi', () => ({
  useApiUrl: () => 'https://api.example.invalid',
}));

const IMG = 'https://example.invalid/pic.png';
const OTHER_IMG = 'https://example.invalid/other.png';
const CONTENT = `look ${IMG}`;
const hasImg = (c: HTMLElement, src = IMG) => c.querySelector(`img[src="${src}"]`) !== null;

function note(idByte: string, url: string): NostrEvent {
  return {
    id: idByte.repeat(64),
    pubkey: '1'.repeat(64),
    created_at: 1751000000,
    kind: 1,
    tags: [],
    content: `look ${url}`,
    sig: '2'.repeat(128),
  };
}
const EVENT_A = note('a', IMG);
const EVENT_B = note('b', OTHER_IMG);

describe('MediaPreview showByDefault (real component)', () => {
  it('renders no media until Show is clicked when showByDefault is false', () => {
    const { container } = render(<MediaPreview content={CONTENT} tags={[]} showByDefault={false} />);
    expect(hasImg(container)).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: /show/i }));
    expect(hasImg(container)).toBe(true);
  });
});

// Effects run before RTL's assertions, so a DOM check alone cannot see an
// element that one commit created and an effect then hid. A created
// <img>/<video> is already a network request in a real browser.
function mediaElementsCreatedDuring(action: () => void): string[] {
  const spy = vi.spyOn(document, 'createElement');
  action();
  const media = spy.mock.calls.map(c => String(c[0]).toLowerCase()).filter(t => t === 'img' || t === 'video');
  spy.mockRestore();
  return media;
}
const mediaElementsCreatedBy = (ui: React.ReactElement) => mediaElementsCreatedDuring(() => render(ui));

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

  // The pane is reused across reports, so a Show on one report must not carry
  // into a sensitive one.
  it('re-hides media when its default turns sensitive, even after the moderator chose Show', () => {
    const { container, rerender } = render(<InlineMediaPreview content={CONTENT} tags={[]} showByDefault={false} />);
    fireEvent.click(screen.getByRole('button', { name: /show 1 media/i }));
    expect(hasImg(container)).toBe(true);
    rerender(<InlineMediaPreview content={CONTENT} tags={[]} showByDefault={false} />);
    rerender(<InlineMediaPreview content={CONTENT} tags={[]} showByDefault={true} />);
    rerender(<InlineMediaPreview content={CONTENT} tags={[]} showByDefault={false} />);
    expect(hasImg(container)).toBe(false);
  });

  it('hides media it was showing by default once the default turns sensitive, after a Hide and Show', () => {
    const { container, rerender } = render(<InlineMediaPreview content={CONTENT} tags={[]} showByDefault={true} />);
    fireEvent.click(screen.getByRole('button', { name: /hide 1 media/i }));
    fireEvent.click(screen.getByRole('button', { name: /show 1 media/i }));
    expect(hasImg(container)).toBe(true);
    rerender(<InlineMediaPreview content={CONTENT} tags={[]} showByDefault={false} />);
    expect(hasImg(container)).toBe(false);
  });

  it('keeps media the moderator showed while the default stays sensitive', () => {
    const { container, rerender } = render(<InlineMediaPreview content={CONTENT} tags={[]} showByDefault={false} />);
    fireEvent.click(screen.getByRole('button', { name: /show 1 media/i }));
    rerender(<InlineMediaPreview content={CONTENT} tags={[]} showByDefault={false} className="mt-2" />);
    expect(hasImg(container)).toBe(true);
  });

  it('follows the default again once a sensitive default has dropped the moderator\'s Show', () => {
    const { container, rerender } = render(<InlineMediaPreview content={CONTENT} tags={[]} showByDefault={true} />);
    fireEvent.click(screen.getByRole('button', { name: /hide 1 media/i }));
    fireEvent.click(screen.getByRole('button', { name: /show 1 media/i }));
    rerender(<InlineMediaPreview content={CONTENT} tags={[]} showByDefault={false} />);
    expect(hasImg(container)).toBe(false);
    rerender(<InlineMediaPreview content={CONTENT} tags={[]} showByDefault={true} />);
    expect(hasImg(container)).toBe(true);
  });

  it("keeps the moderator's Hide when the default turns sensitive and back", () => {
    const { container, rerender } = render(<InlineMediaPreview content={CONTENT} tags={[]} showByDefault={true} />);
    fireEvent.click(screen.getByRole('button', { name: /hide 1 media/i }));
    rerender(<InlineMediaPreview content={CONTENT} tags={[]} showByDefault={false} />);
    expect(hasImg(container)).toBe(false);
    rerender(<InlineMediaPreview content={CONTENT} tags={[]} showByDefault={true} />);
    expect(hasImg(container)).toBe(false);
  });
});

// null: the reports that decide the default are not known yet.
describe('MediaPreview while its default is not known yet', () => {
  it('never creates a media element on the first render', () => {
    expect(mediaElementsCreatedBy(<MediaPreview content={CONTENT} tags={[]} showByDefault={null} />)).toEqual([]);
  });

  it('forgets a Show once the default turns out sensitive', () => {
    const { container, rerender } = render(<MediaPreview content={CONTENT} tags={[]} showByDefault={null} />);
    fireEvent.click(screen.getByRole('button', { name: /show/i }));
    expect(hasImg(container)).toBe(true);
    rerender(<MediaPreview content={CONTENT} tags={[]} showByDefault={false} />);
    expect(hasImg(container)).toBe(false);
  });

  it('leaves the media as it was when a known default goes back to not known', () => {
    const { container, rerender } = render(<MediaPreview content={CONTENT} tags={[]} showByDefault={true} />);
    rerender(<MediaPreview content={CONTENT} tags={[]} showByDefault={null} />);
    expect(hasImg(container)).toBe(true);
  });
});

describe('MediaPreview moving to another event', () => {
  it("never mounts the next event's media after the moderator showed the last one", () => {
    const { container, rerender } = render(<MediaPreview event={EVENT_A} showByDefault={false} />);
    fireEvent.click(screen.getByRole('button', { name: /show/i }));
    expect(hasImg(container)).toBe(true);

    const created = mediaElementsCreatedDuring(() =>
      rerender(<MediaPreview event={EVENT_B} showByDefault={false} />));

    expect(created).toEqual([]);
    expect(hasImg(container, OTHER_IMG)).toBe(false);
  });

  it("follows the next event's default as it arrives, whatever was chosen on the last event", () => {
    const { container, rerender } = render(<MediaPreview event={EVENT_A} showByDefault={false} />);
    fireEvent.click(screen.getByRole('button', { name: /show/i }));
    rerender(<MediaPreview event={EVENT_B} showByDefault={false} />);
    expect(hasImg(container, OTHER_IMG)).toBe(false);

    // The next event's reports load and hold nothing sensitive.
    rerender(<MediaPreview event={EVENT_B} showByDefault={true} />);

    expect(hasImg(container, OTHER_IMG)).toBe(true);
  });

  it("starts the next event from its own default, not the last event's Hide", () => {
    const { container, rerender } = render(<MediaPreview event={EVENT_A} showByDefault={true} />);
    fireEvent.click(screen.getByRole('button', { name: /hide/i }));
    expect(hasImg(container)).toBe(false);

    rerender(<MediaPreview event={EVENT_B} showByDefault={true} />);

    expect(hasImg(container, OTHER_IMG)).toBe(true);
  });
});
