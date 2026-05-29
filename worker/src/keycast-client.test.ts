import { afterEach, describe, expect, it, vi, beforeEach } from 'vitest';
import { suspendUser, unsuspendUser, banUser, getUserStatus, createMinorAccount, type KeycastEnv } from './keycast-client';

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
