// ABOUTME: Pre-auth token generation and verification for Zendesk JWT hardening
// ABOUTME: Produces nonce-bound, HMAC-signed tokens that replace raw npub as user_token

const TOKEN_TTL_SECONDS = 300; // 5 minutes
const TOKEN_PURPOSE = 'zendesk-pre-auth';

interface PreAuthPayload {
  pubkey: string;
  nonce: string;
  exp: number;
  purpose: string;
}

interface GenerateResult {
  token: string;
  nonce: string;
  expiresAt: number;
}

interface VerifyResult {
  valid: boolean;
  pubkey?: string;
  nonce?: string;
  error?: string;
}

function base64UrlEncode(data: string): string {
  return btoa(data)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function base64UrlDecode(str: string): string {
  let base64 = str.replace(/-/g, '+').replace(/_/g, '/');
  while (base64.length % 4) {
    base64 += '=';
  }
  return atob(base64);
}

async function hmacSign(data: string, secret: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sigBytes = await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(data)
  );
  return new Uint8Array(sigBytes);
}

async function hmacVerify(data: string, signature: Uint8Array, secret: string): Promise<boolean> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['verify']
  );
  return crypto.subtle.verify(
    'HMAC',
    key,
    signature,
    new TextEncoder().encode(data)
  );
}

export async function generatePreAuthToken(pubkey: string, secret: string): Promise<GenerateResult> {
  const nonce = crypto.randomUUID();
  const expiresAt = Math.floor(Date.now() / 1000) + TOKEN_TTL_SECONDS;

  const payload: PreAuthPayload = {
    pubkey,
    nonce,
    exp: expiresAt,
    purpose: TOKEN_PURPOSE,
  };

  const payloadB64 = base64UrlEncode(JSON.stringify(payload));
  const sigBytes = await hmacSign(payloadB64, secret);
  const sigB64 = base64UrlEncode(String.fromCharCode(...sigBytes));

  return {
    token: `${payloadB64}.${sigB64}`,
    nonce,
    expiresAt,
  };
}

export async function verifyPreAuthToken(token: string, secret: string): Promise<VerifyResult> {
  const dotIndex = token.indexOf('.');
  if (dotIndex === -1) {
    return { valid: false, error: 'Malformed token: no dot separator' };
  }

  const payloadB64 = token.substring(0, dotIndex);
  const sigB64 = token.substring(dotIndex + 1);

  // Verify HMAC signature (constant-time via crypto.subtle.verify)
  let sigBytes: Uint8Array;
  try {
    const sigStr = base64UrlDecode(sigB64);
    sigBytes = new Uint8Array(sigStr.length);
    for (let i = 0; i < sigStr.length; i++) {
      sigBytes[i] = sigStr.charCodeAt(i);
    }
  } catch {
    return { valid: false, error: 'Malformed token: invalid signature encoding' };
  }

  const signatureValid = await hmacVerify(payloadB64, sigBytes, secret);
  if (!signatureValid) {
    return { valid: false, error: 'Invalid HMAC signature' };
  }

  // Decode and validate payload
  let payload: PreAuthPayload;
  try {
    payload = JSON.parse(base64UrlDecode(payloadB64));
  } catch {
    return { valid: false, error: 'Malformed token: invalid payload' };
  }

  if (payload.purpose !== TOKEN_PURPOSE) {
    return { valid: false, error: `Invalid purpose: expected ${TOKEN_PURPOSE}` };
  }

  const now = Math.floor(Date.now() / 1000);
  if (payload.exp <= now) {
    return { valid: false, error: 'Token expired' };
  }

  return {
    valid: true,
    pubkey: payload.pubkey,
    nonce: payload.nonce,
  };
}

export { TOKEN_PURPOSE, TOKEN_TTL_SECONDS };
export type { PreAuthPayload, GenerateResult, VerifyResult };
