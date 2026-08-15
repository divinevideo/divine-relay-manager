// ABOUTME: Tests for NIP-86 RPC utilities
// ABOUTME: Uses vitest with mocked fetch for relay calls

import { describe, it, expect, vi, beforeEach } from 'vitest';
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
    ['hide', banEvent, 'spam'],
    ['allow', allowEvent, undefined],
  ] as const)('routes %s event visibility through ReportWatcher when configured', async (relayAction, action, reason) => {
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
