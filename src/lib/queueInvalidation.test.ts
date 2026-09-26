// ABOUTME: Pins what gets refreshed after anything that can change whether a report is resolved.
// ABOUTME: Both report feeds are filtered by resolution, so both go stale with it.

import { readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { QueryClient } from '@tanstack/react-query';
import { describe, expect, it, vi } from 'vitest';
import { sourceFiles } from '@/test/sourceFiles';
import { DIRECT_CALL, hasDisallowedDirectCall } from '@/test/resolutionStateScan';
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

// Fixture strings, not real files: the matcher's own rules -- the regex's
// tolerance for formatting, and the scope of the Retry exemption -- are
// pinned here independent of whatever the repo currently contains, so a
// future real file can never make these rules untestable by satisfying them
// by accident.
describe('the direct-call matcher (fixtures)', () => {
  it('recognizes a single-line direct call', () => {
    expect(DIRECT_CALL.test("queryClient.invalidateQueries({ queryKey: ['resolution-state'] });")).toBe(true);
  });

  it('does not mistake the helper call for a direct one', () => {
    expect(DIRECT_CALL.test('invalidateResolutionState(queryClient);')).toBe(false);
  });

  it('recognizes a multi-line call with a trailing comma', () => {
    const source = "queryClient.invalidateQueries({\n  queryKey: ['resolution-state'],\n});";
    expect(DIRECT_CALL.test(source)).toBe(true);
  });

  it('allows the direct call inside retryResolutionSources in Reports.tsx', () => {
    const source = `
function other() {}
const retryResolutionSources = () => {
  queryClient.invalidateQueries({ queryKey: ['resolution-state'] });
};
`;
    expect(hasDisallowedDirectCall(source, join('components', 'Reports.tsx'))).toBe(false);
  });

  // What Important finding #1 in the review exists to prevent: a future
  // handler added anywhere else in Reports.tsx that writes the raw call
  // instead of using the helper. At b4cf4b8 this passed (ALLOWED exempted the
  // whole file); it must fail now.
  it('still catches a direct call added elsewhere in Reports.tsx', () => {
    const source = `
const retryResolutionSources = () => {
  queryClient.invalidateQueries({ queryKey: ['resolution-label-targets'] });
};
function someNewHandler() {
  queryClient.invalidateQueries({ queryKey: ['resolution-state'] });
}
`;
    expect(hasDisallowedDirectCall(source, join('components', 'Reports.tsx'))).toBe(true);
  });

  it('allows the direct call anywhere in the helper file itself', () => {
    const source = "queryClient.invalidateQueries({ queryKey: ['resolution-state'] });";
    expect(hasDisallowedDirectCall(source, join('lib', 'queueInvalidation.ts'))).toBe(false);
  });
});

describe('refreshing resolution state', () => {
  it('finds the direct call in the helper (positive control)', () => {
    const source = readFileSync(join(process.cwd(), 'src', 'lib', 'queueInvalidation.ts'), 'utf8');
    expect(DIRECT_CALL.test(source)).toBe(true);
  });

  it('goes through the helper everywhere else', () => {
    // A handler that refreshes only ['resolution-state'] leaves a newly
    // resolved target in neither view, and a reopened one in both.
    const srcRoot = join(process.cwd(), 'src');
    const offenders = sourceFiles(srcRoot)
      .map(path => relative(srcRoot, path))
      .filter(path => hasDisallowedDirectCall(readFileSync(join(srcRoot, path), 'utf8'), path));

    expect(offenders).toEqual([]);
  });
});
