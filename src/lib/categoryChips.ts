// ABOUTME: Builds the queue's category filter chips: one per display name, not one per wire spelling.
// ABOUTME: Clients send the same category several ways (NS-spam, spam); a chip per spelling hid reports.

import { HIGH_PRIORITY_CATEGORIES, getCategoryLabel } from '@/lib/constants';

export interface CategoryChip {
  label: string;
  highPriority: boolean;
}

/**
 * One chip per display name across the given report categories. A name is
 * high priority when any of its spellings is. High-priority chips come first so
 * CSAM, child safety and underage reports are never buried, then by name.
 * A category with no display name keeps its raw value as its own chip.
 */
export function categoryChips(categories: Iterable<string>): CategoryChip[] {
  const byLabel = new Map<string, boolean>();
  for (const category of categories) {
    const label = getCategoryLabel(category);
    const highPriority = HIGH_PRIORITY_CATEGORIES.includes(category);
    byLabel.set(label, (byLabel.get(label) ?? false) || highPriority);
  }
  return Array.from(byLabel, ([label, highPriority]) => ({ label, highPriority })).sort(
    (a, b) =>
      Number(b.highPriority) - Number(a.highPriority) ||
      a.label.localeCompare(b.label, undefined, { sensitivity: 'base' }),
  );
}

/** True when a report category is one of the spellings a chip stands for. */
export function categoryMatchesChip(category: string, chipLabel: string): boolean {
  return getCategoryLabel(category) === chipLabel;
}
