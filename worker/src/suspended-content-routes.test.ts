// ABOUTME: Route tests for the audited suspended-content viewer, driven through worker.fetch.
// ABOUTME: Pins the order of checks, fail-closed auditing, and that nothing is served without a verified login.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import worker from './index';
import { __clearModeratorLoginCache } from './moderator-identity';

const TEST_NSEC = 'nsec1vl029mgpspedva04g90vltkh6fvh240zqtv9k0t9af8935ke9laqsnlfe5';
const MODERATOR = 'a'.repeat(64);
const AUTHOR = 'b'.repeat(64);
const EVENT_ID = 'c'.repeat(64);
const TOKEN = 'login-token-value-never-logged';
const SECRET_CONTENT = 'words hidden by the suspension';
const ctx = { waitUntil: () => {} } as unknown as ExecutionContext;

function event(overrides: Record<string, unknown> = {}) {
  return { id: EVENT_ID, pubkey: AUTHOR, created_at: 1_700_000_000, kind: 1, tags: [['t', 'tag-only-in-event']], content: SECRET_CONTENT, sig: 'f'.repeat(128), ...overrides };
}
const PROFILE = event({ id: 'd'.repeat(64), kind: 0, content: '{"name":"suspended"}' });
const SECOND = event({ id: 'e'.repeat(64), created_at: 1_699_999_000 });

// ---------------------------------------------------------------------------
// A D1 stand-in that records every statement. The audit insert can be told to
// throw or to change no rows.
// ---------------------------------------------------------------------------
interface Recorded { sql: string; args: unknown[] }
function makeDb(opts: { insert?: 'ok' | 'throw' | 'no-change'; ddl?: 'ok' | 'throw' } = {}) {
  const statements: Recorded[] = [];
  const inserts: unknown[][] = [];
  const db = {
    prepare(sql: string) {
      const rec: Recorded = { sql, args: [] };
      statements.push(rec);
      const stmt = {
        bind(...args: unknown[]) { rec.args = args; return stmt; },
        async run() {
          if (/^\s*CREATE/i.test(sql)) {
            if (opts.ddl === 'throw') throw new Error('D1 unavailable');
            return { success: true, meta: { changes: 0 } };
          }
          if (/INSERT INTO suspended_content_views/.test(sql)) {
            if (opts.insert === 'throw') throw new Error('D1 write failed');
            if (opts.insert === 'no-change') return { success: true, meta: { changes: 0 } };
            inserts.push(rec.args);
            return { success: true, meta: { changes: 1 } };
          }
          return { success: true, meta: { changes: 1 } };
        },
        async first() { return null; },
        async all() { return { results: [] }; },
      };
      return stmt;
    },
    async batch() { return []; },
    async exec() { return { count: 0 }; },
  };
  return { db, statements, inserts };
}

function makeEnv(db?: unknown) {
  return {
    ALLOWED_ORIGINS: 'https://app.example.test',
    ADMIN_API_KEY: 'test-admin-key',
    MODERATOR_LOGIN_URL: 'https://login.example.test',
    RELAY_URL: 'wss://relay.example.test',
    NOSTR_NSEC: TEST_NSEC,
    CDN_DOMAIN: 'media.example.test',
    BLOSSOM_WEBHOOK_SECRET: 'blossom-secret',
    ...(db ? { DB: db } : {}),
  } as never;
}

// ---------------------------------------------------------------------------
// Upstreams: Keycast's login check, the relay's management endpoint, and the
// media server's account list. Each relay method answers from `relayAnswers`.
// ---------------------------------------------------------------------------
type RelayAnswer = { result?: unknown; error?: string } | (() => Response | Promise<Response>);
let relayAnswers: Record<string, RelayAnswer>;
let relayCalls: Array<{ method: string; params: unknown[] }>;
let loginStatus: number;
let loginPubkey: string;
let loginCalls: number;
let mediaAnswer: () => Response | Promise<Response>;
let mediaCalls: number;

function installFetch() {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === 'https://login.example.test/api/nostr') {
      loginCalls++;
      return loginStatus === 200
        ? new Response(JSON.stringify({ result: loginPubkey }), { status: 200 })
        : new Response('no', { status: loginStatus });
    }
    if (url === 'https://relay.example.test/management') {
      const body = JSON.parse(String(init?.body)) as { method: string; params: unknown[] };
      relayCalls.push(body);
      const answer = relayAnswers[body.method];
      if (!answer) return new Response(JSON.stringify({ error: `Unknown method: ${body.method}` }), { status: 200 });
      if (typeof answer === 'function') return answer();
      return new Response(JSON.stringify(answer), { status: 200 });
    }
    if (url.startsWith('https://media.example.test/admin/api/user/')) {
      mediaCalls++;
      return mediaAnswer();
    }
    throw new Error(`unexpected fetch ${url}`);
  }));
}

function post(path: string, body: unknown, headers: Record<string, string> = {}): Request {
  return new Request(`https://api.example.test${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Admin-Key': 'test-admin-key',
      'X-Divine-Login-Token': TOKEN,
      Origin: 'https://app.example.test',
      ...headers,
    },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

const viewEvent = (body: unknown = { eventId: EVENT_ID, surface: 'report' }, headers?: Record<string, string>) =>
  post('/api/suspended-content/event', body, headers);
const viewAccount = (body: unknown = { pubkey: AUTHOR, surface: 'user' }, headers?: Record<string, string>) =>
  post('/api/suspended-content/account', body, headers);

beforeEach(() => {
  __clearModeratorLoginCache();
  relayAnswers = {
    getsuspendedevent: { result: event() },
    listsuspendedpubkeys: { result: [{ pubkey: AUTHOR }] },
    listsuspendedpubkeyevents: { result: { events: [event(), SECOND], next_until: 1_699_999_000, next_until_id: SECOND.id } },
  };
  relayCalls = [];
  loginStatus = 200;
  loginPubkey = MODERATOR;
  loginCalls = 0;
  mediaCalls = 0;
  mediaAnswer = () => new Response(JSON.stringify([
    { sha256: '1'.repeat(64), type: 'video/mp4', owner: AUTHOR, status: 'restricted' },
    { sha256: '2'.repeat(64), type: 'image/jpeg', owner: AUTHOR, status: 'active' },
  ]), { status: 200 });
  installFetch();
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function relayMethods(): string[] {
  return relayCalls.map(c => c.method);
}

// A suspended-content answer that is not a success must carry none of the
// event's id, content or tags.
async function expectNoContent(res: Response): Promise<Record<string, unknown>> {
  const text = await res.text();
  expect(text).not.toContain(SECRET_CONTENT);
  expect(text).not.toContain(EVENT_ID);
  expect(text).not.toContain('tag-only-in-event');
  return JSON.parse(text);
}

// ===========================================================================
// POST /api/suspended-content/event
// ===========================================================================
describe('POST /api/suspended-content/event', () => {
  it('serves the event and records one row naming the verified moderator and the event author', async () => {
    const { db, inserts } = makeDb();
    const res = await worker.fetch(viewEvent(), makeEnv(db), ctx);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true, event: event() });
    expect(relayCalls).toEqual([{ method: 'getsuspendedevent', params: [EVENT_ID] }]);
    // moderator, target, scope, event_id, page_until, surface, events_served
    expect(inserts).toEqual([[MODERATOR, AUTHOR, 'event', EVENT_ID, null, 'report', 1]]);
  });

  it('records whoever Keycast verified and whoever wrote the event, never a value from the request', async () => {
    const otherModerator = '7'.repeat(64);
    const otherAuthor = '8'.repeat(64);
    loginPubkey = otherModerator;
    relayAnswers.getsuspendedevent = { result: event({ pubkey: otherAuthor }) };
    const { db, inserts } = makeDb();
    const res = await worker.fetch(viewEvent({ eventId: EVENT_ID, surface: 'report', moderatorPubkey: MODERATOR }), makeEnv(db), ctx);
    expect(res.status).toBe(200);
    expect(inserts).toEqual([[otherModerator, otherAuthor, 'event', EVENT_ID, null, 'report', 1]]);
  });

  it('canonicalizes an uppercase event id before it reaches the relay or D1', async () => {
    const { db, inserts } = makeDb();
    const res = await worker.fetch(viewEvent({ eventId: EVENT_ID.toUpperCase(), surface: 'age-review' }), makeEnv(db), ctx);
    expect(res.status).toBe(200);
    expect(relayCalls[0].params).toEqual([EVENT_ID]);
    expect(inserts[0][3]).toBe(EVENT_ID);
    expect(inserts[0][5]).toBe('age-review');
  });

  it('answers no-store', async () => {
    const { db } = makeDb();
    const res = await worker.fetch(viewEvent(), makeEnv(db), ctx);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
  });

  it('refuses with 401 and calls neither the relay nor D1 without a login header', async () => {
    const { db, statements } = makeDb();
    const res = await worker.fetch(viewEvent(undefined, { 'X-Divine-Login-Token': '' }), makeEnv(db), ctx);
    expect(res.status).toBe(401);
    expect((await res.json() as { code: string }).code).toBe('moderator_login_required');
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    expect(relayCalls).toEqual([]);
    expect(statements).toEqual([]);
  });

  it('refuses with 401 when Keycast refuses the login', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    loginStatus = 401;
    const { db, statements } = makeDb();
    const res = await worker.fetch(viewEvent(), makeEnv(db), ctx);
    expect(res.status).toBe(401);
    expect(relayCalls).toEqual([]);
    expect(statements).toEqual([]);
  });

  it('refuses a login that only the cache would accept', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { db } = makeDb();
    // A plain route caches the success...
    await worker.fetch(new Request('https://api.example.test/api/decisions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Admin-Key': 'test-admin-key', 'X-Divine-Login-Token': TOKEN },
      body: JSON.stringify({ targetType: 'pubkey', targetId: AUTHOR, action: 'reviewed' }),
    }), makeEnv(db), ctx);
    expect(loginCalls).toBe(1);
    // ...then Keycast stops honouring the login. The viewer checks fresh.
    loginStatus = 401;
    const res = await worker.fetch(viewEvent(), makeEnv(makeDb().db), ctx);
    expect(loginCalls).toBe(2);
    expect(res.status).toBe(401);
    expect(relayCalls).toEqual([]);
  });

  it('refuses without the access gate, before any login check', async () => {
    const res = await worker.fetch(viewEvent(undefined, { 'X-Admin-Key': '' }), makeEnv(makeDb().db), ctx);
    expect(res.status).toBe(401);
    expect(loginCalls).toBe(0);
    expect(relayCalls).toEqual([]);
  });

  it.each([
    ['a non-JSON body', 'not json'],
    ['a bad event id', { eventId: 'x', surface: 'report' }],
    ['the quarantine surface', { eventId: EVENT_ID, surface: 'sexual-quarantine' }],
  ])('answers 400 invalid_request for %s, calling neither the relay nor D1', async (_name, body) => {
    const { db, statements } = makeDb();
    const res = await worker.fetch(viewEvent(body), makeEnv(db), ctx);
    expect(res.status).toBe(400);
    expect((await res.json() as { code: string }).code).toBe('invalid_request');
    expect(relayCalls).toEqual([]);
    expect(statements).toEqual([]);
  });

  it('fails closed without DB, before reading the relay', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await worker.fetch(viewEvent(), makeEnv(), ctx);
    expect(res.status).toBe(503);
    expect((await expectNoContent(res)).code).toBe('audit_unavailable');
    expect(relayCalls).toEqual([]);
  });

  it('fails closed when the table cannot be ensured, before reading the relay', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await worker.fetch(viewEvent(), makeEnv(makeDb({ ddl: 'throw' }).db), ctx);
    expect(res.status).toBe(503);
    expect((await expectNoContent(res)).code).toBe('audit_unavailable');
    expect(relayCalls).toEqual([]);
  });

  it('fails closed when the insert throws: 503 with no event id or content', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await worker.fetch(viewEvent(), makeEnv(makeDb({ insert: 'throw' }).db), ctx);
    expect(res.status).toBe(503);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    expect((await expectNoContent(res)).code).toBe('audit_unavailable');
  });

  it('fails closed when the insert changes no rows', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await worker.fetch(viewEvent(), makeEnv(makeDb({ insert: 'no-change' }).db), ctx);
    expect(res.status).toBe(503);
    expect((await expectNoContent(res)).code).toBe('audit_unavailable');
  });

  it.each([
    ['Event author is not suspended', 409, 'not_suspended'],
    ['Unknown method: getsuspendedevent', 501, 'viewer_unsupported'],
    ['Failed to get suspended event: boom', 502, 'relay_error'],
  ])('writes nothing for %j (%i %s)', async (error, status, code) => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    relayAnswers.getsuspendedevent = { error };
    const { db, inserts } = makeDb();
    const res = await worker.fetch(viewEvent(), makeEnv(db), ctx);
    expect(res.status).toBe(status);
    expect(await res.json()).toMatchObject({ success: false, code });
    expect(inserts).toEqual([]);
  });

  it('answers 404 hidden_for_another_reason, with no row and no getbannedevent call, for a post hidden for another reason (such as also banned)', async () => {
    relayAnswers.getsuspendedevent = { error: 'Event not found, superseded, or hidden by a filter other than suspension' };
    relayAnswers.getbannedevent = { result: event() };
    const { db, inserts } = makeDb();
    const res = await worker.fetch(viewEvent(), makeEnv(db), ctx);
    expect(res.status).toBe(404);
    expect((await expectNoContent(res)).code).toBe('hidden_for_another_reason');
    expect(relayMethods()).toEqual(['getsuspendedevent']);
    expect(inserts).toEqual([]);
  });

  it('never writes moderation_decisions', async () => {
    const { db, statements, inserts } = makeDb();
    const res = await worker.fetch(viewEvent(), makeEnv(db), ctx);
    expect(res.status).toBe(200);
    expect(inserts).toHaveLength(1);
    expect(statements.length).toBeGreaterThan(0);
    expect(statements.some(s => /moderation_decisions/i.test(s.sql))).toBe(false);
  });

  it('never logs the token or the event content', async () => {
    const spies = (['log', 'warn', 'error', 'info', 'debug'] as const).map(level => vi.spyOn(console, level).mockImplementation(() => {}));
    await worker.fetch(viewEvent(), makeEnv(makeDb().db), ctx);
    await worker.fetch(viewEvent(), makeEnv(makeDb({ insert: 'throw' }).db), ctx);
    await worker.fetch(viewEvent(), makeEnv(makeDb({ insert: 'no-change' }).db), ctx);
    await worker.fetch(viewEvent(), makeEnv(), ctx);
    loginStatus = 401;
    await worker.fetch(viewEvent(), makeEnv(makeDb().db), ctx);
    for (const spy of spies) {
      for (const call of spy.mock.calls) {
        const line = call.map(String).join(' ');
        expect(line).not.toContain(TOKEN);
        expect(line).not.toContain(SECRET_CONTENT);
      }
    }
  });
});

// ===========================================================================
// POST /api/suspended-content/account
// ===========================================================================
describe('POST /api/suspended-content/account', () => {
  beforeEach(() => {
    const pageAnswer = relayAnswers.listsuspendedpubkeyevents;
    // The profile read is the same method with kinds [0] and limit 1.
    relayAnswers.listsuspendedpubkeyevents = () => {
      const last = relayCalls[relayCalls.length - 1];
      const opts = last.params[1] as { kinds?: number[] } | undefined;
      if (opts?.kinds?.length === 1 && opts.kinds[0] === 0) {
        return new Response(JSON.stringify({ result: { events: [PROFILE], next_until: null, next_until_id: null } }));
      }
      return new Response(JSON.stringify(typeof pageAnswer === 'function' ? {} : pageAnswer));
    };
  });

  it('first page returns events and profile without an account media listing, recording one account row', async () => {
    const { db, inserts } = makeDb();
    const res = await worker.fetch(viewAccount(), makeEnv(db), ctx);
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    expect(await res.json()).toEqual({
      success: true,
      pubkey: AUTHOR,
      profile: PROFILE,
      events: [event(), SECOND],
      nextUntil: 1_699_999_000,
      nextUntilId: SECOND.id,
    });
    const pageCall = relayCalls.find(c => !(c.params[1] as { kinds?: number[] })?.kinds);
    expect(pageCall?.params).toEqual([AUTHOR, { limit: 50 }]);
    expect(relayCalls.some(c => JSON.stringify(c.params[1]) === JSON.stringify({ kinds: [0], limit: 1 }))).toBe(true);
    expect(mediaCalls).toBe(0);
    expect(inserts).toEqual([[MODERATOR, AUTHOR, 'account', null, null, 'user', 3]]);
  });

  it('records the verified moderator on an account view', async () => {
    loginPubkey = '7'.repeat(64);
    const { db, inserts } = makeDb();
    const res = await worker.fetch(viewAccount({ pubkey: AUTHOR, surface: 'user', until: 9 }), makeEnv(db), ctx);
    expect(res.status).toBe(200);
    expect(inserts[0][0]).toBe('7'.repeat(64));
  });

  it('a later page records page_until and omits profile and account media', async () => {
    const { db, inserts } = makeDb();
    const res = await worker.fetch(viewAccount({
      pubkey: AUTHOR, surface: 'report', until: 1_699_999_000, untilId: SECOND.id, kinds: [1, 34236], limit: 20,
    }), makeEnv(db), ctx);
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body).toMatchObject({ profile: null, events: [event(), SECOND] });
    expect(body).not.toHaveProperty('media');
    expect(body).not.toHaveProperty('profileError');
    expect(body).not.toHaveProperty('mediaError');
    expect(relayCalls).toEqual([{
      method: 'listsuspendedpubkeyevents',
      params: [AUTHOR, { kinds: [1, 34236], until: 1_699_999_000, until_id: SECOND.id, limit: 20 }],
    }]);
    expect(mediaCalls).toBe(0);
    expect(inserts).toEqual([[MODERATOR, AUTHOR, 'account', null, 1_699_999_000, 'report', 2]]);
  });

  it('does not depend on the media server for the first page', async () => {
    mediaAnswer = () => new Response('down', { status: 500 });
    const { db, inserts } = makeDb();
    const res = await worker.fetch(viewAccount(), makeEnv(db), ctx);
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body).toMatchObject({ events: [event(), SECOND], profile: PROFILE });
    expect(body).not.toHaveProperty('media');
    expect(body).not.toHaveProperty('mediaError');
    expect(mediaCalls).toBe(0);
    expect(inserts).toHaveLength(1);
  });

  it('a profile read failure still serves the events, with profileError', async () => {
    relayAnswers.listsuspendedpubkeyevents = (() => {
      const pageAnswer = { result: { events: [event()], next_until: null, next_until_id: null } };
      return () => {
        const opts = relayCalls[relayCalls.length - 1].params[1] as { kinds?: number[] } | undefined;
        return opts?.kinds?.[0] === 0
          ? new Response('bad gateway', { status: 502 })
          : new Response(JSON.stringify(pageAnswer));
      };
    })();
    const { db, inserts } = makeDb();
    const res = await worker.fetch(viewAccount(), makeEnv(db), ctx);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ profile: null, profileError: 'relay_error', events: [event()] });
    expect(inserts[0][6]).toBe(1);
  });

  it('a not-suspended account returns 409 with no media and no row', async () => {
    relayAnswers.listsuspendedpubkeyevents = { error: 'Pubkey is not suspended' };
    const { db, inserts } = makeDb();
    const res = await worker.fetch(viewAccount(), makeEnv(db), ctx);
    expect(res.status).toBe(409);
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({ success: false, error: expect.any(String), code: 'not_suspended' });
    expect(text).not.toContain('1'.repeat(64));
    expect(inserts).toEqual([]);
  });

  it("another author's event in the page is 502 with no row", async () => {
    relayAnswers.listsuspendedpubkeyevents = { result: { events: [event({ pubkey: 'f'.repeat(64) })], next_until: null, next_until_id: null } };
    const { db, inserts } = makeDb();
    const res = await worker.fetch(viewAccount({ pubkey: AUTHOR, surface: 'user', until: 5 }), makeEnv(db), ctx);
    expect(res.status).toBe(502);
    expect((await expectNoContent(res)).code).toBe('relay_error');
    expect(inserts).toEqual([]);
  });

  it('refuses with 401 and calls neither the relay, the media server nor D1 without a verified login', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    loginStatus = 401;
    const { db, statements } = makeDb();
    const res = await worker.fetch(viewAccount(), makeEnv(db), ctx);
    expect(res.status).toBe(401);
    expect(relayCalls).toEqual([]);
    expect(mediaCalls).toBe(0);
    expect(statements).toEqual([]);
  });

  it('answers 400 for untilId without until', async () => {
    const res = await worker.fetch(viewAccount({ pubkey: AUTHOR, surface: 'user', untilId: SECOND.id }), makeEnv(makeDb().db), ctx);
    expect(res.status).toBe(400);
    expect(relayCalls).toEqual([]);
  });

  it('fails closed without DB, before reading the relay or the media server', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await worker.fetch(viewAccount(), makeEnv(), ctx);
    expect(res.status).toBe(503);
    expect((await res.json() as { code: string }).code).toBe('audit_unavailable');
    expect(relayCalls).toEqual([]);
    expect(mediaCalls).toBe(0);
  });

  it('fails closed when the insert throws: 503 with no events, profile or media', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await worker.fetch(viewAccount(), makeEnv(makeDb({ insert: 'throw' }).db), ctx);
    expect(res.status).toBe(503);
    const body = await expectNoContent(res);
    expect(body.code).toBe('audit_unavailable');
    expect(JSON.stringify(body)).not.toContain('1'.repeat(64));
    expect(JSON.stringify(body)).not.toContain('suspended"}');
  });

  it('fails closed when the insert changes no rows', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await worker.fetch(viewAccount(), makeEnv(makeDb({ insert: 'no-change' }).db), ctx);
    expect(res.status).toBe(503);
    expect((await expectNoContent(res)).code).toBe('audit_unavailable');
  });

  it('never writes moderation_decisions', async () => {
    const { db, statements } = makeDb();
    const res = await worker.fetch(viewAccount(), makeEnv(db), ctx);
    expect(res.status).toBe(200);
    expect(statements.length).toBeGreaterThan(0);
    expect(statements.some(s => /moderation_decisions/i.test(s.sql))).toBe(false);
  });
});

// ===========================================================================
// GET /api/suspended-content/views
// ===========================================================================
describe('GET /api/suspended-content/views', () => {
  it('requires the access gate', async () => {
    const res = await worker.fetch(new Request('https://api.example.test/api/suspended-content/views'), makeEnv(makeDb().db), ctx);
    expect(res.status).toBe(401);
  });

  it('needs no Divine login past the access gate', async () => {
    const res = await worker.fetch(new Request('https://api.example.test/api/suspended-content/views', {
      headers: { 'X-Admin-Key': 'test-admin-key' },
    }), makeEnv(makeDb().db), ctx);
    expect(res.status).toBe(200);
    expect(loginCalls).toBe(0);
  });

  it('answers 503 audit_unavailable without DB', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await worker.fetch(new Request('https://api.example.test/api/suspended-content/views', {
      headers: { 'X-Admin-Key': 'test-admin-key' },
    }), makeEnv(), ctx);
    expect(res.status).toBe(503);
    expect((await res.json() as { code: string }).code).toBe('audit_unavailable');
  });
});
