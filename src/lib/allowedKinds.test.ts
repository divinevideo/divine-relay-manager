import { describe, it, expect } from 'vitest';
import { normalizeAllowedKinds } from './allowedKinds';

describe('normalizeAllowedKinds', () => {
  it('passes through a bare number[] (the legacy relay contract)', () => {
    expect(normalizeAllowedKinds([0, 1, 7])).toEqual([0, 1, 7]);
  });

  it('extracts kind from funnelcake {kind, added_at} objects', () => {
    // This is the exact shape that crashed the Settings tab with React #31:
    // rendering the object as a React child throws "Objects are not valid as a
    // React child (found: object with keys {added_at, kind})".
    const raw = [
      { added_at: '2026-01-27T04:25:39.690Z', kind: 0 },
      { added_at: '2026-03-01T06:02:10.855Z', kind: 8 },
      { added_at: '2026-03-08T10:25:21.077Z', kind: 1059 },
    ];
    expect(normalizeAllowedKinds(raw)).toEqual([0, 8, 1059]);
  });

  it('handles a mixed array of numbers and objects', () => {
    expect(normalizeAllowedKinds([1, { kind: 7 }])).toEqual([1, 7]);
  });

  it('drops entries that carry no integer kind rather than crashing', () => {
    expect(
      normalizeAllowedKinds([
        { added_at: 'x' },
        'nope',
        null,
        { kind: 'no' },
        Number.NaN,
        Number.POSITIVE_INFINITY,
        1.5,
        { kind: 1.5 },
      ]),
    ).toEqual([]);
  });

  it('returns [] for null, undefined, or a non-array', () => {
    expect(normalizeAllowedKinds(null)).toEqual([]);
    expect(normalizeAllowedKinds(undefined)).toEqual([]);
    expect(normalizeAllowedKinds({})).toEqual([]);
  });
});
