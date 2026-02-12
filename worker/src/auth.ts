// ABOUTME: Authentication and authorization utilities
// ABOUTME: Zendesk JWT, NIP-98, webhook signature, CF Access credential resolution

import { verifyEvent } from 'nostr-tools';
import { type SecretStoreSecret } from './nip86';

// Zendesk JWT payload structure
export interface ZendeskJWTPayload {
  iss: string;
  iat: number;
  exp: number;
  email: string;
  name: string;
  external_id?: string;
}

export interface Nip98Result {
  valid: boolean;
  pubkey?: string;
  error?: string;
}

// Base64URL decode (handles URL-safe base64)
export function base64UrlDecode(str: string): string {
  // Convert base64url to base64
  let base64 = str.replace(/-/g, '+').replace(/_/g, '/');
  // Add padding if needed
  while (base64.length % 4) {
    base64 += '=';
  }
  return atob(base64);
}

// Verify Zendesk JWT token
export async function verifyZendeskJWT(
  request: Request,
  env: { ZENDESK_JWT_SECRET?: string }
): Promise<{ valid: true; payload: ZendeskJWTPayload } | { valid: false; error: string }> {
  const authHeader = request.headers.get('Authorization');

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return { valid: false, error: 'Missing or invalid Authorization header' };
  }

  if (!env.ZENDESK_JWT_SECRET) {
    return { valid: false, error: 'ZENDESK_JWT_SECRET not configured' };
  }

  const token = authHeader.slice(7); // Remove 'Bearer '

  try {
    const [headerB64, payloadB64, signatureB64] = token.split('.');

    if (!headerB64 || !payloadB64 || !signatureB64) {
      return { valid: false, error: 'Invalid JWT format' };
    }

    // Decode and parse payload
    const payloadJson = base64UrlDecode(payloadB64);
    const payload = JSON.parse(payloadJson) as ZendeskJWTPayload;

    // Check expiration
    const now = Math.floor(Date.now() / 1000);
    if (payload.exp && payload.exp < now) {
      return { valid: false, error: 'Token expired' };
    }

    // Check not-before (iat - issued at)
    if (payload.iat && payload.iat > now + 60) {
      // Allow 60s clock skew
      return { valid: false, error: 'Token not yet valid' };
    }

    // Verify signature using HMAC-SHA256
    const data = new TextEncoder().encode(`${headerB64}.${payloadB64}`);
    const key = await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(env.ZENDESK_JWT_SECRET),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['verify']
    );

    // Decode signature from base64url
    const signatureBytes = Uint8Array.from(
      base64UrlDecode(signatureB64),
      (c) => c.charCodeAt(0)
    );

    const valid = await crypto.subtle.verify('HMAC', key, signatureBytes, data);

    if (!valid) {
      return { valid: false, error: 'Invalid signature' };
    }

    return { valid: true, payload };
  } catch (error) {
    console.error('JWT verification error:', error);
    return { valid: false, error: 'JWT verification failed' };
  }
}

// Verify Zendesk webhook signature
export async function verifyZendeskWebhook(
  request: Request,
  body: string,
  secret: string | undefined
): Promise<boolean> {
  if (!secret) {
    console.warn('Zendesk webhook secret not configured');
    return false;
  }

  // Option 1: Simple API key header (X-Webhook-Key)
  const apiKey = request.headers.get('X-Webhook-Key');
  if (apiKey && apiKey === secret) {
    return true;
  }

  // Option 2: Zendesk native webhook signing (X-Zendesk-Webhook-Signature)
  const signature = request.headers.get('X-Zendesk-Webhook-Signature');
  const timestamp = request.headers.get('X-Zendesk-Webhook-Signature-Timestamp');

  if (!signature || !timestamp) {
    return false;
  }

  // Zendesk signs: timestamp + "." + body
  const signedPayload = `${timestamp}.${body}`;

  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );

  const signatureBytes = await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(signedPayload)
  );

  const expectedSig = btoa(String.fromCharCode(...new Uint8Array(signatureBytes)));

  return signature === expectedSig;
}

// Verify NIP-98 HTTP Auth (kind 27235)
// Returns the authenticated pubkey or an error
export async function verifyNip98Auth(
  request: Request,
  expectedUrl: string
): Promise<Nip98Result> {
  const authHeader = request.headers.get('Authorization');
  if (!authHeader || !authHeader.startsWith('Nostr ')) {
    return { valid: false, error: 'Missing or invalid Authorization header (expected: Nostr <base64>)' };
  }

  try {
    const base64Event = authHeader.slice(6); // Remove "Nostr " prefix
    const eventJson = atob(base64Event);
    const event = JSON.parse(eventJson);

    // Verify event structure
    if (event.kind !== 27235) {
      return { valid: false, error: 'Invalid event kind (expected 27235)' };
    }

    // Verify signature
    if (!verifyEvent(event)) {
      return { valid: false, error: 'Invalid event signature' };
    }

    // Check timestamp (allow 60 seconds clock skew)
    const now = Math.floor(Date.now() / 1000);
    if (Math.abs(event.created_at - now) > 60) {
      return { valid: false, error: 'Event timestamp too old or in future' };
    }

    // Verify URL tag
    const urlTag = event.tags.find((t: string[]) => t[0] === 'u');
    if (!urlTag || urlTag[1] !== expectedUrl) {
      return { valid: false, error: `URL mismatch (expected ${expectedUrl})` };
    }

    // Verify method tag
    const methodTag = event.tags.find((t: string[]) => t[0] === 'method');
    if (!methodTag || methodTag[1].toUpperCase() !== request.method) {
      return { valid: false, error: 'Method mismatch' };
    }

    return { valid: true, pubkey: event.pubkey };
  } catch (e) {
    console.error('[verifyNip98Auth] Error:', e);
    return { valid: false, error: 'Failed to parse auth event' };
  }
}

// Resolve CF Access credentials from env (supports both plain strings and SecretStoreSecret bindings)
export async function getCfAccessCredentials(
  env: { CF_ACCESS_CLIENT_ID?: string | SecretStoreSecret; CF_ACCESS_CLIENT_SECRET?: string | SecretStoreSecret }
): Promise<{ clientId: string; clientSecret: string } | null> {
  if (!env.CF_ACCESS_CLIENT_ID || !env.CF_ACCESS_CLIENT_SECRET) return null;

  const clientId = typeof env.CF_ACCESS_CLIENT_ID === 'string'
    ? env.CF_ACCESS_CLIENT_ID
    : await env.CF_ACCESS_CLIENT_ID.get();
  const clientSecret = typeof env.CF_ACCESS_CLIENT_SECRET === 'string'
    ? env.CF_ACCESS_CLIENT_SECRET
    : await env.CF_ACCESS_CLIENT_SECRET.get();

  if (!clientId || !clientSecret) return null;
  return { clientId, clientSecret };
}

// CORS origin matching
export function getAllowedOrigin(requestOrigin: string | null, allowedOriginsEnv: string | undefined): string {
  if (!allowedOriginsEnv?.trim()) return '';

  const allowedOrigins = allowedOriginsEnv.split(',').map(o => o.trim());
  if (!requestOrigin) return allowedOrigins[0] || '';

  for (const allowed of allowedOrigins) {
    if (allowed.startsWith('*.') && requestOrigin.endsWith(allowed.slice(1))) {
      return requestOrigin;
    }
    if (requestOrigin === allowed) {
      return requestOrigin;
    }
  }

  return allowedOrigins[0] || '';
}
