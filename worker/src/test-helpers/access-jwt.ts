// ABOUTME: Signs Cloudflare Access-shaped RS256 JWTs with a throwaway key pair and
// ABOUTME: serves the matching certs, for tests of the worker's Access JWT checks.

import { vi, type Mock } from 'vitest';
import type { FetchFn } from '../access-jwt';

export const TEAM_DOMAIN = 'team.example.com';
export const AUDIENCE = 'aud-api';

function b64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlJson(value: unknown): string {
  return b64url(new TextEncoder().encode(JSON.stringify(value)));
}

export interface AccessJwtSigner {
  // Signs a token. Header and payload fields override the defaults; pass a key
  // set to undefined to drop it from the token.
  sign(opts?: { header?: Record<string, unknown>; payload?: Record<string, unknown> }): Promise<string>;
  // The certs document /cdn-cgi/access/certs would return for this signer.
  certs: { keys: Array<JsonWebKey & { kid: string }> };
  // A fetch double that serves `certs` for any URL.
  fetchFn: Mock<FetchFn>;
}

export async function makeAccessJwtSigner(kid = 'k1'): Promise<AccessJwtSigner> {
  const pair = await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]) },
    true, ['sign', 'verify'],
  ) as CryptoKeyPair;
  const jwk = await crypto.subtle.exportKey('jwk', pair.publicKey) as JsonWebKey;
  const certs = { keys: [{ ...jwk, kid }] };
  const fetchFn = vi.fn<FetchFn>(async () => ({ ok: true, json: async () => certs }));

  async function sign(opts: { header?: Record<string, unknown>; payload?: Record<string, unknown> } = {}) {
    const now = Math.floor(Date.now() / 1000);
    const header = { alg: 'RS256', kid, typ: 'JWT', ...opts.header };
    const payload = {
      iss: `https://${TEAM_DOMAIN}`, aud: [AUDIENCE], exp: now + 600, iat: now,
      email: 'moderator@example.com', ...opts.payload,
    };
    const data = `${b64urlJson(header)}.${b64urlJson(payload)}`;
    const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', pair.privateKey, new TextEncoder().encode(data));
    return `${data}.${b64url(new Uint8Array(sig))}`;
  }

  return { sign, certs, fetchFn };
}
