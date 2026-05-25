import { afterEach, describe, expect, it, vi, beforeEach } from 'vitest';
import { suspendUser, unsuspendUser, banUser, type KeycastEnv } from './keycast-client';

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
});
