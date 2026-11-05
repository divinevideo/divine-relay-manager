// ABOUTME: Pins that the browser derives a report's target only from shared/report-target.ts.
// ABOUTME: A private copy could group reports differently from the worker that filters them.

import { readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { sourceFiles } from '@/test/sourceFiles';

// A second definition of the rule, however it is written.
const DEFINITION = /\bfunction\s+getReportTarget\s*\(|\b(?:const|let|var)\s+getReportTarget\s*=/;

describe("a report's target", () => {
  it('detects a definition written either way, and ignores an import', () => {
    expect(DEFINITION.test('function getReportTarget(event: NostrEvent) {')).toBe(true);
    expect(DEFINITION.test('const getReportTarget = (event) => null;')).toBe(true);
    expect(DEFINITION.test("import { getReportTarget } from '../../shared/report-target';")).toBe(false);
  });

  it('is defined nowhere in the browser code', () => {
    // The worker filters the queue with shared/report-target.ts. The queue,
    // the report pane and its context hook each carried a private copy; one
    // that drifted would group reports under a different target than the
    // worker filtered on, and they would vanish or duplicate silently.
    const srcRoot = join(process.cwd(), 'src');
    const offenders = sourceFiles(srcRoot)
      .filter(path => DEFINITION.test(readFileSync(path, 'utf8')))
      .map(path => relative(srcRoot, path));

    expect(offenders).toEqual([]);
  });
});
