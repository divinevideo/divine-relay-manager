import { afterEach, describe, expect, it, vi } from 'vitest';
import { handleAccountStatus } from './account-status';
import type { KeycastEnv } from './keycast-client';

const VALID_PUBKEY = 'a'.repeat(64);
const CORS = { 'Access-Control-Allow-Origin': '*' };

function makeEnv(overrides: Partial<KeycastEnv> = {}): KeycastEnv {
  return {
    KEYCAST_URL: 'https://login.test.divine.video',
    KEYCAST_SERVICE_TOKEN: 'test-service-token',
    ...overrides,
  };
}

describe('handleAccountStatus', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('returns verified_minor from keycast on success', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: () =>
          Promise.resolve({
            pubkey: VALID_PUBKEY,
            status: 'active',
            verified_minor: true,
            verified_minor_at: '2026-06-30T12:00:00Z',
          }),
      }),
    );

    const res = await handleAccountStatus(VALID_PUBKEY, makeEnv(), CORS);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      success: true,
      verified_minor: true,
      verified_minor_at: '2026-06-30T12:00:00Z',
    });
  });

  it('rejects an invalid pubkey with 400 (before calling keycast)', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    const res = await handleAccountStatus('not-a-pubkey', makeEnv(), CORS);

    expect(res.status).toBe(400);
    const body = (await res.json()) as { success: boolean };
    expect(body.success).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('degrades gracefully (200, success:false) when keycast is unavailable', async () => {
    const res = await handleAccountStatus(
      VALID_PUBKEY,
      makeEnv({ KEYCAST_URL: undefined }),
      CORS,
    );

    // Not a hard failure: the moderator UI reads this as "status unavailable"
    // without blocking the case view.
    expect(res.status).toBe(200);
    const body = (await res.json()) as { success: boolean };
    expect(body.success).toBe(false);
  });

  it('degrades gracefully when keycast returns a server error', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        text: () => Promise.resolve('boom'),
      }),
    );

    const res = await handleAccountStatus(VALID_PUBKEY, makeEnv(), CORS);

    expect(res.status).toBe(200);
    const body = (await res.json()) as { success: boolean; not_found?: boolean };
    expect(body.success).toBe(false);
    // A server error is unavailable, NOT self-custody.
    expect(body.not_found).toBeFalsy();
  });

  it('reports protected_minor as unknown (null) without a D1 binding', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ pubkey: VALID_PUBKEY, status: 'active', verified_minor: true }),
      }),
    );

    const body = await (await handleAccountStatus(VALID_PUBKEY, makeEnv(), CORS)).json();

    expect(body).toMatchObject({ success: true, verified_minor: true, protected_minor: null });
  });

  it('keeps the keycast status and reports protected_minor null when the registry read throws', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ pubkey: VALID_PUBKEY, status: 'active', verified_minor: true }),
      }),
    );
    const DB = {
      prepare: () => { throw new Error('D1_ERROR: no such table'); },
    } as unknown as D1Database;

    const res = await handleAccountStatus(VALID_PUBKEY, { ...makeEnv(), DB }, CORS);

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ success: true, verified_minor: true, protected_minor: null });
  });

  it('surfaces not_found (self-custody) for a keycast 404, distinct from unavailable', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 404,
        text: () => Promise.resolve('User not found'),
      }),
    );

    const res = await handleAccountStatus(VALID_PUBKEY, makeEnv(), CORS);

    expect(res.status).toBe(200);
    const body = (await res.json()) as { success: boolean; not_found?: boolean };
    expect(body.success).toBe(false);
    expect(body.not_found).toBe(true);
  });
});
