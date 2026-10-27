// ABOUTME: Pins the two hex id checks the worker and ReportWatcher share: exactly 64
// ABOUTME: hex characters, strings only, and ReportWatcher's lowercase-only form.

import { describe, expect, it } from 'vitest';
import { isHex64, isLowerHex64 } from './hex';

const LOWER = '0123456789abcdef'.repeat(4);
const UPPER = '0123456789ABCDEF'.repeat(4);
const MIXED = '0123456789abcDEF'.repeat(4);

// [case, value, isHex64, isLowerHex64]
const CASES: Array<[string, unknown, boolean, boolean]> = [
  ['lowercase', LOWER, true, true],
  ['uppercase', UPPER, true, false],
  ['mixed case', MIXED, true, false],
  ['63 characters', LOWER.slice(1), false, false],
  ['65 characters', `${LOWER}a`, false, false],
  ['a junk prefix', `x${LOWER}`, false, false],
  ['a junk suffix', `${LOWER}x`, false, false],
  ['a trailing newline', `${LOWER}\n`, false, false],
  ['a leading space', ` ${LOWER}`, false, false],
  // Lookalikes outside ASCII: a fullwidth "a" and the Kelvin sign.
  ['a fullwidth letter', `${LOWER.slice(1)}ａ`, false, false],
  ['a Kelvin sign', `${LOWER.slice(1)}K`, false, false],
  ["the worker's auto marker", 'auto', false, false],
  ['an empty string', '', false, false],
  // RegExp.test would coerce these to a valid id.
  ['an array holding a valid id', [LOWER], false, false],
  ['an object that stringifies to a valid id', { toString: () => LOWER }, false, false],
  ['a String object', new String(LOWER), false, false],
  ['null', null, false, false],
  ['undefined', undefined, false, false],
  ['a number', 1234, false, false],
];

describe('isHex64 and isLowerHex64', () => {
  it.each(CASES)('judge %s', (_case, value, hex, lowerHex) => {
    expect(isHex64(value)).toBe(hex);
    expect(isLowerHex64(value)).toBe(lowerHex);
  });
});
