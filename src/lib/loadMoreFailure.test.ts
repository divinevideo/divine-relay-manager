// ABOUTME: Pins what counts as the failure a Load more left, as against a later re-read's failure.
// ABOUTME: Each half of the match (the error object, and its timestamp) has its own case.

import { describe, expect, it } from 'vitest';
import { isLoadMoreFailure, rememberLoadMoreFailure } from './loadMoreFailure';

describe('loadMoreFailure', () => {
  it('matches the failure that was remembered', () => {
    const error = new Error('page failed');
    rememberLoadMoreFailure(error, 1000);

    expect(isLoadMoreFailure(error, 1000)).toBe(true);
  });

  it('does not match the same error object from a later failed fetch', () => {
    const shared = new Error('network down');
    rememberLoadMoreFailure(shared, 1000);

    expect(isLoadMoreFailure(shared, 2000)).toBe(false);
  });

  it('does not match a different error stamped at the same time', () => {
    rememberLoadMoreFailure(new Error('page failed'), 1000);

    expect(isLoadMoreFailure(new Error('another query'), 1000)).toBe(false);
  });

  it('keeps one failure per error, so two queries do not displace each other', () => {
    const first = new Error('relay one');
    const second = new Error('relay two');
    rememberLoadMoreFailure(first, 1000);
    rememberLoadMoreFailure(second, 2000);

    expect(isLoadMoreFailure(first, 1000)).toBe(true);
    expect(isLoadMoreFailure(second, 2000)).toBe(true);
  });

  it('never takes a thrown primitive, or no error, for a leftover', () => {
    rememberLoadMoreFailure('boom', 1000);
    rememberLoadMoreFailure(null, 1000);
    rememberLoadMoreFailure(undefined, 1000);

    expect(isLoadMoreFailure('boom', 1000)).toBe(false);
    expect(isLoadMoreFailure(null, 1000)).toBe(false);
    expect(isLoadMoreFailure(undefined, 1000)).toBe(false);
  });
});
