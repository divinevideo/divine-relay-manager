import { describe, it, expect } from 'vitest';
import { reportsMode, REPORT_KIND } from './reports-filter';

const params = (q: string) => new URLSearchParams(q);

describe('reportsMode', () => {
  it('keeps the legacy bulk filter byte-for-byte when no mode is asked for', () => {
    // Rollback and deploy-gap safety: an old frontend gets exactly today's read.
    expect(reportsMode(params(''))).toEqual({ kind: 'legacy-bulk', filter: { kinds: [REPORT_KIND], limit: 200 } });
  });

  it('opts into the needs-attention mode only with needs_attention=1', () => {
    expect(reportsMode(params('needs_attention=1'))).toEqual({ kind: 'needs-attention' });
    expect(reportsMode(params('needs_attention=true')).kind).toBe('legacy-bulk');
  });

  it('builds an unlimited lookup for one event, lowercased', () => {
    expect(reportsMode(params(`event=${'AB'.repeat(32)}`))).toEqual({
      kind: 'target',
      filter: { kinds: [REPORT_KIND], '#e': ['ab'.repeat(32)] },
    });
  });

  it('builds an unlimited lookup for one pubkey, lowercased', () => {
    expect(reportsMode(params(`pubkey=${'CD'.repeat(32)}`))).toEqual({
      kind: 'target',
      filter: { kinds: [REPORT_KIND], '#p': ['cd'.repeat(32)] },
    });
  });

  it('never filters a targeted lookup, even when needs_attention is also sent', () => {
    // A deep link to a resolved report must still find it.
    expect(reportsMode(params(`event=${'a'.repeat(64)}&needs_attention=1`)).kind).toBe('target');
  });

  it('prefers event over pubkey when both are present', () => {
    expect(reportsMode(params(`event=${'a'.repeat(64)}&pubkey=${'b'.repeat(64)}`))).toEqual({
      kind: 'target',
      filter: { kinds: [REPORT_KIND], '#e': ['a'.repeat(64)] },
    });
  });
});
