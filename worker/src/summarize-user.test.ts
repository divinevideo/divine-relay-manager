// ABOUTME: Tests the user-summary prompt line formatting (kind labeling, #156)
// ABOUTME: and model-output validation/clamping before caching + return (#169)

import { describe, it, expect } from 'vitest';
import { formatRecentPostLine, normalizeUserSummary } from './index';

describe('formatRecentPostLine', () => {
  it('labels kind-1111 comments', () => {
    expect(formatRecentPostLine({ content: 'scam text', kind: 1111 }))
      .toBe('- (comment) "scam text"');
  });

  it('labels kind-6 and kind-16 reposts', () => {
    expect(formatRecentPostLine({ content: 'boosted', kind: 16 }))
      .toBe('- (repost of another user\'s event) "boosted"');
    expect(formatRecentPostLine({ content: 'boosted', kind: 6 }))
      .toBe('- (repost of another user\'s event) "boosted"');
  });

  it('leaves other kinds and missing kind unlabeled (backward compatible)', () => {
    expect(formatRecentPostLine({ content: 'a note', kind: 1 })).toBe('- "a note"');
    expect(formatRecentPostLine({ content: 'a note' })).toBe('- "a note"');
  });

  it('truncates content to 200 chars', () => {
    const line = formatRecentPostLine({ content: 'x'.repeat(300), kind: 1 });
    expect(line).toBe(`- "${'x'.repeat(200)}"`);
  });
});

describe('normalizeUserSummary', () => {
  it('passes through a valid result for every enum risk level', () => {
    for (const riskLevel of ['low', 'medium', 'high', 'critical'] as const) {
      expect(normalizeUserSummary({ summary: 'looks fine', riskLevel }))
        .toEqual({ summary: 'looks fine', riskLevel });
    }
  });

  it('clamps an out-of-enum riskLevel to "unknown" while keeping the summary', () => {
    expect(normalizeUserSummary({ summary: 'ok', riskLevel: 'severe' }))
      .toEqual({ summary: 'ok', riskLevel: 'unknown' });
  });

  it('clamps a missing riskLevel to "unknown"', () => {
    expect(normalizeUserSummary({ summary: 'ok' }))
      .toEqual({ summary: 'ok', riskLevel: 'unknown' });
  });

  it('clamps a non-string riskLevel to "unknown"', () => {
    expect(normalizeUserSummary({ summary: 'ok', riskLevel: 3 }))
      .toEqual({ summary: 'ok', riskLevel: 'unknown' });
  });

  it('normalizes casing and surrounding whitespace on riskLevel', () => {
    expect(normalizeUserSummary({ summary: 'ok', riskLevel: '  HIGH ' }))
      .toEqual({ summary: 'ok', riskLevel: 'high' });
  });

  it('strips unexpected extra keys, returning only summary and riskLevel', () => {
    expect(normalizeUserSummary({ summary: 'ok', riskLevel: 'low', injected: 'ignore me' }))
      .toEqual({ summary: 'ok', riskLevel: 'low' });
  });

  it('rejects a missing summary as malformed', () => {
    expect(normalizeUserSummary({ riskLevel: 'low' })).toBeNull();
  });

  it('rejects a non-string summary as malformed', () => {
    expect(normalizeUserSummary({ summary: 42, riskLevel: 'low' })).toBeNull();
  });

  it('rejects an empty or whitespace-only summary as malformed', () => {
    expect(normalizeUserSummary({ summary: '', riskLevel: 'low' })).toBeNull();
    expect(normalizeUserSummary({ summary: '   ', riskLevel: 'low' })).toBeNull();
  });

  it('rejects non-object inputs as malformed', () => {
    expect(normalizeUserSummary(null)).toBeNull();
    expect(normalizeUserSummary('a string')).toBeNull();
    expect(normalizeUserSummary(42)).toBeNull();
    expect(normalizeUserSummary(['summary', 'low'])).toBeNull();
  });

  // The cache-read path serves an entry only if it survives re-normalization,
  // and only normalized values are ever cached. That is safe (never spuriously
  // regenerates a valid entry) precisely because normalize is idempotent — its
  // own output, including the clamped-'unknown' case, must pass back through
  // unchanged. This test locks that invariant against future schema changes.
  it('is idempotent: re-normalizing its own output is a no-op', () => {
    const inputs = [
      { summary: 'ok', riskLevel: 'critical' },
      { summary: 'ok', riskLevel: 'severe' },          // clamped to 'unknown'
      { summary: 'ok', riskLevel: 'unknown' },          // already out-of-band; stays 'unknown'
      { summary: 'ok', riskLevel: '  HIGH ' },          // normalized to 'high'
      { summary: 'ok', riskLevel: 3, injected: 'drop' }, // clamped + extra key stripped
    ];
    for (const input of inputs) {
      const once = normalizeUserSummary(input);
      expect(once).not.toBeNull();
      expect(normalizeUserSummary(once)).toEqual(once);
    }
  });
});
