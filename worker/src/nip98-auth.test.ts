import { describe, expect, it } from 'vitest';
import { finalizeEvent, generateSecretKey } from 'nostr-tools';
import { verifyNip98Auth } from './index';

const OWN = 'https://api-relay-prod.divine.video/v1/account/moderation-status';
const PUBLIC_HOST = 'api.divine.video';
const PUBLIC = 'https://api.divine.video/v1/account/moderation-status';

type EvtOverrides = { u: string; method: string; createdAt?: number };

// Build a signed kind-27235 event (mirrors nip86.ts:99-112, minus the payload tag).
function signEvent(o: EvtOverrides) {
  const sk = generateSecretKey();
  return finalizeEvent(
    {
      kind: 27235,
      content: '',
      tags: [['u', o.u], ['method', o.method]],
      created_at: o.createdAt ?? Math.floor(Date.now() / 1000),
    },
    sk,
  );
}

function toHeader(evt: unknown): string {
  return 'Nostr ' + btoa(JSON.stringify(evt));
}

// A request that arrives at the worker's OWN host (the forwarded-request scenario).
function reqAtOwnHost(authHeader: string, method = 'GET'): Request {
  return new Request(OWN, { method, headers: { Authorization: authHeader } });
}

describe('verifyNip98Auth host allowlist', () => {
  it('accepts own host arriving at own host (regression: new builds keep working)', async () => {
    const evt = signEvent({ u: OWN, method: 'GET' });
    const res = await verifyNip98Auth(reqAtOwnHost(toHeader(evt)), OWN, [PUBLIC_HOST]);
    expect(res.valid).toBe(true);
    expect(res.pubkey).toBe(evt.pubkey);
  });

  it('accepts a public host that is in the allowlist (the fix)', async () => {
    const evt = signEvent({ u: PUBLIC, method: 'GET' });
    const res = await verifyNip98Auth(reqAtOwnHost(toHeader(evt)), OWN, [PUBLIC_HOST]);
    expect(res.valid).toBe(true);
    expect(res.pubkey).toBe(evt.pubkey);
  });

  it('rejects a host that is NOT in the allowlist', async () => {
    const evt = signEvent({ u: 'https://evil.example/v1/account/moderation-status', method: 'GET' });
    const res = await verifyNip98Auth(reqAtOwnHost(toHeader(evt)), OWN, [PUBLIC_HOST]);
    expect(res.valid).toBe(false);
  });

  it('rejects an allowlisted host with the WRONG path (path stays bound)', async () => {
    const evt = signEvent({ u: 'https://api.divine.video/v1/account/OTHER', method: 'GET' });
    const res = await verifyNip98Auth(reqAtOwnHost(toHeader(evt)), OWN, [PUBLIC_HOST]);
    expect(res.valid).toBe(false);
  });

  it('rejects an allowlisted host with the WRONG method (method stays bound)', async () => {
    const evt = signEvent({ u: PUBLIC, method: 'POST' });
    const res = await verifyNip98Auth(reqAtOwnHost(toHeader(evt), 'GET'), OWN, [PUBLIC_HOST]);
    expect(res.valid).toBe(false);
  });

  it('rejects an allowlisted host with the WRONG scheme (http vs https — scheme not dropped)', async () => {
    const evt = signEvent({ u: 'http://api.divine.video/v1/account/moderation-status', method: 'GET' });
    const res = await verifyNip98Auth(reqAtOwnHost(toHeader(evt)), OWN, [PUBLIC_HOST]);
    expect(res.valid).toBe(false);
  });

  it('rejects an expired event (freshness unchanged)', async () => {
    const evt = signEvent({ u: PUBLIC, method: 'GET', createdAt: Math.floor(Date.now() / 1000) - 120 });
    const res = await verifyNip98Auth(reqAtOwnHost(toHeader(evt)), OWN, [PUBLIC_HOST]);
    expect(res.valid).toBe(false);
  });

  it('rejects an invalid signature (signature check unchanged)', async () => {
    const evt = signEvent({ u: PUBLIC, method: 'GET' });
    const tampered = { ...evt, sig: '0'.repeat(128) };
    const res = await verifyNip98Auth(reqAtOwnHost(toHeader(tampered)), OWN, [PUBLIC_HOST]);
    expect(res.valid).toBe(false);
  });

  it('SCOPE BOUNDARY: a Zendesk-style call (no allowedHosts) rejects the public host', async () => {
    // Mirrors the Zendesk pre-auth call site (index.ts:2442), which passes NO third arg.
    const evt = signEvent({ u: PUBLIC, method: 'GET' });
    const res = await verifyNip98Auth(reqAtOwnHost(toHeader(evt)), OWN);
    expect(res.valid).toBe(false);
    // Mutation check: temporarily pass [PUBLIC_HOST] as the 3rd arg here and this
    // assertion flips to valid — proving the test detects the scope boundary.
  });

  it('empty/unset allowlist ⇒ own host still valid, public host rejected', async () => {
    const ownEvt = signEvent({ u: OWN, method: 'GET' });
    const ownRes = await verifyNip98Auth(reqAtOwnHost(toHeader(ownEvt)), OWN, []);
    expect(ownRes.valid).toBe(true);

    const pubEvt = signEvent({ u: PUBLIC, method: 'GET' });
    const pubRes = await verifyNip98Auth(reqAtOwnHost(toHeader(pubEvt)), OWN, []);
    expect(pubRes.valid).toBe(false);
  });

  it('rejects a userinfo/credential-prefixed host that resolves to a foreign hostname (no .host bypass)', async () => {
    // `URL.hostname` of this is `evil.com` — the `api-relay-prod.divine.video@` part
    // is userinfo, not host. A refactor to `.host` or a naive string split/includes
    // check could be fooled into treating this as the allowlisted own host.
    const evt = signEvent({
      u: 'https://api-relay-prod.divine.video@evil.com/v1/account/moderation-status',
      method: 'GET',
    });
    const res = await verifyNip98Auth(reqAtOwnHost(toHeader(evt)), OWN, [PUBLIC_HOST]);
    expect(res.valid).toBe(false);
  });
});
