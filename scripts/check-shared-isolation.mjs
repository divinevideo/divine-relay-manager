// ABOUTME: Fails if the strict shipping check for shared/ ever loads a test file, vitest
// ABOUTME: or Node's types, which would quietly hand shared code one runtime's globals.
//
// tsconfig.shared.json checks shared/ code with no runtime globals, so code used by both
// the browser and the worker can't lean on one side's API. Its exclude and `types: []`
// only control root discovery: an import can still pull a test file or vitest (and,
// through vite's own types, @types/node) back into the program, and then a shipping
// module using `process` or `console` type-checks with no error. This lists the files
// the program actually resolves and fails on any of those.
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

// Run TypeScript's own entry point with this Node rather than through npx, which
// on Windows is npx.cmd and needs a shell.
const tsc = createRequire(import.meta.url).resolve('typescript/bin/tsc');

const TEST_FILE = /\.(test|spec)\.[cm]?[jt]sx?$/;
const FORBIDDEN_PACKAGE = /[\\/]node_modules[\\/](vitest|@vitest|@types[\\/]node)[\\/]/;

let listed;
try {
  listed = execFileSync(process.execPath, [tsc, '-p', 'tsconfig.shared.json', '--listFilesOnly'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
  });
} catch (err) {
  console.error('check-shared-isolation: could not list tsconfig.shared.json files');
  throw err;
}

const offenders = listed
  .split('\n')
  .map((line) => line.trim())
  .filter((file) => file && (TEST_FILE.test(file) || FORBIDDEN_PACKAGE.test(file)));

if (offenders.length > 0) {
  console.error(
    'tsconfig.shared.json resolves files that give shared code test-only or Node types.\n' +
      'A shipping shared/ module must not import a test file or vitest:\n' +
      offenders
        .slice(0, 10)
        .map((file) => `  ${file}`)
        .join('\n') +
      (offenders.length > 10 ? `\n  ...and ${offenders.length - 10} more` : ''),
  );
  process.exit(1);
}
