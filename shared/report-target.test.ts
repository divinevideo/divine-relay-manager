import { describe, it, expect } from 'vitest';
import { getReportTarget, reportTargetKey } from './report-target';

const E = 'e'.repeat(64);
const P = 'p'.repeat(64);

describe('getReportTarget', () => {
  it('prefers the first e tag over any p tag', () => {
    expect(getReportTarget({ tags: [['p', P], ['e', E]] })).toEqual({ type: 'event', value: E });
  });

  it('falls back to the first p tag when there is no e tag', () => {
    expect(getReportTarget({ tags: [['p', P], ['p', 'x'.repeat(64)]] })).toEqual({ type: 'pubkey', value: P });
  });

  it('is null when the report names neither', () => {
    expect(getReportTarget({ tags: [['x', 'abc']] })).toBeNull();
  });

  it('keeps a valueless e tag as an event target, exactly as the client copies do', () => {
    // Presence-based on purpose: returning null would drop malformed reports
    // from the queue entirely. Changing that is TODO(#160), not this change.
    expect(getReportTarget({ tags: [['e'], ['p', P]] })).toEqual({ type: 'event', value: undefined });
  });

  it('treats a relay payload with no tags array as naming nothing', () => {
    expect(getReportTarget({})).toBeNull();
    expect(getReportTarget({ tags: 'nope' })).toBeNull();
  });
});

describe('reportTargetKey', () => {
  it('joins type and value without normalizing case', () => {
    expect(reportTargetKey({ type: 'pubkey', value: 'AbC' })).toBe('pubkey:AbC');
  });
});
