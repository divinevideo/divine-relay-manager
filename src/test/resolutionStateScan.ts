// ABOUTME: Matcher behind the "goes through invalidateResolutionState everywhere
// ABOUTME: else" scan. Pure and fixture-testable, so its own rules are pinned
// ABOUTME: independent of whatever the repo currently contains.

import { join } from 'node:path';

// Matches a direct invalidateQueries(['resolution-state']) call, tolerant of
// the whitespace and newlines the real call sites are formatted with,
// including a multi-line call with a trailing comma before either closing
// bracket.
export const DIRECT_CALL = /invalidateQueries\(\s*\{\s*queryKey:\s*\[\s*['"]resolution-state['"]\s*,?\s*\]\s*,?\s*\}\s*\)/;

// A file fully exempt from the scan: the helper itself, which must contain
// exactly this direct call (see the "positive control" test).
const FULL_EXEMPT = [join('lib', 'queueInvalidation.ts')];

// Files where a direct call is allowed, but only inside one named function.
// Everywhere else in that file, and every other file, must go through
// invalidateResolutionState. Reports.tsx's retryResolutionSources is the
// queue's Retry, which must refresh only the failed resolution sources:
// invalidating resolved history there would re-read every loaded page behind
// the moderator's back (spec: history stays out of the retry list).
const RETRY_ONLY: Record<string, string> = {
  [join('components', 'Reports.tsx')]: 'retryResolutionSources',
};

// Finds `name`'s declaration (a function statement or a const arrow) and
// returns its body by brace-matching from the first `{` after it, so the scan
// doesn't need a real parser. Returns '' if `name` isn't declared this way --
// a renamed or restructured function then stops being exempt, rather than
// silently exempting nothing or (worse) the rest of the file.
function functionBody(source: string, name: string): string {
  const declaration = new RegExp(
    `(?:function\\s+${name}\\s*\\(|const\\s+${name}\\s*=\\s*(?:\\([^)]*\\)|[A-Za-z0-9_]+)\\s*=>)`,
  ).exec(source);
  if (!declaration) return '';
  const start = source.indexOf('{', declaration.index);
  if (start === -1) return '';
  let depth = 0;
  for (let i = start; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}' && --depth === 0) return source.slice(start, i + 1);
  }
  return source.slice(start);
}

// True when `source` (the file at `relativePath`, relative to src/) has a
// direct call the scan should flag.
export function hasDisallowedDirectCall(source: string, relativePath: string): boolean {
  if (FULL_EXEMPT.includes(relativePath)) return false;
  const exemptFn = RETRY_ONLY[relativePath];
  if (!exemptFn) return DIRECT_CALL.test(source);
  const body = functionBody(source, exemptFn);
  // Test everything OUTSIDE the exempt function's body, not the whole file --
  // otherwise a second, disallowed call anywhere else would go unnoticed as
  // long as the regex also matched once inside the exemption.
  const outsideBody = body ? source.replace(body, '') : source;
  return DIRECT_CALL.test(outsideBody);
}
