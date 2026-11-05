// ABOUTME: Keeps the row a moderator is reading in place while rows are inserted above it.
// ABOUTME: Used when an older history page lands and interleaves with rows already listed.

export interface ScrollAnchor {
  key: string;
  offset: number;
}

const ROW_SELECTOR = '[data-row-key]';

// The first row whose bottom edge is below the viewport's top edge is the row
// at the top of what the moderator sees. Remember it, and how far from the top
// edge it sits.
export function captureScrollAnchor(viewport: HTMLElement): ScrollAnchor | null {
  const top = viewport.getBoundingClientRect().top;
  for (const row of viewport.querySelectorAll<HTMLElement>(ROW_SELECTOR)) {
    const rect = row.getBoundingClientRect();
    if (rect.bottom > top) {
      return { key: row.dataset.rowKey ?? '', offset: rect.top - top };
    }
  }
  return null;
}

// Scroll so the anchored row sits where it was. If it is no longer listed (it
// was resolved and filtered out meanwhile), leave the scroll position alone.
export function restoreScrollAnchor(viewport: HTMLElement, anchor: ScrollAnchor): void {
  const top = viewport.getBoundingClientRect().top;
  for (const row of viewport.querySelectorAll<HTMLElement>(ROW_SELECTOR)) {
    if (row.dataset.rowKey !== anchor.key) continue;
    const drift = row.getBoundingClientRect().top - top - anchor.offset;
    if (drift !== 0) viewport.scrollTop += drift;
    return;
  }
}
