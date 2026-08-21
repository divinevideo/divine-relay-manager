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
          // A real 64-hex pubkey: banpubkey rejects a non-canonical one outright,
          // and this test is about the DM path, not the pubkey format.
          params: ['abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234', 'test reason'],
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
  function makeAccountStateEnvWithDb(caseRow: { id: string; state: string } | null, opts: { requireSchema?: boolean } = {}) {
    const active = caseRow && !['cleared', 'denied_closed'].includes(caseRow.state) ? caseRow : null;
    let ageReviewCasesExists = !opts.requireSchema;
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
        prepare: (sql: string) => ({
          bind: () => ({
            first: async () => {
              if (sql.includes('FROM age_review_cases') && !ageReviewCasesExists) {
                throw new Error('no such table: age_review_cases');
              }
              return active;
            },
            run: async () => ({ success: true, meta: { changes: 1 } }),
          }),
          run: async () => {
            if (sql.includes('CREATE TABLE IF NOT EXISTS age_review_cases')) {
              ageReviewCasesExists = true;
            }
            return { success: true, meta: { changes: 0 } };
          },
        }),
      },
    } as never;
  }

  // D1 present but throwing, to exercise the guard's fail-open / fail-closed split.
  // A real outage fails the schema DDL too, not just the lookup: `.run()` is what
  // ensureSchemaOnce calls, and modelling only `.first()` hid the bootstrap
  // escaping as an unhandled rejection instead of reaching the guard's decision.
  function makeAccountStateEnvWithFailingCaseLookup() {
    return {
      ...(makeAccountStateEnvWithDb(null) as unknown as Record<string, unknown>),
      DB: {
        prepare: () => ({
          bind: () => ({
            first: async () => {
              throw new Error('D1 unavailable');
            },
            run: async () => {
              throw new Error('D1 unavailable');
            },
          }),
          run: async () => {
            throw new Error('D1 unavailable');
          },
        }),
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

  // Same request against a COLD isolate. `schemaReady` in index.ts is module-level,
  // so the first test to reach ensureSchemaOnce makes it a no-op for every test
  // after it -- which silently stops the bootstrap path from being exercised at
  // all. Re-importing under vi.resetModules() is the only way to test what a
  // freshly started worker does on its first request, which is the only time the
  // DDL actually runs.
  async function callRelayRpcColdIsolate(
    method: string,
    params: string[],
    testEnv: never,
    testCtx: ExecutionContext,
  ): Promise<Response> {
    vi.resetModules();
    const freshWorker = (await import('./index')).default;
    return freshWorker.fetch(
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

  it('bootstraps age-review schema before guarding a relay-rpc reversal', async () => {
    // /api/relay-rpc can be the first request to touch a freshly provisioned D1.
    // The guard must create age_review_cases before querying it, otherwise
    // fail-closed turns a missing table into a permanent reversal outage.
    const fetchSpy = makeFetchSpy();
    const waitUntil = vi.fn();
    const testCtx = { waitUntil } as unknown as ExecutionContext;
    const env = makeAccountStateEnvWithDb(null, { requireSchema: true });

    // Cold isolate, or this asserts nothing: `schemaReady` is module-level, so
    // once any earlier test has reached ensureSchemaOnce the bootstrap is a
    // no-op here and the test passes without exercising it. That also made it
    // the file's last order-dependent test.
    const response = await callRelayRpcColdIsolate('unbanpubkey', [VALID_PUBKEY], env, testCtx);
    expect(response.status).toBe(200);

    await drain(waitUntil);
    const kc = keycastCalls(fetchSpy);
    expect(kc).toHaveLength(1);
    expect(kc[0].status).toBe('active');

    fetchSpy.mockRestore();
  });

  it('unsuspendpubkey triggers Keycast unsuspend and DM action ACCOUNT_RESTORED', async () => {
    const fetchSpy = makeFetchSpy();
    const waitUntil = vi.fn();
    const testCtx = { waitUntil } as unknown as ExecutionContext;

    const response = await callRelayRpc('unsuspendpubkey', [VALID_PUBKEY], makeAccountStateEnvWithDb(null), testCtx);
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

    const response = await callRelayRpc('unbanpubkey', [VALID_PUBKEY], makeAccountStateEnvWithDb(null), testCtx);
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

  it('unbanpubkey is refused when the target has an active age-review case', async () => {
    // unbanpubkey calls unsuspendUser, which sets Keycast status to active and so
    // lifts an age-review suspension as well as a ban. Without the guard, a Coop
    // Unban-User restores login and signing on an account still under review.
    const fetchSpy = makeFetchSpy();
    const waitUntil = vi.fn();
    const testCtx = { waitUntil } as unknown as ExecutionContext;
    const env = makeAccountStateEnvWithDb({ id: 'case-unban', state: 'restricted_pending_user_response' });

    const response = await callRelayRpc('unbanpubkey', [VALID_PUBKEY], env, testCtx);
    expect(response.status).toBe(409);
    const body = await response.json() as { code: string; caseId: string };
    expect(body.code).toBe('age_review_active');
    expect(body.caseId).toBe('case-unban');

    // No Keycast status change: the hold must survive the refused unban.
    await drain(waitUntil);
    expect(keycastCalls(fetchSpy)).toHaveLength(0);
    // And nothing went out at all -- the relay un-ban is the action being
    // guarded, so the refusal has to land BEFORE it, not merely report 409
    // afterwards. Asserting only on Keycast would miss a guard that ran late,
    // since Keycast is a waitUntil side effect skipped on any early return.
    expect(fetchSpy).not.toHaveBeenCalled();

    fetchSpy.mockRestore();
  });

  it('allow_pubkey via /api/moderate forwards the guard 409 instead of flattening it to 500', async () => {
    // allow_pubkey re-enters handleRelayRpc with unbanpubkey, so it inherits the
    // guard. Re-wrapping at 500 would drop code/caseId/state that callers route
    // on, and would label a permanent refusal as transient, which retrying
    // clients treat as "try again".
    const fetchSpy = makeFetchSpy();
    const waitUntil = vi.fn();
    const testCtx = { waitUntil } as unknown as ExecutionContext;
    const env = makeAccountStateEnvWithDb({ id: 'case-allow', state: 'restricted_pending_user_response' });

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
      env,
      testCtx,
    );

    expect(response.status).toBe(409);
    const body = await response.json() as { code: string; caseId: string };
    expect(body.code).toBe('age_review_active');
    expect(body.caseId).toBe('case-allow');

    await drain(waitUntil);
    expect(keycastCalls(fetchSpy)).toHaveLength(0);

    fetchSpy.mockRestore();
  });

  it('allow_pubkey via /api/moderate forwards the 503 too, not just the 409', async () => {
    // The other half of the same contract, and the half a caller most needs: a
    // permanent refusal and an unrunnable check must stay distinguishable across
    // the hop. Flattening this one to 500 strips `code`, so the caller cannot tell
    // "there is a case" from "we could not look" from "the relay broke".
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
      makeAccountStateEnvWithFailingCaseLookup(),
      testCtx,
    );

    expect(response.status).toBe(503);
    const body = await response.json() as { code: string };
    expect(body.code).toBe('age_review_check_failed');

    await drain(waitUntil);
    expect(keycastCalls(fetchSpy)).toHaveLength(0);

    fetchSpy.mockRestore();
  });

  // An env that records every SQL statement, so a test can assert the human-review
  // marking actually ran rather than inferring it from a 200.
  function makeSqlRecordingEnv(order?: string[]) {
    const sql: string[] = [];
    const bound: { statement: string; args: unknown[] }[] = [];
    const visibilityOperations: unknown[] = [];
    const db = {
      prepare: (statement: string) => {
        sql.push(statement);
        return {
          // Record the statement WITH its args as one tuple. Keeping two arrays and
          // aligning them by index desynced the moment a statement ran without bind():
          // ensureSchema issues ~20 such calls, so `marked()` silently returned
          // undefined and three tests passed only because an earlier test in the file
          // had already flipped the module-level schemaReady flag. Running them in
          // isolation went red on correct code, and dropping the ensureSchemaOnce call
          // survived the whole mutation battery.
          bind: (...args: unknown[]) => {
            bound.push({ statement, args });
            return {
              first: async () => null,
              run: async () => {
                // Into the SHARED log, so ordering against the relay call is a real
                // index comparison rather than two unrelated arrays.
                if (order && statement.includes('INSERT INTO moderation_targets')) {
                  order.push('db:mark');
                }
                return { success: true, meta: { changes: 1 } };
              },
            };
          },
          run: async () => ({ success: true, meta: { changes: 0 } }),
        };
      },
    };
    const env = {
      ALLOWED_ORIGINS: 'https://app.divine.video',
      RELAY_URL: 'wss://relay.divine.video',
      ADMIN_API_KEY: 'test-admin-key',
      MODERATION_ADMIN_URL: 'https://moderation-api.divine.video',
      SERVICE_API_TOKEN: 'test-token',
      NOSTR_NSEC: TEST_NSEC,
      DB: db,
      REPORT_WATCHER: {
        idFromName: () => 'singleton',
        get: () => ({
          fetch: async (request: Request) => {
            const operation = await request.json() as {
              eventId: string;
              relayAction: 'hide' | 'allow' | 'review' | 'confirm';
              reason?: string;
              humanAction?: string;
            };
            visibilityOperations.push(operation);
            if (operation.relayAction === 'confirm') {
              return Response.json({ success: true, recorded: true });
            }
            if (operation.relayAction === 'review') {
              const recorded = await db.prepare(`
                INSERT INTO moderation_targets (target_id, target_type, ever_human_reviewed)
                VALUES (?, ?, 1)
              `).bind(operation.eventId, 'event').run().then(() => true);
              return Response.json({ success: true, recorded });
            }
            const relayResponse = await fetch('https://relay.divine.video/management', {
              method: 'POST',
              body: JSON.stringify({
                method: operation.relayAction === 'hide' ? 'banevent' : 'allowevent',
                params: operation.relayAction === 'hide'
                  ? [operation.eventId, operation.reason]
                  : [operation.eventId],
              }),
            });
            if (!relayResponse.ok) {
              return Response.json({ success: false, error: 'relay exploded' }, { status: 502 });
            }
            const recorded = operation.humanAction
              ? await db.prepare(`
                INSERT INTO moderation_targets (target_id, target_type, ever_human_reviewed, last_human_action)
                VALUES (?, ?, 1, ?)
              `).bind(operation.eventId, 'event', operation.humanAction).run().then(() => true)
              : undefined;
            return Response.json({ success: true, recorded });
          },
        }),
      },
    } as never;
    // `marked` reads the bound id off the moderation_targets upsert specifically.
    // Asserting only that some SQL mentioned the table lets an implementation mark a
    // DIFFERENT id and still pass, which is the exact failure a case-mangled id causes.
    const markedRow = () => {
      const row = bound.find(b => b.statement.includes('INSERT INTO moderation_targets'));
      return row?.args ?? null;
    };
    return {
      env,
      sql,
      bound,
      visibilityOperations,
      marked: () => markedRow()?.[0] ?? null,
      markedAction: () => markedRow()?.[2] ?? null,
    };
  }

  const VALID_EVENT_ID = 'a'.repeat(64);

  // Coop routes Hide-Content and Restore-Content through the adapter. Sending them
  // over raw /api/relay-rpc bans/allows the event but never marks it human-reviewed,
  // so ReportWatcher.hasHumanResolution stays false and the next immediate-tier
  // report re-hides content a moderator deliberately restored. These two tests pin
  // that a moderator decision is recorded, which is the whole point of routing them
  // through /api/moderate instead.
  // Records the NIP-86 method AND interleaves relay/DB calls into one ordered log, so a
  // test can pin which relay call was issued and that the human-review mark happened
  // AFTER it. Without this, an implementation that marks first, or that hides when asked
  // to restore, passes a "some SQL mentioned moderation_targets" assertion.
  function makeOrderedRelaySpy(
    order: string[],
    opts: { relayFails?: boolean; failRelayCall?: number } = {},
  ) {
    let relayCalls = 0;
    return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url.includes('/api/v1/notify')) {
        order.push('dm');
        return new Response(JSON.stringify({ dm_sent: true }), { status: 200 });
      }
      if (url.includes('/api/admin/users/')) return new Response('', { status: 200 });
      const raw = input instanceof Request ? await input.clone().text() : String(init?.body ?? '');
      let method = 'unknown';
      try { method = (JSON.parse(raw) as { method?: string }).method ?? 'unknown'; } catch { /* not NIP-86 */ }
      order.push(`relay:${method}`);
      relayCalls++;
      if (opts.relayFails || opts.failRelayCall === relayCalls) {
        return new Response(JSON.stringify({ error: 'relay exploded' }), { status: 502 });
      }
      return new Response(JSON.stringify({ result: true }), { status: 200 });
    });
  }

  async function postModerate(body: unknown, env: never, testCtx: ExecutionContext) {
    return worker.fetch(
      new Request('https://api-relay-prod.divine.video/api/moderate', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Admin-Key': 'test-admin-key',
          Origin: 'https://app.divine.video',
        },
        body: JSON.stringify(body),
      }),
      env,
      testCtx,
    );
  }

  it('hide_event bans the event, then marks THAT id human-reviewed, and sends no DM', async () => {
    const order: string[] = [];
    const fetchSpy = makeOrderedRelaySpy(order);
    const waitUntil = vi.fn();
    const testCtx = { waitUntil } as unknown as ExecutionContext;
    const { env, marked, markedAction } = makeSqlRecordingEnv(order);

    const response = await postModerate(
      { action: 'hide_event', eventId: VALID_EVENT_ID, reason: 'COOP hide' }, env, testCtx);

    expect(response.status).toBe(200);
    // Which relay call: a hide must ban, never allow. Pins an inverted implementation.
    expect(order.filter(o => o.startsWith('relay:'))).toEqual(['relay:banevent']);
    // Which id got marked: not merely "some SQL touched the table".
    expect(marked()).toBe(VALID_EVENT_ID);
    expect(markedAction()).toBe('hide_event');
    // Ordering: the mark must follow the relay confirming, or we suppress ReportWatcher
    // on content that is still live. Both entries are in the same log, so this compares
    // real positions. The previous version compared 0 to order.length and asserted 0 < 1.
    expect(order).toEqual(['relay:banevent', 'db:mark']);
    expect(await response.json()).toMatchObject({ success: true, recorded: true });

    // Hiding is not a permanent ban. delete_event DMs the creator PERMANENT_BAN, so
    // reusing it here would tell someone their content was removed for good.
    await drain(waitUntil);
    expect(order).not.toContain('dm');

    fetchSpy.mockRestore();
  });

  it.each([
    ['banevent', 'hide'],
    ['allowevent', 'allow'],
  ] as const)('raw %s coordinates visibility without asserting human review', async (method, relayAction) => {
    const order: string[] = [];
    const fetchSpy = makeOrderedRelaySpy(order);
    const { env, visibilityOperations, markedAction } = makeSqlRecordingEnv(order);

    const response = await worker.fetch(new Request('https://api-relay-prod.divine.video/api/relay-rpc', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Admin-Key': 'test-admin-key',
        Origin: 'https://app.divine.video',
      },
      body: JSON.stringify({ method, params: [VALID_EVENT_ID, 'manual action'] }),
    }), env, { waitUntil: vi.fn() } as unknown as ExecutionContext);

    expect(response.status).toBe(200);
    expect(visibilityOperations).toEqual([{
      eventId: VALID_EVENT_ID,
      relayAction,
      reason: 'manual action',
    }]);
    expect(markedAction()).toBeNull();
    fetchSpy.mockRestore();
  });

  it('forwards a legacy non-canonical allowevent without making cleanup stricter', async () => {
    const order: string[] = [];
    const fetchSpy = makeOrderedRelaySpy(order);
    const { env, visibilityOperations } = makeSqlRecordingEnv(order);

    const response = await worker.fetch(new Request('https://api-relay-prod.divine.video/api/relay-rpc', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Admin-Key': 'test-admin-key',
        Origin: 'https://app.divine.video',
      },
      body: JSON.stringify({ method: 'allowevent', params: ['legacy-event-id'] }),
    }), env, { waitUntil: vi.fn() } as unknown as ExecutionContext);

    expect(response.status).toBe(200);
    expect(order).toContain('relay:allowevent');
    expect(visibilityOperations).toEqual([]);
    fetchSpy.mockRestore();
  });

  it('allow_event allows and marks THAT id inside one coordinated operation', async () => {
    const order: string[] = [];
    const fetchSpy = makeOrderedRelaySpy(order);
    const waitUntil = vi.fn();
    const testCtx = { waitUntil } as unknown as ExecutionContext;
    const { env, marked, markedAction, visibilityOperations } = makeSqlRecordingEnv(order);

    const response = await postModerate({
      action: 'allow_event',
      eventId: VALID_EVENT_ID,
      reason: 'False positive',
      moderatorPubkey: 'b'.repeat(64),
    }, env, testCtx);

    expect(response.status).toBe(200);
    expect(order).toEqual(['relay:allowevent', 'db:mark']);
    expect(marked()).toBe(VALID_EVENT_ID);
    expect(markedAction()).toBe('allow_event');
    expect(visibilityOperations).toEqual([{
      eventId: VALID_EVENT_ID,
      relayAction: 'allow',
      reason: 'False positive',
      humanAction: 'allow_event',
      moderatorPubkey: 'b'.repeat(64),
    }]);
    expect(await response.json()).toMatchObject({ success: true, recorded: true, reconciled: true });

    fetchSpy.mockRestore();
  });

  // moderation_targets.target_id is BINARY-collated and ReportWatcher reads the lowercase
  // id off the report's `e` tag. An uppercase id marked verbatim writes a row nobody can
  // read: success is reported and the suppression never engages.
  it('hide_event canonicalises the event id, so the mark is readable by ReportWatcher', async () => {
    const order: string[] = [];
    const fetchSpy = makeOrderedRelaySpy(order);
    const testCtx = { waitUntil: vi.fn() } as unknown as ExecutionContext;
    const { env, marked } = makeSqlRecordingEnv();

    const response = await postModerate(
      { action: 'hide_event', eventId: VALID_EVENT_ID.toUpperCase() }, env, testCtx);

    expect(response.status).toBe(200);
    expect(marked()).toBe(VALID_EVENT_ID);
    fetchSpy.mockRestore();
  });

  it('rejects an event id that is not 64 hex, instead of banning whatever it was given', async () => {
    const order: string[] = [];
    const fetchSpy = makeOrderedRelaySpy(order);
    const testCtx = { waitUntil: vi.fn() } as unknown as ExecutionContext;
    const { env, sql } = makeSqlRecordingEnv();

    for (const bad of ['not-hex', '', 'a'.repeat(63), { $ne: 1 }]) {
      const response = await postModerate({ action: 'allow_event', eventId: bad }, env, testCtx);
      expect(response.status).toBe(400);
    }
    // Nothing may reach the relay or the ledger on a malformed id.
    expect(order.filter(o => o.startsWith('relay:'))).toEqual([]);
    expect(sql.some(s => s.includes('INSERT INTO moderation_targets'))).toBe(false);

    fetchSpy.mockRestore();
  });

  it('rejects malformed restore attribution before mutating relay visibility', async () => {
    const order: string[] = [];
    const fetchSpy = makeOrderedRelaySpy(order);
    const testCtx = { waitUntil: vi.fn() } as unknown as ExecutionContext;
    const { env, visibilityOperations } = makeSqlRecordingEnv();

    const response = await postModerate({
      action: 'allow_event',
      eventId: VALID_EVENT_ID,
      moderatorPubkey: { forged: true },
    }, env, testCtx);

    expect(response.status).toBe(400);
    expect(visibilityOperations).toEqual([]);
    expect(order).toEqual([]);
    fetchSpy.mockRestore();
  });

  it('validates and canonicalises auto-hide confirmation provenance', async () => {
    const testCtx = { waitUntil: vi.fn() } as unknown as ExecutionContext;
    const { env, visibilityOperations } = makeSqlRecordingEnv();
    const request = (body: Record<string, unknown>) => worker.fetch(new Request(
      'https://api-relay-prod.divine.video/api/confirm-auto-hide',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Admin-Key': 'test-admin-key',
          Origin: 'https://app.divine.video',
        },
        body: JSON.stringify({ eventId: VALID_EVENT_ID, ...body }),
      },
    ), env, testCtx);

    for (const body of [{ reportId: 'forged' }, { reporterPubkey: 'forged' }]) {
      expect((await request(body)).status).toBe(400);
    }
    const response = await request({
      reportId: 'B'.repeat(64),
      reporterPubkey: 'C'.repeat(64),
    });

    expect(response.status).toBe(200);
    expect(visibilityOperations).toEqual([{
      eventId: VALID_EVENT_ID,
      relayAction: 'confirm',
      reportId: 'b'.repeat(64),
      reporterPubkey: 'c'.repeat(64),
    }]);
  });

  // The relay change is the recoverable half; the RECORD is why these actions exist. A
  // caller told plain success would believe the decision is protected from ReportWatcher
  // when it is not.
  it('reports recorded:false when the relay change lands but the mark does not', async () => {
    const order: string[] = [];
    const fetchSpy = makeOrderedRelaySpy(order);
    const testCtx = { waitUntil: vi.fn() } as unknown as ExecutionContext;
    const env = {
      ALLOWED_ORIGINS: 'https://app.divine.video',
      RELAY_URL: 'wss://relay.divine.video',
      ADMIN_API_KEY: 'test-admin-key',
      SERVICE_API_TOKEN: 'test-token',
      NOSTR_NSEC: TEST_NSEC,
      DB: {
        prepare: (statement: string) => ({
          bind: () => ({
            first: async () => null,
            run: async () => {
              if (statement.includes('moderation_targets')) throw new Error('no such table');
              return { success: true, meta: { changes: 1 } };
            },
          }),
          run: async () => ({ success: true, meta: { changes: 0 } }),
        }),
      },
      REPORT_WATCHER: {
        idFromName: () => 'singleton',
        get: () => ({
          fetch: async () => {
            await fetch('https://relay.divine.video/management', {
              method: 'POST',
              body: JSON.stringify({ method: 'allowevent' }),
            });
            return Response.json({ success: true, recorded: false });
          },
        }),
      },
    } as never;

    const response = await postModerate({ action: 'allow_event', eventId: VALID_EVENT_ID }, env, testCtx);

    expect(response.status).toBe(200);
    expect(order.filter(o => o.startsWith('relay:'))).toEqual(['relay:allowevent']);
    expect(await response.json()).toMatchObject({ success: true, recorded: false, reconciled: false });

    fetchSpy.mockRestore();
  });

  it('does not issue a stale second allow and still syncs Zendesk', async () => {
    const order: string[] = [];
    const fetchSpy = makeOrderedRelaySpy(order);
    const testCtx = { waitUntil: vi.fn() } as unknown as ExecutionContext;
    const { env, sql } = makeSqlRecordingEnv(order);

    const response = await postModerate({ action: 'allow_event', eventId: VALID_EVENT_ID }, env, testCtx);

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ success: true, recorded: true, reconciled: true });
    expect(order).toEqual(['relay:allowevent', 'db:mark']);
    expect(sql.some(statement => statement.includes('FROM zendesk_tickets'))).toBe(true);

    fetchSpy.mockRestore();
  });

  // A transient relay fault must stay retryable. Forwarding the relay's 400 would tell an
  // automated caller "do not retry" for what is an upstream outage.
  it('a relay failure flattens to 500, not a terminal 400', async () => {
    const order: string[] = [];
    const fetchSpy = makeOrderedRelaySpy(order, { relayFails: true });
    const testCtx = { waitUntil: vi.fn() } as unknown as ExecutionContext;
    const { env, sql } = makeSqlRecordingEnv();

    const response = await postModerate({ action: 'hide_event', eventId: VALID_EVENT_ID }, env, testCtx);

    expect(response.status).toBe(500);
    // And nothing may be recorded for an enforcement that did not happen.
    expect(sql.some(s => s.includes('INSERT INTO moderation_targets'))).toBe(false);

    fetchSpy.mockRestore();
  });

  it('refuses a reversal when the case lookup itself fails, rather than lifting the hold', async () => {
    // Fail closed on the reversal direction: an unchecked unban silently lifts a
    // minor-safety hold and reports success, so nobody learns the check never
    // ran. 503, not 409 -- "could not check", not "there is a case".
    const fetchSpy = makeFetchSpy();
    const waitUntil = vi.fn();
    const testCtx = { waitUntil } as unknown as ExecutionContext;
    const env = makeAccountStateEnvWithFailingCaseLookup();

    const response = await callRelayRpc('unbanpubkey', [VALID_PUBKEY], env, testCtx);
    expect(response.status).toBe(503);
    const body = await response.json() as { code: string };
    expect(body.code).toBe('age_review_check_failed');

    // Nothing lifted: no Keycast status change on a refused reversal.
    await drain(waitUntil);
    expect(keycastCalls(fetchSpy)).toHaveLength(0);

    fetchSpy.mockRestore();
  });

  it('refuses a reversal when there is no DB binding at all', async () => {
    // The persistent version of "the check cannot happen". Handling only the
    // thrown lookup would leave this case lifting holds while the transient one
    // refused, which is the wrong way round.
    const fetchSpy = makeFetchSpy();
    const waitUntil = vi.fn();
    const testCtx = { waitUntil } as unknown as ExecutionContext;

    const response = await callRelayRpc('unbanpubkey', [VALID_PUBKEY], makeAccountStateEnv(), testCtx);
    expect(response.status).toBe(503);
    const body = await response.json() as { code: string };
    expect(body.code).toBe('age_review_check_failed');

    await drain(waitUntil);
    expect(keycastCalls(fetchSpy)).toHaveLength(0);

    fetchSpy.mockRestore();
  });

  it('still lets a suspend through with no DB binding', async () => {
    const fetchSpy = makeFetchSpy();
    const waitUntil = vi.fn();
    const testCtx = { waitUntil } as unknown as ExecutionContext;

    const response = await callRelayRpc('suspendpubkey', [VALID_PUBKEY, 'policy'], makeAccountStateEnv(), testCtx);
    expect(response.status).toBe(200);
    await drain(waitUntil);
    const kc = keycastCalls(fetchSpy);
    expect(kc).toHaveLength(1);
    expect(kc[0].status).toBe('suspended');

    fetchSpy.mockRestore();
  });

  it('refuses unsuspendpubkey the same way when the lookup fails', async () => {
    const fetchSpy = makeFetchSpy();
    const waitUntil = vi.fn();
    const testCtx = { waitUntil } as unknown as ExecutionContext;

    const response = await callRelayRpc(
      'unsuspendpubkey', [VALID_PUBKEY], makeAccountStateEnvWithFailingCaseLookup(), testCtx,
    );
    expect(response.status).toBe(503);
    await drain(waitUntil);
    expect(keycastCalls(fetchSpy)).toHaveLength(0);

    fetchSpy.mockRestore();
  });

  it('still lets a suspend through when the lookup fails (over-enforcing is the safe side)', async () => {
    // The enforce direction keeps failing open: a suspend applied without the
    // check is visible and reversible, and blocking it would stop moderation
    // during an outage.
    const fetchSpy = makeFetchSpy();
    const waitUntil = vi.fn();
    const testCtx = { waitUntil } as unknown as ExecutionContext;

    const response = await callRelayRpc(
      'suspendpubkey', [VALID_PUBKEY, 'policy'], makeAccountStateEnvWithFailingCaseLookup(), testCtx,
    );
    expect(response.status).toBe(200);

    // Failing open must actually let the enforcement through, not just return 200.
    await drain(waitUntil);
    const kc = keycastCalls(fetchSpy);
    expect(kc).toHaveLength(1);
    expect(kc[0].status).toBe('suspended');

    fetchSpy.mockRestore();
  });

  // The three below run against a cold isolate, so the schema bootstrap actually
  // executes rather than being skipped by a flag an earlier test already set.
  // Bootstrapping is part of the check, not a precondition for it: when D1 is
  // down the DDL fails too, and that failure must reach the same fail-open /
  // fail-closed decision as a failed lookup instead of escaping the handler.
  it('still lets a suspend through on a cold isolate when D1 is down entirely', async () => {
    const fetchSpy = makeFetchSpy();
    const waitUntil = vi.fn();
    const testCtx = { waitUntil } as unknown as ExecutionContext;

    const response = await callRelayRpcColdIsolate(
      'suspendpubkey', [VALID_PUBKEY, 'policy'], makeAccountStateEnvWithFailingCaseLookup(), testCtx,
    );
    expect(response.status).toBe(200);
    // CORS must survive: a bare rejection loses the headers and the UI sees a
    // network error instead of the documented body.
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('https://app.divine.video');

    await drain(waitUntil);
    const kc = keycastCalls(fetchSpy);
    expect(kc).toHaveLength(1);
    expect(kc[0].status).toBe('suspended');

    fetchSpy.mockRestore();
  });

  it('refuses an unban on a cold isolate when D1 is down entirely', async () => {
    const fetchSpy = makeFetchSpy();
    const waitUntil = vi.fn();
    const testCtx = { waitUntil } as unknown as ExecutionContext;

    const response = await callRelayRpcColdIsolate(
      'unbanpubkey', [VALID_PUBKEY], makeAccountStateEnvWithFailingCaseLookup(), testCtx,
    );
    expect(response.status).toBe(503);
    const body = await response.json() as { code: string };
    expect(body.code).toBe('age_review_check_failed');
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('https://app.divine.video');

    await drain(waitUntil);
    expect(keycastCalls(fetchSpy)).toHaveLength(0);

    fetchSpy.mockRestore();
  });

  it('rejects a non-canonical pubkey on the ENFORCE direction', async () => {
    // A value the relay stores byte-exactly enforces on nobody, so a ban or suspend
    // carrying one is a no-op that reports success. 400 rather than the guard's 503:
    // this is the same answer handleGetActiveAgeReviewCase gives for the same regex,
    // and unlike a D1 outage a malformed pubkey never becomes valid on a retry.
    const fetchSpy = makeFetchSpy();
    const waitUntil = vi.fn();
    const testCtx = { waitUntil } as unknown as ExecutionContext;

    for (const method of ['banpubkey', 'suspendpubkey']) {
      const response = await callRelayRpc(
        method, [VALID_PUBKEY.toUpperCase(), 'policy'], makeAccountStateEnvWithDb(null), testCtx,
      );
      expect(response.status, `${method} must reject a non-canonical pubkey`).toBe(400);
      const body = await response.json() as { error: string };
      expect(body.error).toBe('Invalid pubkey');
    }

    await drain(waitUntil);
    expect(fetchSpy).not.toHaveBeenCalled();

    fetchSpy.mockRestore();
  });

  it('lets the REVERSE direction carry a non-canonical pubkey, so a bad row stays removable', async () => {
    // Deliberately asymmetric. banpubkey does not go through this check on main and
    // rows written before it did still exist, stored byte-exactly. If the un-ban
    // refused what the ban accepted, those rows could never be cleared from the UI --
    // cleanup would be stricter than the thing that created the mess. Nothing is
    // risked by allowing it: an age-review case is keyed to a real lowercase pubkey,
    // so a non-canonical value cannot have one to skip.
    const fetchSpy = makeFetchSpy();
    const waitUntil = vi.fn();
    const testCtx = { waitUntil } as unknown as ExecutionContext;

    const response = await callRelayRpc(
      'unbanpubkey', [VALID_PUBKEY.toUpperCase()], makeAccountStateEnvWithDb(null), testCtx,
    );
    expect(response.status).toBe(200);

    fetchSpy.mockRestore();
  });

  it('refuses an unsuspend on a cold isolate when D1 is down entirely', async () => {
    const fetchSpy = makeFetchSpy();
    const waitUntil = vi.fn();
    const testCtx = { waitUntil } as unknown as ExecutionContext;

    const response = await callRelayRpcColdIsolate(
      'unsuspendpubkey', [VALID_PUBKEY], makeAccountStateEnvWithFailingCaseLookup(), testCtx,
    );
    expect(response.status).toBe(503);
    const body = await response.json() as { code: string };
    expect(body.code).toBe('age_review_check_failed');

    await drain(waitUntil);
    expect(keycastCalls(fetchSpy)).toHaveLength(0);

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

    // The guard short-circuits before any enforcement side effect. Keycast and
    // the DM are waitUntil work skipped on any early return, so they cannot show
    // that the refusal beat the relay call -- assert nothing went out at all.
    await drain(waitUntil);
    expect(keycastCalls(fetchSpy)).toHaveLength(0);
    expect(await notifyBodies(fetchSpy)).toHaveLength(0);
    expect(fetchSpy).not.toHaveBeenCalled();

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
    // As above: the refusal has to land before the relay call, not after it.
    expect(fetchSpy).not.toHaveBeenCalled();

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
      makeAccountStateEnvWithDb(null),
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

describe('zendesk pre-auth canonical public host', () => {
  const OWN_HOST_PREAUTH_URL = 'https://api-relay-prod.divine.video/api/zendesk/pre-auth';
  const PUBLIC_HOST_PREAUTH_URL = 'https://api.divine.video/api/zendesk/pre-auth';

  // Tolerates ensureSchemaOnce's DDL and the pre-auth nonce INSERT as async
  // no-ops; the response proves canonical-host auth reached token issuance.
  function makeZendeskDb() {
    const statement = (): { bind: () => unknown; run: () => Promise<{ success: boolean }>; first: () => Promise<null> } => ({
      bind: () => statement(),
      run: async () => ({ success: true }),
      first: async () => null,
    });
    return { prepare: statement };
  }

  function preAuthRequest(signedUrl: string): Request {
    const sk = generateSecretKey();
    const evt = finalizeEvent(
      {
        kind: 27235,
        content: '',
        tags: [['u', signedUrl], ['method', 'POST']],
        created_at: Math.floor(Date.now() / 1000),
      },
      sk,
    );
    return new Request(OWN_HOST_PREAUTH_URL, {
      method: 'POST',
      headers: { Authorization: 'Nostr ' + btoa(JSON.stringify(evt)) },
    });
  }

  it('accepts a public-host-signed request when the host is allowlisted', async () => {
    const res = await worker.fetch(
      preAuthRequest(PUBLIC_HOST_PREAUTH_URL),
      {
        ZENDESK_PREAUTH_SECRET: 'test-secret',
        DB: makeZendeskDb(),
        NIP98_PUBLIC_HOST_ALLOWLIST: 'api.divine.video',
      } as never,
      ctx,
    );
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      success: true,
      token: expect.any(String),
    });
  });

  it('rejects a public-host-signed request when the host is not allowlisted', async () => {
    const res = await worker.fetch(
      preAuthRequest(PUBLIC_HOST_PREAUTH_URL),
      {
        ZENDESK_PREAUTH_SECRET: 'test-secret',
        DB: makeZendeskDb(),
      } as never,
      ctx,
    );

    expect(res.status).toBe(401);
  });

  it('keeps accepting an own-host-signed request without an allowlist', async () => {
    const res = await worker.fetch(
      preAuthRequest(OWN_HOST_PREAUTH_URL),
      {
        ZENDESK_PREAUTH_SECRET: 'test-secret',
        DB: makeZendeskDb(),
      } as never,
      ctx,
    );

    expect(res.status).toBe(200);
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

describe('GET /api/decisions truncation reporting (#221)', () => {
  function makeDecisionsEnv(rowCount: number) {
    const rows = Array.from({ length: rowCount }, (_, i) => ({
      id: rowCount - i,
      target_type: 'pubkey',
      target_id: 'a'.repeat(64),
      action: 'dismissed',
      // Newest first, one second apart, so the oldest returned row is predictable.
      created_at: `2026-06-${String(14 + Math.floor(i / 100)).padStart(2, '0')} 00:00:${String(i % 60).padStart(2, '0')}`,
    }));
    return {
      ALLOWED_ORIGINS: 'https://app.divine.video',
      RELAY_URL: 'wss://relay.divine.video',
      ADMIN_API_KEY: 'test-admin-key',
      DB: {
        prepare: (_sql: string) => ({
          bind: (limit: number) => ({
            all: async () => ({ results: rows.slice(0, limit) }),
          }),
          run: async () => ({}),
          all: async () => ({ results: [] }),
        }),
      },
    } as never;
  }

  async function getDecisions(env: never) {
    return worker.fetch(
      new Request('https://api.example/api/decisions', {
        headers: { 'X-Admin-Key': 'test-admin-key' },
      }),
      env,
      ctx
    );
  }

  it('reports truncated with the oldest covered row when more than 1000 decisions exist', async () => {
    const res = await getDecisions(makeDecisionsEnv(1500));
    const body = await res.json() as { decisions: unknown[]; truncated: boolean; oldest_covered: string | null };

    expect(res.status).toBe(200);
    expect(body.decisions).toHaveLength(1000);
    expect(body.truncated).toBe(true);
    // The 1001st row must not leak out, and oldest_covered describes what DID come back.
    expect(body.oldest_covered).toBe('2026-06-23 00:00:39');
  });

  it('reports not truncated when the table fits under the cap', async () => {
    const res = await getDecisions(makeDecisionsEnv(3));
    const body = await res.json() as { decisions: unknown[]; truncated: boolean; oldest_covered: string | null };

    expect(body.decisions).toHaveLength(3);
    expect(body.truncated).toBe(false);
    expect(body.oldest_covered).toBe('2026-06-14 00:00:02');
  });

  // Exactly at the cap is the case the extra fetched row exists to get right:
  // 1000 rows is a COMPLETE window, not a truncated one. The query asks for
  // DECISIONS_LIMIT + 1 precisely so this can be told apart without a second
  // COUNT, and a `>=` here would throw the "history only reaches back to..."
  // banner on every corpus that happens to land on the boundary.
  it('does not flag truncation on a table of exactly 1000 decisions', async () => {
    const res = await getDecisions(makeDecisionsEnv(1000));
    const body = await res.json() as { decisions: unknown[]; truncated: boolean };

    expect(body.decisions).toHaveLength(1000);
    expect(body.truncated).toBe(false);
  });

  it('reports a null oldest_covered on an empty table rather than truncated', async () => {
    const res = await getDecisions(makeDecisionsEnv(0));
    const body = await res.json() as { decisions: unknown[]; truncated: boolean; oldest_covered: string | null };

    expect(body.decisions).toEqual([]);
    expect(body.truncated).toBe(false);
    expect(body.oldest_covered).toBeNull();
  });
});

describe('GET /api/resolution-labels truncation reporting (#221)', () => {
  // Minimal fake relay: accepts the REQ, replays the given events, then EOSE.
  // queryRelay() wires up via addEventListener (not onmessage/onopen properties),
  // so the stub must implement that dispatch — matching the pattern already used
  // for other queryRelay-backed tests in this repo (see human-decision.test.ts,
  // ReportWatcher.test.ts, zendesk-sync.test.ts). The brief's version used
  // onmessage/onopen properties, which queryRelay never assigns, so every test
  // silently hit the outer try/catch and got `success: false` instead of events.
  function stubRelay(events: Array<{ id: string; created_at: number }>) {
    class FakeWebSocket {
      private listeners: Map<string, Array<(event: unknown) => void>> = new Map();
      constructor(_url: string) {
        setTimeout(() => this.emit('open', {}), 0);
      }
      addEventListener(type: string, listener: (event: unknown) => void) {
        if (!this.listeners.has(type)) this.listeners.set(type, []);
        this.listeners.get(type)!.push(listener);
      }
      send(raw: string) {
        const [, subId] = JSON.parse(raw) as [string, string];
        setTimeout(() => {
          for (const ev of events) {
            this.emit('message', { data: JSON.stringify(['EVENT', subId, ev]) });
          }
          this.emit('message', { data: JSON.stringify(['EOSE', subId]) });
        }, 0);
      }
      close() { /* no-op */ }
      private emit(type: string, event: unknown) {
        for (const handler of this.listeners.get(type) || []) handler(event);
      }
    }
    vi.stubGlobal('WebSocket', FakeWebSocket as never);
  }

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  async function getLabels() {
    return worker.fetch(
      new Request('https://api.example/api/resolution-labels', {
        headers: { 'X-Admin-Key': 'test-admin-key' },
      }),
      { ALLOWED_ORIGINS: 'https://app.divine.video', RELAY_URL: 'wss://relay.divine.video', ADMIN_API_KEY: 'test-admin-key' } as never,
      ctx
    );
  }

  it('flags truncation when the relay fills the 500-event limit', async () => {
    stubRelay(Array.from({ length: 500 }, (_, i) => ({ id: String(i).padStart(64, '0'), created_at: 1_760_000_000 - i })));

    const body = await (await getLabels()).json() as { events: unknown[]; truncated: boolean; oldest_covered: number | null };

    expect(body.events).toHaveLength(500);
    expect(body.truncated).toBe(true);
    expect(body.oldest_covered).toBe(1_760_000_000 - 499);
  });

  it('does not flag truncation below the limit', async () => {
    stubRelay([
      { id: 'a'.repeat(64), created_at: 1_760_000_000 },
      { id: 'b'.repeat(64), created_at: 1_759_000_000 },
    ]);

    const body = await (await getLabels()).json() as { events: unknown[]; truncated: boolean; oldest_covered: number | null };

    expect(body.truncated).toBe(false);
    expect(body.oldest_covered).toBe(1_759_000_000);
  });

  it('reports a null oldest_covered when the relay returns nothing', async () => {
    stubRelay([]);

    const body = await (await getLabels()).json() as { events: unknown[]; truncated: boolean; oldest_covered: number | null };

    expect(body.events).toEqual([]);
    expect(body.truncated).toBe(false);
    expect(body.oldest_covered).toBeNull();
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
    REPORT_WATCHER: {
      idFromName: () => 'singleton',
      get: () => ({
        fetch: async (request: Request) => {
          const operation = await request.json() as {
            eventId: string;
            relayAction: 'hide' | 'allow';
            reason?: string;
          };
          try {
            const response = await fetch('https://relay.example/management', {
              method: 'POST',
              body: JSON.stringify({
                method: operation.relayAction === 'hide' ? 'banevent' : 'allowevent',
                params: operation.relayAction === 'hide'
                  ? [operation.eventId, operation.reason]
                  : [operation.eventId],
              }),
            });
            if (!response.ok) {
              return Response.json({ success: false, error: 'relay refused' }, { status: 502 });
            }
            return Response.json({ success: true });
          } catch (error) {
            return Response.json({
              success: false,
              error: error instanceof Error ? error.message : 'relay failed',
            }, { status: 502 });
          }
        },
      }),
    },
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

  // The deep-link path, which changed materially and lost its only coverage
  // when isUnconfirmedTargetedMiss went. That guard 502'd a targeted lookup
  // that came back empty AND unconfirmed; queryRelay now fails the read itself,
  // so a targeted lookup 502s even when events DID arrive -- Reports.tsx turns
  // that into "Relay unavailable" (retry) where it used to render "found".
  // Deliberate: a truncated targeted read is not proof of what it found. It is
  // also the one behavior change here a moderator sees on a deep link, so it
  // gets pinned at the endpoint rather than only argued in the description.
  it('returns 502 for a targeted lookup that received events and then timed out', async () => {
    vi.useFakeTimers();
    const resPromise = worker.fetch(
      new Request(`https://api.example/api/reports?event=${'a'.repeat(64)}`, {
        headers: { 'X-Admin-Key': 'test-admin-key' },
      }),
      reportsEnv,
      ctx,
    );
    await vi.advanceTimersByTimeAsync(0);
    const sock = FakeRelaySocket.instances[0];
    expect(sock).toBeDefined();
    // The filter really is the targeted one, not the bulk window.
    expect(JSON.parse(sock.sent[0])[2]['#e']).toEqual([ 'a'.repeat(64) ]);
    sock.message(['EVENT', sock.subId(), EVENT_A]);
    await vi.advanceTimersByTimeAsync(5000);

    const res = await resPromise;
    expect(res.status).toBe(502);
    const body = await res.json() as { success: boolean; events?: unknown[] };
    expect(body.success).toBe(false);
    // Not handed back as a find: an unconfirmed hit must not read as "found".
    expect(body.events).toBeUndefined();
  });

  // The complement, so the 502 above is not just "targeted lookups always
  // fail": an EOSE-confirmed targeted hit is still a find.
  it('returns the event for a targeted lookup the relay confirmed', async () => {
    const resPromise = worker.fetch(
      new Request(`https://api.example/api/reports?event=${'a'.repeat(64)}`, {
        headers: { 'X-Admin-Key': 'test-admin-key' },
      }),
      reportsEnv,
      ctx,
    );
    await new Promise((r) => setTimeout(r, 0));
    const sock = FakeRelaySocket.instances[0];
    expect(sock).toBeDefined();
    sock.message(['EVENT', sock.subId(), EVENT_A]);
    sock.message(['EOSE', sock.subId()]);

    const res = await resPromise;
    expect(res.status).toBe(200);
    const body = await res.json() as { success: boolean; events: unknown[] };
    expect(body.success).toBe(true);
    expect(body.events).toHaveLength(1);
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

  // Every exit clears the timeout and marks itself resolved before closing the
  // socket, so if close() throws there is nothing left to settle the promise:
  // queryRelay hangs forever and /api/reports never answers, stalling the
  // moderator's poll until the client's 30s abort. Two of these exits sit
  // inside the message listener's parse-error catch, so the throw is swallowed
  // and there is not even a log. Resolving before closing removes the class.
  describe('settles even when the socket refuses to close', () => {
    const breakClose = (sock: FakeRelaySocket) => {
      sock.close = () => { throw new Error('close failed'); };
    };

    it('on EOSE', async () => {
      const resPromise = worker.fetch(reportsRequest(), reportsEnv, ctx);
      await new Promise((r) => setTimeout(r, 0));
      const sock = FakeRelaySocket.instances[0];
      breakClose(sock);
      sock.message(['EVENT', sock.subId(), EVENT_A]);
      sock.message(['EOSE', sock.subId()]);
      expect((await resPromise).status).toBe(200);
    });

    it('on CLOSED', async () => {
      const resPromise = worker.fetch(reportsRequest(), reportsEnv, ctx);
      await new Promise((r) => setTimeout(r, 0));
      const sock = FakeRelaySocket.instances[0];
      breakClose(sock);
      sock.message(['CLOSED', sock.subId(), 'error: could not complete query']);
      expect((await resPromise).status).toBe(502);
    });

    it('on timeout', async () => {
      vi.useFakeTimers();
      const resPromise = worker.fetch(reportsRequest(), reportsEnv, ctx);
      await vi.advanceTimersByTimeAsync(0);
      const sock = FakeRelaySocket.instances[0];
      breakClose(sock);
      await vi.advanceTimersByTimeAsync(5000);
      expect((await resPromise).status).toBe(502);
    });
  });

  // The subscription id is what makes CLOSED ours. A relay multiplexes frames
  // for every open subscription down one socket, so an unmatched CLOSED must
  // not end a query that is still legitimately running.
  it('ignores a CLOSED naming a different subscription', async () => {
    vi.useFakeTimers();
    const resPromise = worker.fetch(reportsRequest(), reportsEnv, ctx);
    await vi.advanceTimersByTimeAsync(0);
    const sock = FakeRelaySocket.instances[0];
    expect(sock).toBeDefined();
    sock.message(['CLOSED', 'some-other-subscription', 'error: could not complete query']);
    // Still running: only the 5s timeout ends it, and it ends as a timeout.
    await vi.advanceTimersByTimeAsync(5000);
    const res = await resPromise;
    const body = await res.json() as { error?: string };
    expect(body.error).toMatch(/timed out/i);
    expect(body.error).not.toMatch(/closed the subscription/i);
  });

  // NIP-01 makes the CLOSED message a required field, but a relay that sends an
  // empty one must still produce a readable error rather than "undefined".
  it('reports a CLOSED with no reason as an unexplained close', async () => {
    const resPromise = worker.fetch(reportsRequest(), reportsEnv, ctx);
    await new Promise((r) => setTimeout(r, 0));
    const sock = FakeRelaySocket.instances[0];
    expect(sock).toBeDefined();
    sock.message(['CLOSED', sock.subId()]);
    const res = await resPromise;
    expect(res.status).toBe(502);
    const body = await res.json() as { error?: string };
    expect(body.error).toMatch(/no reason given/i);
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

  function reopenDb() {
    return {
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
  }

  // Each label filter opens its own socket, and the second only exists after the
  // first query resolves. Polling for it keeps the feed from racing ahead.
  async function feedLabelToEachFilter() {
    for (let i = 0; i < 2; i++) {
      for (let t = 0; t < 100 && !FakeRelaySocket.instances[i]; t++) {
        await new Promise((r) => setTimeout(r, 0));
      }
      const sock = FakeRelaySocket.instances[i];
      expect(sock).toBeDefined();
      sock.message(['EVENT', sock.subId(), LABEL_A]);
      sock.message(['EOSE', sock.subId()]);
    }
  }

  const reopenRequest = () => new Request(`https://api.example/api/decisions/${'a'.repeat(64)}`, {
    method: 'DELETE',
    headers: { 'X-Admin-Key': 'test-admin-key' },
  });

  // The positive control for the flag. Every other case below asserts it goes
  // TRUE; without this one, flagging any reopen that touched a label at all
  // still passes -- and that mutation puts a destructive "may stay hidden"
  // toast on the ordinary successful reopen, which is the failure mode this
  // flag exists to avoid in the other direction.
  it('reports a clean reopen when the labels it found were removed', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response(JSON.stringify({ result: true }), { status: 200 })
    ));

    const resPromise = worker.fetch(
      reopenRequest(),
      { ...(reportsEnv as object), DB: reopenDb(), NOSTR_NSEC: TEST_NSEC } as never,
      ctx,
    );
    await feedLabelToEachFilter();

    const res = await resPromise;
    const body = await res.json() as { labelsDeleted: number; labelCleanupFailed: boolean };
    // A label was genuinely removed -- this is not the vacuous empty-read case.
    expect(body.labelsDeleted).toBeGreaterThan(0);
    expect(body.labelCleanupFailed).toBe(false);
  });

  // The label read can succeed while the delete fails. A relay admin key
  // mismatch 403s every management command but leaves reads working, and that
  // refusal does NOT throw: the RPC comes back success:false. The label
  // survives and keeps the report hidden, so this reopen is no cleaner than a
  // failed read and must not report one.
  it('flags labelCleanupFailed when the label is found but banevent is refused', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    // Signing succeeds; the relay refuses the management command.
    vi.stubGlobal('fetch', vi.fn(async () => new Response('forbidden', { status: 403 })));

    const resPromise = worker.fetch(
      reopenRequest(),
      { ...(reportsEnv as object), DB: reopenDb(), NOSTR_NSEC: TEST_NSEC } as never,
      ctx,
    );
    await feedLabelToEachFilter();

    const res = await resPromise;
    const body = await res.json() as { labelsDeleted: number; labelCleanupFailed: boolean };
    expect(body.labelsDeleted).toBe(0); // nothing was actually removed
    expect(body.labelCleanupFailed).toBe(true);
  });

  // Events arrive off the wire unvalidated, so a label with no id reaches the
  // cleanup loop. It cannot be banned, so it survives exactly like a refused
  // delete and must not report a clean reopen either.
  it('flags labelCleanupFailed when a resolution label has no id to ban', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { id: _dropped, ...LABEL_WITHOUT_ID } = LABEL_A;

    const resPromise = worker.fetch(
      reopenRequest(),
      { ...(reportsEnv as object), DB: reopenDb(), NOSTR_NSEC: TEST_NSEC } as never,
      ctx,
    );
    for (let i = 0; i < 2; i++) {
      for (let t = 0; t < 100 && !FakeRelaySocket.instances[i]; t++) {
        await new Promise((r) => setTimeout(r, 0));
      }
      const sock = FakeRelaySocket.instances[i];
      expect(sock).toBeDefined();
      sock.message(['EVENT', sock.subId(), LABEL_WITHOUT_ID]);
      sock.message(['EOSE', sock.subId()]);
    }

    const res = await resPromise;
    const body = await res.json() as { labelsDeleted: number; labelCleanupFailed: boolean };
    expect(body.labelsDeleted).toBe(0);
    expect(body.labelCleanupFailed).toBe(true);
  });

  // The other way the delete can fail: signing itself throws, so the RPC never
  // gets made. Reaches the flag through the catch rather than the refusal
  // branch, which is why both cases are pinned separately.
  it('flags labelCleanupFailed when the banevent call throws', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const resPromise = worker.fetch(
      reopenRequest(),
      // No NOSTR_NSEC, so the banevent cannot be signed at all.
      { ...(reportsEnv as object), DB: reopenDb() } as never,
      ctx,
    );
    await feedLabelToEachFilter();

    const res = await resPromise;
    const body = await res.json() as { labelsDeleted: number; labelCleanupFailed: boolean };
    expect(body.labelsDeleted).toBe(0);
    expect(body.labelCleanupFailed).toBe(true);
  });

  // An incomplete read is not an empty one. Before this PR a timeout resolved
  // success:true with whatever had arrived, so the cleanup banned those labels;
  // treating the read as a failure must not also throw them away, because the
  // D1 delete below runs either way. A label received and left alive keeps the
  // report hidden, so discarding it makes reopen strictly worse than not
  // changing queryRelay at all.
  it('bans the resolution labels it received even when the read did not complete', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response(JSON.stringify({ result: true }), { status: 200 })
    ));

    const resPromise = worker.fetch(
      reopenRequest(),
      { ...(reportsEnv as object), DB: reopenDb(), NOSTR_NSEC: TEST_NSEC } as never,
      ctx,
    );

    // First filter delivers a label, then the socket drops before EOSE.
    // Second filter closes empty. Neither read completed.
    for (let i = 0; i < 2; i++) {
      for (let t = 0; t < 100 && !FakeRelaySocket.instances[i]; t++) {
        await new Promise((r) => setTimeout(r, 0));
      }
      const sock = FakeRelaySocket.instances[i];
      expect(sock).toBeDefined();
      if (i === 0) sock.message(['EVENT', sock.subId(), LABEL_A]);
      sock.emit('close', {});
    }

    const res = await resPromise;
    const body = await res.json() as { labelsDeleted: number; labelCleanupFailed: boolean };
    expect(body.labelsDeleted).toBe(1); // the label that arrived was still removed
    expect(body.labelCleanupFailed).toBe(true); // and the read is still reported incomplete
  });

  // publishLabel writes exactly one target tag -- 'e' for an event, 'p' for a
  // pubkey, never both -- so of the two filters the worker runs, one can never
  // match. That was harmless when a stalled read was an empty success; now that
  // it is a failure, a stall on the dead filter reports a failed cleanup and
  // tells the moderator to retry something that cannot help. Naming the target
  // type removes the query that was never going to match.
  it('queries only the filter that can match when the target type is known', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response(JSON.stringify({ result: true }), { status: 200 })
    ));

    const resPromise = worker.fetch(
      new Request(`https://api.example/api/decisions/${'a'.repeat(64)}?targetType=event`, {
        method: 'DELETE',
        headers: { 'X-Admin-Key': 'test-admin-key' },
      }),
      { ...(reportsEnv as object), DB: reopenDb(), NOSTR_NSEC: TEST_NSEC } as never,
      ctx,
    );
    for (let t = 0; t < 100 && !FakeRelaySocket.instances[0]; t++) {
      await new Promise((r) => setTimeout(r, 0));
    }
    const sock = FakeRelaySocket.instances[0];
    expect(sock).toBeDefined();
    sock.message(['EOSE', sock.subId()]);

    const res = await resPromise;
    const body = await res.json() as { labelCleanupFailed: boolean };
    expect(body.labelCleanupFailed).toBe(false);
    // One socket, and it asked about the e-tag.
    expect(FakeRelaySocket.instances).toHaveLength(1);
    expect(JSON.parse(sock.sent[0])[2]['#e']).toEqual([ 'a'.repeat(64) ]);
  });

  it('queries the pubkey filter alone for a pubkey target', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response(JSON.stringify({ result: true }), { status: 200 })
    ));

    const resPromise = worker.fetch(
      new Request(`https://api.example/api/decisions/${'a'.repeat(64)}?targetType=pubkey`, {
        method: 'DELETE',
        headers: { 'X-Admin-Key': 'test-admin-key' },
      }),
      { ...(reportsEnv as object), DB: reopenDb(), NOSTR_NSEC: TEST_NSEC } as never,
      ctx,
    );
    for (let t = 0; t < 100 && !FakeRelaySocket.instances[0]; t++) {
      await new Promise((r) => setTimeout(r, 0));
    }
    const sock = FakeRelaySocket.instances[0];
    expect(sock).toBeDefined();
    sock.message(['EOSE', sock.subId()]);

    await resPromise;
    expect(FakeRelaySocket.instances).toHaveLength(1);
    expect(JSON.parse(sock.sent[0])[2]['#p']).toEqual([ 'a'.repeat(64) ]);
  });

  // The whitelist at the route is load-bearing, not defensive tidiness. An
  // unrecognised value must fall back to both filters, because the alternative
  // -- trusting the raw string -- indexes the tag map with a miss and builds a
  // filter keyed "undefined". That is an UNTARGETED query: the relay ignores
  // the unknown key and returns resolution labels for arbitrary targets, which
  // the cleanup loop then bans. One reopen would wipe resolution labels
  // queue-wide and still report success.
  it('falls back to both filters when the target type is not a recognised value', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response(JSON.stringify({ result: true }), { status: 200 })
    ));

    const resPromise = worker.fetch(
      new Request(`https://api.example/api/decisions/${'a'.repeat(64)}?targetType=EVENT`, {
        method: 'DELETE',
        headers: { 'X-Admin-Key': 'test-admin-key' },
      }),
      { ...(reportsEnv as object), DB: reopenDb(), NOSTR_NSEC: TEST_NSEC } as never,
      ctx,
    );
    for (let i = 0; i < 2; i++) {
      for (let t = 0; t < 100 && !FakeRelaySocket.instances[i]; t++) {
        await new Promise((r) => setTimeout(r, 0));
      }
      const sock = FakeRelaySocket.instances[i];
      expect(sock).toBeDefined();
      sock.message(['EOSE', sock.subId()]);
    }

    await resPromise;
    expect(FakeRelaySocket.instances).toHaveLength(2);
    const filters = FakeRelaySocket.instances.map((s) => JSON.parse(s.sent[0])[2]);
    // Every filter is anchored to the target. None may be an open query.
    expect(filters[0]['#e']).toEqual([ 'a'.repeat(64) ]);
    expect(filters[1]['#p']).toEqual([ 'a'.repeat(64) ]);
    for (const f of filters) expect(Object.keys(f)).not.toContain('undefined');
    // Degrading safely is right, but silently would make a client-side typo
    // invisible in production.
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('unrecognised targetType'), 'EVENT');
  });

  // Worker and Pages deploy separately, so a new worker serves an old frontend
  // that sends no targetType. It must keep checking both tags rather than
  // guessing one and silently skipping the labels that matter.
  it('still queries both filters when the target type is not given', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response(JSON.stringify({ result: true }), { status: 200 })
    ));

    const resPromise = worker.fetch(
      reopenRequest(),
      { ...(reportsEnv as object), DB: reopenDb(), NOSTR_NSEC: TEST_NSEC } as never,
      ctx,
    );
    for (let i = 0; i < 2; i++) {
      for (let t = 0; t < 100 && !FakeRelaySocket.instances[i]; t++) {
        await new Promise((r) => setTimeout(r, 0));
      }
      const sock = FakeRelaySocket.instances[i];
      expect(sock).toBeDefined();
      sock.message(['EOSE', sock.subId()]);
    }

    await resPromise;
    expect(FakeRelaySocket.instances).toHaveLength(2);
  });

  // Each failure path carries its events independently, so each is pinned
  // independently. The timeout is the one this branch is named for.
  it('bans a label received before the read timed out', async () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response(JSON.stringify({ result: true }), { status: 200 })
    ));

    const resPromise = worker.fetch(
      reopenRequest(),
      { ...(reportsEnv as object), DB: reopenDb(), NOSTR_NSEC: TEST_NSEC } as never,
      ctx,
    );
    for (let i = 0; i < 2; i++) {
      for (let t = 0; t < 100 && !FakeRelaySocket.instances[i]; t++) {
        await vi.advanceTimersByTimeAsync(0);
      }
      const sock = FakeRelaySocket.instances[i];
      expect(sock).toBeDefined();
      if (i === 0) sock.message(['EVENT', sock.subId(), LABEL_A]);
      await vi.advanceTimersByTimeAsync(5000);
    }

    const res = await resPromise;
    const body = await res.json() as { labelsDeleted: number; labelCleanupFailed: boolean };
    expect(body.labelsDeleted).toBe(1);
    expect(body.labelCleanupFailed).toBe(true);
  });

  it('bans a label received before the relay CLOSED the subscription', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response(JSON.stringify({ result: true }), { status: 200 })
    ));

    const resPromise = worker.fetch(
      reopenRequest(),
      { ...(reportsEnv as object), DB: reopenDb(), NOSTR_NSEC: TEST_NSEC } as never,
      ctx,
    );
    for (let i = 0; i < 2; i++) {
      for (let t = 0; t < 100 && !FakeRelaySocket.instances[i]; t++) {
        await new Promise((r) => setTimeout(r, 0));
      }
      const sock = FakeRelaySocket.instances[i];
      expect(sock).toBeDefined();
      if (i === 0) sock.message(['EVENT', sock.subId(), LABEL_A]);
      sock.message(['CLOSED', sock.subId(), 'error: could not complete query']);
    }

    const res = await resPromise;
    const body = await res.json() as { labelsDeleted: number; labelCleanupFailed: boolean };
    expect(body.labelsDeleted).toBe(1);
    expect(body.labelCleanupFailed).toBe(true);
  });

  it('bans a label received before the socket errored', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response(JSON.stringify({ result: true }), { status: 200 })
    ));

    const resPromise = worker.fetch(
      reopenRequest(),
      { ...(reportsEnv as object), DB: reopenDb(), NOSTR_NSEC: TEST_NSEC } as never,
      ctx,
    );
    for (let i = 0; i < 2; i++) {
      for (let t = 0; t < 100 && !FakeRelaySocket.instances[i]; t++) {
        await new Promise((r) => setTimeout(r, 0));
      }
      const sock = FakeRelaySocket.instances[i];
      expect(sock).toBeDefined();
      if (i === 0) sock.message(['EVENT', sock.subId(), LABEL_A]);
      sock.emit('error', {});
    }

    const res = await resPromise;
    const body = await res.json() as { labelsDeleted: number; labelCleanupFailed: boolean };
    expect(body.labelsDeleted).toBe(1);
    expect(body.labelCleanupFailed).toBe(true);
  });

  // The same window exists on the success path, and it is the common one: the
  // worker sends REQ and never CLOSE, so between EOSE and the socket actually
  // closing the relay can stream a newly published matching label. Counting it
  // would ban a label the read never reported.
  it('does not ban a label that arrived after EOSE', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response(JSON.stringify({ result: true }), { status: 200 })
    ));
    const LATE_LABEL = { ...LABEL_A, id: 'd'.repeat(64) };

    const resPromise = worker.fetch(
      reopenRequest(),
      { ...(reportsEnv as object), DB: reopenDb(), NOSTR_NSEC: TEST_NSEC } as never,
      ctx,
    );
    for (let i = 0; i < 2; i++) {
      for (let t = 0; t < 100 && !FakeRelaySocket.instances[i]; t++) {
        await new Promise((r) => setTimeout(r, 0));
      }
      const sock = FakeRelaySocket.instances[i];
      expect(sock).toBeDefined();
      if (i === 0) {
        sock.message(['EVENT', sock.subId(), LABEL_A]);
        sock.message(['EOSE', sock.subId()]);
        sock.message(['EVENT', sock.subId(), LATE_LABEL]); // too late to count
      } else {
        sock.message(['EOSE', sock.subId()]);
      }
    }

    const res = await resPromise;
    const body = await res.json() as { labelsDeleted: number };
    expect(body.labelsDeleted).toBe(1);
  });

  // A frame can still arrive after a failure path has handed its events to the
  // caller: the socket is closing, not closed. Two independent things stop that
  // late label joining a set the caller is already iterating and banning, and on
  // this path either alone suffices -- the message listener's resolved-guard
  // blocks the push, and all four socket failure exits (timeout, CLOSED, error,
  // close) resolve with `events.slice()`, a snapshot the late frame cannot
  // reach. The outer catch carries no events at all; it fires before the array
  // is in scope.
  //
  // So this test dies only to the conjunction: drop the guard and it passes,
  // drop the slice and it passes, drop both and it fails. The after-EOSE case
  // ABOVE is the guard's sole-custody pin, because the success exit hands back
  // the live `events` array and the snapshot is not there to cover it. Neither
  // mechanism is redundant: removing the copies would leave the guard as the
  // only thing standing between a late frame and the caller's set.
  it('does not ban a label that arrived after the read had already failed', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response(JSON.stringify({ result: true }), { status: 200 })
    ));
    const LATE_LABEL = { ...LABEL_A, id: 'd'.repeat(64) };

    const resPromise = worker.fetch(
      reopenRequest(),
      { ...(reportsEnv as object), DB: reopenDb(), NOSTR_NSEC: TEST_NSEC } as never,
      ctx,
    );
    for (let i = 0; i < 2; i++) {
      for (let t = 0; t < 100 && !FakeRelaySocket.instances[i]; t++) {
        await new Promise((r) => setTimeout(r, 0));
      }
      const sock = FakeRelaySocket.instances[i];
      expect(sock).toBeDefined();
      if (i === 0) {
        sock.message(['EVENT', sock.subId(), LABEL_A]);
        sock.emit('close', {});           // read fails, caller gets its events
        sock.message(['EVENT', sock.subId(), LATE_LABEL]); // too late to count
      } else {
        sock.emit('close', {});
      }
    }

    const res = await resPromise;
    const body = await res.json() as { labelsDeleted: number };
    expect(body.labelsDeleted).toBe(1);
  });

  // A completed read that fills the page is indistinguishable from a truncated
  // one, so it must report an incomplete cleanup even though EOSE arrived. The
  // 50 is written out rather than imported: the page size doubles as the
  // worst-case number of sequential signed round-trips in one reopen, so it is
  // bounded by the client's 30s timeout and the Workers subrequest budget --
  // that bound is part of what the test pins.
  it('reports incomplete cleanup when the label read fills the page', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response(JSON.stringify({ result: true }), { status: 200 })
    ));
    const fullPage = Array.from({ length: 50 }, (_, i) => ({
      ...LABEL_A,
      id: i.toString(16).padStart(64, '0'),
    }));

    const resPromise = worker.fetch(
      reopenRequest(),
      { ...(reportsEnv as object), DB: reopenDb(), NOSTR_NSEC: TEST_NSEC } as never,
      ctx,
    );
    for (let i = 0; i < 2; i++) {
      // A full page means LABEL_CLEANUP_LIMIT sequential banevent round-trips
      // before the second filter opens its socket, so this wait needs a far
      // bigger budget than the single-label cases above.
      for (let t = 0; t < 5000 && !FakeRelaySocket.instances[i]; t++) {
        await new Promise((r) => setTimeout(r, 0));
      }
      const sock = FakeRelaySocket.instances[i];
      expect(sock).toBeDefined();
      if (i === 0) for (const label of fullPage) sock.message(['EVENT', sock.subId(), label]);
      sock.message(['EOSE', sock.subId()]);
    }

    // The cap is what makes truncation implausible rather than merely
    // detectable, so the requested page size is pinned too: detection only
    // fires on our own limit, never on a lower one the relay imposes.
    expect(JSON.parse(FakeRelaySocket.instances[0].sent[0])[2].limit).toBe(50);

    const res = await resPromise;
    const body = await res.json() as { labelsDeleted: number; labelCleanupFailed: boolean };
    expect(body.labelsDeleted).toBe(50); // every label on the page was removed
    expect(body.labelCleanupFailed).toBe(true); // but there may be more beyond it
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
