import { describe, it, expect } from 'vitest';
import { queryStrict, isDefinitiveRpcNegative, RelayReadError, type ReqCapable } from './relayRead';
import { ApiError } from './adminApi';

function ev(id: string) {
  return { id, pubkey: 'd4'.repeat(32), created_at: 1, kind: 1, tags: [], content: '', sig: '' };
}

/** A relay whose stream yields exactly the given messages, then ends. */
function fakeRelay(msgs: Array<[string, ...unknown[]]>): ReqCapable {
  return {
    // eslint-disable-next-line require-yield
    async *req() {
      for (const m of msgs) yield m;
    },
  } as ReqCapable;
}

const opts = () => ({ signal: new AbortController().signal, timeoutMs: 1000 });

describe('queryStrict', () => {
  it('returns events once the relay signals EOSE', async () => {
    const relay = fakeRelay([
      ['EVENT', 'sub', ev('a')],
      ['EVENT', 'sub', ev('b')],
      ['EOSE', 'sub'],
    ]);
    await expect(queryStrict(relay, [{ ids: ['a'] }], opts())).resolves.toHaveLength(2);
  });

  it('returns an empty result for a genuinely empty relay (EOSE, no events)', async () => {
    const relay = fakeRelay([['EOSE', 'sub']]);
    await expect(queryStrict(relay, [{ ids: ['a'] }], opts())).resolves.toEqual([]);
  });

  it('throws when the relay CLOSES the subscription', async () => {
    // Funnelcake sends CLOSED with "could not complete query" when its query
    // layer degrades. NPool.query would swallow this and return [], which is
    // indistinguishable from an empty account. Assert the message, not just the
    // type, or turning this throw into a break still passes via the EOSE check.
    const relay = fakeRelay([['CLOSED', 'sub', 'error: could not complete query']]);
    await expect(queryStrict(relay, [{ ids: ['a'] }], opts())).rejects.toThrow(/closed the subscription/i);
  });

  it('rejects rather than resolving when the read times out', async () => {
    // The live failure path. A relay that stops responding (or closes, which
    // NRelay1 swallows) hangs until our timeout aborts the iterator, and the
    // abort must surface as a rejection. If it ever resolved instead, an empty
    // result would be reported to a moderator as "no content found".
    const hanging: ReqCapable = {
      async *req(_filters, opts) {
        await new Promise((_resolve, reject) => {
          opts?.signal?.addEventListener('abort', () =>
            reject(new DOMException('The signal has been aborted', 'AbortError')));
        });
        yield ['EOSE', 'sub'] as [string, ...unknown[]]; // unreachable
      },
    } as ReqCapable;

    await expect(
      queryStrict(hanging, [{ ids: ['a'] }], { signal: new AbortController().signal, timeoutMs: 50 }),
    ).rejects.toThrow();
  });

  it('throws when the stream ends without EOSE', async () => {
    // NPool.req returns immediately when no relay is routed to, and an aborted
    // read simply stops. Neither established what the relay holds.
    const relay = fakeRelay([]);
    await expect(queryStrict(relay, [{ ids: ['a'] }], opts())).rejects.toBeInstanceOf(RelayReadError);
  });

  it('does not treat events received before a CLOSE as a complete read', async () => {
    const relay = fakeRelay([
      ['EVENT', 'sub', ev('a')],
      ['CLOSED', 'sub', 'error: stored replay timed out'],
    ]);
    await expect(queryStrict(relay, [{ ids: ['a'] }], opts())).rejects.toBeInstanceOf(RelayReadError);
  });
});

describe('isDefinitiveRpcNegative', () => {
  it('accepts the production shape of "not banned" (HTTP 400)', () => {
    // Verified end to end: the relay answers success:false and the worker
    // returns it as HTTP 400, so the ApiError DOES carry a status code.
    expect(isDefinitiveRpcNegative(new ApiError('Event not found or not banned', 400, 'Bad Request'))).toBe(true);
  });

  it('accepts a statusless RPC-level negative', () => {
    expect(isDefinitiveRpcNegative(new ApiError('Event not found or not banned'))).toBe(true);
  });

  it('rejects auth and server failures, which must not read as a negative', () => {
    expect(isDefinitiveRpcNegative(new ApiError('Unauthorized', 401, 'Unauthorized'))).toBe(false);
    expect(isDefinitiveRpcNegative(new ApiError('Forbidden', 403, 'Forbidden'))).toBe(false);
    expect(isDefinitiveRpcNegative(new ApiError('Internal Server Error', 500, 'ISE'))).toBe(false);
  });

  it('rejects an unrecognised relay-side failure rather than assuming a negative', () => {
    expect(isDefinitiveRpcNegative(new ApiError('database unavailable', 400, 'Bad Request'))).toBe(false);
  });

  it('rejects a management-endpoint 404, which the worker also delivers as a 400', () => {
    // callNip86Rpc renders any non-ok relay response as "Relay error: <status>
    // <text>" and handleRelayRpc returns every failure as HTTP 400. A loose
    // match would read this as "not banned" and report a deletion during an
    // outage, which is the failure this whole module exists to prevent.
    expect(isDefinitiveRpcNegative(new ApiError('Relay error: 404 Not Found', 400, 'Bad Request'))).toBe(false);
  });

  it('rejects the relay sentence when it arrives with a non-400 status', () => {
    // Exercises the status gate independently of the message, so neither check
    // can be removed without a test noticing.
    expect(isDefinitiveRpcNegative(new ApiError('Event not found or not banned', 500, 'ISE'))).toBe(false);
  });

  it('rejects non-ApiError failures (network, abort)', () => {
    expect(isDefinitiveRpcNegative(new Error('Failed to fetch'))).toBe(false);
    expect(isDefinitiveRpcNegative(undefined)).toBe(false);
  });
});
