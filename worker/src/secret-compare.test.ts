// ABOUTME: Tests secretsMatch, the constant-time comparison for shared secrets
// ABOUTME: (admin API keys, service bearer tokens). Pins behaviour; timing isn't unit-testable.

import { describe, it, expect } from 'vitest';
import { secretsMatch } from './secret-compare';

describe('secretsMatch', () => {
  it('matches an identical secret', () => {
    expect(secretsMatch('admin-key-123', 'admin-key-123')).toBe(true);
  });

  it('matches identical non-ASCII secrets', () => {
    expect(secretsMatch('clé-🔑', 'clé-🔑')).toBe(true);
  });

  it.each([
    ['the last character', 'admin-key-124'],
    ['the first character', 'bdmin-key-123'],
    ['case', 'ADMIN-KEY-123'],
  ])('refuses a same-length secret that differs in %s', (_label, supplied) => {
    expect(secretsMatch(supplied, 'admin-key-123')).toBe(false);
  });

  it.each([
    ['a prefix of the secret', 'admin-key-12'],
    ['the secret plus extra', 'admin-key-1234'],
    ['the secret plus a trailing space', 'admin-key-123 '],
    // Every byte lines up with the secret as the comparison wraps around it.
    ['the secret repeated', 'admin-key-123admin-key-123'],
  ])('refuses %s', (_label, supplied) => {
    expect(secretsMatch(supplied, 'admin-key-123')).toBe(false);
  });

  it('refuses an empty supplied value', () => {
    expect(secretsMatch('', 'admin-key-123')).toBe(false);
  });

  it('never matches an empty expected secret, even against an empty value', () => {
    // An unset secret resolved to '' must not authorize a request that sends ''.
    expect(secretsMatch('', '')).toBe(false);
    expect(secretsMatch('anything', '')).toBe(false);
  });

  it.each([
    // An unresolved Secrets Store binding stringifies to '[object Object]'.
    ['a Secrets Store binding', '[object Object]', { get: async () => 'admin-key-123' }],
    ['null', 'null', null],
    ['undefined', 'undefined', undefined],
  ])('never matches when the expected secret is %s rather than a string', (_label, supplied, expected) => {
    expect(secretsMatch(supplied, expected as unknown as string)).toBe(false);
  });

  it('never matches when the supplied value is not a string', () => {
    expect(secretsMatch(null as unknown as string, 'null')).toBe(false);
  });
});
