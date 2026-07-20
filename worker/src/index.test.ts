import { afterEach, describe, expect, it, vi } from 'vitest';
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
