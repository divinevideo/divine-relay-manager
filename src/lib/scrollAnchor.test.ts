// ABOUTME: Pins how the row a moderator is reading is remembered and put back after rows land above it.
// ABOUTME: Layout is stubbed: jsdom does none, so each row's box follows the viewport's scrollTop.

import { describe, expect, it, vi } from 'vitest';
import { captureScrollAnchor, restoreScrollAnchor } from './scrollAnchor';

const box = (top: number, height: number) =>
  ({ top, bottom: top + height, left: 0, right: 0, width: 0, height, x: 0, y: top, toJSON: () => ({}) }) as DOMRect;

// A viewport 300px tall whose rows sit at fixed offsets in the scrolled content.
function layout(rowTops: Record<string, number>) {
  const viewport = document.createElement('div');
  vi.spyOn(viewport, 'getBoundingClientRect').mockReturnValue(box(0, 300));
  for (const [key, top] of Object.entries(rowTops)) {
    const row = document.createElement('div');
    row.dataset.rowKey = key;
    vi.spyOn(row, 'getBoundingClientRect').mockImplementation(() => box(top - viewport.scrollTop, 100));
    viewport.appendChild(row);
  }
  return viewport;
}

describe('captureScrollAnchor', () => {
  it('takes the first row still visible at the top, and how far it sits from the top edge', () => {
    const viewport = layout({ a: 0, b: 100, c: 200 });
    viewport.scrollTop = 150;

    expect(captureScrollAnchor(viewport)).toEqual({ key: 'b', offset: -50 });
  });

  it('has nothing to anchor to when nothing is listed', () => {
    expect(captureScrollAnchor(layout({}))).toBeNull();
  });
});

describe('restoreScrollAnchor', () => {
  it('scrolls by however far the anchored row moved', () => {
    // Two rows landed above c: it now sits 200px lower in the content.
    const viewport = layout({ a: 0, x: 100, y: 200, b: 300, c: 400 });
    viewport.scrollTop = 200;

    restoreScrollAnchor(viewport, { key: 'c', offset: 0 });

    expect(viewport.scrollTop).toBe(400);
  });

  it('leaves the scroll alone when the anchored row is no longer listed', () => {
    const viewport = layout({ a: 0 });
    viewport.scrollTop = 50;

    restoreScrollAnchor(viewport, { key: 'gone', offset: 0 });

    expect(viewport.scrollTop).toBe(50);
  });
});
