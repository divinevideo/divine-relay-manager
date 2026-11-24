// ABOUTME: Tests for the shared relay profile fetch used to capture account identity.
// ABOUTME: Mocks the WebSocket rather than the module, so the real queryRelay is exercised.

import { describe, it, expect, vi, afterEach } from 'vitest';
import { fetchAccountIdentity, queryRelay, relayPageFetcher, RELAY_WALK_PAGE_TIMEOUT_MS, RELAY_WALK_DEADLINE_MS, RELAY_WALK_MIN_PAGE_MS } from './relay-profile';

/**
 * Mirrors mockRelay in bulk-moderate.test.ts. We stub the socket, not the module:
 * fetchAccountIdentity calls queryRelay inside the same module, so spying on the
 * module export would never intercept the call and the test would pass for the
 * wrong reason.
 */
function mockRelay(events: Array<Record<string, unknown>>) {
  vi.spyOn(globalThis, 'WebSocket').mockImplementation((function () {
    const listeners = new Map<string, Array<(value?: unknown) => void>>();
    let subId = 'identity-test';

    queueMicrotask(() => {
      listeners.get('open')?.forEach((h) => h());
      for (const event of events) {
        listeners.get('message')?.forEach((h) => h({ data: JSON.stringify(['EVENT', subId, event]) }));
      }
      listeners.get('message')?.forEach((h) => h({ data: JSON.stringify(['EOSE', subId]) }));
    });

    return {
      addEventListener: (e: string, h: (value?: unknown) => void) => {
        listeners.set(e, [...(listeners.get(e) || []), h]);
      },
      send: vi.fn((payload: string) => {
        const parsed = JSON.parse(payload);
        if (parsed[0] === 'REQ') subId = parsed[1];
      }),
      close: vi.fn(),
    };
  } as unknown as typeof WebSocket));
}

afterEach(() => {
  vi.restoreAllMocks();
});

// The backfill treats a null identity_captured_at as "never looked". A caller
// that cannot tell a completed-but-empty lookup from a failed one will stamp
// the timestamp either way, and a case whose relay lookup merely timed out is
// then excluded from recovery permanently -- while the account's profile is
// about to be hidden by enforcement. So the failure has to be distinguishable.
describe('fetchAccountIdentity lookup outcome', () => {
  it('reports a completed lookup when the account has no kind-0', async () => {
    mockRelay([]);
    const res = await fetchAccountIdentity('abc123', 'wss://relay.test');
    expect(res.completed).toBe(true);
    expect(res.profile).toBeNull();
  });

  it('reports a completed lookup when a profile is found', async () => {
    mockRelay([{
      id: 'e1', kind: 0, pubkey: 'abc123', tags: [],
      content: JSON.stringify({ display_name: 'Some One' }),
    }]);
    const res = await fetchAccountIdentity('abc123', 'wss://relay.test');
    expect(res.completed).toBe(true);
    expect(res.profile?.name).toBe('Some One');
  });

  // queryRelay resolves { success: false, events } when the socket closes or
  // times out before EOSE (the #186 contract; fetchAccountIdentity reads
  // `complete ?? success`, so it lands on false either way). Only EOSE proves
  // the relay had nothing; an unconfirmed absence must not count as a completed
  // lookup, or a dropped connection excludes the case from backfill exactly as
  // a hard error would have.
  it('reports an incomplete lookup when the relay closed before EOSE', async () => {
    vi.spyOn(globalThis, 'WebSocket').mockImplementation((function () {
      const listeners = new Map<string, Array<(value?: unknown) => void>>();
      queueMicrotask(() => {
        listeners.get('open')?.forEach((h) => h());
        // Drops without ever sending EOSE.
        listeners.get('close')?.forEach((h) => h());
      });
      return {
        addEventListener: (e: string, h: (value?: unknown) => void) => {
          listeners.set(e, [...(listeners.get(e) || []), h]);
        },
        send: vi.fn(),
        close: vi.fn(),
      };
    } as unknown as typeof WebSocket));

    const res = await fetchAccountIdentity('abc123', 'wss://relay.test');

    expect(res.completed).toBe(false);
    expect(res.profile).toBeNull();
  });

  // The mirror of the case above: the socket still dies before EOSE, but this
  // time the kind-0 already arrived. An event in hand is a confirmed answer --
  // discarding it would leave identity_captured_at null and let enforcement hide
  // the profile before any backfill could look again. This pins presence over
  // absence, which is the property that has to survive the rebase onto #186:
  // there, an early close reports success: false while still carrying the
  // events it received, so a success-first check would throw this profile away.
  it('captures a profile that arrived before the relay closed without EOSE', async () => {
    vi.spyOn(globalThis, 'WebSocket').mockImplementation((function () {
      const listeners = new Map<string, Array<(value?: unknown) => void>>();
      let subId = 'identity-test';
      queueMicrotask(() => {
        listeners.get('open')?.forEach((h) => h());
        listeners.get('message')?.forEach((h) => h({
          data: JSON.stringify(['EVENT', subId, {
            id: 'e6', kind: 0, pubkey: 'abc123', tags: [],
            content: JSON.stringify({ display_name: 'Arrived First' }),
          }]),
        }));
        // Drops without ever sending EOSE.
        listeners.get('close')?.forEach((h) => h());
      });
      return {
        addEventListener: (e: string, h: (value?: unknown) => void) => {
          listeners.set(e, [...(listeners.get(e) || []), h]);
        },
        send: vi.fn((payload: string) => {
          const parsed = JSON.parse(payload);
          if (parsed[0] === 'REQ') subId = parsed[1];
        }),
        close: vi.fn(),
      };
    } as unknown as typeof WebSocket));

    const res = await fetchAccountIdentity('abc123', 'wss://relay.test');

    expect(res.completed).toBe(true);
    expect(res.profile?.name).toBe('Arrived First');
  });

  it('reports an incomplete lookup when the socket cannot be opened', async () => {
    vi.spyOn(globalThis, 'WebSocket').mockImplementation((() => {
      throw new Error('relay down');
    }) as unknown as typeof WebSocket);
    const res = await fetchAccountIdentity('abc123', 'wss://relay.test');
    expect(res.completed).toBe(false);
    expect(res.profile).toBeNull();
  });

  it('reports an incomplete lookup when no relay is configured', async () => {
    const res = await fetchAccountIdentity('abc123', undefined);
    expect(res.completed).toBe(false);
  });
});

describe('fetchAccountIdentity', () => {
  it('parses a kind-0 result into a profile', async () => {
    mockRelay([{
      id: 'e1',
      kind: 0,
      pubkey: 'abc123',
      tags: [],
      content: JSON.stringify({ display_name: 'Some One', nip05: 'x@y.z' }),
    }]);

    const { profile } = await fetchAccountIdentity('abc123', 'wss://relay.test');

    expect(profile?.name).toBe('Some One');
    expect(profile?.nip05).toBe('x@y.z');
  });

  it('surfaces a vine username for a restored OG account', async () => {
    mockRelay([{
      id: 'e2',
      kind: 0,
      pubkey: 'abc123',
      tags: [['client', 'vine-archive-importer'], ['vine_username', 'someuser']],
      content: JSON.stringify({}),
    }]);

    const { profile } = await fetchAccountIdentity('abc123', 'wss://relay.test');

    expect(profile?.isVineImport).toBe(true);
    expect(profile?.vineUsername).toBe('someuser');
  });

  // What comes back here is persisted, not rendered. sanitizeInline is a
  // display transform -- it strips markdown punctuation and truncates at 80
  // characters -- so applying it on the way in silently stores a handle the
  // account never used, and the whole premise is that the real one is about to
  // become unrecoverable. Both render paths sanitize on the way out.
  it('preserves the account name exactly as the profile carried it', async () => {
    const name = '*Star*Girl*';
    mockRelay([{
      id: 'e3', kind: 0, pubkey: 'abc123', tags: [],
      content: JSON.stringify({ display_name: name }),
    }]);

    const { profile } = await fetchAccountIdentity('abc123', 'wss://relay.test');

    expect(profile?.name).toBe(name);
  });

  it('does not truncate a long account name on the way into storage', async () => {
    const name = 'A'.repeat(120);
    mockRelay([{
      id: 'e4', kind: 0, pubkey: 'abc123', tags: [],
      content: JSON.stringify({ display_name: name }),
    }]);

    const { profile } = await fetchAccountIdentity('abc123', 'wss://relay.test');

    expect(profile?.name).toBe(name);
    expect(profile?.name).not.toContain('…');
  });

  // Every field here is bound into the INSERT that opens the case, and D1
  // rejects a non-string bind outright. A kind-0 whose display_name is an
  // object would therefore have thrown out of case creation -- letting the
  // reported account suppress its own age review by editing its own profile.
  it('yields only bindable values from a kind-0 with non-string fields', async () => {
    mockRelay([{
      id: 'e5', kind: 0, pubkey: 'abc123',
      tags: [['vine_username', ['nope']]],
      content: JSON.stringify({ display_name: { evil: 1 }, name: ['a'], nip05: 42 }),
    }]);

    const { completed, profile } = await fetchAccountIdentity('abc123', 'wss://relay.test');

    expect(completed).toBe(true);
    for (const value of [profile?.name, profile?.nip05, profile?.vineUsername]) {
      expect(value === undefined || typeof value === 'string').toBe(true);
    }
  });

  it('never throws, whatever the socket does', async () => {
    vi.spyOn(globalThis, 'WebSocket').mockImplementation((() => {
      throw new Error('relay down');
    }) as unknown as typeof WebSocket);

    await expect(fetchAccountIdentity('abc123', 'wss://relay.test')).resolves.toEqual({
      completed: false,
      profile: null,
    });
  });
});

/**
 * A socket the test drives frame by frame, so a frame can land after
 * queryRelay has already resolved. `emit` is live once the REQ is sent.
 */
function scriptedRelay() {
  const relay = {
    subId: '',
    emit: (_type: string, _value?: unknown) => {},
    message: (payload: unknown) => relay.emit('message', { data: JSON.stringify(payload) }),
    ready: null as unknown as Promise<void>,
  };
  let markReady!: () => void;
  relay.ready = new Promise<void>((r) => { markReady = r; });
  vi.spyOn(globalThis, 'WebSocket').mockImplementation((function () {
    const listeners = new Map<string, Array<(value?: unknown) => void>>();
    relay.emit = (type, value) => listeners.get(type)?.forEach((h) => h(value));
    queueMicrotask(() => relay.emit('open'));
    return {
      addEventListener: (e: string, h: (value?: unknown) => void) => {
        listeners.set(e, [...(listeners.get(e) || []), h]);
      },
      send: vi.fn((payload: string) => {
        const parsed = JSON.parse(payload);
        if (parsed[0] === 'REQ') { relay.subId = parsed[1]; markReady(); }
      }),
      close: vi.fn(),
    };
  } as unknown as typeof WebSocket));
  return relay;
}

const EVENT_A = { id: 'a'.repeat(64), kind: 1985 };
const LATE = { id: 'd'.repeat(64), kind: 1985 };

// The #186 contract: only EOSE makes a read complete, and every failure exit
// still hands back the events that arrived before it. Callers that act on a
// partial read (a profile captured before a drop) depend on those events. These
// were pinned through Reopen's label cleanup until #324 stopped it reading the
// relay, so they are pinned here, on queryRelay itself.
describe('queryRelay partial reads and late frames', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  // The success exit hands back the live `events` array, so the message
  // listener's resolved-guard is all that keeps a frame streamed after EOSE
  // (the worker never sends CLOSE) out of the caller's result.
  it('does not add a frame that arrives after EOSE to the result', async () => {
    const relay = scriptedRelay();
    const pending = queryRelay({ kinds: [1985] }, 'wss://relay.test');
    await relay.ready;
    relay.message(['EVENT', relay.subId, EVENT_A]);
    relay.message(['EOSE', relay.subId]);
    relay.message(['EVENT', relay.subId, LATE]);

    const res = await pending;
    expect(res).toMatchObject({ success: true, complete: true });
    expect(res.events).toEqual([EVENT_A]);
  });

  // A failure exit can be followed by a frame while the socket is closing. Two
  // things keep it out: the resolved-guard blocks the push, and every failure
  // exit returns `events.slice()`, a snapshot the push cannot reach. Either
  // alone suffices here, so this dies only to removing both; the after-EOSE
  // case above is the guard's sole pin.
  it('does not add a frame that arrives after the read failed to the result', async () => {
    const relay = scriptedRelay();
    const pending = queryRelay({ kinds: [1985] }, 'wss://relay.test');
    await relay.ready;
    relay.message(['EVENT', relay.subId, EVENT_A]);
    relay.emit('close');
    relay.message(['EVENT', relay.subId, LATE]);

    const res = await pending;
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/closed before EOSE/i);
    expect(res.events).toEqual([EVENT_A]);
  });

  it('hands back the events received before the read timed out', async () => {
    vi.useFakeTimers();
    const relay = scriptedRelay();
    const pending = queryRelay({ kinds: [1985] }, 'wss://relay.test');
    await vi.advanceTimersByTimeAsync(0);
    await relay.ready;
    relay.message(['EVENT', relay.subId, EVENT_A]);
    await vi.advanceTimersByTimeAsync(5000);

    const res = await pending;
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/timed out/i);
    expect(res.events).toEqual([EVENT_A]);
  });

  it('hands back the events received before the relay CLOSED the subscription', async () => {
    const relay = scriptedRelay();
    const pending = queryRelay({ kinds: [1985] }, 'wss://relay.test');
    await relay.ready;
    relay.message(['EVENT', relay.subId, EVENT_A]);
    relay.message(['CLOSED', relay.subId, 'error: could not complete query']);

    const res = await pending;
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/could not complete query/);
    expect(res.events).toEqual([EVENT_A]);
  });

  it('hands back the events received before the socket errored', async () => {
    const relay = scriptedRelay();
    const pending = queryRelay({ kinds: [1985] }, 'wss://relay.test');
    await relay.ready;
    relay.message(['EVENT', relay.subId, EVENT_A]);
    relay.emit('error');

    const res = await pending;
    expect(res.success).toBe(false);
    expect(res.error).toBe('WebSocket error');
    expect(res.events).toEqual([EVENT_A]);
  });
});

// The relay answers nothing until its whole query finishes, and keeps running it
// for up to 30s after we hang up, so a slow page is waited out once, never
// retried. Only the paged walks behind the queue get the longer bound.
describe('relay read patience', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  async function settle(ms: number) {
    await vi.advanceTimersByTimeAsync(ms);
  }

  it('keeps the 5000 ms default for a plain queryRelay call', async () => {
    vi.useFakeTimers();
    const relay = scriptedRelay();
    const pending = queryRelay({ kinds: [1985] }, 'wss://relay.test');
    await settle(0);
    await relay.ready;
    await settle(4999);
    relay.message(['EOSE', relay.subId]);
    expect((await pending).success).toBe(true);

    const relay2 = scriptedRelay();
    const pending2 = queryRelay({ kinds: [1985] }, 'wss://relay.test');
    await settle(0);
    await relay2.ready;
    await settle(5000);
    const res = await pending2;
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/timed out before EOSE/);
  });

  it('honours a per-call timeout override', async () => {
    vi.useFakeTimers();
    const relay = scriptedRelay();
    const pending = queryRelay({ kinds: [1985] }, 'wss://relay.test', { timeoutMs: 15000 });
    await settle(0);
    await relay.ready;
    await settle(6000);
    relay.message(['EVENT', relay.subId, EVENT_A]);
    relay.message(['EOSE', relay.subId]);
    const res = await pending;
    expect(res).toMatchObject({ success: true, complete: true });
    expect(res.events).toEqual([EVENT_A]);
  });

  it('a walked page that answers after 6s succeeds', async () => {
    vi.useFakeTimers();
    const relay = scriptedRelay();
    const pending = relayPageFetcher<object>('wss://relay.test', { kinds: [1984] }, 2000)(undefined);
    await settle(0);
    await relay.ready;
    await settle(6000);
    relay.message(['EVENT', relay.subId, EVENT_A]);
    relay.message(['EOSE', relay.subId]);
    expect(await pending).toEqual([EVENT_A]);
  });

  it('a walked page that never answers still fails at the walk bound, once', async () => {
    vi.useFakeTimers();
    const sockets = vi.spyOn(globalThis, 'WebSocket');
    const relay = scriptedRelay();
    const settled = relayPageFetcher<object>('wss://relay.test', { kinds: [1984] }, 2000)(undefined)
      .then(() => 'resolved', (e: Error) => e.message);
    await settle(0);
    await relay.ready;
    await settle(RELAY_WALK_PAGE_TIMEOUT_MS - 1);
    relay.message(['EVENT', relay.subId, EVENT_A]);
    await settle(1);
    expect(await settled).toMatch(/Relay query timed out before EOSE \(1 events received\)/);
    // No retry: the relay is asked exactly once, however long we waited.
    await settle(60_000);
    expect(sockets).toHaveBeenCalledTimes(1);
  });

  it('the walk bound is 15000 ms', () => {
    expect(RELAY_WALK_PAGE_TIMEOUT_MS).toBe(15000);
  });

  // A walk has a deadline under the browser's 30s abort, so the worker answers
  // (502) rather than starting relay queries nobody will read. The last page's
  // timeout is clamped to the time left.
  describe('walk deadline', () => {
    const PAGE = [{ id: 'p1', created_at: 100 }];

    it('is 25000 ms, under the 30s client bound', () => {
      expect(RELAY_WALK_DEADLINE_MS).toBe(25000);
    });

    it('two slow pages fail at the deadline and no third request is issued', async () => {
      vi.useFakeTimers();
      const sockets = vi.spyOn(globalThis, 'WebSocket');
      const fetchPage = relayPageFetcher<{ id: string; created_at: number }>('wss://relay.test', { kinds: [1984] }, 1);

      const relay1 = scriptedRelay();
      const first = fetchPage(undefined);
      await settle(0);
      await relay1.ready;
      await settle(14000);
      relay1.message(['EVENT', relay1.subId, PAGE[0]]);
      relay1.message(['EOSE', relay1.subId]);
      expect(await first).toEqual(PAGE);

      // 11s left: the second page is clamped from 15s to 11s.
      const relay2 = scriptedRelay();
      const second = fetchPage(100).then(() => 'resolved', (e: Error) => e.message);
      await settle(0);
      await relay2.ready;
      await settle(10999);
      let early = false;
      void second.then(() => { early = true; });
      await settle(0);
      expect(early).toBe(false);
      await settle(1);
      expect(await second).toMatch(/timed out before EOSE/);

      // Past the deadline a further page never reaches the relay.
      const calls = sockets.mock.calls.length;
      await expect(fetchPage(99)).rejects.toThrow(/timed out/);
      expect(sockets.mock.calls.length).toBe(calls);
    });

    // Minimum relay load: a page given almost no time would start a query the
    // worker cannot wait for, which the relay then runs to completion anyway.
    describe('walk floor', () => {
      it('is 3000 ms', () => {
        expect(RELAY_WALK_MIN_PAGE_MS).toBe(3000);
      });

      // Spends the walk's first two pages (14s, then `secondAt`) so that
      // 25000 - 14000 - secondAt is what is left for the third.
      async function spendTo(fetchPage: (until: number | undefined) => Promise<unknown>, secondAt: number) {
        for (const [at, until] of [[14000, undefined], [secondAt, 100]] as const) {
          const relay = scriptedRelay();
          const p = fetchPage(until);
          await settle(0);
          await relay.ready;
          await settle(at);
          relay.message(['EVENT', relay.subId, PAGE[0]]);
          relay.message(['EOSE', relay.subId]);
          await p;
        }
      }

      it('opens no socket when under 3000 ms are left (2.9s)', async () => {
        vi.useFakeTimers();
        const sockets = vi.spyOn(globalThis, 'WebSocket');
        const fetchPage = relayPageFetcher<{ id: string; created_at: number }>('wss://relay.test', { kinds: [1984] }, 1);
        await spendTo(fetchPage, 8100);
        const opened = sockets.mock.calls.length;
        await expect(fetchPage(99)).rejects.toThrow(/timed out before EOSE/);
        expect(sockets.mock.calls.length).toBe(opened);
      });

      it('sends a request clamped to the time left when 3100 ms are left', async () => {
        vi.useFakeTimers();
        const fetchPage = relayPageFetcher<{ id: string; created_at: number }>('wss://relay.test', { kinds: [1984] }, 1);
        await spendTo(fetchPage, 7900);
        const relay = scriptedRelay();
        const third = fetchPage(99).then(() => 'resolved', (e: Error) => e.message);
        await settle(0);
        await relay.ready; // REQ sent
        let early = false;
        void third.then(() => { early = true; });
        await settle(3099);
        expect(early).toBe(false);
        await settle(1);
        expect(await third).toMatch(/timed out before EOSE/);
      });
    });

    it('a walk that finishes under the deadline is unaffected', async () => {
      vi.useFakeTimers();
      const fetchPage = relayPageFetcher<{ id: string; created_at: number }>('wss://relay.test', { kinds: [1984] }, 1);
      for (const at of [10000, 10000]) {
        const relay = scriptedRelay();
        const p = fetchPage(undefined);
        await settle(0);
        await relay.ready;
        await settle(at);
        relay.message(['EVENT', relay.subId, PAGE[0]]);
        relay.message(['EOSE', relay.subId]);
        expect(await p).toEqual(PAGE);
      }
    });
  });
});
