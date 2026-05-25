// ABOUTME: Canonical child-safety and underage report category wire aliases
// ABOUTME: Shared by frontend constants and worker ReportWatcher age-review matching

/** NIP-32 / client aliases for child-safety reports (camelCase and kebab-case, with and without NS- prefix). */
export const CHILD_SAFETY_CATEGORIES = [
  'NS-childSafety',
  'NS-child-safety',
  'childSafety',
  'child-safety',
] as const;

/** NIP-32 / client aliases for under-16 user reports. */
export const UNDERAGE_CATEGORIES = [
  'NS-underageUser',
  'NS-underage-user',
  'underageUser',
  'underage-user',
] as const;

export type ChildSafetyCategory = typeof CHILD_SAFETY_CATEGORIES[number];
export type UnderageCategory = typeof UNDERAGE_CATEGORIES[number];

export function isChildSafetyCategory(category: string): category is ChildSafetyCategory {
  return (CHILD_SAFETY_CATEGORIES as readonly string[]).includes(category);
}

export function isUnderageCategory(category: string): category is UnderageCategory {
  return (UNDERAGE_CATEGORIES as readonly string[]).includes(category);
}
