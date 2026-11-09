import { describe, it, expect } from 'vitest';
import { canonicalHex64, hexTagFilterValues } from './hex-id';

const LOWER = 'ab'.repeat(32);

describe('canonicalHex64', () => {
  it('lowercases a 64-character hex id written in any case', () => {
    expect(canonicalHex64(LOWER.toUpperCase())).toBe(LOWER);
    expect(canonicalHex64('Ab'.repeat(32))).toBe(LOWER);
    expect(canonicalHex64(LOWER)).toBe(LOWER);
  });

  it('is null for anything that is not a 64-character hex id', () => {
    expect(canonicalHex64(LOWER.slice(1))).toBeNull();
    expect(canonicalHex64(`${LOWER}0`)).toBeNull();
    expect(canonicalHex64('zz'.repeat(32))).toBeNull();
    expect(canonicalHex64(` ${LOWER.slice(1)}`)).toBeNull();
    expect(canonicalHex64('')).toBeNull();
    expect(canonicalHex64(undefined)).toBeNull();
    expect(canonicalHex64([LOWER])).toBeNull();
  });
});

describe('hexTagFilterValues', () => {
  it('asks for the lowercase and the all-uppercase spelling of a hex id, however it is written', () => {
    const UPPER = LOWER.toUpperCase();
    expect(hexTagFilterValues(LOWER)).toEqual([LOWER, UPPER]);
    expect(hexTagFilterValues(UPPER)).toEqual([LOWER, UPPER]);
    expect(hexTagFilterValues('Ab'.repeat(32))).toEqual([LOWER, UPPER]);
  });

  it('asks for an id with no letters once, since it has one spelling', () => {
    expect(hexTagFilterValues('1'.repeat(64))).toEqual(['1'.repeat(64)]);
  });

  it('asks for any other value as written, once, as getReportTarget keys it', () => {
    expect(hexTagFilterValues('NOT-HEX')).toEqual(['NOT-HEX']);
    expect(hexTagFilterValues(LOWER.slice(1).toUpperCase())).toEqual([LOWER.slice(1).toUpperCase()]);
  });
});
