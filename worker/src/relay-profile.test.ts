// ABOUTME: Tests for the shared relay profile fetch used to capture account identity.
// ABOUTME: Mocks the WebSocket rather than the module, so the real queryRelay is exercised.

import { describe, it, expect, vi, afterEach } from 'vitest';
import { fetchAccountIdentity } from './relay-profile';

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

  // queryRelay resolves { success: true, events: [], complete: false } when the
  // socket closes or times out before EOSE. Only EOSE proves the relay had
  // nothing; an unconfirmed absence must not count as a completed lookup, or a
  // dropped connection excludes the case from backfill exactly as a hard error
  // would have.
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
