// ABOUTME: Tests the user-summary prompt line formatting (kind labeling, #156)

import { describe, it, expect } from 'vitest';
import { formatRecentPostLine } from './index';

describe('formatRecentPostLine', () => {
  it('labels kind-1111 comments', () => {
    expect(formatRecentPostLine({ content: 'scam text', kind: 1111 }))
      .toBe('- (comment) "scam text"');
  });

  it('labels kind-6 and kind-16 reposts', () => {
    expect(formatRecentPostLine({ content: 'boosted', kind: 16 }))
      .toBe('- (repost of another user\'s event) "boosted"');
    expect(formatRecentPostLine({ content: 'boosted', kind: 6 }))
      .toBe('- (repost of another user\'s event) "boosted"');
  });

  it('leaves other kinds and missing kind unlabeled (backward compatible)', () => {
    expect(formatRecentPostLine({ content: 'a note', kind: 1 })).toBe('- "a note"');
    expect(formatRecentPostLine({ content: 'a note' })).toBe('- "a note"');
  });

  it('truncates content to 200 chars', () => {
    const line = formatRecentPostLine({ content: 'x'.repeat(300), kind: 1 });
    expect(line).toBe(`- "${'x'.repeat(200)}"`);
  });
});
