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

  it('should handle WS (non-secure) URLs', () => {
    const env = {
      RELAY_URL: 'ws://localhost:7777',
      MANAGEMENT_PATH: '/',
    };
    expect(getManagementUrl(env)).toBe('https://localhost:7777/');
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
});
