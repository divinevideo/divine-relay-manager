// ABOUTME: Tests for the shared Cloudflare Access JWT verifier: format, algorithm, signature,
// ABOUTME: then issuer, audience, exp and nbf; plus the certs cache, key import and failure backoff.

import { describe, it, expect, vi, afterEach } from 'vitest';
import { verifyAccessJwt, __resetAccessCertsCacheForTests, type FetchFn } from './access-jwt';
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

  it('honors a signed not-before claim with 30 seconds of clock leeway', async () => {
    const signer = await makeAccessJwtSigner();
    const clock = Date.now();
    const seconds = Math.floor(clock / 1000);
    for (const nbf of [seconds + 31, String(seconds), null]) {
      const onReject = vi.fn();
      expect(await verifyAccessJwt(await signer.sign({ payload: { nbf } }), { ...config, onReject }, signer.fetchFn, () => clock)).toBeNull();
      expect(onReject).toHaveBeenCalledWith('not-yet-valid');
    }
    for (const nbf of [seconds - 1, seconds, seconds + 30]) {
      expect(await verifyAccessJwt(await signer.sign({ payload: { nbf } }), config, signer.fetchFn, () => clock)).not.toBeNull();
    }
  });

  it('checks the signature before the claims, so a forged token never reports a claim reason', async () => {
    const signer = await makeAccessJwtSigner();
    const forger = await makeAccessJwtSigner(); // same kid, different key
    const now = Math.floor(Date.now() / 1000);
    for (const payload of [{ aud: ['aud-other'] }, { iss: 'https://other.example.com' }, { exp: now - 1 }, { nbf: now + 3600 }]) {
      const onReject = vi.fn();
      await verifyAccessJwt(await forger.sign({ payload }), { ...config, onReject }, signer.fetchFn);
      expect(onReject.mock.calls).toEqual([['signature']]);
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
  it('does not let an older in-flight fetch replace newer certs at the same clock tick', async () => {
    const oldSigner = await makeAccessJwtSigner('old');
    const newSigner = await makeAccessJwtSigner('new');
    const clock = Date.now();
    let release!: (response: { ok: boolean; json: () => Promise<typeof oldSigner.certs> }) => void;
    const oldResponse = new Promise<{ ok: boolean; json: () => Promise<typeof oldSigner.certs> }>((resolve) => { release = resolve; });
    const fetchFn = vi.fn().mockImplementationOnce(() => oldResponse)
      .mockImplementation(async () => ({ ok: true, json: async () => newSigner.certs }));
    const oldToken = await oldSigner.sign();
    const newToken = await newSigner.sign();
    const slow = verifyAccessJwt(oldToken, config, fetchFn, () => clock);
    expect(await verifyAccessJwt(newToken, config, fetchFn, () => clock)).not.toBeNull();
    release({ ok: true, json: async () => oldSigner.certs });
    await slow;
    expect(await verifyAccessJwt(newToken, config, fetchFn, () => clock)).not.toBeNull();
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it('does not publish a certs document containing a malformed or unimportable entry', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const signer = await makeAccessJwtSigner();
    const token = await signer.sign();
    let clock = Date.now();
    const now = () => clock;
    for (const badKey of [null, { kid: 'bad', kty: 'RSA' }]) {
      const malformed = vi.fn(async () => ({ ok: true, json: async () => ({ keys: [...signer.certs.keys, badKey] }) }));
      const onReject = vi.fn();
      expect(await verifyAccessJwt(token, { ...config, onReject }, malformed, now)).toBeNull();
      expect(onReject).toHaveBeenCalledWith('certs-unavailable');
      expect(malformed).toHaveBeenCalledTimes(1);
      clock += 10 * 1000;
    }
    expect(await verifyAccessJwt(token, config, signer.fetchFn, now)).not.toBeNull();
    expect(signer.fetchFn).toHaveBeenCalledTimes(1);
  });

  it('refuses a certs document with an entry lacking a usable kid or RSA type, naming it in the log', async () => {
    const signer = await makeAccessJwtSigner();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { kid: _kid, ...kidless } = signer.certs.keys[0];
    for (const bad of [kidless, { ...kidless, kid: '' }, { ...kidless, kid: 123 }, { ...signer.certs.keys[0], kid: 'ec', kty: 'EC' }]) {
      __resetAccessCertsCacheForTests();
      warn.mockClear();
      const fetchFn = vi.fn(async () => ({ ok: true, json: async () => ({ keys: [...signer.certs.keys, bad] }) }));
      const onReject = vi.fn();
      expect(await verifyAccessJwt(await signer.sign(), { ...config, onReject }, fetchFn)).toBeNull();
      expect(onReject).toHaveBeenCalledWith('certs-unavailable');
      expect(warn).toHaveBeenCalledWith('[auth] Access certs fetch failed: invalid key entry');
    }
  });

  it('refuses once the hour is up and the refetch fails, rather than trusting the old keys', async () => {
    const signer = await makeAccessJwtSigner();
    const token = await signer.sign({ payload: { exp: Math.floor(Date.now() / 1000) + 3 * 3600 } });
    let clock = Date.now();
    const now = () => clock;
    let up = true;
    const fetchFn = vi.fn(async () => (up ? { ok: true, json: async () => signer.certs } : { ok: false, json: async () => ({}) }));
    const onReject = vi.fn();
    expect(await verifyAccessJwt(token, config, fetchFn, now)).not.toBeNull();
    up = false;
    clock += 61 * 60 * 1000;
    expect(await verifyAccessJwt(token, { ...config, onReject }, fetchFn, now)).toBeNull();
    expect(onReject).toHaveBeenCalledWith('certs-unavailable');
  });

  it('backs off for 10 seconds after a failed certs fetch, then tries again', async () => {
    const signer = await makeAccessJwtSigner();
    const token = await signer.sign();
    let clock = Date.now();
    const now = () => clock;
    let up = false;
    const fetchFn = vi.fn(async () => (up ? { ok: true, json: async () => signer.certs } : { ok: false, status: 503, json: async () => ({}) }));
    for (let i = 0; i < 25; i++) {
      const onReject = vi.fn();
      expect(await verifyAccessJwt(token, { ...config, onReject }, fetchFn, now)).toBeNull();
      expect(onReject).toHaveBeenCalledWith('certs-unavailable');
      clock += 300;
    }
    expect(fetchFn).toHaveBeenCalledTimes(1);
    clock += 10 * 1000;
    expect(await verifyAccessJwt(token, config, fetchFn, now)).toBeNull();
    expect(fetchFn).toHaveBeenCalledTimes(2);
    up = true;
    clock += 10 * 1000;
    expect(await verifyAccessJwt(token, config, fetchFn, now)).not.toBeNull();
    expect(fetchFn).toHaveBeenCalledTimes(3);
  });

  it('allows one retry per backoff window while the certs endpoint hangs', async () => {
    const signer = await makeAccessJwtSigner();
    const token = await signer.sign();
    let clock = Date.now();
    const now = () => clock;
    let settle: (res: { ok: boolean; status?: number; json: () => Promise<unknown> }) => void = () => {};
    const fetchFn = vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 503, json: async () => ({}) })
      .mockImplementationOnce(() => new Promise((resolve) => { settle = resolve; }));
    expect(await verifyAccessJwt(token, config, fetchFn, now)).toBeNull();
    clock += 10 * 1000;
    const retry = verifyAccessJwt(token, config, fetchFn, now);
    for (let i = 0; i < 10; i++) {
      clock += 300;
      expect(await verifyAccessJwt(token, config, fetchFn, now)).toBeNull();
    }
    expect(fetchFn).toHaveBeenCalledTimes(2);
    settle({ ok: true, json: async () => signer.certs });
    expect(await retry).not.toBeNull();
    expect(await verifyAccessJwt(token, config, fetchFn, now)).not.toBeNull();
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it('clears the backoff once a fetch succeeds, so a later hourly refresh refuses no one', async () => {
    const signer = await makeAccessJwtSigner();
    const token = await signer.sign({ payload: { exp: Math.floor(Date.now() / 1000) + 3 * 3600 } });
    let clock = Date.now();
    const now = () => clock;
    let settle: () => void = () => {};
    // Concurrent requests on an expired cache each fetch, so every later call answers healthily.
    const fetchFn = vi.fn<FetchFn>(async () => ({ ok: true, json: async () => signer.certs }))
      .mockResolvedValueOnce({ ok: false, status: 503, json: async () => ({}) })
      .mockResolvedValueOnce({ ok: true, json: async () => signer.certs })
      .mockImplementationOnce(() => new Promise((resolve) => { settle = () => resolve({ ok: true, json: async () => signer.certs }); }));
    expect(await verifyAccessJwt(token, config, fetchFn, now)).toBeNull();
    clock += 10 * 1000;
    expect(await verifyAccessJwt(token, config, fetchFn, now)).not.toBeNull();
    clock += 61 * 60 * 1000;
    const refresh = verifyAccessJwt(token, config, fetchFn, now);
    const concurrent = [1, 2, 3].map(() => verifyAccessJwt(token, config, fetchFn, now));
    settle();
    expect(await refresh).not.toBeNull();
    for (const result of await Promise.all(concurrent)) expect(result).not.toBeNull();
  });

  it('ignores a failure from before the cache expired at the next hourly refresh', async () => {
    const signer = await makeAccessJwtSigner('real');
    const token = await signer.sign({ payload: { exp: Math.floor(Date.now() / 1000) + 3 * 3600 } });
    let clock = Date.now();
    const now = () => clock;
    const expiredRefresh = async (fetchFn: FetchFn) => {
      clock += 61 * 60 * 1000;
      const results = await Promise.all([1, 2, 3, 4].map(() => verifyAccessJwt(token, config, fetchFn, now)));
      for (const result of results) expect(result).not.toBeNull();
    };
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    // An unknown-kid refetch fails while the cache is fresh.
    let up = true;
    const blip = vi.fn<FetchFn>(async () => (up ? { ok: true, json: async () => signer.certs } : { ok: false, status: 503, json: async () => ({}) }));
    expect(await verifyAccessJwt(token, config, blip, now)).not.toBeNull();
    clock += 30 * 60 * 1000;
    up = false;
    expect(await verifyAccessJwt(await signer.sign({ header: { kid: 'forged' } }), config, blip, now)).toBeNull();
    up = true;
    await expiredRefresh(blip);

    // On a cold cache, one concurrent fetch fails after another has succeeded.
    __resetAccessCertsCacheForTests();
    let failLate: () => void = () => {};
    const race = vi.fn<FetchFn>(async () => ({ ok: true, json: async () => signer.certs }))
      .mockImplementationOnce(() => new Promise((resolve) => { failLate = () => resolve({ ok: false, status: 503, json: async () => ({}) }); }));
    const late = verifyAccessJwt(token, config, race, now);
    expect(await verifyAccessJwt(token, config, race, now)).not.toBeNull();
    failLate();
    await late;
    await expiredRefresh(race);
  });

  it('backs off after the hourly refresh fails, as on a cold cache', async () => {
    const signer = await makeAccessJwtSigner();
    const token = await signer.sign({ payload: { exp: Math.floor(Date.now() / 1000) + 3 * 3600 } });
    let clock = Date.now();
    const now = () => clock;
    let up = true;
    const fetchFn = vi.fn<FetchFn>(async () => (up ? { ok: true, json: async () => signer.certs } : { ok: false, status: 503, json: async () => ({}) }));
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(await verifyAccessJwt(token, config, fetchFn, now)).not.toBeNull();
    up = false;
    clock += 61 * 60 * 1000;
    for (let i = 0; i < 5; i++) {
      expect(await verifyAccessJwt(token, config, fetchFn, now)).toBeNull();
      clock += 1000;
    }
    expect(fetchFn).toHaveBeenCalledTimes(2);
    up = true;
    clock += 10 * 1000;
    expect(await verifyAccessJwt(token, config, fetchFn, now)).not.toBeNull();
    expect(fetchFn).toHaveBeenCalledTimes(3);
  });

  it('starts the backoff only once a fetch has failed, so requests during the first fetch are not refused', async () => {
    const signer = await makeAccessJwtSigner();
    const token = await signer.sign();
    const pending: Array<() => void> = [];
    const fetchFn = vi.fn(() => new Promise<{ ok: boolean; json: () => Promise<unknown> }>((resolve) => {
      pending.push(() => resolve({ ok: true, json: async () => signer.certs }));
    }));
    const results = Array.from({ length: 3 }, () => verifyAccessJwt(token, config, fetchFn));
    expect(fetchFn).toHaveBeenCalledTimes(3);
    pending.forEach((release) => release());
    expect((await Promise.all(results)).every((claims) => claims !== null)).toBe(true);
  });

  it('logs why a certs fetch failed, never the token', async () => {
    const signer = await makeAccessJwtSigner();
    const token = await signer.sign();
    let clock = Date.now();
    const now = () => clock;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await verifyAccessJwt(token, config, vi.fn(async () => ({ ok: false, status: 503, json: async () => ({}) })), now);
    expect(warn).toHaveBeenCalledWith('[auth] Access certs fetch failed: HTTP 503');
    clock += 10 * 1000;
    await verifyAccessJwt(token, config, vi.fn(async () => { throw new TypeError('network'); }), now);
    expect(warn).toHaveBeenCalledWith('[auth] Access certs fetch failed: TypeError');
    expect(warn.mock.calls.flat().join(' ')).not.toContain(token.split('.')[2]);
  });

  it('reports a failed unknown-kid refetch as certs-unavailable, and the rate-limited case as unknown-key', async () => {
    const signer = await makeAccessJwtSigner('real');
    let clock = Date.now();
    const now = () => clock;
    let up = true;
    const fetchFn = vi.fn(async () => (up ? { ok: true, json: async () => signer.certs } : { ok: false, json: async () => ({}) }));
    expect(await verifyAccessJwt(await signer.sign(), config, fetchFn, now)).not.toBeNull();
    up = false;
    clock += 61 * 1000;
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const refetched = vi.fn();
    await verifyAccessJwt(await signer.sign({ header: { kid: 'rotated' } }), { ...config, onReject: refetched }, fetchFn, now);
    expect(refetched).toHaveBeenCalledWith('certs-unavailable');
    const limited = vi.fn();
    await verifyAccessJwt(await signer.sign({ header: { kid: 'rotated' } }), { ...config, onReject: limited }, fetchFn, now);
    expect(limited).toHaveBeenCalledWith('unknown-key');
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it('imports each key once per fetch, not on every request', async () => {
    const signer = await makeAccessJwtSigner();
    const importKey = vi.spyOn(crypto.subtle, 'importKey');
    let clock = Date.now();
    const now = () => clock;
    const token = await signer.sign({ payload: { exp: Math.floor(Date.now() / 1000) + 3 * 3600 } });
    for (let i = 0; i < 20; i++) {
      expect(await verifyAccessJwt(token, config, signer.fetchFn, now)).not.toBeNull();
      clock += 2 * 60 * 1000;
    }
    expect(signer.fetchFn).toHaveBeenCalledTimes(1);
    expect(importKey).toHaveBeenCalledTimes(1);
  });

  it('refuses when the certs fetch fails, and does not cache the failure', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const signer = await makeAccessJwtSigner();
    const token = await signer.sign();
    let clock = Date.now();
    const now = () => clock;
    const failing = vi.fn(async () => ({ ok: false, json: async () => ({}) }));
    expect(await verifyAccessJwt(token, config, failing, now)).toBeNull();
    clock += 10 * 1000;
    const throwing = vi.fn(async () => { throw new Error('network'); });
    expect(await verifyAccessJwt(token, config, throwing, now)).toBeNull();
    expect(throwing).toHaveBeenCalledTimes(1);
    clock += 10 * 1000;
    expect(await verifyAccessJwt(token, config, signer.fetchFn, now)).not.toBeNull();
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
    let clock = Date.now();
    const now = () => clock;
    const onReject = vi.fn();
    const empty = vi.fn(async () => ({ ok: true, json: async () => ({ keys: [] }) }));
    expect(await verifyAccessJwt(token, { ...config, onReject }, empty, now)).toBeNull();
    expect(onReject).toHaveBeenCalledWith('certs-unavailable');
    clock += 10 * 1000;
    expect(await verifyAccessJwt(token, config, signer.fetchFn, now)).not.toBeNull();
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
