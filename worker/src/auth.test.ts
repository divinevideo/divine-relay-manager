// ABOUTME: Tests for authentication and authorization utilities
// ABOUTME: Covers Zendesk JWT, NIP-98, webhook signatures, CF Access, CORS

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { finalizeEvent, nip19 } from 'nostr-tools';
import {
  base64UrlDecode,
  verifyZendeskJWT,
  verifyZendeskWebhook,
  verifyNip98Auth,
  getCfAccessCredentials,
  getAllowedOrigin,
} from './auth';

// Test nsec (DO NOT USE IN PRODUCTION - throwaway test key)
const TEST_NSEC = 'nsec1vl029mgpspedva04g90vltkh6fvh240zqtv9k0t9af8935ke9laqsnlfe5';
const TEST_SECRET_KEY = nip19.decode(TEST_NSEC).data as Uint8Array;
const TEST_PUBKEY = '7e7e9c42a91bfef19fa929e5fda1b72e0ebc1a4c1141673e2794234d86addf4e';

// ============================================================================
// Helpers
// ============================================================================

const JWT_SECRET = 'test-zendesk-jwt-secret-key';

function base64UrlEncode(str: string): string {
  return btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function signJwt(payload: Record<string, unknown>, secret: string): Promise<string> {
  const header = base64UrlEncode(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = base64UrlEncode(JSON.stringify(payload));
  const data = new TextEncoder().encode(`${header}.${body}`);

  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, data);
  const sigB64 = base64UrlEncode(String.fromCharCode(...new Uint8Array(sig)));

  return `${header}.${body}.${sigB64}`;
}

function makeRequest(headers: Record<string, string> = {}, method = 'GET'): Request {
  return new Request('https://example.com/api/test', {
    method,
    headers,
  });
}

// ============================================================================
// base64UrlDecode
// ============================================================================

describe('base64UrlDecode', () => {
  it('should decode standard base64url', () => {
    const encoded = base64UrlEncode('hello world');
    expect(base64UrlDecode(encoded)).toBe('hello world');
  });

  it('should handle URL-safe characters (- and _)', () => {
    // '+' in base64 → '-' in base64url, '/' → '_'
    const encoded = btoa('\xfb\xff\xfe').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    const decoded = base64UrlDecode(encoded);
    expect(decoded).toBe(atob(btoa('\xfb\xff\xfe')));
  });

  it('should handle missing padding', () => {
    // 'a' in base64 is 'YQ==' — without padding: 'YQ'
    expect(base64UrlDecode('YQ')).toBe('a');
    expect(base64UrlDecode('YWI')).toBe('ab');
    expect(base64UrlDecode('YWJj')).toBe('abc');
  });
});

// ============================================================================
// verifyZendeskJWT
// ============================================================================

describe('verifyZendeskJWT', () => {
  const env = { ZENDESK_JWT_SECRET: JWT_SECRET };

  it('should accept a valid JWT', async () => {
    const now = Math.floor(Date.now() / 1000);
    const token = await signJwt({
      iss: 'test',
      iat: now,
      exp: now + 300,
      email: 'user@example.com',
      name: 'Test User',
    }, JWT_SECRET);

    const req = makeRequest({ Authorization: `Bearer ${token}` });
    const result = await verifyZendeskJWT(req, env);

    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.payload.email).toBe('user@example.com');
      expect(result.payload.name).toBe('Test User');
    }
  });

  it('should reject missing Authorization header', async () => {
    const req = makeRequest({});
    const result = await verifyZendeskJWT(req, env);

    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.error).toContain('Missing');
    }
  });

  it('should reject non-Bearer token', async () => {
    const req = makeRequest({ Authorization: 'Basic abc123' });
    const result = await verifyZendeskJWT(req, env);

    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.error).toContain('Missing');
    }
  });

  it('should reject when ZENDESK_JWT_SECRET not configured', async () => {
    const now = Math.floor(Date.now() / 1000);
    const token = await signJwt({ iss: 'test', iat: now, exp: now + 300, email: 'a@b.com', name: 'A' }, JWT_SECRET);
    const req = makeRequest({ Authorization: `Bearer ${token}` });
    const result = await verifyZendeskJWT(req, {});

    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.error).toContain('not configured');
    }
  });

  it('should reject expired token', async () => {
    const now = Math.floor(Date.now() / 1000);
    const token = await signJwt({
      iss: 'test',
      iat: now - 600,
      exp: now - 300, // expired 5 minutes ago
      email: 'user@example.com',
      name: 'Test',
    }, JWT_SECRET);

    const req = makeRequest({ Authorization: `Bearer ${token}` });
    const result = await verifyZendeskJWT(req, env);

    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.error).toContain('expired');
    }
  });

  it('should reject token issued too far in the future', async () => {
    const now = Math.floor(Date.now() / 1000);
    const token = await signJwt({
      iss: 'test',
      iat: now + 120, // 2 minutes in future (>60s skew)
      exp: now + 600,
      email: 'user@example.com',
      name: 'Test',
    }, JWT_SECRET);

    const req = makeRequest({ Authorization: `Bearer ${token}` });
    const result = await verifyZendeskJWT(req, env);

    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.error).toContain('not yet valid');
    }
  });

  it('should reject invalid signature (wrong secret)', async () => {
    const now = Math.floor(Date.now() / 1000);
    const token = await signJwt({
      iss: 'test',
      iat: now,
      exp: now + 300,
      email: 'user@example.com',
      name: 'Test',
    }, 'wrong-secret');

    const req = makeRequest({ Authorization: `Bearer ${token}` });
    const result = await verifyZendeskJWT(req, env);

    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.error).toContain('Invalid signature');
    }
  });

  it('should reject malformed JWT (missing parts)', async () => {
    const req = makeRequest({ Authorization: 'Bearer not.a.valid.jwt.at.all' });
    const result = await verifyZendeskJWT(req, env);
    // Should fail somewhere in verification (parse error or invalid sig)
    expect(result.valid).toBe(false);
  });

  it('should reject JWT with only 2 parts', async () => {
    const req = makeRequest({ Authorization: 'Bearer header.payload' });
    const result = await verifyZendeskJWT(req, env);

    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.error).toContain('Invalid JWT format');
    }
  });

  it('should accept token within 60s clock skew for iat', async () => {
    const now = Math.floor(Date.now() / 1000);
    const token = await signJwt({
      iss: 'test',
      iat: now + 50, // 50s in future — within 60s skew
      exp: now + 600,
      email: 'user@example.com',
      name: 'Test',
    }, JWT_SECRET);

    const req = makeRequest({ Authorization: `Bearer ${token}` });
    const result = await verifyZendeskJWT(req, env);

    expect(result.valid).toBe(true);
  });
});

// ============================================================================
// verifyZendeskWebhook
// ============================================================================

describe('verifyZendeskWebhook', () => {
  const WEBHOOK_SECRET = 'test-webhook-secret';

  it('should accept valid X-Webhook-Key header', async () => {
    const req = makeRequest({ 'X-Webhook-Key': WEBHOOK_SECRET }, 'POST');
    const result = await verifyZendeskWebhook(req, '{"test": true}', WEBHOOK_SECRET);
    expect(result).toBe(true);
  });

  it('should reject wrong X-Webhook-Key', async () => {
    const req = makeRequest({ 'X-Webhook-Key': 'wrong-key' }, 'POST');
    const result = await verifyZendeskWebhook(req, '{"test": true}', WEBHOOK_SECRET);
    expect(result).toBe(false);
  });

  it('should reject when secret not configured', async () => {
    const req = makeRequest({ 'X-Webhook-Key': WEBHOOK_SECRET }, 'POST');
    const result = await verifyZendeskWebhook(req, '{"test": true}', undefined);
    expect(result).toBe(false);
  });

  it('should accept valid HMAC signature', async () => {
    const body = '{"action": "ban_user", "pubkey": "abc123"}';
    const timestamp = '2026-02-11T00:00:00Z';

    // Compute expected signature: HMAC-SHA256(secret, timestamp + "." + body)
    const signedPayload = `${timestamp}.${body}`;
    const key = await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(WEBHOOK_SECRET),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign']
    );
    const sigBytes = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(signedPayload));
    const signature = btoa(String.fromCharCode(...new Uint8Array(sigBytes)));

    const req = makeRequest({
      'X-Zendesk-Webhook-Signature': signature,
      'X-Zendesk-Webhook-Signature-Timestamp': timestamp,
    }, 'POST');

    const result = await verifyZendeskWebhook(req, body, WEBHOOK_SECRET);
    expect(result).toBe(true);
  });

  it('should reject invalid HMAC signature', async () => {
    const req = makeRequest({
      'X-Zendesk-Webhook-Signature': 'invalid-signature',
      'X-Zendesk-Webhook-Signature-Timestamp': '2026-02-11T00:00:00Z',
    }, 'POST');

    const result = await verifyZendeskWebhook(req, '{"test": true}', WEBHOOK_SECRET);
    expect(result).toBe(false);
  });

  it('should reject when no auth headers present', async () => {
    const req = makeRequest({}, 'POST');
    const result = await verifyZendeskWebhook(req, '{"test": true}', WEBHOOK_SECRET);
    expect(result).toBe(false);
  });

  it('should reject when signature present but timestamp missing', async () => {
    const req = makeRequest({
      'X-Zendesk-Webhook-Signature': 'some-sig',
    }, 'POST');
    const result = await verifyZendeskWebhook(req, '{"test": true}', WEBHOOK_SECRET);
    expect(result).toBe(false);
  });
});

// ============================================================================
// verifyNip98Auth
// ============================================================================

describe('verifyNip98Auth', () => {
  const EXPECTED_URL = 'https://api.example.com/api/test';

  function makeNip98Event(overrides: Record<string, unknown> = {}) {
    const now = Math.floor(Date.now() / 1000);
    return finalizeEvent({
      kind: 27235,
      created_at: now,
      tags: [
        ['u', EXPECTED_URL],
        ['method', 'POST'],
      ],
      content: '',
      ...overrides,
    }, TEST_SECRET_KEY);
  }

  function makeNip98Request(event: ReturnType<typeof makeNip98Event>, method = 'POST'): Request {
    const encoded = btoa(JSON.stringify(event));
    return new Request(EXPECTED_URL, {
      method,
      headers: { Authorization: `Nostr ${encoded}` },
    });
  }

  it('should accept a valid NIP-98 auth event', async () => {
    const event = makeNip98Event();
    const req = makeNip98Request(event);
    const result = await verifyNip98Auth(req, EXPECTED_URL);

    expect(result.valid).toBe(true);
    expect(result.pubkey).toBe(TEST_PUBKEY);
  });

  it('should reject missing Authorization header', async () => {
    const req = new Request(EXPECTED_URL, { method: 'POST' });
    const result = await verifyNip98Auth(req, EXPECTED_URL);

    expect(result.valid).toBe(false);
    expect(result.error).toContain('Missing');
  });

  it('should reject non-Nostr Authorization header', async () => {
    const req = new Request(EXPECTED_URL, {
      method: 'POST',
      headers: { Authorization: 'Bearer token123' },
    });
    const result = await verifyNip98Auth(req, EXPECTED_URL);

    expect(result.valid).toBe(false);
    expect(result.error).toContain('Missing');
  });

  it('should reject wrong event kind', async () => {
    const now = Math.floor(Date.now() / 1000);
    const event = finalizeEvent({
      kind: 1, // wrong kind — should be 27235
      created_at: now,
      tags: [['u', EXPECTED_URL], ['method', 'POST']],
      content: '',
    }, TEST_SECRET_KEY);

    const req = makeNip98Request(event as ReturnType<typeof makeNip98Event>);
    const result = await verifyNip98Auth(req, EXPECTED_URL);

    expect(result.valid).toBe(false);
    expect(result.error).toContain('Invalid event kind');
  });

  it('should reject expired event (>60s old)', async () => {
    const event = makeNip98Event({ created_at: Math.floor(Date.now() / 1000) - 120 });
    const req = makeNip98Request(event);
    const result = await verifyNip98Auth(req, EXPECTED_URL);

    expect(result.valid).toBe(false);
    expect(result.error).toContain('timestamp');
  });

  it('should reject future event (>60s ahead)', async () => {
    const event = makeNip98Event({ created_at: Math.floor(Date.now() / 1000) + 120 });
    const req = makeNip98Request(event);
    const result = await verifyNip98Auth(req, EXPECTED_URL);

    expect(result.valid).toBe(false);
    expect(result.error).toContain('timestamp');
  });

  it('should accept event within 60s clock skew', async () => {
    const event = makeNip98Event({ created_at: Math.floor(Date.now() / 1000) - 50 });
    const req = makeNip98Request(event);
    const result = await verifyNip98Auth(req, EXPECTED_URL);

    expect(result.valid).toBe(true);
  });

  it('should reject URL mismatch', async () => {
    const event = makeNip98Event({
      tags: [['u', 'https://wrong-url.com/api'], ['method', 'POST']],
    });
    const req = makeNip98Request(event);
    const result = await verifyNip98Auth(req, EXPECTED_URL);

    expect(result.valid).toBe(false);
    expect(result.error).toContain('URL mismatch');
  });

  it('should reject method mismatch', async () => {
    const event = makeNip98Event({
      tags: [['u', EXPECTED_URL], ['method', 'GET']],
    });
    // Request is POST but event says GET
    const req = makeNip98Request(event, 'POST');
    const result = await verifyNip98Auth(req, EXPECTED_URL);

    expect(result.valid).toBe(false);
    expect(result.error).toContain('Method mismatch');
  });

  it('should accept case-insensitive method match', async () => {
    const event = makeNip98Event({
      tags: [['u', EXPECTED_URL], ['method', 'post']],
    });
    const req = makeNip98Request(event, 'POST');
    const result = await verifyNip98Auth(req, EXPECTED_URL);

    expect(result.valid).toBe(true);
  });

  it('should reject invalid base64', async () => {
    const req = new Request(EXPECTED_URL, {
      method: 'POST',
      headers: { Authorization: 'Nostr !!!not-base64!!!' },
    });
    const result = await verifyNip98Auth(req, EXPECTED_URL);

    expect(result.valid).toBe(false);
    expect(result.error).toContain('Failed to parse');
  });

  it('should reject tampered event (invalid signature)', async () => {
    const event = makeNip98Event();
    // Tamper with the content
    const tampered = { ...event, content: 'tampered' };
    const encoded = btoa(JSON.stringify(tampered));
    const req = new Request(EXPECTED_URL, {
      method: 'POST',
      headers: { Authorization: `Nostr ${encoded}` },
    });
    const result = await verifyNip98Auth(req, EXPECTED_URL);

    expect(result.valid).toBe(false);
    expect(result.error).toContain('Invalid event signature');
  });

  it('should reject event with missing url tag', async () => {
    const event = makeNip98Event({
      tags: [['method', 'POST']], // no 'u' tag
    });
    const req = makeNip98Request(event);
    const result = await verifyNip98Auth(req, EXPECTED_URL);

    expect(result.valid).toBe(false);
    expect(result.error).toContain('URL mismatch');
  });

  it('should reject event with missing method tag', async () => {
    const event = makeNip98Event({
      tags: [['u', EXPECTED_URL]], // no 'method' tag
    });
    const req = makeNip98Request(event);
    const result = await verifyNip98Auth(req, EXPECTED_URL);

    expect(result.valid).toBe(false);
    expect(result.error).toContain('Method mismatch');
  });
});

// ============================================================================
// getCfAccessCredentials
// ============================================================================

describe('getCfAccessCredentials', () => {
  it('should resolve plain string secrets', async () => {
    const env = {
      CF_ACCESS_CLIENT_ID: 'my-client-id',
      CF_ACCESS_CLIENT_SECRET: 'my-client-secret',
    };
    const result = await getCfAccessCredentials(env);
    expect(result).toEqual({ clientId: 'my-client-id', clientSecret: 'my-client-secret' });
  });

  it('should resolve Secrets Store objects', async () => {
    const env = {
      CF_ACCESS_CLIENT_ID: { get: async () => 'store-client-id' },
      CF_ACCESS_CLIENT_SECRET: { get: async () => 'store-client-secret' },
    };
    const result = await getCfAccessCredentials(env);
    expect(result).toEqual({ clientId: 'store-client-id', clientSecret: 'store-client-secret' });
  });

  it('should handle mixed string + Secrets Store', async () => {
    const env = {
      CF_ACCESS_CLIENT_ID: 'plain-string-id',
      CF_ACCESS_CLIENT_SECRET: { get: async () => 'store-secret' },
    };
    const result = await getCfAccessCredentials(env);
    expect(result).toEqual({ clientId: 'plain-string-id', clientSecret: 'store-secret' });
  });

  it('should return null when CLIENT_ID missing', async () => {
    const env = { CF_ACCESS_CLIENT_SECRET: 'secret' };
    const result = await getCfAccessCredentials(env);
    expect(result).toBeNull();
  });

  it('should return null when CLIENT_SECRET missing', async () => {
    const env = { CF_ACCESS_CLIENT_ID: 'id' };
    const result = await getCfAccessCredentials(env);
    expect(result).toBeNull();
  });

  it('should return null when both missing', async () => {
    const result = await getCfAccessCredentials({});
    expect(result).toBeNull();
  });

  it('should return null when Secrets Store returns empty string', async () => {
    const env = {
      CF_ACCESS_CLIENT_ID: { get: async () => '' },
      CF_ACCESS_CLIENT_SECRET: { get: async () => 'secret' },
    };
    const result = await getCfAccessCredentials(env);
    expect(result).toBeNull();
  });
});

// ============================================================================
// getAllowedOrigin
// ============================================================================

describe('getAllowedOrigin', () => {
  it('should return exact match', () => {
    const result = getAllowedOrigin('https://relay.admin.divine.video', 'https://relay.admin.divine.video,https://other.com');
    expect(result).toBe('https://relay.admin.divine.video');
  });

  it('should return wildcard match', () => {
    const result = getAllowedOrigin('https://preview-abc.divine.video', '*.divine.video,https://other.com');
    expect(result).toBe('https://preview-abc.divine.video');
  });

  it('should return first allowed origin when no request origin', () => {
    const result = getAllowedOrigin(null, 'https://relay.admin.divine.video,https://other.com');
    expect(result).toBe('https://relay.admin.divine.video');
  });

  it('should return first allowed origin when request origin not in list', () => {
    const result = getAllowedOrigin('https://evil.com', 'https://relay.admin.divine.video');
    expect(result).toBe('https://relay.admin.divine.video');
  });

  it('should return empty string when no allowed origins configured', () => {
    expect(getAllowedOrigin('https://any.com', undefined)).toBe('');
    expect(getAllowedOrigin('https://any.com', '')).toBe('');
    expect(getAllowedOrigin('https://any.com', '   ')).toBe('');
  });

  it('should handle whitespace in allowed origins', () => {
    const result = getAllowedOrigin('https://relay.admin.divine.video', ' https://relay.admin.divine.video , https://other.com ');
    expect(result).toBe('https://relay.admin.divine.video');
  });

  it('should not match partial wildcard incorrectly', () => {
    // '*.divine.video' should NOT match 'https://divine.video' (no subdomain)
    // Actually: 'https://divine.video'.endsWith('.divine.video') is true
    // This is a known behavior — wildcard matches anything ending with .divine.video
    const result = getAllowedOrigin('https://evil.divine.video.attacker.com', '*.divine.video');
    // Should NOT match because attacker.com doesn't end with .divine.video
    expect(result).not.toBe('https://evil.divine.video.attacker.com');
  });
});
