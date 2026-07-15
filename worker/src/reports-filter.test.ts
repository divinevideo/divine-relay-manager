import { describe, expect, it } from 'vitest';
import { buildReportsFilter } from './reports-filter';

describe('buildReportsFilter', () => {
  it('defaults to the bulk 200 window when no target param', () => {
    expect(buildReportsFilter(new URLSearchParams(''))).toEqual({ kinds: [1984], limit: 200 });
  });
  it('scopes to #e when an event param is present', () => {
    expect(buildReportsFilter(new URLSearchParams('event=abc'))).toEqual({ kinds: [1984], '#e': ['abc'] });
  });
  it('scopes to #p when a pubkey param is present', () => {
    expect(buildReportsFilter(new URLSearchParams('pubkey=def'))).toEqual({ kinds: [1984], '#p': ['def'] });
  });
  it('prefers event over pubkey when both are present', () => {
    expect(buildReportsFilter(new URLSearchParams('event=abc&pubkey=def'))).toEqual({ kinds: [1984], '#e': ['abc'] });
  });
});
