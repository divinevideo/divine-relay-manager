// ABOUTME: Tests for NIP-86 RPC utilities
// ABOUTME: Uses vitest with mocked fetch for relay calls

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  getSecretKey,
  getAdminPubkey,
  getManagementUrl,
  callNip86Rpc,
  banEvent,
  allowEvent,
  banPubkey,
  unbanPubkey,
  suspendPubkey,
  unsuspendPubkey,
  type Nip86Env,
} from './nip86';

// Test nsec (DO NOT USE IN PRODUCTION - this is a throwaway test key)
const TEST_NSEC = 'nsec1vl029mgpspedva04g90vltkh6fvh240zqtv9k0t9af8935ke9laqsnlfe5';
// Pubkey derived from TEST_NSEC
const TEST_PUBKEY = '7e7e9c42a91bfef19fa929e5fda1b72e0ebc1a4c1141673e2794234d86addf4e';

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('getSecretKey', () => {
  it('should decode nsec string', async () => {
    const env = { NOSTR_NSEC: TEST_NSEC };
    const key = await getSecretKey(env);
    expect(key).toBeInstanceOf(Uint8Array);
    expect(key.length).toBe(32);
  });

  it('should handle Secrets Store object', async () => {
    const env = {
      NOSTR_NSEC: { get: async () => TEST_NSEC },
    };
    const key = await getSecretKey(env);
    expect(key).toBeInstanceOf(Uint8Array);
    expect(key.length).toBe(32);
  });

  it('should throw on missing secret', async () => {
    const env = {
      NOSTR_NSEC: { get: async () => '' },
    };
    await expect(getSecretKey(env)).rejects.toThrow('NOSTR_NSEC secret not configured');
  });

  it('should throw on invalid format', async () => {
    const env = { NOSTR_NSEC: 'npub1invalid' };
    await expect(getSecretKey(env)).rejects.toThrow();
  });
});

describe('getAdminPubkey', () => {
  it('should return pubkey from nsec', async () => {
    const env = { NOSTR_NSEC: TEST_NSEC };
    const pubkey = await getAdminPubkey(env);
    expect(pubkey).toBe(TEST_PUBKEY);
  });
});

describe('getManagementUrl', () => {
  it('should use MANAGEMENT_URL if set', () => {
    const env = {
      RELAY_URL: 'wss://relay.example.com',
      MANAGEMENT_URL: 'http://localhost:8080',
    };
    expect(getManagementUrl(env)).toBe('http://localhost:8080');
  });

  it('should convert WSS to HTTPS with management path', () => {
    const env = {
      RELAY_URL: 'wss://relay.example.com',
      MANAGEMENT_PATH: '/management',
    };
    expect(getManagementUrl(env)).toBe('https://relay.example.com/management');
  });

  it('should use default management path', () => {
    const env = {
      RELAY_URL: 'wss://relay.example.com',
    };
    expect(getManagementUrl(env)).toBe('https://relay.example.com/management');
  });

  it('should keep WS (non-secure) URLs on http, not upgrade them to https', () => {
    // This asserted https, which contradicted its own name and made ws:// unusable:
    // a local relay serving plain HTTP was called over TLS and every NIP-86
    // management request failed on the handshake. ws is the insecure scheme and
    // maps to http, exactly as deriveFunnelcakeApiUrl already does for the same
    // input.
    //
    // Only local dev is affected. wrangler.staging.toml and wrangler.prod.toml
    // both set RELAY_URL to wss://, which is unchanged.
    const env = {
      RELAY_URL: 'ws://localhost:7777',
      MANAGEMENT_PATH: '/',
    };
    expect(getManagementUrl(env)).toBe('http://localhost:7777/');
  });

  it('still upgrades WSS to HTTPS', () => {
    // The pair to the above: the secure scheme must not be downgraded.
    const env = {
      RELAY_URL: 'wss://relay.example.com',
      MANAGEMENT_PATH: '/',
    };
    expect(getManagementUrl(env)).toBe('https://relay.example.com/');
  });
});

describe('callNip86Rpc', () => {
  const mockEnv: Nip86Env = {
    NOSTR_NSEC: TEST_NSEC,
    RELAY_URL: 'wss://relay.test.com',
    MANAGEMENT_PATH: '/',
  };

  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('should call relay with NIP-98 auth header', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ result: ['event1', 'event2'] }),
    });
    vi.stubGlobal('fetch', mockFetch);

    const result = await callNip86Rpc('listbannedevents', [], mockEnv);

    expect(result.success).toBe(true);
    expect(result.result).toEqual(['event1', 'event2']);

    // Verify fetch was called correctly
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, options] = mockFetch.mock.calls[0];
    expect(url).toBe('https://relay.test.com/');
    expect(options.method).toBe('POST');
    expect(options.headers['Content-Type']).toBe('application/nostr+json+rpc');
    expect(options.headers['Authorization']).toMatch(/^Nostr /);
  });

  it('should handle relay error response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      statusText: 'Internal Server Error',
    }));

    const result = await callNip86Rpc('banevent', ['abc123'], mockEnv);

    expect(result.success).toBe(false);
    expect(result.error).toContain('500');
  });

  it('should handle RPC error in response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ error: 'Event not found' }),
    }));

    const result = await callNip86Rpc('banevent', ['abc123'], mockEnv);

    expect(result.success).toBe(false);
    expect(result.error).toBe('Event not found');
  });

  it('should filter undefined params', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ result: true }),
    });
    vi.stubGlobal('fetch', mockFetch);

    await callNip86Rpc('banevent', ['abc123', undefined, 'reason'], mockEnv);

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.params).toEqual(['abc123', 'reason']);
  });

  it('bounds relay calls below the Durable Object gate timeout', async () => {
    const signal = new AbortController().signal;
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(signal);
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ result: true }),
    });
    vi.stubGlobal('fetch', mockFetch);

    await callNip86Rpc('banevent', ['abc123'], mockEnv);

    expect(timeoutSpy).toHaveBeenCalledWith(15_000);
    expect(mockFetch.mock.calls[0][1].signal).toBe(signal);
  });

  it('returns a structured failure, flagged as a timeout, when the relay request times out', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new DOMException('timed out', 'TimeoutError')));

    await expect(callNip86Rpc('listbannedevents', [], mockEnv)).resolves.toEqual({
      success: false,
      error: 'timed out',
      timedOut: true,
    });
  });

  it('does not flag other rejections as timeouts', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('network down')));

    await expect(callNip86Rpc('listbannedevents', [], mockEnv)).resolves.toEqual({
      success: false,
      error: 'network down',
    });
  });
});

describe('convenience methods', () => {
  const mockEnv: Nip86Env = {
    NOSTR_NSEC: TEST_NSEC,
    RELAY_URL: 'wss://relay.test.com',
    MANAGEMENT_PATH: '/',
  };

  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ result: true }),
    });
    vi.stubGlobal('fetch', mockFetch);
  });

  it('banEvent should call banevent RPC', async () => {
    const result = await banEvent('event123', 'spam', mockEnv);
    expect(result.success).toBe(true);

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.method).toBe('banevent');
    expect(body.params).toEqual(['event123', 'spam']);
  });

  it('allowEvent should call allowevent RPC', async () => {
    const result = await allowEvent('event123', mockEnv);
    expect(result.success).toBe(true);

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.method).toBe('allowevent');
    expect(body.params).toEqual(['event123']);
  });

  it.each([
    ['hide', banEvent, 'spam', 'hide_event'],
    ['allow', allowEvent, undefined, 'allow_event'],
  ] as const)('routes %s event visibility through ReportWatcher when configured', async (relayAction, action, reason, humanAction) => {
    const eventId = 'ab'.repeat(32);
    const coordinatorFetch = vi.fn(async (_request: Request) => Response.json({ success: true }));
    const env = {
      ...mockEnv,
      REPORT_WATCHER: {
        idFromName: vi.fn(() => 'singleton'),
        get: vi.fn(() => ({ fetch: coordinatorFetch })),
      },
    } as never;

    const result = reason
      ? await action(eventId, reason, env)
      : await action(eventId, env);

    expect(result.success).toBe(true);
    expect(mockFetch).not.toHaveBeenCalled();
    const request = coordinatorFetch.mock.calls[0][0];
    expect(await request.json()).toEqual({
      eventId,
      relayAction,
      humanAction,
      ...(reason ? { reason } : {}),
    });
  });

  it('banPubkey should call banpubkey RPC', async () => {
    const result = await banPubkey('pubkey123', 'abuse', mockEnv);
    expect(result.success).toBe(true);

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.method).toBe('banpubkey');
    expect(body.params).toEqual(['pubkey123', 'abuse']);
  });

  it('does not re-read the ban list when the relay confirms the ban', async () => {
    const result = await banPubkey('pubkey123', 'abuse', mockEnv);

    expect(result).toEqual({ success: true, result: true });
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('unbanPubkey should call unbanpubkey RPC', async () => {
    const result = await unbanPubkey('pubkey123', mockEnv);
    expect(result.success).toBe(true);

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.method).toBe('unbanpubkey');
    expect(body.params).toEqual(['pubkey123']);
  });

  it('suspendPubkey should call suspendpubkey RPC with [pubkey, reason]', async () => {
    const result = await suspendPubkey('pubkey123', 'age_review', mockEnv);
    expect(result.success).toBe(true);

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.method).toBe('suspendpubkey');
    expect(body.params).toEqual(['pubkey123', 'age_review']);
  });

  it('unsuspendPubkey should call unsuspendpubkey RPC with [pubkey]', async () => {
    const result = await unsuspendPubkey('pubkey123', mockEnv);
    expect(result.success).toBe(true);

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.method).toBe('unsuspendpubkey');
    expect(body.params).toEqual(['pubkey123']);
  });
});

// The relay writes the ban before its slow snapshot and content purge, so a
// banpubkey that errors or outlives the worker's bound has usually landed.
// Reporting that as a plain failure invites a retry, which re-enforces under a
// new enforcement id. banPubkey reads the ban list before it fails.
describe('banPubkey confirm-before-failing', () => {
  const mockEnv: Nip86Env = {
    NOSTR_NSEC: TEST_NSEC,
    RELAY_URL: 'wss://relay.test.com',
    MANAGEMENT_PATH: '/',
  };
  const TARGET = 'ab'.repeat(32);
  const OTHER = 'cd'.repeat(32);

  /** fetch double that answers banpubkey and listbannedpubkeys independently. */
  function relayDouble(opts: {
    ban: () => Promise<unknown>;
    list: () => Promise<unknown>;
  }) {
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      const { method } = JSON.parse(init.body as string) as { method: string };
      if (method === 'banpubkey') return opts.ban();
      if (method === 'listbannedpubkeys') return opts.list();
      throw new Error(`unexpected method ${method}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  }
  const rpcOk = (result: unknown) => async () => ({ ok: true, json: async () => ({ result }) });
  const rpcError = (error: string) => async () => ({ ok: true, json: async () => ({ error }) });
  const rejects = (err: Error) => async () => { throw err; };

  it('reports a timed-out ban as applied when the ban list shows it', async () => {
    relayDouble({
      ban: rejects(new DOMException('The operation was aborted due to timeout', 'TimeoutError')),
      list: rpcOk([{ pubkey: OTHER }, { pubkey: TARGET, reason: 'abuse' }]),
    });

    const result = await banPubkey(TARGET, 'abuse', mockEnv);

    expect(result).toEqual({
      success: true,
      contentRemovalUnconfirmed: true,
      relayTimedOut: true,
      relayError: 'The operation was aborted due to timeout',
    });
  });

  it('reports a ban whose content purge errored as applied when the ban list shows it', async () => {
    relayDouble({
      ban: rpcError('Failed to ban pubkey: ban inserted but content purge failed'),
      list: rpcOk([{ pubkey: TARGET }]),
    });

    const result = await banPubkey(TARGET, 'abuse', mockEnv);

    expect(result.success).toBe(true);
    expect(result.contentRemovalUnconfirmed).toBe(true);
    expect(result.relayError).toBe('Failed to ban pubkey: ban inserted but content purge failed');
    // The relay answered: its purge failed, it was not still running.
    expect(result.relayTimedOut).toBeUndefined();
  });

  // callNip86Rpc throws rather than returns when the body read fails, e.g. the
  // bound aborting mid-body. That is the same "did it land?" question.
  it('checks the ban list when the ban response body cannot be read', async () => {
    relayDouble({
      ban: async () => ({ ok: true, json: async () => { throw new DOMException('aborted', 'TimeoutError'); } }),
      list: rpcOk([TARGET]),
    });

    const result = await banPubkey(TARGET, 'abuse', mockEnv);

    // Headers had arrived, and funnelcake sends them only after the ban
    // finished, so this is not "still working": no relayTimedOut.
    expect(result).toEqual({ success: true, contentRemovalUnconfirmed: true, relayError: 'aborted' });
  });

  it('accepts a ban list of bare pubkey strings', async () => {
    relayDouble({ ban: rpcError('boom'), list: rpcOk([TARGET]) });

    const result = await banPubkey(TARGET, 'abuse', mockEnv);

    expect(result.success).toBe(true);
  });

  it('fails as unconfirmed, keeping the relay error, when the ban list lacks the pubkey', async () => {
    relayDouble({ ban: rpcError('Relay error: 503 Service Unavailable'), list: rpcOk([{ pubkey: OTHER }]) });

    const result = await banPubkey(TARGET, 'abuse', mockEnv);

    expect(result).toEqual({
      success: false,
      code: 'ban_unconfirmed',
      error: 'Ban not confirmed: Relay error: 503 Service Unavailable',
    });
  });

  it('fails as unconfirmed when the ban list cannot be read', async () => {
    relayDouble({ ban: rpcError('boom'), list: rejects(new TypeError('network down')) });

    const result = await banPubkey(TARGET, 'abuse', mockEnv);

    expect(result).toEqual({ success: false, code: 'ban_unconfirmed', error: 'Ban not confirmed: boom' });
  });

  it('fails as unconfirmed when the ban list body cannot be read', async () => {
    relayDouble({
      ban: rpcError('boom'),
      list: async () => ({ ok: true, json: async () => { throw new SyntaxError('Unexpected token <'); } }),
    });

    const result = await banPubkey(TARGET, 'abuse', mockEnv);

    expect(result).toEqual({ success: false, code: 'ban_unconfirmed', error: 'Ban not confirmed: boom' });
  });

  it('fails as unconfirmed when the ban list read returns an RPC error', async () => {
    relayDouble({ ban: rpcError('boom'), list: rpcError('Not authorized as admin') });

    const result = await banPubkey(TARGET, 'abuse', mockEnv);

    expect(result).toEqual({ success: false, code: 'ban_unconfirmed', error: 'Ban not confirmed: boom' });
  });

  it('fails as unconfirmed when the ban list is not a list', async () => {
    relayDouble({ ban: rpcError('boom'), list: rpcOk({ pubkey: TARGET }) });

    const result = await banPubkey(TARGET, 'abuse', mockEnv);

    expect(result.success).toBe(false);
    expect(result.code).toBe('ban_unconfirmed');
  });

  // The ban already spent its own 15s bound; the check must fit inside the
  // browser's 30s so the moderator gets this answer rather than a client timeout.
  it('bounds the ban-list check tighter than the ban itself', async () => {
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout');
    relayDouble({ ban: rpcError('boom'), list: rpcOk([TARGET]) });

    await banPubkey(TARGET, 'abuse', mockEnv);

    expect(timeoutSpy.mock.calls.map(([ms]) => ms)).toEqual([15_000, 5_000]);
  });
});
