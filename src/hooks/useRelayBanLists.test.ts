// ABOUTME: Pins what a relay list says about one target given how its read went.
// ABOUTME: Presence survives a failed refresh; absence does not.

import { beforeEach, describe, it, expect, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { listMembership, useBannedEvents } from './useRelayBanLists';

const listBannedEvents = vi.hoisted(() => vi.fn());
vi.mock('@/hooks/useAdminApi', () => ({
  useAdminApi: () => ({ listBannedEvents }),
}));

type Entry = { pubkey: string };
const TARGET = 'a'.repeat(64);
const OTHER = 'b'.repeat(64);
const isTarget = (e: Entry) => e.pubkey === TARGET;

describe('listMembership', () => {
  it('is unknown before the list has ever answered', () => {
    expect(listMembership<Entry>({ isError: false, data: undefined }, isTarget)).toBeNull();
    expect(listMembership<Entry>({ isError: true, data: undefined }, isTarget)).toBeNull();
  });

  it('is a confirmed negative only when the latest read succeeded', () => {
    expect(listMembership({ isError: false, data: [{ pubkey: OTHER }] }, isTarget)).toBe(false);
  });

  it('is unknown when the target is absent from a list whose refresh then failed', () => {
    // React Query keeps the last good list in `data` after a failed refetch.
    // Absence from that stale copy is not a confirmed negative.
    expect(listMembership({ isError: true, data: [{ pubkey: OTHER }] }, isTarget)).toBeNull();
  });

  it('is a positive when the target is present, whether or not the refresh failed', () => {
    expect(listMembership({ isError: false, data: [{ pubkey: TARGET }] }, isTarget)).toBe(true);
    expect(listMembership({ isError: true, data: [{ pubkey: TARGET }] }, isTarget)).toBe(true);
  });
});

// Every place a source file names one of the three shared keys, other than to
// refresh or drop the cache entry by key. Anything else -- a useQuery, a
// queryOptions, a setQueryData -- is a second definition or a second writer.
const SHARED_KEY = /queryKey:\s*\[\s*['"](banned-pubkeys|banned-events|suspended-pubkeys)['"]\s*\](?:\s*as\s+const)?/g;
const BY_KEY_CALL = /\b(?:invalidateQueries|refetchQueries|removeQueries|cancelQueries|resetQueries)\(\s*\{\s*$/;
// v5's setQueryData takes the key itself as its first argument, not an object,
// so it needs its own pattern.
const DIRECT_WRITE = /\bsetQueryData\s*(?:<[^>]*>)?\(\s*\[\s*['"](banned-pubkeys|banned-events|suspended-pubkeys)['"]/g;

function keyDefinitions(source: string): string[] {
  const found: string[] = [];
  for (const match of source.matchAll(SHARED_KEY)) {
    const before = source.slice(Math.max(0, match.index - 120), match.index);
    if (!BY_KEY_CALL.test(before)) found.push(match[1]);
  }
  for (const match of source.matchAll(DIRECT_WRITE)) found.push(match[1]);
  return found;
}

describe('the relay-list query keys', () => {
  // `banned-pubkeys`, `banned-events` and `suspended-pubkeys` are shared cache
  // entries, and the queryFn and options that run are those of whichever
  // observer triggers the fetch. A second definition is how the report pane
  // came to swallow errors into an empty list the queue then read as a success.
  // This keeps the next one from being written by hand.

  it('detects a definition in either property order, and ignores refreshes by key', () => {
    expect(keyDefinitions("useQuery({ queryKey: ['banned-events'], queryFn: f })")).toEqual(['banned-events']);
    expect(keyDefinitions("useQuery({ queryFn: f, queryKey: ['banned-events'] as const })")).toEqual(['banned-events']);
    expect(keyDefinitions("queryClient.setQueryData(['suspended-pubkeys'], [])")).toEqual(['suspended-pubkeys']);
    expect(keyDefinitions("queryClient.setQueryData<string[]>(['banned-pubkeys'], [])")).toEqual(['banned-pubkeys']);
    expect(keyDefinitions("queryClient.getQueryData(['banned-pubkeys'])")).toEqual([]);
    expect(keyDefinitions("queryClient.invalidateQueries({ queryKey: ['banned-pubkeys'] })")).toEqual([]);
    expect(keyDefinitions("queryClient.refetchQueries({\n  queryKey: ['banned-events'],\n})")).toEqual([]);
  });

  it('finds the three real definitions in useRelayBanLists', () => {
    // Positive control: if the detector stopped matching how definitions are
    // written, the next test would pass vacuously. This one would not.
    const source = readFileSync(join(process.cwd(), 'src', 'hooks', 'useRelayBanLists.ts'), 'utf8');
    expect(keyDefinitions(source).sort()).toEqual(['banned-events', 'banned-pubkeys', 'suspended-pubkeys']);
  });

  it('are defined nowhere else', () => {
    // import.meta.url is not a file: URL under the jsdom environment, so resolve
    // from the working directory, which is the repo root for every test run.
    const srcRoot = join(process.cwd(), 'src');
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) {
          walk(path);
        } else if (
          /\.tsx?$/.test(name)
          && !/\.test\.tsx?$/.test(name)
          && !path.endsWith(join('hooks', 'useRelayBanLists.ts'))
        ) {
          for (const key of keyDefinitions(readFileSync(path, 'utf8'))) {
            offenders.push(`${relative(srcRoot, path)}: ${key}`);
          }
        }
      }
    };
    walk(srcRoot);

    expect(offenders).toEqual([]);
  });
});

describe('useBannedEvents', () => {
  beforeEach(() => {
    listBannedEvents.mockReset();
  });

  function freshWrapper() {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    return ({ children }: { children: ReactNode }) =>
      createElement(QueryClientProvider, { client }, children);
  }

  // The reports queue passes both of these, and both are silent if dropped: the
  // queue would stop its 15s poll of the ban lists, or lose the fresh read it
  // asks for on a deep link. Nothing in the Reports tests would notice.
  it('polls when the caller passes a refetchInterval', async () => {
    listBannedEvents.mockResolvedValue([]);

    renderHook(() => useBannedEvents({ refetchInterval: 30 }), { wrapper: freshWrapper() });

    await waitFor(() => expect(listBannedEvents.mock.calls.length).toBeGreaterThanOrEqual(3), { timeout: 2000 });
  });

  it("honours the caller's staleTime when another observer mounts", async () => {
    listBannedEvents.mockResolvedValue([]);
    const wrapper = freshWrapper();

    const first = renderHook(() => useBannedEvents(), { wrapper });
    await waitFor(() => expect(first.result.current.isSuccess).toBe(true));

    // Control: a second observer on the default window reuses the cached list.
    renderHook(() => useBannedEvents(), { wrapper });
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(listBannedEvents).toHaveBeenCalledTimes(1);

    // One that treats cached data as immediately stale reads again on mount.
    renderHook(() => useBannedEvents({ staleTime: 0 }), { wrapper });
    await waitFor(() => expect(listBannedEvents).toHaveBeenCalledTimes(2));
  });

  // Relay stats, the events list and settings read nothing until a relay is
  // configured. They used to say so on their own query; the option now has to
  // survive the trip through the shared definition.
  it('does not read while the caller has not enabled it', async () => {
    listBannedEvents.mockResolvedValue([]);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const wrapper = ({ children }: { children: ReactNode }) =>
      createElement(QueryClientProvider, { client }, children);

    renderHook(() => useBannedEvents({ enabled: false }), { wrapper });
    await new Promise(resolve => setTimeout(resolve, 50));

    expect(listBannedEvents).not.toHaveBeenCalled();
  });
});
