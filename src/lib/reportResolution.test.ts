import { describe, it, expect } from 'vitest';
import { isConsolidatedReportResolved } from './reportResolution';

const AUTHOR = 'a'.repeat(64);
const EVENT = 'e'.repeat(64);
const banned = new Set([AUTHOR]);

describe('isConsolidatedReportResolved', () => {
  it('resolves an event report when its author is in the banned set', () => {
    const report = { target: { type: 'event' as const, value: EVENT }, authorPubkey: AUTHOR };
    expect(isConsolidatedReportResolved(report, new Set(), banned)).toBe(true);
  });

  it('does not resolve an event report whose author is not banned', () => {
    const report = { target: { type: 'event' as const, value: EVENT }, authorPubkey: 'c'.repeat(64) };
    expect(isConsolidatedReportResolved(report, new Set(), banned)).toBe(false);
  });

  it('does not cross-resolve when the event report has no known author', () => {
    const report = { target: { type: 'event' as const, value: EVENT }, authorPubkey: undefined };
    expect(isConsolidatedReportResolved(report, new Set(), banned)).toBe(false);
  });

  it('still resolves via an exact target-key match', () => {
    const report = { target: { type: 'event' as const, value: EVENT }, authorPubkey: undefined };
    expect(isConsolidatedReportResolved(report, new Set([`event:${EVENT}`]), new Set())).toBe(true);
  });

  it('does not cross-resolve a pubkey-target report by ban (that is the exact-key path)', () => {
    const report = { target: { type: 'pubkey' as const, value: AUTHOR }, authorPubkey: AUTHOR };
    // Cross-resolution is event-only; a pubkey target resolves solely via
    // resolvedTargets (which the caller populates from bans/decisions/labels).
    expect(isConsolidatedReportResolved(report, new Set(), banned)).toBe(false);
    expect(isConsolidatedReportResolved(report, new Set([`pubkey:${AUTHOR}`]), new Set())).toBe(true);
  });
});
