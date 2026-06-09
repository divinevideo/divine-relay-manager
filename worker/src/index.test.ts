import { describe, expect, it, vi } from 'vitest';
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
    expect(waitUntil).toHaveBeenCalledOnce();
    await waitUntil.mock.calls[0][0];
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

  it('banpubkey sends DM action ACCOUNT_BANNED', async () => {
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
    // No Keycast suspend/unsuspend on ban
    expect(keycastCalls(fetchSpy)).toHaveLength(0);

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
