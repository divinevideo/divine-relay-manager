// A script under scripts/ must not fall back to a deployed endpoint when its
// environment variable is unset.
//
// This is not hygiene. seed-test-events.ts publishes fabricated profiles,
// videos and kind 1984 reports, and it read
// `process.env.RELAY_URL || 'wss://relay.divine.video'`. Running it without
// setting RELAY_URL — the documented usage at the top of the file said exactly
// that — injected fake content and fake reports into the live moderation
// queue. wrangler.local.toml had the same shape and the same consequence
// (see worker/test/local-config-targets-local-stack.test.ts).
//
// The check is deliberately inverted, like the worker one: rather than listing
// the scripts that must be safe, it finds every hardcoded endpoint that a
// script would silently adopt and requires each to be local or explicitly
// excused. A script added later fails this test until someone decides which it
// is, instead of inheriting a production default unnoticed.
//
// Two shapes are covered, because both make an unset environment reach a
// deployed host with no action from the operator:
//
//   const X_URL = process.env.X_URL || 'wss://relay.divine.video';
//   const X_URL = 'wss://relay.divine.video';
//
// A default carried on a command-line flag is not covered. bulk-delete-videos.mjs
// defaults --relay to production because deleting production events is its
// purpose; it names no target of its own and cannot run without --pubkeys. The
// hazard here is specifically the run that looks local and is not.
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const SCRIPTS_DIR = dirname(fileURLToPath(import.meta.url));

/**
 * Hardcoded endpoints that are deliberately not local. Each needs a reason,
 * because the point is that adding to this list is a decision rather than a
 * default.
 */
const EXCUSED: Record<string, string> = {};

const LOCAL_HOST_RE =
  /^(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]|::1|[A-Za-z0-9-]+\.localhost)$/;

// `process.env.NAME || 'url'` and the `??` spelling. Quoted literals only: the
// scripts build media URLs with template literals (`https://blossom…/${hash}`)
// and those are event content, not an endpoint this process talks to.
const ENV_FALLBACK_RE =
  /process\.env\.([A-Za-z_$][\w$]*)\s*(?:\|\||\?\?)\s*(['"])([^'"]*)\2/g;

// `const SOMETHING_URL = 'url'` with no env read at all — the same hazard with
// the environment variable removed rather than defaulted.
const BARE_URL_CONST_RE =
  /\bconst\s+([A-Za-z_$][\w$]*(?:URL|Url|url))\s*=\s*(['"])([^'"]*)\2/g;

const URL_SCHEME_RE = /^(wss?|https?):\/\//i;

type Finding = { file: string; line: number; name: string; value: string };

function lineOf(source: string, index: number): number {
  return source.slice(0, index).split('\n').length;
}

function findingsIn(file: string, source: string): Finding[] {
  const found: Finding[] = [];
  for (const re of [ENV_FALLBACK_RE, BARE_URL_CONST_RE]) {
    re.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = re.exec(source)) !== null) {
      const [, name, , value] = match;
      if (!URL_SCHEME_RE.test(value)) continue;
      found.push({ file, line: lineOf(source, match.index), name, value });
    }
  }
  return found;
}

function isLocal(value: string): boolean {
  try {
    return LOCAL_HOST_RE.test(new URL(value).hostname);
  } catch {
    return false;
  }
}

const scriptFiles = readdirSync(SCRIPTS_DIR)
  .filter((f) => /\.(ts|mjs|js)$/.test(f) && !f.endsWith('.test.ts'))
  .sort();

describe('scripts do not default to deployed endpoints', () => {
  it('finds the scripts it is meant to guard', () => {
    expect(scriptFiles).toContain('seed-test-events.ts');
    expect(scriptFiles.length).toBeGreaterThan(5);
  });

  it.each(scriptFiles)('%s', (file) => {
    const source = readFileSync(join(SCRIPTS_DIR, file), 'utf-8');
    const offenders = findingsIn(file, source)
      .filter((f) => !isLocal(f.value))
      .filter((f) => !(f.value in EXCUSED))
      .map((f) => `${f.file}:${f.line} ${f.name} = ${f.value}`);

    expect(
      offenders,
      `A script must not silently adopt a deployed endpoint. Either point the ` +
        `default at the local stack, require the variable and exit when it is ` +
        `unset (see seed-test-events.ts), or add the value to EXCUSED in this ` +
        `file with a reason.`,
    ).toEqual([]);
  });

  it('rejects a production default', () => {
    const offenders = findingsIn(
      'fake.ts',
      "const RELAY_URL = process.env.RELAY_URL || 'wss://relay.divine.video';",
    );
    expect(offenders.map((f) => f.value)).toEqual(['wss://relay.divine.video']);
  });

  it('rejects a production endpoint with no environment variable at all', () => {
    const offenders = findingsIn(
      'fake.ts',
      "const WORKER_URL = 'https://api-relay-prod.divine.video';",
    );
    expect(offenders.map((f) => f.value)).toEqual([
      'https://api-relay-prod.divine.video',
    ]);
  });

  it('accepts a local default', () => {
    const offenders = findingsIn(
      'fake.ts',
      "const RELAY_URL = process.env.RELAY_URL || 'ws://127.0.0.1:4444';",
    ).filter((f) => !isLocal(f.value));
    expect(offenders).toEqual([]);
  });

  it('ignores a media URL built as a template literal', () => {
    const offenders = findingsIn(
      'fake.ts',
      'const videoUrl = `https://blossom.divine.video/${mediaHash}.mp4`;',
    );
    expect(offenders).toEqual([]);
  });
});
