import { describe, it, expect } from 'vitest';
import { getReportTarget, getWrittenReportTarget, reportTargetKey } from './report-target';

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

  it('lowercases a 64-character hex value, so a report written in uppercase names the same target', () => {
    const id = 'ab'.repeat(32);
    expect(getReportTarget({ tags: [['e', id.toUpperCase()]] })).toEqual({ type: 'event', value: id });
    expect(getReportTarget({ tags: [['p', id.toUpperCase()]] })).toEqual({ type: 'pubkey', value: id });
  });

  it('leaves any other value as written', () => {
    // A malformed report stays visible under its own value (TODO(#160)).
    expect(getReportTarget({ tags: [['e', 'NOT-HEX']] })).toEqual({ type: 'event', value: 'NOT-HEX' });
    expect(getReportTarget({ tags: [['p', 'AB'.repeat(31)]] })).toEqual({ type: 'pubkey', value: 'AB'.repeat(31) });
  });

  it('treats a relay payload with no tags array as naming nothing', () => {
    expect(getReportTarget({})).toBeNull();
    expect(getReportTarget({ tags: 'nope' })).toBeNull();
  });
});

describe('getWrittenReportTarget', () => {
  it('keeps the value exactly as the tag spells it, picking the same tag as getReportTarget', () => {
    const upper = 'AB'.repeat(32);
    expect(getWrittenReportTarget({ tags: [['p', P], ['e', upper]] })).toEqual({ type: 'event', value: upper });
    expect(getWrittenReportTarget({ tags: [['p', upper]] })).toEqual({ type: 'pubkey', value: upper });
    expect(getWrittenReportTarget({ tags: [['x', 'abc']] })).toBeNull();
  });
});

describe('reportTargetKey', () => {
  it('joins type and value without normalizing case', () => {
    expect(reportTargetKey({ type: 'pubkey', value: 'AbC' })).toBe('pubkey:AbC');
  });
});
