// ABOUTME: Pins the report-watcher proxy: queue cursors pass through, the sexual-quarantine actor is the verified moderator,
// ABOUTME: and the moderator login token never reaches the ReportWatcher Durable Object.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import worker from './index';
import { __clearModeratorLoginCache } from './moderator-identity';

it('forwards review queue cursors through the authenticated Worker entry point', async () => {
  const first = 'a'.repeat(64);
  const second = 'b'.repeat(64);
  const cursor = `sexual-review-v3:0:0000000000001000:${first}`;
  const env = {
    ADMIN_API_KEY: 'synthetic-admin-key', ALLOWED_ORIGINS: 'https://app.example.test',
    REPORT_WATCHER: { idFromName: () => 'singleton', get: () => ({ fetch: async (request: Request) => {
      const continued = new URL(request.url).searchParams.get('cursor') === cursor;
      return Response.json({ cases: [{ eventId: continued ? second : first }], ...(!continued && { nextCursor: cursor }) });
    } }) },
  } as never;
  const read = (search = '') => worker.fetch(new Request(`https://api.example.test/api/report-watcher/sexual-quarantine${search}`, {
    headers: { 'X-Admin-Key': 'synthetic-admin-key' },
  }), env, {} as ExecutionContext);
  const page = await read();
  expect(await page.json()).toEqual({ cases: [{ eventId: first }], nextCursor: cursor });
  const next = await read(`?cursor=${encodeURIComponent(cursor)}`);
  expect(await next.json()).toEqual({ cases: [{ eventId: second }] });
  expect(next.headers.get('Cache-Control')).toBe('private, no-store');
});

const PUBKEY = 'b'.repeat(64);
const TOKEN = 'secret-login-token-value';
const EVENT_ID = 'e'.repeat(64);
const ctx = { waitUntil: () => {} } as unknown as ExecutionContext;

interface Captured {
  url: string;
  method: string;
  headers: Headers;
  body: string;
}

function makeEnv(captured: Captured[], withLogin = true) {
  return {
    ALLOWED_ORIGINS: 'https://app.divine.video',
    ADMIN_API_KEY: 'test-admin-key',
    ...(withLogin ? { MODERATOR_LOGIN_URL: 'https://login.example.test' } : {}),
    REPORT_WATCHER: {
      idFromName: () => 'id',
      get: () => ({
        fetch: async (req: Request) => {
          captured.push({
            url: req.url,
            method: req.method,
            headers: new Headers(req.headers),
            body: await req.text(),
          });
          return new Response(JSON.stringify({ success: true }), { status: 200 });
        },
      }),
    },
  } as never;
}

function call(
  env: never,
  path: string,
  method: string,
  headers: Record<string, string>,
  body?: string
) {
  return worker.fetch(
    new Request(`https://worker.test${path}`, {
      method,
      headers: { 'X-Admin-Key': 'test-admin-key', ...headers },
      body,
    }),
    env,
    ctx
  );
}

const decisionPath = `/api/report-watcher/sexual-quarantine/${EVENT_ID}`;

describe('report-watcher proxy', () => {
  let captured: Captured[];
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    __clearModeratorLoginCache();
    captured = [];
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        if (String(input).endsWith('/api/nostr')) {
          return new Response(JSON.stringify({ result: PUBKEY }), { status: 200 });
        }
        return new Response('{}', { status: 200 });
      })
    );
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  const decide = (headers: Record<string, string>, body: string, withLogin = true) =>
    call(
      makeEnv(captured, withLogin),
      decisionPath,
      'POST',
      { 'Content-Type': 'application/json', ...headers },
      body
    );

  it('forwards the verified moderator as actor', async () => {
    await decide(
      { 'X-Divine-Login-Token': TOKEN },
      JSON.stringify({ decision: 'confirm', reason: 'r' })
    );
    expect(captured).toHaveLength(1);
    const forwarded = JSON.parse(captured[0].body);
    expect(forwarded.actor).toBe(PUBKEY);
    expect(forwarded.decision).toBe('confirm');
    expect(captured[0].headers.get('Content-Type')).toBe('application/json');
  });

  it("forwards 'unattributed' without a verified login", async () => {
    await decide({}, JSON.stringify({ decision: 'confirm' }), false);
    expect(JSON.parse(captured[0].body).actor).toBe('unattributed');
  });

  it('replaces a body actor', async () => {
    await decide({}, JSON.stringify({ decision: 'confirm', actor: 'someone-else' }), false);
    expect(JSON.parse(captured[0].body).actor).toBe('unattributed');
    await decide(
      { 'X-Divine-Login-Token': TOKEN },
      JSON.stringify({ decision: 'confirm', actor: 'someone-else' })
    );
    expect(JSON.parse(captured[1].body).actor).toBe(PUBKEY);
    // A body actor that differs from the verified moderator is logged, never
    // the token. Only the verified login's mismatch is noted.
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(String(warnSpy.mock.calls[0][0])).toContain('/api/report-watcher/sexual-quarantine');
    expect(JSON.stringify(warnSpy.mock.calls)).not.toContain(TOKEN);
  });

  it('strips the login token from a decision POST, in any header case', async () => {
    await decide({ 'X-Divine-Login-Token': TOKEN }, JSON.stringify({ decision: 'confirm' }));
    await decide({ 'x-divine-login-token': TOKEN }, JSON.stringify({ decision: 'confirm' }));
    for (const c of captured) {
      expect(c.headers.has('X-Divine-Login-Token')).toBe(false);
      expect(JSON.stringify([...c.headers])).not.toContain(TOKEN);
      expect(c.body).not.toContain(TOKEN);
    }
  });

  it('strips the login token from GET /config and POST /start', async () => {
    const env = makeEnv(captured);
    await call(env, '/api/report-watcher/config', 'GET', { 'X-Divine-Login-Token': TOKEN });
    await call(env, '/api/report-watcher/start', 'POST', { 'x-divine-login-token': TOKEN }, '{}');
    expect(captured).toHaveLength(2);
    for (const c of captured) {
      expect(c.headers.has('X-Divine-Login-Token')).toBe(false);
      expect(JSON.stringify([...c.headers])).not.toContain(TOKEN);
    }
    expect(captured[1].body).toBe('{}');
  });

  it.each([
    ['invalid JSON', '{not json', 'Invalid JSON'],
    ['an empty body', '', 'Invalid JSON'],
    ['a JSON array', '[1,2]', 'Revision, decision, reviewer and reason are required'],
    ['a JSON string', '"x"', 'Revision, decision, reviewer and reason are required'],
    ['JSON null', 'null', 'Revision, decision, reviewer and reason are required'],
  ])('refuses an unparseable decision body without calling the DO (%s)', async (_name, body, error) => {
    const res = await decide({ 'X-Divine-Login-Token': TOKEN }, body);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error });
    expect(res.headers.get('Cache-Control')).toBe('private, no-store');
    expect(captured).toHaveLength(0);
  });

  it.each([`${decisionPath}/`, `${decisionPath}//x`, `${decisionPath}/.`, `${decisionPath}/%2e`, `${decisionPath}/./`])(
    'rewrites the actor on a loosely shaped decision path %s',
    async (path) => {
      await call(
        makeEnv(captured),
        path,
        'POST',
        { 'Content-Type': 'application/json', 'X-Divine-Login-Token': TOKEN },
        JSON.stringify({ decision: 'confirm', actor: 'forged' })
      );
      expect(captured).toHaveLength(1);
      expect(JSON.parse(captured[0].body).actor).toBe(PUBKEY);
    }
  );

  it('sets a JSON Content-Type and drops the stale Content-Length on a rewritten decision', async () => {
    const original = JSON.stringify({ decision: 'confirm', actor: 'forged-actor-longer-than-the-pubkey-is-not' });
    await decide(
      { 'X-Divine-Login-Token': TOKEN, 'Content-Type': 'text/plain', 'Content-Length': String(original.length) },
      original
    );
    expect(captured[0].headers.get('Content-Type')).toBe('application/json');
    const len = captured[0].headers.get('Content-Length');
    expect(len === null || len === String(new TextEncoder().encode(captured[0].body).length)).toBe(true);
    expect(len).not.toBe(String(original.length));
  });

  it('refuses /event-visibility at the proxy without reaching the Durable Object', async () => {
    for (const path of ['/api/report-watcher/event-visibility', '/api/report-watcher/event-visibility/x']) {
      const res = await call(
        makeEnv(captured),
        path,
        'POST',
        { 'Content-Type': 'application/json' },
        JSON.stringify({ moderatorPubkey: 'forged' })
      );
      expect(res.status).toBe(404);
    }
    expect(captured).toHaveLength(0);
  });
});
