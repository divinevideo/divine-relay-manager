import { describe, expect, it } from 'vitest';
import { categoryChips, categoryMatchesChip } from './categoryChips';

describe('categoryChips', () => {
  it('gives each display name one chip, however many spellings arrive', () => {
    const chips = categoryChips(['NS-aiGenerated', 'aiGenerated', 'ai-generated', 'NS-spam', 'spam']);
    expect(chips.map(c => c.label)).toEqual(['AI Generated', 'Spam']);
  });

  it('puts high-priority categories first, then sorts by name', () => {
    const chips = categoryChips(['spam', 'copyright', 'NS-underageUser', 'csam', 'NS-childSafety']);
    expect(chips).toEqual([
      { label: 'Child Safety', highPriority: true },
      { label: 'CSAM', highPriority: true },
      { label: 'Under 16', highPriority: true },
      { label: 'Copyright', highPriority: false },
      { label: 'Spam', highPriority: false },
    ]);
  });

  it('marks a name high priority when any of its spellings is', () => {
    // 'csam' and 'NS-csam' are both high priority; 'sexual_minors' too. One chip, red.
    expect(categoryChips(['NS-csam', 'sexual_minors'])).toEqual([{ label: 'CSAM', highPriority: true }]);
  });

  it('names NS-impersonation instead of showing the raw value', () => {
    expect(categoryChips(['NS-impersonation', 'impersonation'])).toEqual([
      { label: 'Impersonation', highPriority: false },
    ]);
  });

  it('keeps an unknown category as its own chip under its raw value', () => {
    expect(categoryChips(['made-up'])).toEqual([{ label: 'made-up', highPriority: false }]);
  });
});

describe('categoryMatchesChip', () => {
  it('matches every spelling of the chip', () => {
    expect(categoryMatchesChip('NS-spam', 'Spam')).toBe(true);
    expect(categoryMatchesChip('spam', 'Spam')).toBe(true);
    expect(categoryMatchesChip('NS-harassment', 'Spam')).toBe(false);
  });
});
