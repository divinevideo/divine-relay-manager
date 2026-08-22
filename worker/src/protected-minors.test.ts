import { describe, expect, it, vi } from 'vitest';
import { handleProtectedMinorServiceRoute, UUID_RE } from './protected-minors';

const path = '/api/internal/protected-minors/resolve';
const cors = {};
function request(headers?: HeadersInit) {
  return new Request(`https://api.test${path}`, { method: 'POST', headers, body: JSON.stringify({ pubkey: 'a'.repeat(64) }) });
}

describe('protected-minor service authentication', () => {
  it('accepts modern lowercase UUID versions without interpreting them', () => {
    for (const version of ['6', '7', '8']) {
      expect(UUID_RE.test(`018f1f4e-7b3a-${version}abc-8def-0123456789ab`)).toBe(true);
    }
    expect(UUID_RE.test('018f1f4e-7b3a-9abc-8def-0123456789ab')).toBe(false);
  });
  it.each([
    ['missing', undefined],
    ['wrong bearer', { Authorization: 'Bearer wrong' }],
    ['CF Access browser assertion', { 'Cf-Access-Jwt-Assertion': 'browser-session' }],
    ['moderator admin key', { 'X-Admin-Key': 'admin-key' }],
  ])('rejects %s credentials', async (_name, headers) => {
    const response = await handleProtectedMinorServiceRoute(request(headers), path,
      { PROTECTED_MINOR_SERVICE_TOKEN: 'service-token' }, cors);
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: 'unauthorized' });
  });

  it('resolves Secrets Store bindings and reaches the service boundary', async () => {
    const response = await handleProtectedMinorServiceRoute(request({ Authorization: 'Bearer service-token' }), path,
      { PROTECTED_MINOR_SERVICE_TOKEN: { get: async () => 'service-token' } }, cors);
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: 'service_unavailable' });
  });

  it('rejects unauthorized requests before preparing D1', async () => {
    const prepareDb = vi.fn();
    const response = await handleProtectedMinorServiceRoute(request(), path,
      { DB: {} as D1Database, PROTECTED_MINOR_SERVICE_TOKEN: 'service-token' }, cors, prepareDb);
    expect(response.status).toBe(401);
    expect(prepareDb).not.toHaveBeenCalled();
  });

  it('keeps schema-preparation failures retryable', async () => {
    const prepareDb = vi.fn().mockRejectedValue(new Error('D1 unavailable'));
    const response = await handleProtectedMinorServiceRoute(
      request({ Authorization: 'Bearer service-token' }), path,
      { DB: {} as D1Database, PROTECTED_MINOR_SERVICE_TOKEN: 'service-token' }, cors, prepareDb,
    );
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: 'service_unavailable' });
  });
});
