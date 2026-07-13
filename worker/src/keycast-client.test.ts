import { afterEach, describe, expect, it, vi, beforeEach } from 'vitest';
import { suspendUser, unsuspendUser, banUser, clearVerifiedMinor, getUserStatus, createMinorAccount, type KeycastEnv } from './keycast-client';

const VALID_PUBKEY = 'a'.repeat(64);

function makeEnv(overrides: Partial<KeycastEnv> = {}): KeycastEnv {
  return {
    KEYCAST_URL: 'https://login.test.divine.video',
    KEYCAST_SERVICE_TOKEN: 'test-service-token',
    ...overrides,
  };
}

describe('keycast-client', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: () => Promise.resolve(''),
    });
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe('suspendUser', () => {
    it('sends PUT with status suspended and reason', async () => {
      const result = await suspendUser(VALID_PUBKEY, 'age_review', makeEnv());
      expect(result).toEqual({ success: true });
      expect(fetchMock).toHaveBeenCalledOnce();
      const [url, opts] = fetchMock.mock.calls[0];
      expect(url).toBe(`https://login.test.divine.video/api/admin/users/${VALID_PUBKEY}/status`);
      expect(opts.method).toBe('PUT');
      expect(JSON.parse(opts.body)).toEqual({ status: 'suspended', reason: 'age_review' });
      expect(opts.headers['Authorization']).toBe('Bearer test-service-token');
      expect(opts.headers['Content-Type']).toBe('application/json');
    });

    it('sends reason "moderation" for general moderation suspends', async () => {
      const result = await suspendUser(VALID_PUBKEY, 'moderation', makeEnv());
      expect(result).toEqual({ success: true });
      const [, opts] = fetchMock.mock.calls[0];
      expect(JSON.parse(opts.body)).toEqual({ status: 'suspended', reason: 'moderation' });
    });

    it('returns success false with status on 4xx', async () => {
      fetchMock.mockResolvedValue({ ok: false, status: 404, text: () => Promise.resolve('Not found') });
      const result = await suspendUser(VALID_PUBKEY, 'age_review', makeEnv());
      expect(result).toEqual({ success: false, status: 404, error: expect.stringContaining('404') });
    });

    it('returns success false on network error', async () => {
      fetchMock.mockRejectedValue(new Error('Connection refused'));
      const result = await suspendUser(VALID_PUBKEY, 'age_review', makeEnv());
      expect(result).toEqual({ success: false, error: expect.stringContaining('Connection refused') });
    });
  });

  describe('clearVerifiedMinor', () => {
    it('sends DELETE to the verified-minor endpoint with actor and reason', async () => {
      const actor = 'b'.repeat(64);
      const result = await clearVerifiedMinor(VALID_PUBKEY, actor, 'age_review_denied', makeEnv());
      expect(result).toEqual({ success: true });
      expect(fetchMock).toHaveBeenCalledOnce();
      const [url, opts] = fetchMock.mock.calls[0];
      expect(url).toBe(
        `https://login.test.divine.video/api/admin/users/${VALID_PUBKEY}/verified-minor?actor=${actor}&reason=age_review_denied`,
      );
      expect(opts.method).toBe('DELETE');
      expect(opts.headers['Authorization']).toBe('Bearer test-service-token');
    });

    it('omits actor and reason when absent (keycast log-only fallback)', async () => {
      const result = await clearVerifiedMinor(VALID_PUBKEY, undefined, undefined, makeEnv());
      expect(result).toEqual({ success: true });
      const [url] = fetchMock.mock.calls[0];
      expect(url).toBe(`https://login.test.divine.video/api/admin/users/${VALID_PUBKEY}/verified-minor`);
    });

    it('drops a malformed actor instead of failing the clear (keycast 400s on it)', async () => {
      const result = await clearVerifiedMinor(VALID_PUBKEY, 'not-a-pubkey', 'age_review_denied', makeEnv());
      expect(result).toEqual({ success: true });
      const [url] = fetchMock.mock.calls[0];
      expect(url).not.toContain('actor=');
      expect(url).toContain('reason=age_review_denied');
    });

    it('returns success false with status on 4xx', async () => {
      fetchMock.mockResolvedValue({ ok: false, status: 401, text: () => Promise.resolve('bad token') });
      const result = await clearVerifiedMinor(VALID_PUBKEY, undefined, undefined, makeEnv());
      expect(result).toEqual({ success: false, status: 401, error: expect.stringContaining('401') });
    });

    it('returns success false on network error without throwing', async () => {
      fetchMock.mockRejectedValue(new Error('Connection refused'));
      const result = await clearVerifiedMinor(VALID_PUBKEY, undefined, undefined, makeEnv());
      expect(result).toEqual({ success: false, error: expect.stringContaining('Connection refused') });
    });

    it('rejects an invalid target pubkey without calling keycast', async () => {
      const result = await clearVerifiedMinor('nope', undefined, undefined, makeEnv());
      expect(result.success).toBe(false);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('reports not configured when env is missing', async () => {
      const result = await clearVerifiedMinor(VALID_PUBKEY, undefined, undefined, makeEnv({ KEYCAST_URL: undefined }));
      expect(result).toEqual({ success: false, error: 'not configured' });
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  describe('unsuspendUser', () => {
    it('sends PUT with status active and no reason', async () => {
      const result = await unsuspendUser(VALID_PUBKEY, makeEnv());
      expect(result).toEqual({ success: true });
      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body).toEqual({ status: 'active' });
      expect(body.reason).toBeUndefined();
    });
  });

  describe('banUser', () => {
    it('sends PUT with status banned and reason', async () => {
      const result = await banUser(VALID_PUBKEY, 'age_review_expired', makeEnv());
      expect(result).toEqual({ success: true });
      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body).toEqual({ status: 'banned', reason: 'age_review_expired' });
    });
  });

  // keycast#279 / divine-relay-manager#175: attribute an age-review status change
  // to the moderator so keycast writes a durable admin_audit_events row. Mirrors
  // clearVerifiedMinor's client-side actor guard, but actor rides the JSON body.
  describe('actor attribution on status changes', () => {
    const ACTOR = 'b'.repeat(64);

    it('suspendUser includes a valid actor in the body', async () => {
      const result = await suspendUser(VALID_PUBKEY, 'age_review', makeEnv(), ACTOR);
      expect(result).toEqual({ success: true });
      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body).toEqual({ status: 'suspended', reason: 'age_review', actor: ACTOR });
    });

    it('banUser includes a valid actor in the body', async () => {
      await banUser(VALID_PUBKEY, 'age_review_denied', makeEnv(), ACTOR);
      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body).toEqual({ status: 'banned', reason: 'age_review_denied', actor: ACTOR });
    });

    it('unsuspendUser includes a valid actor in the body', async () => {
      await unsuspendUser(VALID_PUBKEY, makeEnv(), ACTOR);
      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body).toEqual({ status: 'active', actor: ACTOR });
    });

    it('drops a malformed actor instead of failing the status change (keycast 400s on it)', async () => {
      const result = await suspendUser(VALID_PUBKEY, 'age_review', makeEnv(), 'not-a-pubkey');
      expect(result).toEqual({ success: true });
      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body).toEqual({ status: 'suspended', reason: 'age_review' });
      expect(body.actor).toBeUndefined();
    });

    it('omits actor when none is supplied (keycast log-only fallback)', async () => {
      await banUser(VALID_PUBKEY, 'moderation', makeEnv());
      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body).toEqual({ status: 'banned', reason: 'moderation' });
      expect(body.actor).toBeUndefined();
    });

    it('drops an uppercase-hex actor (Nostr pubkeys are canonical lowercase; keycast log-only fallback)', async () => {
      const result = await suspendUser(VALID_PUBKEY, 'age_review', makeEnv(), 'A'.repeat(64));
      expect(result).toEqual({ success: true });
      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body).toEqual({ status: 'suspended', reason: 'age_review' });
      expect(body.actor).toBeUndefined();
    });

    it('drops a wrong-length actor on the ban leg (63 hex chars)', async () => {
      const result = await banUser(VALID_PUBKEY, 'age_review_denied', makeEnv(), 'a'.repeat(63));
      expect(result).toEqual({ success: true });
      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body).toEqual({ status: 'banned', reason: 'age_review_denied' });
      expect(body.actor).toBeUndefined();
    });
  });

  describe('config validation', () => {
    it('returns not configured when KEYCAST_URL is missing', async () => {
      const result = await suspendUser(VALID_PUBKEY, 'age_review', makeEnv({ KEYCAST_URL: undefined }));
      expect(result).toEqual({ success: false, error: 'not configured' });
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('returns not configured when KEYCAST_SERVICE_TOKEN is missing', async () => {
      const result = await suspendUser(VALID_PUBKEY, 'age_review', makeEnv({ KEYCAST_SERVICE_TOKEN: undefined }));
      expect(result).toEqual({ success: false, error: 'not configured' });
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('resolves SecretStoreSecret binding for token', async () => {
      const env = makeEnv({ KEYCAST_SERVICE_TOKEN: { get: () => Promise.resolve('secret-from-store') } });
      await suspendUser(VALID_PUBKEY, 'age_review', env);
      expect(fetchMock.mock.calls[0][1].headers['Authorization']).toBe('Bearer secret-from-store');
    });

    it('returns not configured when SecretStoreSecret resolves to empty string', async () => {
      const env = makeEnv({ KEYCAST_SERVICE_TOKEN: { get: () => Promise.resolve('') } });
      const result = await suspendUser(VALID_PUBKEY, 'age_review', env);
      expect(result).toEqual({ success: false, error: 'not configured' });
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  describe('pubkey validation', () => {
    it('rejects pubkey shorter than 64 hex chars', async () => {
      const result = await suspendUser('abc123', 'age_review', makeEnv());
      expect(result).toEqual({ success: false, error: expect.stringContaining('pubkey') });
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('rejects pubkey with non-hex characters', async () => {
      const result = await suspendUser('g'.repeat(64), 'age_review', makeEnv());
      expect(result).toEqual({ success: false, error: expect.stringContaining('pubkey') });
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  describe('getUserStatus', () => {
    it('returns verified_minor true only for boolean true', async () => {
      fetchMock.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ pubkey: VALID_PUBKEY, status: 'active', verified_minor: true }),
      });
      const result = await getUserStatus(VALID_PUBKEY, makeEnv());
      expect(result.success).toBe(true);
      expect(result.verified_minor).toBe(true);
    });

    it('returns verified_minor false for string "true"', async () => {
      fetchMock.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ pubkey: VALID_PUBKEY, status: 'active', verified_minor: 'true' }),
      });
      const result = await getUserStatus(VALID_PUBKEY, makeEnv());
      expect(result.verified_minor).toBe(false);
    });

    it('returns verified_minor false for string "false"', async () => {
      fetchMock.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ pubkey: VALID_PUBKEY, status: 'active', verified_minor: 'false' }),
      });
      const result = await getUserStatus(VALID_PUBKEY, makeEnv());
      expect(result.verified_minor).toBe(false);
    });

    it('returns verified_minor false for numeric 1', async () => {
      fetchMock.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ pubkey: VALID_PUBKEY, status: 'active', verified_minor: 1 }),
      });
      const result = await getUserStatus(VALID_PUBKEY, makeEnv());
      expect(result.verified_minor).toBe(false);
    });

    it('returns verified_minor false when field is missing', async () => {
      fetchMock.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ pubkey: VALID_PUBKEY, status: 'active' }),
      });
      const result = await getUserStatus(VALID_PUBKEY, makeEnv());
      expect(result.verified_minor).toBe(false);
    });

    it('returns verified_minor false for null', async () => {
      fetchMock.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ pubkey: VALID_PUBKEY, status: 'active', verified_minor: null }),
      });
      const result = await getUserStatus(VALID_PUBKEY, makeEnv());
      expect(result.verified_minor).toBe(false);
    });

    it('returns error on non-OK response', async () => {
      fetchMock.mockResolvedValue({ ok: false, status: 500, text: () => Promise.resolve('Server error') });
      const result = await getUserStatus(VALID_PUBKEY, makeEnv());
      expect(result.success).toBe(false);
      expect(result.error).toContain('500');
    });
  });

  describe('createMinorAccount', () => {
    it('sends POST with username and returns pubkey and claim_url', async () => {
      fetchMock.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({
          pubkey: VALID_PUBKEY,
          claim_url: 'https://login.test/claim/abc',
          expires_at: '2026-06-15T00:00:00Z',
        }),
      });
      const result = await createMinorAccount('testuser', undefined, makeEnv());
      expect(result.success).toBe(true);
      expect(result.pubkey).toBe(VALID_PUBKEY);
      expect(result.claim_url).toBe('https://login.test/claim/abc');
      expect(result.expires_at).toBe('2026-06-15T00:00:00Z');

      const [url, opts] = fetchMock.mock.calls[0];
      expect(url).toBe('https://login.test.divine.video/api/admin/create-minor-account');
      expect(opts.method).toBe('POST');
      expect(JSON.parse(opts.body)).toEqual({ username: 'testuser' });
    });

    it('includes display_name when provided', async () => {
      fetchMock.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ pubkey: VALID_PUBKEY, claim_url: 'https://x' }),
      });
      await createMinorAccount('testuser', 'Test User', makeEnv());
      expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
        username: 'testuser',
        display_name: 'Test User',
      });
    });

    it('returns error on non-OK response', async () => {
      fetchMock.mockResolvedValue({ ok: false, status: 409, text: () => Promise.resolve('Username taken') });
      const result = await createMinorAccount('taken', undefined, makeEnv());
      expect(result.success).toBe(false);
      expect(result.error).toContain('409');
    });

    it('returns error on network failure', async () => {
      fetchMock.mockRejectedValue(new Error('DNS lookup failed'));
      const result = await createMinorAccount('testuser', undefined, makeEnv());
      expect(result.success).toBe(false);
      expect(result.error).toContain('DNS lookup failed');
    });

    it('returns not configured when env is missing', async () => {
      const result = await createMinorAccount('testuser', undefined, makeEnv({ KEYCAST_URL: undefined }));
      expect(result.success).toBe(false);
      expect(result.error).toBe('not configured');
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });
});
