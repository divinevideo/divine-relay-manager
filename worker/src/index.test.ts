import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { finalizeEvent, generateSecretKey } from 'nostr-tools';
import worker from './index';

const env = {
  ALLOWED_ORIGINS: 'https://app.divine.video,https://*.openvine-app.pages.dev',
  RELAY_URL: 'wss://relay.divine.video',
} as never;

const TEST_NSEC = 'nsec1vl029mgpspedva04g90vltkh6fvh240zqtv9k0t9af8935ke9laqsnlfe5';

const ctx = {} as ExecutionContext;

function makeModerateMediaEnv(serviceApiToken: string | { get: () => Promise<string> }) {
  return {
    ALLOWED_ORIGINS: 'https://app.divine.video',
    RELAY_URL: 'wss://relay.divine.video',
    ADMIN_API_KEY: 'test-admin-key',
    MODERATION_ADMIN_URL: 'https://moderation-api.divine.video',
    SERVICE_API_TOKEN: serviceApiToken,
    MODERATION_API: {
      fetch: vi.fn(async () => {
        return new Response(JSON.stringify({ success: true, sha256: 'abc123', action: 'AGE_RESTRICTED' }), { status: 200 });
      }),
    },
  } as never;
}

function makeRelayRpcEnv(serviceApiToken: string | { get: () => Promise<string> }) {
  return {
    ALLOWED_ORIGINS: 'https://app.divine.video',
    RELAY_URL: 'wss://relay.divine.video',
    ADMIN_API_KEY: 'test-admin-key',
    MODERATION_ADMIN_URL: 'https://moderation-api.divine.video',
    SERVICE_API_TOKEN: serviceApiToken,
    NOSTR_NSEC: TEST_NSEC,
  } as never;
}

describe('relay manager cors', () => {
  it('echoes app origin on preflight', async () => {
    const response = await worker.fetch(
      new Request('https://api-relay-prod.divine.video/api/info', {
        method: 'OPTIONS',
        headers: {
          Origin: 'https://app.divine.video',
          'Access-Control-Request-Method': 'GET',
          'Access-Control-Request-Headers': 'Content-Type,Authorization,X-Requested-With',
        },
      }),
      env,
      ctx,
    );

    expect(response.status).toBe(204);
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('https://app.divine.video');
    expect(response.headers.get('Access-Control-Allow-Methods')).toBe('GET, POST, PUT, PATCH, DELETE, OPTIONS');
    expect(response.headers.get('Access-Control-Allow-Headers')).toBe('Content-Type, Authorization, X-Requested-With, Range, X-Admin-Key, CF-Access-Client-Id, CF-Access-Client-Secret');
    expect(response.headers.get('Access-Control-Max-Age')).toBe('86400');
    expect(response.headers.get('Vary')).toContain('Origin');
  });

  it('does not allow unknown origins', async () => {
    const response = await worker.fetch(
      new Request('https://api-relay-prod.divine.video/api/info', {
        headers: {
          Origin: 'https://evil.example',
        },
      }),
      env,
      ctx,
    );

    expect(response.headers.get('Access-Control-Allow-Origin')).toBeNull();
  });

  it('echoes preview origin on actual responses', async () => {
    const response = await worker.fetch(
      new Request('https://api-relay-prod.divine.video/api/info', {
        headers: {
          Origin: 'https://pr-123.openvine-app.pages.dev',
        },
      }),
      env,
      ctx,
    );

    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('https://pr-123.openvine-app.pages.dev');
    expect(response.headers.get('Access-Control-Allow-Methods')).toBe('GET, POST, PUT, PATCH, DELETE, OPTIONS');
    expect(response.headers.get('Access-Control-Allow-Headers')).toBe('Content-Type, Authorization, X-Requested-With, Range, X-Admin-Key, CF-Access-Client-Id, CF-Access-Client-Secret');
    expect(response.headers.get('Access-Control-Max-Age')).toBe('86400');
    expect(response.headers.get('Vary')).toContain('Origin');
  });
});

describe('SERVICE_API_TOKEN secrets store resolution', () => {
  it('resolves plain string token', async () => {
    const testEnv = makeModerateMediaEnv('my-secret-token');
    const response = await worker.fetch(
      new Request('https://api-relay-prod.divine.video/api/moderate-media', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Admin-Key': 'test-admin-key',
          Origin: 'https://app.divine.video',
        },
        body: JSON.stringify({ sha256: 'abc123', action: 'AGE_RESTRICTED' }),
      }),
      testEnv,
      ctx,
    );

    expect(response.status).toBe(200);
    const mockFetch = (testEnv as unknown as { MODERATION_API: { fetch: ReturnType<typeof vi.fn> } }).MODERATION_API.fetch;
    const forwardedRequest = mockFetch.mock.calls[0][0] as Request;
    expect(forwardedRequest.headers.get('Authorization')).toBe('Bearer my-secret-token');
  });

  it('resolves Secrets Store binding via .get()', async () => {
    const secretsStoreBinding = { get: vi.fn(async () => 'resolved-secret') };
    const testEnv = makeModerateMediaEnv(secretsStoreBinding);
    const response = await worker.fetch(
      new Request('https://api-relay-prod.divine.video/api/moderate-media', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Admin-Key': 'test-admin-key',
          Origin: 'https://app.divine.video',
        },
        body: JSON.stringify({ sha256: 'abc123', action: 'AGE_RESTRICTED' }),
      }),
      testEnv,
      ctx,
    );

    expect(response.status).toBe(200);
    const mockFetch = (testEnv as unknown as { MODERATION_API: { fetch: ReturnType<typeof vi.fn> } }).MODERATION_API.fetch;
    const forwardedRequest = mockFetch.mock.calls[0][0] as Request;
    expect(forwardedRequest.headers.get('Authorization')).toBe('Bearer resolved-secret');
    expect(secretsStoreBinding.get).toHaveBeenCalledOnce();
  });

  it('returns 500 when Secrets Store binding resolves to null', async () => {
    const secretsStoreBinding = { get: vi.fn(async () => null) };
    const testEnv = makeModerateMediaEnv(secretsStoreBinding as never);
    const response = await worker.fetch(
      new Request('https://api-relay-prod.divine.video/api/moderate-media', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Admin-Key': 'test-admin-key',
          Origin: 'https://app.divine.video',
        },
        body: JSON.stringify({ sha256: 'abc123', action: 'AGE_RESTRICTED' }),
      }),
      testEnv,
      ctx,
    );

    expect(response.status).toBe(500);
    const body = await response.json() as { success: boolean; error: string };
    expect(body.success).toBe(false);
    expect(body.error).toContain('SERVICE_API_TOKEN');
  });
});

describe('notifyModerationService null token', () => {
  it('logs and swallows null token errors on the non-critical DM path', async () => {
    const nullBinding = { get: vi.fn(async () => null) };
    const testEnv = makeRelayRpcEnv(nullBinding as never);
    const waitUntil = vi.fn();
    const testCtx = { waitUntil } as unknown as ExecutionContext;
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ result: true }), { status: 200 })
    );

    const response = await worker.fetch(
      new Request('https://api-relay-prod.divine.video/api/relay-rpc', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Admin-Key': 'test-admin-key',
          Origin: 'https://app.divine.video',
        },
        body: JSON.stringify({
          method: 'banpubkey',
          params: ['deadbeef', 'test reason'],
        }),
      }),
      testEnv,
      testCtx,
    );

    expect(response.status).toBe(200);
    // banpubkey schedules two non-critical tasks: the Keycast ban and the DM.
    expect(waitUntil).toHaveBeenCalledTimes(2);
    await Promise.all(waitUntil.mock.calls.map(c => c[0]));
    expect(errorSpy).toHaveBeenCalledWith(
      '[notifyAccountState] DM notification error:',
      expect.objectContaining({
        message: expect.stringContaining('SERVICE_API_TOKEN'),
      }),
    );

    fetchSpy.mockRestore();
    errorSpy.mockRestore();
  });
});

describe('relay-rpc account-state side effects', () => {
  // Restore the global fetch spy even if a test throws mid-assertion, so a
  // failure can't leak its spy and cascade into later tests.
  afterEach(() => { vi.restoreAllMocks(); });

  const VALID_PUBKEY = 'abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234';

  function makeAccountStateEnv() {
    return {
      ALLOWED_ORIGINS: 'https://app.divine.video',
      RELAY_URL: 'wss://relay.divine.video',
      ADMIN_API_KEY: 'test-admin-key',
      MODERATION_ADMIN_URL: 'https://moderation-api.divine.video',
      SERVICE_API_TOKEN: 'test-token',
      NOSTR_NSEC: TEST_NSEC,
      KEYCAST_URL: 'https://login.divine.video',
      KEYCAST_SERVICE_TOKEN: 'keycast-token',
    } as never;
  }

  // Same env with a DB whose active-case lookup returns `caseRow` only when it
  // is non-terminal, mirroring the guard query's WHERE state NOT IN
  // (cleared, denied_closed). A terminal or null row resolves to null.
  function makeAccountStateEnvWithDb(caseRow: { id: string; state: string } | null) {
    const active = caseRow && !['cleared', 'denied_closed'].includes(caseRow.state) ? caseRow : null;
    return {
      ALLOWED_ORIGINS: 'https://app.divine.video',
      RELAY_URL: 'wss://relay.divine.video',
      ADMIN_API_KEY: 'test-admin-key',
      MODERATION_ADMIN_URL: 'https://moderation-api.divine.video',
      SERVICE_API_TOKEN: 'test-token',
      NOSTR_NSEC: TEST_NSEC,
      KEYCAST_URL: 'https://login.divine.video',
      KEYCAST_SERVICE_TOKEN: 'keycast-token',
      DB: {
        prepare: () => ({ bind: () => ({ first: async () => active }) }),
      },
    } as never;
  }

  // Routes a mocked fetch by URL so each backend can be asserted independently.
  function makeFetchSpy() {
    return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url.includes('/api/v1/notify')) {
        return new Response(JSON.stringify({ dm_sent: true }), { status: 200 });
      }
      if (url.includes('/api/admin/users/')) {
        return new Response('', { status: 200 });
      }
      // NIP-86 relay RPC management endpoint
      return new Response(JSON.stringify({ result: true }), { status: 200 });
    });
  }

  async function callRelayRpc(
    method: string,
    params: string[],
    testEnv: never,
    testCtx: ExecutionContext,
  ): Promise<Response> {
    return worker.fetch(
      new Request('https://api-relay-prod.divine.video/api/relay-rpc', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Admin-Key': 'test-admin-key',
          Origin: 'https://app.divine.video',
        },
        body: JSON.stringify({ method, params }),
      }),
      testEnv,
      testCtx,
    );
  }

  async function notifyBodies(fetchSpy: ReturnType<typeof makeFetchSpy>): Promise<Array<{ action: string; recipientPubkey: string }>> {
    const reqs = fetchSpy.mock.calls
      .map(([input]) => input)
      .filter((input): input is Request => input instanceof Request && input.url.includes('/api/v1/notify'));
    return Promise.all(reqs.map(async req => JSON.parse(await req.clone().text())));
  }

  function keycastCalls(fetchSpy: ReturnType<typeof makeFetchSpy>): Array<{ url: string; status: string }> {
    return fetchSpy.mock.calls
      .filter(([input]) => {
        const url = input instanceof Request ? input.url : String(input);
        return url.includes('/api/admin/users/');
      })
      .map(([input, init]) => {
        const url = input instanceof Request ? input.url : String(input);
        const body = input instanceof Request ? undefined : (init as RequestInit | undefined)?.body;
        return { url, status: JSON.parse(String(body)).status as string };
      });
  }

  async function drain(waitUntil: ReturnType<typeof vi.fn>): Promise<void> {
    await Promise.all(waitUntil.mock.calls.map(c => c[0]));
  }

  it('banpubkey triggers Keycast ban and DM action ACCOUNT_BANNED', async () => {
    const fetchSpy = makeFetchSpy();
    const waitUntil = vi.fn();
    const testCtx = { waitUntil } as unknown as ExecutionContext;

    const response = await callRelayRpc('banpubkey', [VALID_PUBKEY, 'spam'], makeAccountStateEnv(), testCtx);
    expect(response.status).toBe(200);
    await drain(waitUntil);

    const bodies = await notifyBodies(fetchSpy);
    expect(bodies).toHaveLength(1);
    expect(bodies[0].action).toBe('ACCOUNT_BANNED');
    expect(bodies[0].recipientPubkey).toBe(VALID_PUBKEY);

    const kc = keycastCalls(fetchSpy);
    expect(kc).toHaveLength(1);
    expect(kc[0].url).toContain(`/api/admin/users/${VALID_PUBKEY}/status`);
    expect(kc[0].status).toBe('banned');

    fetchSpy.mockRestore();
  });

  it('suspendpubkey triggers Keycast suspend and DM action ACCOUNT_SUSPENDED', async () => {
    const fetchSpy = makeFetchSpy();
    const waitUntil = vi.fn();
    const testCtx = { waitUntil } as unknown as ExecutionContext;

    const response = await callRelayRpc('suspendpubkey', [VALID_PUBKEY, 'policy'], makeAccountStateEnv(), testCtx);
    expect(response.status).toBe(200);
    await drain(waitUntil);

    const bodies = await notifyBodies(fetchSpy);
    expect(bodies).toHaveLength(1);
    expect(bodies[0].action).toBe('ACCOUNT_SUSPENDED');

    const kc = keycastCalls(fetchSpy);
    expect(kc).toHaveLength(1);
    expect(kc[0].url).toContain(`/api/admin/users/${VALID_PUBKEY}/status`);
    expect(kc[0].status).toBe('suspended');

    fetchSpy.mockRestore();
  });

  it('unsuspendpubkey triggers Keycast unsuspend and DM action ACCOUNT_RESTORED', async () => {
    const fetchSpy = makeFetchSpy();
    const waitUntil = vi.fn();
    const testCtx = { waitUntil } as unknown as ExecutionContext;

    const response = await callRelayRpc('unsuspendpubkey', [VALID_PUBKEY], makeAccountStateEnv(), testCtx);
    expect(response.status).toBe(200);
    await drain(waitUntil);

    const bodies = await notifyBodies(fetchSpy);
    expect(bodies).toHaveLength(1);
    expect(bodies[0].action).toBe('ACCOUNT_RESTORED');

    const kc = keycastCalls(fetchSpy);
    expect(kc).toHaveLength(1);
    expect(kc[0].status).toBe('active');

    fetchSpy.mockRestore();
  });

  it('unbanpubkey triggers Keycast restore (active) and sends no DM', async () => {
    const fetchSpy = makeFetchSpy();
    const waitUntil = vi.fn();
    const testCtx = { waitUntil } as unknown as ExecutionContext;

    const response = await callRelayRpc('unbanpubkey', [VALID_PUBKEY], makeAccountStateEnv(), testCtx);
    expect(response.status).toBe(200);
    await drain(waitUntil);

    const kc = keycastCalls(fetchSpy);
    expect(kc).toHaveLength(1);
    expect(kc[0].url).toContain(`/api/admin/users/${VALID_PUBKEY}/status`);
    expect(kc[0].status).toBe('active');
    // unban lifts the Keycast ban but sends no DM (restore-on-unban DM tracked in #96)
    expect(await notifyBodies(fetchSpy)).toHaveLength(0);

    fetchSpy.mockRestore();
  });

  it('suspendpubkey is refused when the target has an active age-review case', async () => {
    const fetchSpy = makeFetchSpy();
    const waitUntil = vi.fn();
    const testCtx = { waitUntil } as unknown as ExecutionContext;
    const env = makeAccountStateEnvWithDb({ id: 'case-1', state: 'restricted_pending_user_response' });

    const response = await callRelayRpc('suspendpubkey', [VALID_PUBKEY, 'policy'], env, testCtx);
    expect(response.status).toBe(409);
    const body = await response.json() as { code: string; caseId: string; state: string };
    expect(body.code).toBe('age_review_active');
    expect(body.caseId).toBe('case-1');

    // The guard short-circuits before any enforcement side effect.
    await drain(waitUntil);
    expect(keycastCalls(fetchSpy)).toHaveLength(0);
    expect(await notifyBodies(fetchSpy)).toHaveLength(0);

    fetchSpy.mockRestore();
  });

  it('unsuspendpubkey is refused when the target has an active age-review case', async () => {
    const fetchSpy = makeFetchSpy();
    const waitUntil = vi.fn();
    const testCtx = { waitUntil } as unknown as ExecutionContext;
    const env = makeAccountStateEnvWithDb({ id: 'case-2', state: 'restricted_pending_parental_consent' });

    const response = await callRelayRpc('unsuspendpubkey', [VALID_PUBKEY], env, testCtx);
    expect(response.status).toBe(409);
    const body = await response.json() as { code: string };
    expect(body.code).toBe('age_review_active');
    expect(keycastCalls(fetchSpy)).toHaveLength(0);

    fetchSpy.mockRestore();
  });

  it('suspendpubkey proceeds normally when the target has no active age-review case', async () => {
    const fetchSpy = makeFetchSpy();
    const waitUntil = vi.fn();
    const testCtx = { waitUntil } as unknown as ExecutionContext;
    const env = makeAccountStateEnvWithDb(null);

    const response = await callRelayRpc('suspendpubkey', [VALID_PUBKEY, 'policy'], env, testCtx);
    expect(response.status).toBe(200);
    await drain(waitUntil);
    const kc = keycastCalls(fetchSpy);
    expect(kc).toHaveLength(1);
    expect(kc[0].status).toBe('suspended');

    fetchSpy.mockRestore();
  });

  it('suspendpubkey proceeds when the only age-review case is terminal (cleared)', async () => {
    const fetchSpy = makeFetchSpy();
    const waitUntil = vi.fn();
    const testCtx = { waitUntil } as unknown as ExecutionContext;
    const env = makeAccountStateEnvWithDb({ id: 'case-x', state: 'cleared' });

    const response = await callRelayRpc('suspendpubkey', [VALID_PUBKEY, 'policy'], env, testCtx);
    expect(response.status).toBe(200);
    await drain(waitUntil);
    expect(keycastCalls(fetchSpy)).toHaveLength(1);

    fetchSpy.mockRestore();
  });

  it('banpubkey is not gated by an active age-review case (severe-action escape hatch)', async () => {
    const fetchSpy = makeFetchSpy();
    const waitUntil = vi.fn();
    const testCtx = { waitUntil } as unknown as ExecutionContext;
    const env = makeAccountStateEnvWithDb({ id: 'case-3', state: 'restricted_pending_user_response' });

    const response = await callRelayRpc('banpubkey', [VALID_PUBKEY, 'csam'], env, testCtx);
    expect(response.status).toBe(200);
    await drain(waitUntil);
    const kc = keycastCalls(fetchSpy);
    expect(kc).toHaveLength(1);
    expect(kc[0].status).toBe('banned');

    fetchSpy.mockRestore();
  });

  it('ban_pubkey via /api/moderate sends exactly one ACCOUNT_BANNED DM (no double)', async () => {
    const fetchSpy = makeFetchSpy();
    const waitUntil = vi.fn();
    const testCtx = { waitUntil } as unknown as ExecutionContext;

    const response = await worker.fetch(
      new Request('https://api-relay-prod.divine.video/api/moderate', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Admin-Key': 'test-admin-key',
          Origin: 'https://app.divine.video',
        },
        body: JSON.stringify({ action: 'ban_pubkey', pubkey: VALID_PUBKEY, reason: 'spam' }),
      }),
      makeAccountStateEnv(),
      testCtx,
    );
    expect(response.status).toBe(200);
    await drain(waitUntil);

    // handleModerate's ban_pubkey routes through handleRelayRpc; only the helper
    // DMs, so there must be exactly one ACCOUNT_BANNED, never a duplicate.
    const bodies = await notifyBodies(fetchSpy);
    expect(bodies).toHaveLength(1);
    expect(bodies[0].action).toBe('ACCOUNT_BANNED');
    // ...and the same path reaches Keycast (status banned).
    const kc = keycastCalls(fetchSpy);
    expect(kc).toHaveLength(1);
    expect(kc[0].status).toBe('banned');

    fetchSpy.mockRestore();
  });

  it('allow_pubkey via /api/moderate restores the Keycast account (active)', async () => {
    const fetchSpy = makeFetchSpy();
    const waitUntil = vi.fn();
    const testCtx = { waitUntil } as unknown as ExecutionContext;

    const response = await worker.fetch(
      new Request('https://api-relay-prod.divine.video/api/moderate', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Admin-Key': 'test-admin-key',
          Origin: 'https://app.divine.video',
        },
        body: JSON.stringify({ action: 'allow_pubkey', pubkey: VALID_PUBKEY }),
      }),
      makeAccountStateEnv(),
      testCtx,
    );
    expect(response.status).toBe(200);
    await drain(waitUntil);

    // allow_pubkey -> unbanpubkey -> Keycast active. Requires ctx to be passed
    // through handleModerate's allow_pubkey case.
    const kc = keycastCalls(fetchSpy);
    expect(kc).toHaveLength(1);
    expect(kc[0].status).toBe('active');

    fetchSpy.mockRestore();
  });

  it('skips account-state side effects with a warning when no ExecutionContext is available', async () => {
    const fetchSpy = makeFetchSpy();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const response = await callRelayRpc(
      'suspendpubkey',
      [VALID_PUBKEY, 'policy'],
      makeAccountStateEnv(),
      undefined as unknown as ExecutionContext,
    );
    expect(response.status).toBe(200);

    // Without a ctx to keep them alive, neither the DM nor the Keycast call is
    // dispatched, and BOTH skips are logged rather than silently dropped.
    expect(await notifyBodies(fetchSpy)).toHaveLength(0);
    expect(keycastCalls(fetchSpy)).toHaveLength(0);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('skipping Keycast suspend'));
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('[notifyAccountState] No ExecutionContext'));

    warnSpy.mockRestore();
    fetchSpy.mockRestore();
  });
});

describe('relay-rpc admin access via MOD_RELAY_ADMIN_KEY (Secrets Store shared key)', () => {
  function makeEnvWithModKey(modKeyValue: string) {
    return {
      ALLOWED_ORIGINS: 'https://app.divine.video',
      RELAY_URL: 'wss://relay.divine.video',
      ADMIN_API_KEY: 'test-admin-key',
      MOD_RELAY_ADMIN_KEY: { get: vi.fn(async () => modKeyValue) },
      MODERATION_ADMIN_URL: 'https://moderation-api.divine.video',
      SERVICE_API_TOKEN: 'svc-token',
      MODERATION_API: {
        fetch: vi.fn(async () => new Response(JSON.stringify({ success: true, sha256: 'abc123', action: 'AGE_RESTRICTED' }), { status: 200 })),
      },
    } as never;
  }

  it('authorizes relay-rpc when X-Admin-Key matches the resolved MOD_RELAY_ADMIN_KEY (not ADMIN_API_KEY)', async () => {
    const testEnv = makeEnvWithModKey('mod-shared-key');
    const response = await worker.fetch(
      new Request('https://api-relay-prod.divine.video/api/relay-rpc', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Admin-Key': 'mod-shared-key',
          Origin: 'https://app.divine.video',
        },
        body: JSON.stringify({}),
      }),
      testEnv,
      ctx,
    );

    expect(response.status).toBe(400);
    const body = await response.json() as { success: boolean; error: string };
    expect(body.error).toBe('Missing method');
  });

  it('does not authorize other admin endpoints with MOD_RELAY_ADMIN_KEY', async () => {
    const testEnv = makeEnvWithModKey('mod-shared-key');
    const response = await worker.fetch(
      new Request('https://api-relay-prod.divine.video/api/moderate-media', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Admin-Key': 'mod-shared-key',
          Origin: 'https://app.divine.video',
        },
        body: JSON.stringify({ sha256: 'abc123', action: 'AGE_RESTRICTED' }),
      }),
      testEnv,
      ctx,
    );

    expect(response.status).toBe(401);
  });

  it('rejects relay-rpc when X-Admin-Key matches neither ADMIN_API_KEY nor MOD_RELAY_ADMIN_KEY', async () => {
    const testEnv = makeEnvWithModKey('mod-shared-key');
    const response = await worker.fetch(
      new Request('https://api-relay-prod.divine.video/api/relay-rpc', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Admin-Key': 'totally-wrong-key',
          Origin: 'https://app.divine.video',
        },
        body: JSON.stringify({}),
      }),
      testEnv,
      ctx,
    );

    expect(response.status).toBe(401);
  });
});

describe('GET /api/account-status/:pubkey', () => {
  afterEach(() => vi.unstubAllGlobals());

  const accountEnv = {
    ALLOWED_ORIGINS: 'https://app.divine.video',
    RELAY_URL: 'wss://relay.divine.video',
    ADMIN_API_KEY: 'test-admin-key',
    KEYCAST_URL: 'https://login.test.divine.video',
    KEYCAST_SERVICE_TOKEN: 'test-service-token',
  } as never;
  const PUBKEY = 'a'.repeat(64);

  it('surfaces verified_minor for an admin-authed request', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({
        pubkey: PUBKEY,
        status: 'active',
        verified_minor: true,
        verified_minor_at: '2026-06-30T12:00:00Z',
      }),
    }));

    const response = await worker.fetch(
      new Request(`https://api.divine.video/api/account-status/${PUBKEY}`, {
        headers: { 'X-Admin-Key': 'test-admin-key', Origin: 'https://app.divine.video' },
      }),
      accountEnv,
      ctx,
    );

    expect(response.status).toBe(200);
    const body = await response.json() as { success: boolean; verified_minor?: boolean };
    expect(body.success).toBe(true);
    expect(body.verified_minor).toBe(true);
  });

  it('requires admin auth (401 without an admin key)', async () => {
    const response = await worker.fetch(
      new Request(`https://api.divine.video/api/account-status/${PUBKEY}`, {
        headers: { Origin: 'https://app.divine.video' },
      }),
      accountEnv,
      ctx,
    );

    expect(response.status).toBe(401);
  });
});

describe('bulk-moderate age-review guard', () => {
  const VALID_PUBKEY = 'abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234';

  // Generic mock DB: tolerates ensureSchemaOnce's DDL and the enqueue INSERT,
  // records every executed statement's SQL, and answers the guard's
  // age_review_cases lookup with `caseRow` only when it is non-terminal
  // (mirroring the WHERE state NOT IN (cleared, denied_closed) filter).
  // `lookupThrows` simulates a transient D1 failure on that lookup only.
  function makeBulkEnv(
    caseRow: { id: string; state: string } | null,
    opts: { lookupThrows?: boolean } = {},
  ) {
    const active = caseRow && !['cleared', 'denied_closed'].includes(caseRow.state) ? caseRow : null;
    const executed: string[] = [];
    const send = vi.fn(async () => {});
    const statement = (sql: string) => ({
      bind: () => statement(sql),
      run: async () => { executed.push(sql); return { success: true, meta: { changes: 1 } }; },
      first: async () => {
        if (sql.includes('age_review_cases')) {
          if (opts.lookupThrows) throw new Error('D1 unavailable');
          return active;
        }
        return null;
      },
      all: async () => ({ results: [] }),
    });
    const env = {
      ALLOWED_ORIGINS: 'https://app.divine.video',
      RELAY_URL: 'wss://relay.divine.video',
      ADMIN_API_KEY: 'test-admin-key',
      NOSTR_NSEC: TEST_NSEC,
      DB: { prepare: statement },
      BULK_QUEUE: { send },
    } as never;
    return { env, executed, send };
  }

  function enqueueRequest(body: object): Request {
    return new Request('https://api-relay-prod.divine.video/api/bulk-moderate', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Admin-Key': 'test-admin-key',
        Origin: 'https://app.divine.video',
      },
      body: JSON.stringify(body),
    });
  }

  it('refuses a bulk action when the target has an active age-review case', async () => {
    const { env, executed, send } = makeBulkEnv({ id: 'case-b1', state: 'restricted_pending_user_response' });
    const response = await worker.fetch(
      enqueueRequest({ pubkey: VALID_PUBKEY, action: 'age-restrict-all' }), env, ctx,
    );
    expect(response.status).toBe(409);
    const body = await response.json() as { code: string; caseId: string; state: string };
    expect(body.code).toBe('age_review_active');
    expect(body.caseId).toBe('case-b1');
    expect(body.state).toBe('restricted_pending_user_response');
    // The guard short-circuits before any job is created or enqueued.
    expect(executed.some((sql) => sql.includes('INSERT INTO bulk_jobs'))).toBe(false);
    expect(send).not.toHaveBeenCalled();
  });

  it('refuses delete-all the same way (no destructive job on an open case)', async () => {
    const { env, send } = makeBulkEnv({ id: 'case-b2', state: 'submitted_for_review' });
    const response = await worker.fetch(
      enqueueRequest({ pubkey: VALID_PUBKEY, action: 'delete-all' }), env, ctx,
    );
    expect(response.status).toBe(409);
    expect(send).not.toHaveBeenCalled();
  });

  it('proceeds when the only age-review case is terminal (cleared)', async () => {
    const { env, send } = makeBulkEnv({ id: 'case-b3', state: 'cleared' });
    const response = await worker.fetch(
      enqueueRequest({ pubkey: VALID_PUBKEY, action: 'age-restrict-all' }), env, ctx,
    );
    expect(response.status).toBe(200);
    const body = await response.json() as { success: boolean; jobId: string };
    expect(body.success).toBe(true);
    expect(body.jobId).toMatch(/^[0-9a-f-]{36}$/);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('fails open when the case lookup throws (transient D1 error must not block moderation)', async () => {
    const { env, send } = makeBulkEnv({ id: 'case-b4', state: 'restricted_pending_user_response' }, { lookupThrows: true });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const response = await worker.fetch(
      enqueueRequest({ pubkey: VALID_PUBKEY, action: 'age-restrict-all' }), env, ctx,
    );
    expect(response.status).toBe(200);
    expect(send).toHaveBeenCalledTimes(1);
    errorSpy.mockRestore();
  });

  it('leaves validation to the handler: malformed pubkey is a 400, not a guard error', async () => {
    const { env, send } = makeBulkEnv({ id: 'case-b5', state: 'restricted_pending_user_response' });
    const response = await worker.fetch(
      enqueueRequest({ pubkey: 'not-a-pubkey', action: 'age-restrict-all' }), env, ctx,
    );
    expect(response.status).toBe(400);
    expect(send).not.toHaveBeenCalled();
  });
});

describe('summarize-user cache validation', () => {
  const FALLBACK_SUMMARY = 'Unable to analyze user behavior at this time.';

  function makeSummarizeEnv(
    cached: string | null,
    opts: { anthropicKey?: string; getThrows?: boolean; putThrows?: boolean } = {},
  ) {
    const kv = {
      get: vi.fn(async () => {
        if (opts.getThrows) throw new Error('KV read down');
        return cached;
      }),
      put: vi.fn(async () => {
        if (opts.putThrows) throw new Error('KV write down');
      }),
    };
    const env = {
      ALLOWED_ORIGINS: 'https://app.divine.video',
      RELAY_URL: 'wss://relay.divine.video',
      ADMIN_API_KEY: 'test-admin-key',
      ANTHROPIC_API_KEY: opts.anthropicKey,
      KV: kv,
    } as never;
    return { env, kv };
  }

  // Stub the Anthropic call so a regeneration returns a known summary. Lets a
  // test tell "served from cache / fallback" apart from "actually regenerated".
  function stubModel(summaryJson: string) {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ content: [{ type: 'text', text: summaryJson }] }), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  }

  function summarizeRequest() {
    return new Request('https://api-relay-prod.divine.video/api/summarize-user', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Admin-Key': 'test-admin-key',
        Origin: 'https://app.divine.video',
      },
      body: JSON.stringify({ pubkey: 'abc', recentPosts: [], existingLabels: [], reportHistory: [] }),
    });
  }

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('serves a valid cached summary unchanged, without regenerating', async () => {
    const { env, kv } = makeSummarizeEnv(JSON.stringify({ summary: 'cached ok', riskLevel: 'high' }));
    const response = await worker.fetch(summarizeRequest(), env, ctx);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ summary: 'cached ok', riskLevel: 'high' });
    expect(kv.get).toHaveBeenCalled();
    expect(kv.put).not.toHaveBeenCalled();
  });

  it('re-validates a well-formed cached entry on read: clamps riskLevel, strips extras, serves it', async () => {
    // Valid non-blank summary but out-of-enum riskLevel + an extra key (e.g. a
    // pre-#169 entry). This is served (not regenerated) with the summary text
    // intact and only the schema tightened. No Anthropic key proves no regen.
    const stale = JSON.stringify({ summary: 'stale but real', riskLevel: 'severe', injected: 'ignore me' });
    const { env, kv } = makeSummarizeEnv(stale);
    const response = await worker.fetch(summarizeRequest(), env, ctx);
    expect(await response.json()).toEqual({ summary: 'stale but real', riskLevel: 'unknown' });
    expect(kv.put).not.toHaveBeenCalled();
  });

  it('regenerates instead of serving a cached entry that fails normalization', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    // Blank summary -> normalizes to null. Without an Anthropic key the
    // regeneration fails into the fallback, whose summary text differs from the
    // cached one, proving the stale entry was not served.
    const { env } = makeSummarizeEnv(JSON.stringify({ summary: '', riskLevel: 'critical' }));
    const response = await worker.fetch(summarizeRequest(), env, ctx);
    const body = await response.json() as { summary: string; riskLevel: string };
    expect(body.summary).toBe(FALLBACK_SUMMARY); // fell through, did not serve the blank cached entry
    expect(body.riskLevel).toBe('unknown');
  });

  it('regenerates instead of serving an unparseable cached entry', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { env, kv } = makeSummarizeEnv('this is not json');
    const response = await worker.fetch(summarizeRequest(), env, ctx);
    const body = await response.json() as { summary: string; riskLevel: string };
    expect(body.summary).toBe(FALLBACK_SUMMARY); // did not serve the raw cached string
    expect(body.riskLevel).toBe('unknown');
    expect(kv.put).not.toHaveBeenCalled();       // fallback path never caches
  });

  it('degrades to regeneration when the cache read throws, not the error card', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const fetchMock = stubModel('{"summary":"fresh","riskLevel":"low"}');
    const { env } = makeSummarizeEnv(null, { anthropicKey: 'test-key', getThrows: true });
    const response = await worker.fetch(summarizeRequest(), env, ctx);
    expect(await response.json()).toEqual({ summary: 'fresh', riskLevel: 'low' }); // regenerated, not fallback
    expect(fetchMock).toHaveBeenCalled();
  });

  it('returns the generated summary even when the cache write throws', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    stubModel('{"summary":"fresh","riskLevel":"low"}');
    const { env, kv } = makeSummarizeEnv(null, { anthropicKey: 'test-key', putThrows: true });
    const response = await worker.fetch(summarizeRequest(), env, ctx);
    expect(await response.json()).toEqual({ summary: 'fresh', riskLevel: 'low' }); // write failure did not collapse it
    expect(kv.put).toHaveBeenCalled();
  });
});

describe('mobile NIP-98 endpoint host allowlist (#173)', () => {
  const OWN_HOST_URL = 'https://api-relay-prod.divine.video/v1/account/moderation-status';
  const PUBLIC_HOST_URL = 'https://api.divine.video/v1/account/moderation-status';

  function nip98Header(u: string): string {
    const sk = generateSecretKey();
    const evt = finalizeEvent(
      { kind: 27235, content: '', tags: [['u', u], ['method', 'GET']], created_at: Math.floor(Date.now() / 1000) },
      sk,
    );
    return 'Nostr ' + btoa(JSON.stringify(evt));
  }

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // No DB in env → handleGetModerationStatus fails open to 200 (age-review.ts:581-584),
  // so a 200 here proves the auth gate passed, with no D1 harness needed. The
  // fail-open path logs an expected `[age-review] DB not available` warning;
  // silence it so the suite output stays clean.
  it('accepts a public-host-signed request when the host is allowlisted (the fix, end-to-end)', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const res = await worker.fetch(
      new Request(OWN_HOST_URL, { method: 'GET', headers: { Authorization: nip98Header(PUBLIC_HOST_URL) } }),
      { NIP98_PUBLIC_HOST_ALLOWLIST: 'api.divine.video' } as never,
      ctx,
    );
    expect(res.status).toBe(200);
  });

  // Config is user-edited free text (unlike URL.hostname, which the platform always
  // lowercases), so a mixed-case entry must still normalize to match at compare time.
  it('accepts a public host configured with mixed case (config is case-insensitive)', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const res = await worker.fetch(
      new Request(OWN_HOST_URL, { method: 'GET', headers: { Authorization: nip98Header(PUBLIC_HOST_URL) } }),
      { NIP98_PUBLIC_HOST_ALLOWLIST: 'API.Divine.Video' } as never,
      ctx,
    );
    expect(res.status).toBe(200);
  });

  it('accepts an own-host-signed request with no allowlist configured (regression)', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const res = await worker.fetch(
      new Request(OWN_HOST_URL, { method: 'GET', headers: { Authorization: nip98Header(OWN_HOST_URL) } }),
      {} as never,
      ctx,
    );
    expect(res.status).toBe(200);
  });

  it('rejects a public-host-signed request when the host is NOT allowlisted', async () => {
    const res = await worker.fetch(
      new Request(OWN_HOST_URL, { method: 'GET', headers: { Authorization: nip98Header(PUBLIC_HOST_URL) } }),
      {} as never,
      ctx,
    );
    expect(res.status).toBe(401);
  });
});

describe('zendesk pre-auth NIP-98 scope boundary (#173)', () => {
  const OWN_HOST_PREAUTH_URL = 'https://api-relay-prod.divine.video/api/zendesk/pre-auth';
  const PUBLIC_HOST_PREAUTH_URL = 'https://api.divine.video/api/zendesk/pre-auth';

  // Tolerates ensureSchemaOnce's DDL (db.ts: a sequence of `.prepare(sql).run()`
  // calls, no `.bind()`/`.first()` needed for schema setup) as async no-ops. The
  // pre-auth nonce INSERT is never reached in this test — auth fails first.
  function makeZendeskDb() {
    const statement = (): { bind: () => unknown; run: () => Promise<{ success: boolean }>; first: () => Promise<null> } => ({
      bind: () => statement(),
      run: async () => ({ success: true }),
      first: async () => null,
    });
    return { prepare: statement };
  }

  // Proves the Zendesk pre-auth route stays same-host-only even with the mobile
  // allowlist configured (Global Constraint 4: Zendesk is out of #173's scope).
  it('rejects a public-host-signed request even when the mobile allowlist is configured (scope boundary)', async () => {
    const sk = generateSecretKey();
    const evt = finalizeEvent(
      {
        kind: 27235,
        content: '',
        tags: [['u', PUBLIC_HOST_PREAUTH_URL], ['method', 'POST']],
        created_at: Math.floor(Date.now() / 1000),
      },
      sk,
    );
    const res = await worker.fetch(
      new Request(OWN_HOST_PREAUTH_URL, {
        method: 'POST',
        headers: { Authorization: 'Nostr ' + btoa(JSON.stringify(evt)) },
      }),
      {
        ZENDESK_PREAUTH_SECRET: 'test-secret',
        DB: makeZendeskDb(),
        NIP98_PUBLIC_HOST_ALLOWLIST: 'api.divine.video',
      } as never,
      ctx,
    );
    expect(res.status).toBe(401);
  });
});

// -- scheduled() DB-unavailable alert (#197) ----------------------------------

describe('scheduled cron — DB-unavailable alert', () => {
  const scheduledEvent = {} as ScheduledEvent;

  // The REPORT_WATCHER keep-alive check runs before the DB block and returns
  // early if the binding is absent, so it must be present to exercise the DB
  // branch below.
  function makeReportWatcher() {
    return {
      idFromName: vi.fn().mockReturnValue('singleton-id'),
      get: vi.fn().mockReturnValue({
        fetch: vi.fn().mockResolvedValue(new Response(JSON.stringify({ status: { running: true } }), { status: 200 })),
      }),
    };
  }

  // Tolerates ensureSchema's DDL and checkAgeReviewDeadlines' queries without
  // producing any rows, so the DB-present case exercises the real code path
  // without also triggering the deadline-alert Slack call.
  function makeTolerantDb() {
    const statement = (sql: string): unknown => ({
      bind: () => statement(sql),
      run: async () => ({ success: true, meta: { changes: 0 } }),
      first: async () => null,
      all: async () => ({ results: [] }),
    });
    return { prepare: statement };
  }

  beforeEach(() => {
    // scheduled() unconditionally logs a ReportWatcher status line; keep it
    // out of test stdout.
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('sends the DB-unavailable Slack alert (with environment) when the DB binding is absent', async () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', mockFetch);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const cronEnv = {
      ALLOWED_ORIGINS: 'https://app.divine.video',
      RELAY_URL: 'wss://relay.divine.video',
      REPORT_WATCHER: makeReportWatcher(),
      SLACK_WEBHOOK_URL: 'https://hooks.slack.com/test',
      ENVIRONMENT: 'staging',
      // DB intentionally absent
    } as never;

    await worker.scheduled(scheduledEvent, cronEnv, ctx);

    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockFetch.mock.calls[0][0]).toBe('https://hooks.slack.com/test');
    const options = mockFetch.mock.calls[0][1] as { body: string };
    const payload = JSON.parse(options.body) as { text: string };
    expect(payload.text).toContain('[staging]');
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('D1 UNAVAILABLE'));
  });

  it('defaults the environment to "unknown" when ENVIRONMENT is not configured', async () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', mockFetch);
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const cronEnv = {
      ALLOWED_ORIGINS: 'https://app.divine.video',
      RELAY_URL: 'wss://relay.divine.video',
      REPORT_WATCHER: makeReportWatcher(),
      SLACK_WEBHOOK_URL: 'https://hooks.slack.com/test',
      // ENVIRONMENT and DB both intentionally absent
    } as never;

    await worker.scheduled(scheduledEvent, cronEnv, ctx);

    const options = mockFetch.mock.calls[0][1] as { body: string };
    const payload = JSON.parse(options.body) as { text: string };
    expect(payload.text).toContain('[unknown]');
  });

  it('sends the DB-unavailable alert even when REPORT_WATCHER is not configured', async () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', mockFetch);
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const cronEnv = {
      ALLOWED_ORIGINS: 'https://app.divine.video',
      RELAY_URL: 'wss://relay.divine.video',
      SLACK_WEBHOOK_URL: 'https://hooks.slack.com/test',
      // REPORT_WATCHER and DB both intentionally absent
    } as never;

    await worker.scheduled(scheduledEvent, cronEnv, ctx);

    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockFetch.mock.calls[0][0]).toBe('https://hooks.slack.com/test');
  });

  it('does not send the DB-unavailable alert when the DB binding is present', async () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', mockFetch);

    const cronEnv = {
      ALLOWED_ORIGINS: 'https://app.divine.video',
      RELAY_URL: 'wss://relay.divine.video',
      REPORT_WATCHER: makeReportWatcher(),
      SLACK_WEBHOOK_URL: 'https://hooks.slack.com/test',
      DB: makeTolerantDb(),
    } as never;

    await worker.scheduled(scheduledEvent, cronEnv, ctx);

    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('does not send the DB-unavailable alert when no webhook is configured', async () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', mockFetch);

    const cronEnv = {
      ALLOWED_ORIGINS: 'https://app.divine.video',
      RELAY_URL: 'wss://relay.divine.video',
      REPORT_WATCHER: makeReportWatcher(),
      // SLACK_WEBHOOK_URL intentionally absent, DB absent too
    } as never;

    await worker.scheduled(scheduledEvent, cronEnv, ctx);

    expect(mockFetch).not.toHaveBeenCalled();
  });
});

// A relay whose backing store is slow or dying must not make the moderation
// queue render as legitimately empty. queryRelay() may only report success on
// an EOSE-complete result; timeout and close-before-EOSE are errors so the
// API returns 502 and the frontend keeps its last good data. Surfaced by a
// slow staging backend, but any relay answer past the timeout does the same
// in production.
describe('bulk relay-query integrity (/api/reports, /api/resolution-labels)', () => {
  class FakeRelaySocket {
    static instances: FakeRelaySocket[] = [];
    url: string;
    sent: string[] = [];
    private listeners: Record<string, ((ev: unknown) => void)[]> = {};
    constructor(url: string) {
      this.url = url;
      FakeRelaySocket.instances.push(this);
      queueMicrotask(() => this.emit('open', {}));
    }
    addEventListener(type: string, cb: (ev: unknown) => void) {
      (this.listeners[type] ??= []).push(cb);
    }
    send(data: string) { this.sent.push(data); }
    close() { queueMicrotask(() => this.emit('close', {})); }
    emit(type: string, ev: unknown) {
      for (const cb of this.listeners[type] ?? []) cb(ev);
    }
    subId(): string { return JSON.parse(this.sent[0])[1] as string; }
    message(payload: unknown) { this.emit('message', { data: JSON.stringify(payload) }); }
  }

  const reportsEnv = {
    ALLOWED_ORIGINS: 'https://app.divine.video',
    RELAY_URL: 'wss://relay.example',
    ADMIN_API_KEY: 'test-admin-key',
  } as never;

  const reportsRequest = () => new Request('https://api.example/api/reports', {
    headers: { 'X-Admin-Key': 'test-admin-key' },
  });

  const labelsRequest = () => new Request('https://api.example/api/resolution-labels', {
    headers: { 'X-Admin-Key': 'test-admin-key' },
  });

  const EVENT_A = { id: 'a'.repeat(64), kind: 1984, pubkey: 'b'.repeat(64), tags: [], content: '', sig: 'c'.repeat(128), created_at: 1 };
  const EVENT_B = { id: 'd'.repeat(64), kind: 1984, pubkey: 'b'.repeat(64), tags: [], content: '', sig: 'c'.repeat(128), created_at: 2 };
  const LABEL_A = { id: 'e'.repeat(64), kind: 1985, pubkey: 'f'.repeat(64), tags: [['L', 'moderation/resolution']], content: '', sig: 'c'.repeat(128), created_at: 3 };

  beforeEach(() => {
    FakeRelaySocket.instances = [];
    vi.stubGlobal('WebSocket', FakeRelaySocket);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('returns events on an EOSE-complete result', async () => {
    const resPromise = worker.fetch(reportsRequest(), reportsEnv, ctx);
    await new Promise((r) => setTimeout(r, 0));
    const sock = FakeRelaySocket.instances[0];
    expect(sock).toBeDefined();
    sock.message(['EVENT', sock.subId(), EVENT_A]);
    sock.message(['EVENT', sock.subId(), EVENT_B]);
    sock.message(['EOSE', sock.subId()]);
    const res = await resPromise;
    expect(res.status).toBe(200);
    const body = await res.json() as { success: boolean; events: unknown[] };
    expect(body.success).toBe(true);
    expect(body.events).toHaveLength(2);
  });

  it('returns 502 when the relay query times out before EOSE (partial data must not read as an empty queue)', async () => {
    vi.useFakeTimers();
    const resPromise = worker.fetch(reportsRequest(), reportsEnv, ctx);
    await vi.advanceTimersByTimeAsync(0);
    const sock = FakeRelaySocket.instances[0];
    expect(sock).toBeDefined();
    sock.message(['EVENT', sock.subId(), EVENT_A]); // partial data arrived, then the relay stalls
    await vi.advanceTimersByTimeAsync(5000);
    const res = await resPromise;
    expect(res.status).toBe(502);
    const body = await res.json() as { success: boolean; error?: string };
    expect(body.success).toBe(false);
    expect(body.error).toMatch(/timed out/i);
  });

  it('returns 502 when the relay closes before EOSE', async () => {
    const resPromise = worker.fetch(reportsRequest(), reportsEnv, ctx);
    await new Promise((r) => setTimeout(r, 0));
    const sock = FakeRelaySocket.instances[0];
    expect(sock).toBeDefined();
    sock.message(['EVENT', sock.subId(), EVENT_A]);
    sock.emit('close', {});
    const res = await resPromise;
    expect(res.status).toBe(502);
    const body = await res.json() as { success: boolean; error?: string };
    expect(body.success).toBe(false);
    expect(body.error).toMatch(/closed before/i);
  });

  // /api/resolution-labels feeds the queue's resolvedTargets set, which decides
  // whether a handled target stays hidden. A truncated read here is worse than
  // an error: it silently re-presents resolved work as pending (#221).
  it('returns labels on an EOSE-complete result', async () => {
    const resPromise = worker.fetch(labelsRequest(), reportsEnv, ctx);
    await new Promise((r) => setTimeout(r, 0));
    const sock = FakeRelaySocket.instances[0];
    expect(sock).toBeDefined();
    sock.message(['EVENT', sock.subId(), LABEL_A]);
    sock.message(['EOSE', sock.subId()]);
    const res = await resPromise;
    expect(res.status).toBe(200);
    const body = await res.json() as { success: boolean; events: unknown[] };
    expect(body.success).toBe(true);
    expect(body.events).toHaveLength(1);
  });

  it('returns 502 when the resolution-label query times out before EOSE', async () => {
    vi.useFakeTimers();
    const resPromise = worker.fetch(labelsRequest(), reportsEnv, ctx);
    await vi.advanceTimersByTimeAsync(0);
    const sock = FakeRelaySocket.instances[0];
    expect(sock).toBeDefined();
    sock.message(['EVENT', sock.subId(), LABEL_A]); // partial labels arrived, then the relay stalls
    await vi.advanceTimersByTimeAsync(5000);
    const res = await resPromise;
    expect(res.status).toBe(502);
    const body = await res.json() as { success: boolean; error?: string };
    expect(body.success).toBe(false);
    expect(body.error).toMatch(/timed out/i);
  });

  // NIP-01 CLOSED is how a relay says it refused or killed the subscription.
  // funnelcake sends "error: could not complete query" when its store fails a
  // query, which is exactly the incident behind this fix. Waiting out the 5s
  // timeout on a failure the relay already reported is both slow and mislabeled.
  it('fails immediately with the relay reason when the subscription is CLOSED', async () => {
    vi.useFakeTimers();
    const resPromise = worker.fetch(reportsRequest(), reportsEnv, ctx);
    await vi.advanceTimersByTimeAsync(0);
    const sock = FakeRelaySocket.instances[0];
    expect(sock).toBeDefined();
    sock.message(['CLOSED', sock.subId(), 'error: could not complete query']);
    // Resolves without needing the 5s timer to run down.
    const res = await resPromise;
    expect(res.status).toBe(502);
    const body = await res.json() as { success: boolean; error?: string };
    expect(body.success).toBe(false);
    expect(body.error).toMatch(/could not complete query/i);
    expect(body.error).not.toMatch(/timed out/i); // reported as what the relay said
  });

  // A reopen deletes the D1 decisions unconditionally, but clearing the relay's
  // resolution labels is best-effort. When that read fails the label survives and
  // keeps the report hidden, so the response has to say so or the UI reports a
  // clean reopen that did not happen.
  it('flags labelCleanupFailed when the resolution-label query fails during a reopen', async () => {
    const db = {
      prepare: () => {
        const stmt: Record<string, unknown> = {
          bind: () => stmt,
          run: async () => ({ success: true, meta: { changes: 3 } }),
          first: async () => null,
          all: async () => ({ results: [] }),
        };
        return stmt;
      },
    };
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    const resPromise = worker.fetch(
      new Request(`https://api.example/api/decisions/${'a'.repeat(64)}`, {
        method: 'DELETE',
        headers: { 'X-Admin-Key': 'test-admin-key' },
      }),
      { ...(reportsEnv as object), DB: db } as never,
      ctx,
    );
    await new Promise((r) => setTimeout(r, 0));
    // Both label filters close before EOSE, so neither cleanup can run.
    for (const sock of FakeRelaySocket.instances) sock.emit('close', {});
    await new Promise((r) => setTimeout(r, 0));
    for (const sock of FakeRelaySocket.instances) sock.emit('close', {});

    const res = await resPromise;
    expect(res.status).toBe(200);
    const body = await res.json() as { success: boolean; deleted: number; labelCleanupFailed: boolean };
    expect(body.success).toBe(true);
    expect(body.deleted).toBe(3); // the decisions really were deleted
    expect(body.labelCleanupFailed).toBe(true); // but the reopen is not clean
  });

  // The label read can succeed while the delete fails: a relay admin key
  // mismatch 403s every management command but leaves reads working. The label
  // survives and keeps the report hidden, so this reopen is no cleaner than a
  // failed read and must not report one.
  it('flags labelCleanupFailed when the label is found but banevent fails', async () => {
    const db = {
      prepare: () => {
        const stmt: Record<string, unknown> = {
          bind: () => stmt,
          run: async () => ({ success: true, meta: { changes: 2 } }),
          first: async () => null,
          all: async () => ({ results: [] }),
        };
        return stmt;
      },
    };
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const resPromise = worker.fetch(
      new Request(`https://api.example/api/decisions/${'a'.repeat(64)}`, {
        method: 'DELETE',
        headers: { 'X-Admin-Key': 'test-admin-key' },
      }),
      // No NOSTR_NSEC, so the NIP-86 banevent cannot be signed and fails.
      { ...(reportsEnv as object), DB: db } as never,
      ctx,
    );

    // Both label queries return a label and complete cleanly; only the delete fails.
    for (let i = 0; i < 2; i++) {
      await new Promise((r) => setTimeout(r, 0));
      const sock = FakeRelaySocket.instances[i];
      if (!sock) break;
      sock.message(['EVENT', sock.subId(), LABEL_A]);
      sock.message(['EOSE', sock.subId()]);
    }

    const res = await resPromise;
    const body = await res.json() as { success: boolean; labelsDeleted: number; labelCleanupFailed: boolean };
    expect(body.labelsDeleted).toBe(0); // nothing was actually removed
    expect(body.labelCleanupFailed).toBe(true);
  });

  it('returns 502 when the relay closes before EOSE on resolution labels', async () => {
    const resPromise = worker.fetch(labelsRequest(), reportsEnv, ctx);
    await new Promise((r) => setTimeout(r, 0));
    const sock = FakeRelaySocket.instances[0];
    expect(sock).toBeDefined();
    sock.message(['EVENT', sock.subId(), LABEL_A]);
    sock.emit('close', {});
    const res = await resPromise;
    expect(res.status).toBe(502);
    const body = await res.json() as { success: boolean; error?: string };
    expect(body.success).toBe(false);
    expect(body.error).toMatch(/closed before/i);
  });
});
