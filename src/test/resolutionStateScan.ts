// ABOUTME: Matcher behind the "goes through invalidateResolutionState everywhere
// ABOUTME: else" scan. Pure and fixture-testable, so its own rules are pinned
// ABOUTME: independent of whatever the repo currently contains.

import { join } from 'node:path';

// Matches a direct invalidateQueries(['resolution-state']) call, tolerant of
// the whitespace and newlines the real call sites are formatted with,
// including a multi-line call with a trailing comma before either closing
// bracket.
export const DIRECT_CALL = /invalidateQueries\(\s*\{\s*queryKey:\s*\[\s*['"]resolution-state['"]\s*,?\s*\]\s*,?\s*\}\s*\)/;

// Only the shared invalidation helper may use the key directly.
export function hasDisallowedDirectCall(source: string, relativePath: string): boolean {
  return relativePath !== join('lib', 'queueInvalidation.ts') && DIRECT_CALL.test(source);
}
