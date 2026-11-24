// ABOUTME: Pins the ordering of the worker's relay-walk deadline and the browser's read bounds.
// ABOUTME: The worker must answer (data or 502) before the browser aborts, or a walk is abandoned mid-flight.

import { describe, it, expect } from 'vitest';
import { RELAY_WALK_DEADLINE_MS } from '../../shared/relay-pager';
import { RESOLUTION_LABEL_READ_TIMEOUT_MS } from '@/lib/constants';
import { API_TIMEOUT_MS } from '@/lib/adminApi';

// Headroom the worker needs after its walk: schema init before the walk, D1
// arrivals reads after it, and network time. Bare ordering is not enough: a
// deadline of 29s would still sit below a 30s bound and lose that race.
const MARGIN_MS = 3000;

describe('relay walk deadline vs browser bounds', () => {
  it('the worker walk deadline is below the browser label-read bound', () => {
    expect(RELAY_WALK_DEADLINE_MS).toBeLessThan(RESOLUTION_LABEL_READ_TIMEOUT_MS);
  });

  it('the worker walk deadline is below the feed API timeout', () => {
    expect(RELAY_WALK_DEADLINE_MS).toBeLessThan(API_TIMEOUT_MS);
  });

  it('keeps a margin under the browser label-read bound', () => {
    expect(RELAY_WALK_DEADLINE_MS + MARGIN_MS).toBeLessThanOrEqual(RESOLUTION_LABEL_READ_TIMEOUT_MS);
  });

  it('keeps a margin under the feed API timeout', () => {
    expect(RELAY_WALK_DEADLINE_MS + MARGIN_MS).toBeLessThanOrEqual(API_TIMEOUT_MS);
  });
});
