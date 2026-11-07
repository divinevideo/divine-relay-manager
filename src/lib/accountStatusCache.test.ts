// ABOUTME: Pins the account-status cache key and the single-account refresh that
// ABOUTME: age review and the report view both use after an action.
import { QueryClient } from '@tanstack/react-query';
import { describe, expect, it } from 'vitest';
import { accountStatusKey, invalidateAccountStatus } from './accountStatusCache';

const API = 'https://api.example';
const SUBJECT = 'ab'.repeat(32);
const OTHER = 'cd'.repeat(32);

function cached() {
  const client = new QueryClient();
  client.setQueryData(accountStatusKey(API, SUBJECT), { success: true, status: 'active' });
  client.setQueryData(accountStatusKey(API, OTHER), { success: true, status: 'active' });
  const isInvalidated = (pubkey: string) => client.getQueryState(accountStatusKey(API, pubkey))!.isInvalidated;
  return { client, isInvalidated };
}

describe('accountStatusCache', () => {
  it('keys an account by its lowercased pubkey, so both views share one entry', () => {
    expect(accountStatusKey(API, SUBJECT.toUpperCase())).toEqual(['account-status', API, SUBJECT]);
  });

  it('refreshes only the acted-on account', async () => {
    const { client, isInvalidated } = cached();
    await invalidateAccountStatus(client, SUBJECT);
    expect(isInvalidated(SUBJECT)).toBe(true);
    expect(isInvalidated(OTHER)).toBe(false);
  });

  // A report's p tag can be uppercase; the cached entry is always lowercase.
  it('refreshes the entry for an uppercase pubkey', async () => {
    const { client, isInvalidated } = cached();
    await invalidateAccountStatus(client, SUBJECT.toUpperCase());
    expect(isInvalidated(SUBJECT)).toBe(true);
  });

});
