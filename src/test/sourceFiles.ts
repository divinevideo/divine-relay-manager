// ABOUTME: Lists the non-test TypeScript sources under a directory, for tests that scan the code.
// ABOUTME: Shared by the scans that keep one rule defined, or one cache refreshed, in one place.

import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

export function sourceFiles(dir: string): string[] {
  const found: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) found.push(...sourceFiles(path));
    else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) found.push(path);
  }
  return found;
}
