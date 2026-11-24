// ABOUTME: Only labels signed by the worker's own key may mark a target handled.
// ABOUTME: Anyone able to publish a kind-1985 label must not hide reports from the queue.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { getPublicKey, nip19 } from 'nostr-tools';
import {
  reduceLabelsToTargets,
  readResolutionLabelTargets,
  resolveLabelSigner,
} from './resolution-labels';

const SIGNER = 'a1'.repeat(32);
const OTHER = 'b2'.repeat(32);
const TARGET = 'c3'.repeat(32);

const signed = (pubkey: unknown, createdAt = 5) => ({
  id: Math.random().toString(36).slice(2),
  pubkey,
  created_at: createdAt,
  tags: [['e', TARGET]],
}) as never;

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('reduceLabelsToTargets trusts only the signer', () => {
  it('ignores a label signed by another key', () => {
    expect(reduceLabelsToTargets([signed(OTHER)], SIGNER)).toEqual([]);
  });

  it('ignores a label with no pubkey', () => {
    expect(reduceLabelsToTargets([signed(undefined)], SIGNER)).toEqual([]);
  });

  it('counts a label signed by the worker key', () => {
    expect(reduceLabelsToTargets([signed(SIGNER)], SIGNER)).toEqual([
      { type: 'event', value: TARGET, at: 5 },
    ]);
  });

  it('does not let a foreign newer label re-date a signed one', () => {
    const targets = reduceLabelsToTargets([signed(SIGNER, 5), signed(OTHER, 900)], SIGNER);
    expect(targets).toEqual([{ type: 'event', value: TARGET, at: 5 }]);
  });
});

describe('reduceLabelsToTargets signer guard', () => {
  it.each([['empty', ''], ['undefined', undefined], ['number', 5]])('throws on a %s signer', (_n, bad) => {
    expect(() => reduceLabelsToTargets([signed(undefined)], bad as never)).toThrow(/signing key/i);
  });

  it('ignores a non-string pubkey', () => {
    expect(reduceLabelsToTargets([signed(12345)], SIGNER)).toEqual([]);
  });
});

describe('readResolutionLabelTargets', () => {
  function stubRelay(events: unknown[]) {
    const filters: Array<Record<string, unknown>> = [];
    class FakeWebSocket {
      private listeners = new Map<string, Array<(e: unknown) => void>>();
      constructor(_url: string) { setTimeout(() => this.emit('open', {}), 0); }
      addEventListener(type: string, l: (e: unknown) => void) {
        this.listeners.set(type, [...(this.listeners.get(type) ?? []), l]);
      }
      send(raw: string) {
        const [, subId, filter] = JSON.parse(raw);
        filters.push(filter);
        setTimeout(() => {
          for (const ev of events) this.emit('message', { data: JSON.stringify(['EVENT', subId, ev]) });
          this.emit('message', { data: JSON.stringify(['EOSE', subId]) });
        }, 0);
      }
      close() {}
      private emit(type: string, e: unknown) { for (const h of this.listeners.get(type) ?? []) h(e); }
    }
    vi.stubGlobal('WebSocket', FakeWebSocket as never);
    return filters;
  }

  it('asks the relay only for labels by the signer', async () => {
    const filters = stubRelay([]);
    await readResolutionLabelTargets('wss://relay.test', SIGNER);
    expect(filters).toHaveLength(1);
    expect(filters[0].authors).toEqual([SIGNER]);
    expect(filters[0]['#L']).toEqual(['moderation/resolution']);
  });

  it('drops a foreign label a relay returns despite the authors filter', async () => {
    // The foreign label is newer and names another target, so a leak changes
    // either the date or the target set.
    stubRelay([signed(OTHER, 900), { ...(signed(OTHER, 800) as object), tags: [['e', 'd4'.repeat(32)]] }, signed(SIGNER, 7)]);
    const { targets } = await readResolutionLabelTargets('wss://relay.test', SIGNER);
    expect(targets).toEqual([{ type: 'event', value: TARGET, at: 7 }]);
  });

  it('fails, without querying, when the signer is unresolved', async () => {
    const filters = stubRelay([signed(SIGNER)]);
    await expect(readResolutionLabelTargets('wss://relay.test', null)).rejects.toThrow(/signing key/i);
    expect(filters).toHaveLength(0);
  });
});

describe('resolveLabelSigner', () => {
  const sk = new Uint8Array(32).fill(7);
  const nsec = nip19.nsecEncode(sk);

  it('derives the pubkey from a plain-string secret', async () => {
    expect(await resolveLabelSigner({ NOSTR_NSEC: nsec })).toBe(getPublicKey(sk));
  });

  it('derives the pubkey from a Secrets Store binding', async () => {
    expect(await resolveLabelSigner({ NOSTR_NSEC: { get: async () => nsec } })).toBe(getPublicKey(sk));
  });

  it('returns null and logs when the binding throws', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const result = await resolveLabelSigner({ NOSTR_NSEC: { get: async () => { throw new Error('store down'); } } });
    expect(result).toBeNull();
    expect(err).toHaveBeenCalled();
  });

  it('returns null when the secret is malformed', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await resolveLabelSigner({ NOSTR_NSEC: 'not-an-nsec' })).toBeNull();
  });
});
