// ABOUTME: Tests for the shared Cloudflare Access JWT verifier: signature, issuer,
// ABOUTME: audience, expiry and algorithm checks, plus the per-isolate certs cache.

import { describe, it, expect, vi, afterEach } from 'vitest';
import { verifyAccessJwt, __resetAccessCertsCacheForTests } from './access-jwt';
import { makeAccessJwtSigner, TEAM_DOMAIN, AUDIENCE } from './test-helpers/access-jwt';

const config = { teamDomain: TEAM_DOMAIN, audience: AUDIENCE };

afterEach(() => {
  __resetAccessCertsCacheForTests();
  vi.restoreAllMocks();
});

describe('verifyAccessJwt', () => {
  it('returns the verified claims for a valid token', async () => {
    const signer = await makeAccessJwtSigner();
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    const claims = await verifyAccessJwt(await signer.sign(), config, signer.fetchFn);
    expect(claims).toMatchObject({ iss: `https://${TEAM_DOMAIN}`, aud: [AUDIENCE], email: 'moderator@example.com' });
    expect(signer.fetchFn).toHaveBeenCalledWith(
      `https://${TEAM_DOMAIN}/cdn-cgi/access/certs`, { signal: expect.any(AbortSignal) },
    );
    // A hung certs endpoint is abandoned after 5 seconds.
    expect(timeout).toHaveBeenCalledWith(5000);
  });

  it('returns common_name and no email for a service-token token', async () => {
    const signer = await makeAccessJwtSigner();
    const token = await signer.sign({ payload: { email: undefined, common_name: 'client-id.access', sub: '' } });
    const claims = await verifyAccessJwt(token, config, signer.fetchFn);
    expect(claims?.common_name).toBe('client-id.access');
    expect(claims?.sub).toBe('');
    expect(claims?.email).toBeUndefined();
  });

  it('accepts aud as a single string', async () => {
    const signer = await makeAccessJwtSigner();
    const token = await signer.sign({ payload: { aud: AUDIENCE } });
    expect(await verifyAccessJwt(token, config, signer.fetchFn)).toMatchObject({ aud: [AUDIENCE] });
  });

  it('rejects a signature with one byte changed', async () => {
    const signer = await makeAccessJwtSigner();
    const [h, p, sig] = (await signer.sign()).split('.');
    const bytes = Uint8Array.from(atob(sig.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
    bytes[10] ^= 0x01;
    const flipped = btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    const onReject = vi.fn();
    expect(await verifyAccessJwt(`${h}.${p}.${flipped}`, { ...config, onReject }, signer.fetchFn)).toBeNull();
    expect(onReject).toHaveBeenCalledWith('signature');
  });

  it('rejects a token signed by a key the certs do not list', async () => {
    const signer = await makeAccessJwtSigner();
    const forger = await makeAccessJwtSigner(); // same kid, different key
    expect(await verifyAccessJwt(await forger.sign(), config, signer.fetchFn)).toBeNull();
  });

  it('rejects the wrong issuer', async () => {
    const signer = await makeAccessJwtSigner();
    const token = await signer.sign({ payload: { iss: 'https://other.cloudflareaccess.com' } });
    expect(await verifyAccessJwt(token, config, signer.fetchFn)).toBeNull();
  });

  it('rejects another application\'s audience, as a string or an array', async () => {
    const signer = await makeAccessJwtSigner();
    for (const aud of ['aud-consent', ['aud-consent'], []]) {
      const token = await signer.sign({ payload: { aud } });
      expect(await verifyAccessJwt(token, config, signer.fetchFn)).toBeNull();
    }
  });

  it('rejects an expired, a missing, or a non-numeric exp', async () => {
    const signer = await makeAccessJwtSigner();
    const now = Math.floor(Date.now() / 1000);
    for (const exp of [now - 1, now, undefined, String(now + 600)]) {
      const token = await signer.sign({ payload: { exp } });
      expect(await verifyAccessJwt(token, config, signer.fetchFn)).toBeNull();
    }
  });

  it('rejects any algorithm but RS256, and a missing kid', async () => {
    const signer = await makeAccessJwtSigner();
    for (const header of [{ alg: 'none' }, { alg: 'HS256' }, { alg: 'RS512' }, { kid: undefined }]) {
      const token = await signer.sign({ header });
      expect(await verifyAccessJwt(token, config, signer.fetchFn)).toBeNull();
    }
  });

  it('rejects a token without a kid even when a certs key has none', async () => {
    const signer = await makeAccessJwtSigner();
    const kidless = { keys: signer.certs.keys.map(({ kid: _kid, ...k }) => k) };
    const fetchFn = vi.fn(async () => ({ ok: true, json: async () => kidless }));
    const token = await signer.sign({ header: { kid: undefined } });
    expect(await verifyAccessJwt(token, config, fetchFn)).toBeNull();
  });

  it('rejects malformed tokens', async () => {
    const signer = await makeAccessJwtSigner();
    for (const token of ['test', 'a.b', 'a.b.c', '..', `${(await signer.sign()).split('.').slice(0, 2).join('.')}.`]) {
      expect(await verifyAccessJwt(token, config, signer.fetchFn)).toBeNull();
    }
  });

  it('rejects a valid token with anything appended or non-base64url characters', async () => {
    const signer = await makeAccessJwtSigner();
    const token = await signer.sign();
    const [h, p, sig] = token.split('.');
    for (const variant of [`${token}.junk`, `${h}.${p}.+${sig}`, ` ${token}`, `${h}.${p}.${sig}=`]) {
      const onReject = vi.fn();
      expect(await verifyAccessJwt(variant, { ...config, onReject }, signer.fetchFn)).toBeNull();
      expect(onReject).toHaveBeenCalledWith('malformed');
    }
  });

  it('names the reason for each refusal', async () => {
    const signer = await makeAccessJwtSigner();
    const now = Math.floor(Date.now() / 1000);
    const cases: Array<[string, Promise<string>]> = [
      ['algorithm', signer.sign({ header: { alg: 'HS256' } })],
      ['issuer', signer.sign({ payload: { iss: 'https://other.example.com' } })],
      ['audience', signer.sign({ payload: { aud: ['aud-other'] } })],
      ['expired', signer.sign({ payload: { exp: now - 1 } })],
      ['unknown-key', signer.sign({ header: { kid: 'not-published' } })],
      ['malformed', signer.sign({ header: { kid: undefined } })],
    ];
    for (const [reason, tokenPromise] of cases) {
      const onReject = vi.fn();
      await verifyAccessJwt(await tokenPromise, { ...config, onReject }, signer.fetchFn);
      expect(onReject).toHaveBeenCalledWith(reason);
    }
    const onReject = vi.fn();
    await verifyAccessJwt(await signer.sign(), { teamDomain: TEAM_DOMAIN, onReject }, signer.fetchFn);
    expect(onReject).toHaveBeenCalledWith('not-configured');
  });

  it('refuses without a team domain, an audience or a token, and does not fetch certs', async () => {
    const signer = await makeAccessJwtSigner();
    const token = await signer.sign();
    expect(await verifyAccessJwt(token, { audience: AUDIENCE }, signer.fetchFn)).toBeNull();
    expect(await verifyAccessJwt(token, { teamDomain: TEAM_DOMAIN }, signer.fetchFn)).toBeNull();
    expect(await verifyAccessJwt(token, { teamDomain: TEAM_DOMAIN, audience: '' }, signer.fetchFn)).toBeNull();
    expect(await verifyAccessJwt('', config, signer.fetchFn)).toBeNull();
    expect(signer.fetchFn).not.toHaveBeenCalled();
  });

  it('accepts nothing when a setting is unset or empty, even a token shaped to match it', async () => {
    const signer = await makeAccessJwtSigner();
    const forUnsetTeam = await signer.sign({ payload: { iss: 'https://undefined' } });
    expect(await verifyAccessJwt(forUnsetTeam, { audience: AUDIENCE }, signer.fetchFn)).toBeNull();
    const forEmptyAudience = await signer.sign({ payload: { aud: [''] } });
    expect(await verifyAccessJwt(forEmptyAudience, { teamDomain: TEAM_DOMAIN, audience: '' }, signer.fetchFn)).toBeNull();
  });
});

describe('certs cache', () => {
  it('refuses when the certs fetch fails, and does not cache the failure', async () => {
    const signer = await makeAccessJwtSigner();
    const token = await signer.sign();
    const failing = vi.fn(async () => ({ ok: false, json: async () => ({}) }));
    expect(await verifyAccessJwt(token, config, failing)).toBeNull();
    const throwing = vi.fn(async () => { throw new Error('network'); });
    expect(await verifyAccessJwt(token, config, throwing)).toBeNull();
    expect(await verifyAccessJwt(token, config, signer.fetchFn)).not.toBeNull();
    expect(signer.fetchFn).toHaveBeenCalledTimes(1);
  });

  it('refuses a non-2xx certs response even when its body lists the key', async () => {
    const signer = await makeAccessJwtSigner();
    const fetchFn = vi.fn(async () => ({ ok: false, json: async () => signer.certs }));
    expect(await verifyAccessJwt(await signer.sign(), config, fetchFn)).toBeNull();
  });

  it('does not cache an empty key set', async () => {
    const signer = await makeAccessJwtSigner();
    const token = await signer.sign();
    const onReject = vi.fn();
    const empty = vi.fn(async () => ({ ok: true, json: async () => ({ keys: [] }) }));
    expect(await verifyAccessJwt(token, { ...config, onReject }, empty)).toBeNull();
    expect(onReject).toHaveBeenCalledWith('certs-unavailable');
    expect(await verifyAccessJwt(token, config, signer.fetchFn)).not.toBeNull();
  });

  it('names an unreachable certs endpoint as the reason', async () => {
    const signer = await makeAccessJwtSigner();
    const onReject = vi.fn();
    const failing = vi.fn(async () => ({ ok: false, json: async () => ({}) }));
    await verifyAccessJwt(await signer.sign(), { ...config, onReject }, failing);
    expect(onReject).toHaveBeenCalledWith('certs-unavailable');
  });

  it('limits unknown-kid refetches to one a minute even while the refetch fails', async () => {
    const signer = await makeAccessJwtSigner('real');
    let clock = Date.now();
    const now = () => clock;
    let up = true;
    const fetchFn = vi.fn(async () => (up ? { ok: true, json: async () => signer.certs } : { ok: false, json: async () => ({}) }));
    expect(await verifyAccessJwt(await signer.sign(), config, fetchFn, now)).not.toBeNull();
    up = false;
    clock += 61 * 1000;
    for (const kid of ['random-1', 'random-2', 'random-3']) {
      expect(await verifyAccessJwt(await signer.sign({ header: { kid } }), config, fetchFn, now)).toBeNull();
    }
    expect(fetchFn).toHaveBeenCalledTimes(2);
    // The cached keys still verify real tokens meanwhile.
    expect(await verifyAccessJwt(await signer.sign(), config, fetchFn, now)).not.toBeNull();
  });

  it('lets only one of many concurrent unknown-kid requests refetch', async () => {
    const signer = await makeAccessJwtSigner('real');
    let clock = Date.now();
    const now = () => clock;
    expect(await verifyAccessJwt(await signer.sign(), config, signer.fetchFn, now)).not.toBeNull();
    clock += 61 * 1000;
    const forged = await Promise.all(Array.from({ length: 20 }, (_, i) => signer.sign({ header: { kid: `random-${i}` } })));
    const results = await Promise.all(forged.map((t) => verifyAccessJwt(t, config, signer.fetchFn, now)));
    expect(results.every((r) => r === null)).toBe(true);
    expect(signer.fetchFn).toHaveBeenCalledTimes(2);
  });

  it('fetches certs once within the hour and again after it', async () => {
    const signer = await makeAccessJwtSigner();
    const token = await signer.sign({ payload: { exp: Math.floor(Date.now() / 1000) + 3 * 3600 } });
    let clock = Date.now();
    const now = () => clock;
    expect(await verifyAccessJwt(token, config, signer.fetchFn, now)).not.toBeNull();
    clock += 59 * 60 * 1000;
    expect(await verifyAccessJwt(token, config, signer.fetchFn, now)).not.toBeNull();
    expect(signer.fetchFn).toHaveBeenCalledTimes(1);
    clock += 2 * 60 * 1000;
    expect(await verifyAccessJwt(token, config, signer.fetchFn, now)).not.toBeNull();
    expect(signer.fetchFn).toHaveBeenCalledTimes(2);
  });

  it('refetches once for an unknown kid, so a rotated key is picked up', async () => {
    const oldSigner = await makeAccessJwtSigner('old');
    const newSigner = await makeAccessJwtSigner('new');
    let clock = Date.now();
    const now = () => clock;
    let served = oldSigner.certs;
    const fetchFn = vi.fn(async () => ({ ok: true, json: async () => served }));
    expect(await verifyAccessJwt(await oldSigner.sign(), config, fetchFn, now)).not.toBeNull();
    served = { keys: [...oldSigner.certs.keys, ...newSigner.certs.keys] };
    clock += 61 * 1000;
    expect(await verifyAccessJwt(await newSigner.sign(), config, fetchFn, now)).not.toBeNull();
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it('does not refetch for an unknown kid straight after fetching the certs', async () => {
    const signer = await makeAccessJwtSigner('real');
    const token = await signer.sign({ header: { kid: 'random' } });
    expect(await verifyAccessJwt(token, config, signer.fetchFn)).toBeNull();
    expect(signer.fetchFn).toHaveBeenCalledTimes(1);
  });

  it('refetches for unknown kids at most once a minute', async () => {
    const signer = await makeAccessJwtSigner('real');
    let clock = Date.now();
    const now = () => clock;
    expect(await verifyAccessJwt(await signer.sign(), config, signer.fetchFn, now)).not.toBeNull();
    clock += 61 * 1000;
    expect(await verifyAccessJwt(await signer.sign({ header: { kid: 'random-1' } }), config, signer.fetchFn, now)).toBeNull();
    expect(await verifyAccessJwt(await signer.sign({ header: { kid: 'random-2' } }), config, signer.fetchFn, now)).toBeNull();
    expect(signer.fetchFn).toHaveBeenCalledTimes(2);
    clock += 61 * 1000;
    expect(await verifyAccessJwt(await signer.sign({ header: { kid: 'random-3' } }), config, signer.fetchFn, now)).toBeNull();
    expect(signer.fetchFn).toHaveBeenCalledTimes(3);
  });

  it('keeps a separate cache per team domain', async () => {
    const a = await makeAccessJwtSigner();
    const b = await makeAccessJwtSigner();
    expect(await verifyAccessJwt(await a.sign(), config, a.fetchFn)).not.toBeNull();
    const otherTeam = 'other.example.com';
    const token = await b.sign({ payload: { iss: `https://${otherTeam}` } });
    expect(await verifyAccessJwt(token, { teamDomain: otherTeam, audience: AUDIENCE }, b.fetchFn)).not.toBeNull();
  });
});
