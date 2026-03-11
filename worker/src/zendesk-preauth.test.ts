import { describe, it, expect } from 'vitest';
import { generatePreAuthToken, verifyPreAuthToken } from './zendesk-preauth';

const TEST_SECRET = 'test-secret-key-for-hmac-signing-1234567890abcdef';

describe('generatePreAuthToken', () => {
  it('returns token, nonce, and expiresAt', async () => {
    const result = await generatePreAuthToken('aabbccdd'.repeat(8), TEST_SECRET);
    expect(result.token).toBeDefined();
    expect(result.nonce).toBeDefined();
    expect(result.nonce.length).toBe(36); // UUID format
    expect(result.expiresAt).toBeGreaterThan(Math.floor(Date.now() / 1000));
  });

  it('token has two dot-separated base64url segments', async () => {
    const { token } = await generatePreAuthToken('aabbccdd'.repeat(8), TEST_SECRET);
    const parts = token.split('.');
    expect(parts).toHaveLength(2);
    expect(parts[0].length).toBeGreaterThan(0);
    expect(parts[1].length).toBeGreaterThan(0);
  });

  it('embeds pubkey, nonce, exp, and purpose in the payload', async () => {
    const pubkey = 'aabbccdd'.repeat(8);
    const { token } = await generatePreAuthToken(pubkey, TEST_SECRET);
    const payloadB64 = token.split('.')[0];
    const padding = '='.repeat((4 - (payloadB64.length % 4)) % 4);
    const payload = JSON.parse(atob(payloadB64.replace(/-/g, '+').replace(/_/g, '/') + padding));
    expect(payload.pubkey).toBe(pubkey);
    expect(payload.purpose).toBe('zendesk-pre-auth');
    expect(typeof payload.nonce).toBe('string');
    expect(payload.exp).toBeGreaterThan(Math.floor(Date.now() / 1000));
  });

  it('generates unique nonces on each call', async () => {
    const pubkey = 'aabbccdd'.repeat(8);
    const r1 = await generatePreAuthToken(pubkey, TEST_SECRET);
    const r2 = await generatePreAuthToken(pubkey, TEST_SECRET);
    expect(r1.nonce).not.toBe(r2.nonce);
  });
});

describe('verifyPreAuthToken', () => {
  it('returns valid result for a freshly generated token', async () => {
    const pubkey = 'aabbccdd'.repeat(8);
    const { token } = await generatePreAuthToken(pubkey, TEST_SECRET);
    const result = await verifyPreAuthToken(token, TEST_SECRET);
    expect(result.valid).toBe(true);
    expect(result.pubkey).toBe(pubkey);
    expect(result.nonce).toBeDefined();
  });

  it('rejects a token with a tampered payload', async () => {
    const pubkey = 'aabbccdd'.repeat(8);
    const { token } = await generatePreAuthToken(pubkey, TEST_SECRET);
    const [, sig] = token.split('.');
    const tamperedPayload = btoa(JSON.stringify({ pubkey: '1111111111111111'.repeat(4), nonce: 'fake', exp: 9999999999, purpose: 'zendesk-pre-auth' }))
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    const tamperedToken = `${tamperedPayload}.${sig}`;
    const result = await verifyPreAuthToken(tamperedToken, TEST_SECRET);
    expect(result.valid).toBe(false);
    expect(result.error).toContain('signature');
  });

  it('rejects a token with wrong secret', async () => {
    const pubkey = 'aabbccdd'.repeat(8);
    const { token } = await generatePreAuthToken(pubkey, TEST_SECRET);
    const result = await verifyPreAuthToken(token, 'wrong-secret');
    expect(result.valid).toBe(false);
  });

  it('rejects a token with wrong purpose', async () => {
    const pubkey = 'aabbccdd'.repeat(8);
    const payload = { pubkey, nonce: crypto.randomUUID(), exp: Math.floor(Date.now() / 1000) + 300, purpose: 'wrong-purpose' };
    const payloadB64 = btoa(JSON.stringify(payload)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(TEST_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const sigBytes = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payloadB64));
    const sigB64 = btoa(String.fromCharCode(...new Uint8Array(sigBytes))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    const token = `${payloadB64}.${sigB64}`;
    const result = await verifyPreAuthToken(token, TEST_SECRET);
    expect(result.valid).toBe(false);
    expect(result.error).toContain('purpose');
  });

  it('rejects an expired token', async () => {
    const pubkey = 'aabbccdd'.repeat(8);
    const payload = { pubkey, nonce: crypto.randomUUID(), exp: Math.floor(Date.now() / 1000) - 60, purpose: 'zendesk-pre-auth' };
    const payloadB64 = btoa(JSON.stringify(payload)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(TEST_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const sigBytes = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payloadB64));
    const sigB64 = btoa(String.fromCharCode(...new Uint8Array(sigBytes))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    const token = `${payloadB64}.${sigB64}`;
    const result = await verifyPreAuthToken(token, TEST_SECRET);
    expect(result.valid).toBe(false);
    expect(result.error).toContain('expired');
  });

  it('rejects a malformed token without dot separator', async () => {
    const result = await verifyPreAuthToken('nodot', TEST_SECRET);
    expect(result.valid).toBe(false);
  });
});
