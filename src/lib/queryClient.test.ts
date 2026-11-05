import { afterEach, describe, expect, it, vi } from 'vitest';
import { MutationObserver, onlineManager } from '@tanstack/react-query';
import { createQueryClient } from './queryClient';

// A moderation action reads its target from the screen when it runs. Queued
// offline, it would run on reconnect against whatever report is open by then,
// Delete Event and Delete Media included. Offline, an action must fail at once.
describe('createQueryClient', () => {
  afterEach(() => {
    onlineManager.setOnline(true);
  });

  it('runs a mutation while offline instead of holding it for reconnect', async () => {
    onlineManager.setOnline(false);
    const client = createQueryClient();
    const mutationFn = vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    });
    const observer = new MutationObserver(client, { mutationFn });

    await expect(observer.mutate()).rejects.toThrow('Failed to fetch');
    expect(mutationFn).toHaveBeenCalledTimes(1);
    expect(client.getMutationCache().getAll().some((m) => m.state.isPaused)).toBe(false);
  });

  it('keeps the query defaults the app had', () => {
    const queries = createQueryClient().getDefaultOptions().queries;

    expect(queries).toMatchObject({ refetchOnWindowFocus: true, staleTime: 60000, gcTime: Infinity });
  });
});
