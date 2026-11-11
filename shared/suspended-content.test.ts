import { describe, expect, it } from 'vitest';
import {
  SUSPENDED_PAGE_DEFAULT,
  SUSPENDED_PAGE_MAX,
  parseSuspendedAccountRequest,
  parseSuspendedEventRequest,
} from './suspended-content';

const ID = 'ab'.repeat(32);
const PK = 'cd'.repeat(32);

describe('parseSuspendedEventRequest', () => {
  it('accepts an event id and a viewer surface, lowercasing the id', () => {
    expect(parseSuspendedEventRequest({ eventId: ID.toUpperCase(), surface: 'report' }))
      .toEqual({ eventId: ID, surface: 'report' });
    expect(parseSuspendedEventRequest({ eventId: ID, surface: 'user' })).toEqual({ eventId: ID, surface: 'user' });
    expect(parseSuspendedEventRequest({ eventId: ID, surface: 'age-review' })).toEqual({ eventId: ID, surface: 'age-review' });
  });

  it.each([
    ['a non-object body', 'x'],
    ['null', null],
    ['an array', [ID]],
    ['a missing event id', { surface: 'report' }],
    ['a short event id', { eventId: ID.slice(1), surface: 'report' }],
    ['a non-hex event id', { eventId: 'g'.repeat(64), surface: 'report' }],
    ['a missing surface', { eventId: ID }],
    ['an unknown surface', { eventId: ID, surface: 'elsewhere' }],
    ['the quarantine surface, which only the worker writes', { eventId: ID, surface: 'sexual-quarantine' }],
  ])('refuses %s', (_name, body) => {
    expect(parseSuspendedEventRequest(body)).toHaveProperty('error');
  });
});

describe('parseSuspendedAccountRequest', () => {
  it('accepts the minimum, leaving the optional fields out', () => {
    expect(parseSuspendedAccountRequest({ pubkey: PK.toUpperCase(), surface: 'user' }))
      .toEqual({ pubkey: PK, surface: 'user' });
  });

  it('accepts every optional field, lowercasing untilId', () => {
    expect(parseSuspendedAccountRequest({
      pubkey: PK, surface: 'report', until: 1_700_000_000, untilId: ID.toUpperCase(), kinds: [1, 34236], limit: 25,
    })).toEqual({ pubkey: PK, surface: 'report', until: 1_700_000_000, untilId: ID, kinds: [1, 34236], limit: 25 });
  });

  it('accepts the bounds', () => {
    expect(parseSuspendedAccountRequest({ pubkey: PK, surface: 'user', until: 0, limit: 1 })).not.toHaveProperty('error');
    expect(parseSuspendedAccountRequest({
      pubkey: PK, surface: 'user', until: 4294967295, limit: SUSPENDED_PAGE_MAX,
      kinds: Array.from({ length: 64 }, (_, i) => i === 0 ? 65535 : i),
    })).not.toHaveProperty('error');
  });

  it.each([
    ['a non-object body', 7],
    ['a bad pubkey', { pubkey: 'x', surface: 'user' }],
    ['an unknown surface', { pubkey: PK, surface: 'nope' }],
    ['the quarantine surface', { pubkey: PK, surface: 'sexual-quarantine' }],
    ['untilId without until', { pubkey: PK, surface: 'user', untilId: ID }],
    ['a non-hex untilId', { pubkey: PK, surface: 'user', until: 1, untilId: 'z' }],
    ['a negative until', { pubkey: PK, surface: 'user', until: -1 }],
    ['an until past u32', { pubkey: PK, surface: 'user', until: 4294967296 }],
    ['a fractional until', { pubkey: PK, surface: 'user', until: 1.5 }],
    ['a string until', { pubkey: PK, surface: 'user', until: '1' }],
    ['empty kinds', { pubkey: PK, surface: 'user', kinds: [] }],
    ['65 kinds', { pubkey: PK, surface: 'user', kinds: Array.from({ length: 65 }, (_, i) => i) }],
    ['a kind past 65535', { pubkey: PK, surface: 'user', kinds: [65536] }],
    ['a negative kind', { pubkey: PK, surface: 'user', kinds: [-1] }],
    ['a non-array kinds', { pubkey: PK, surface: 'user', kinds: 1 }],
    ['limit 0', { pubkey: PK, surface: 'user', limit: 0 }],
    ['a limit past the max', { pubkey: PK, surface: 'user', limit: SUSPENDED_PAGE_MAX + 1 }],
    ['a fractional limit', { pubkey: PK, surface: 'user', limit: 2.5 }],
  ])('refuses %s', (_name, body) => {
    expect(parseSuspendedAccountRequest(body)).toHaveProperty('error');
  });

  it('pages at 50 by default, at most 100', () => {
    expect(SUSPENDED_PAGE_DEFAULT).toBe(50);
    expect(SUSPENDED_PAGE_MAX).toBe(100);
  });
});
