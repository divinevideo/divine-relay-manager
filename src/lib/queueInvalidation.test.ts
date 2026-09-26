// ABOUTME: Pins what gets refreshed after anything that can change whether a report is resolved.
// ABOUTME: Both report feeds are filtered by resolution, so both go stale with it.

import { readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { QueryClient } from '@tanstack/react-query';
import { describe, expect, it, vi } from 'vitest';
import { sourceFiles } from '@/test/sourceFiles';
import { invalidateResolutionState, RESOLVED_HISTORY_KEY_ROOT } from './queueInvalidation';

describe('invalidateResolutionState', () => {
  it('refreshes the resolution state, the needs-attention feed and resolved history', () => {
    const queryClient = new QueryClient();
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');

    invalidateResolutionState(queryClient);

    expect(invalidate.mock.calls.map(([filters]) => filters)).toEqual([
      { queryKey: ['resolution-state'] },
      { queryKey: ['reports'] },
      { queryKey: ['reports-resolved'] },
    ]);
    expect(RESOLVED_HISTORY_KEY_ROOT).toBe('reports-resolved');
  });
});

const DIRECT = /invalidateQueries\(\s*\{\s*queryKey:\s*\[\s*['"]resolution-state['"]\s*\]\s*\}\s*\)/;
// The helper itself, and the queue's Retry, which must refresh only the failed
// resolution sources: invalidating resolved history there would re-read every
// loaded page behind the moderator's back (spec: history stays out of the
// retry list).
const ALLOWED = [join('lib', 'queueInvalidation.ts'), join('components', 'Reports.tsx')];

describe('refreshing resolution state', () => {
  it('recognizes the direct call, and only the direct call', () => {
    expect(DIRECT.test("queryClient.invalidateQueries({ queryKey: ['resolution-state'] });")).toBe(true);
    expect(DIRECT.test('invalidateResolutionState(queryClient);')).toBe(false);
  });

  it('finds the direct call in the helper (positive control)', () => {
    const source = readFileSync(join(process.cwd(), 'src', 'lib', 'queueInvalidation.ts'), 'utf8');
    expect(DIRECT.test(source)).toBe(true);
  });

  it('goes through the helper everywhere else', () => {
    // A handler that refreshes only ['resolution-state'] leaves a newly
    // resolved target in neither view, and a reopened one in both.
    const srcRoot = join(process.cwd(), 'src');
    const offenders = sourceFiles(srcRoot)
      .map(path => relative(srcRoot, path))
      .filter(path => !ALLOWED.includes(path))
      .filter(path => DIRECT.test(readFileSync(join(srcRoot, path), 'utf8')));

    expect(offenders).toEqual([]);
  });
});
