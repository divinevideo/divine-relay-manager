// ABOUTME: Pins the report-watcher proxy: queue cursors pass through, the sexual-quarantine actor is the verified moderator,
// ABOUTME: and the moderator login token never reaches the ReportWatcher Durable Object.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import worker from './index';
import { __clearModeratorLoginCache } from './moderator-identity';
import { __clearSuspendedListCache } from './suspended-content';

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

// ============================================================================
// A suspended author's snapshot is audited like the viewer (Task B7)
// ============================================================================
describe("a suspended author's quarantine snapshot", () => {
  const AUTHOR = 'a'.repeat(64);
  const MOD = 'c'.repeat(64);
  const SNAPSHOT_CONTENT = 'snapshot content hidden by the suspension';
  // Media identifiers: the snapshot's asset, a thumbnail hash only the hold
  // list and the report name, as a real case carries them.
  const VIDEO_HASH = '9'.repeat(64);
  const THUMB_HASH = '8'.repeat(64);
  const caseBody = () => ({
    eventId: EVENT_ID, revision: 3, state: 'hidden', reporters: 2,
    firstReport: {
      id: 'f'.repeat(64), pubkey: 'd'.repeat(64), reason: 'sexual-content',
      source: { kind: 1984, tags: [['e', EVENT_ID], ['p', AUTHOR], ['x', THUMB_HASH]], content: 'report text' },
    },
    snapshot: {
      event: { id: EVENT_ID, pubkey: AUTHOR, created_at: 1, kind: 34236, tags: [['imeta', `url https://media.example.test/${VIDEO_HASH}`]], content: SNAPSHOT_CONTENT, sig: 's' },
      assets: [VIDEO_HASH],
    },
    mediaHoldAssets: [VIDEO_HASH, THUMB_HASH],
  });
  // What an unaudited answer may still carry for a suspended or unknown author.
  const redactedCase = (withheld: 'suspended' | 'unknown') => {
    const { snapshot: _s, mediaHoldAssets: _m, firstReport, ...rest } = caseBody();
    const { source: _src, ...report } = firstReport;
    return { ...rest, firstReport: report, snapshotWithheld: withheld };
  };
  const expectNoMedia = (text: string) => {
    expect(text).not.toContain(SNAPSHOT_CONTENT);
    expect(text).not.toContain(VIDEO_HASH);
    expect(text).not.toContain(THUMB_HASH);
  };

  let suspendedList: { result?: unknown; error?: string };
  let bannedEvent: unknown;
  let relayCalls: string[];
  let loginCalls: number;
  let loginOk: boolean;
  let doBody: unknown;
  let doStatus: number;
  let inserts: unknown[][];
  let insertMode: 'ok' | 'throw';
  let statements: string[];

  function db() {
    return {
      prepare(sql: string) {
        statements.push(sql);
        let args: unknown[] = [];
        const stmt = {
          bind(...a: unknown[]) { args = a; return stmt; },
          async run() {
            if (/INSERT INTO suspended_content_views/.test(sql)) {
              if (insertMode === 'throw') throw new Error('D1 down');
              inserts.push(args);
            }
            return { success: true, meta: { changes: 1 } };
          },
        };
        return stmt;
      },
    };
  }

  function env(withDb = true) {
    return {
      ALLOWED_ORIGINS: 'https://app.divine.video',
      ADMIN_API_KEY: 'test-admin-key',
      MODERATOR_LOGIN_URL: 'https://login.example.test',
      RELAY_URL: 'wss://relay.example.test',
      NOSTR_NSEC: 'nsec1vl029mgpspedva04g90vltkh6fvh240zqtv9k0t9af8935ke9laqsnlfe5',
      ...(withDb ? { DB: db() } : {}),
      REPORT_WATCHER: {
        idFromName: () => 'id',
        get: () => ({ fetch: async () => new Response(JSON.stringify(doBody), { status: doStatus }) }),
      },
    } as never;
  }

  function get(path: string, login = true) {
    return worker.fetch(new Request(`https://worker.test/api/report-watcher/sexual-quarantine/${path}`, {
      headers: { 'X-Admin-Key': 'test-admin-key', ...(login ? { 'X-Divine-Login-Token': TOKEN } : {}) },
    }), env(), ctx);
  }

  beforeEach(() => {
    __clearModeratorLoginCache();
    __clearSuspendedListCache();
    bannedEvent = undefined;
    suspendedList = { result: [{ pubkey: AUTHOR }] };
    relayCalls = [];
    loginCalls = 0;
    loginOk = true;
    doBody = caseBody();
    doStatus = 200;
    inserts = [];
    insertMode = 'ok';
    statements = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === 'https://login.example.test/api/nostr') {
        loginCalls++;
        return loginOk ? new Response(JSON.stringify({ result: MOD })) : new Response('no', { status: 401 });
      }
      if (url === 'https://relay.example.test/management') {
        const { method } = JSON.parse(String(init?.body)) as { method: string };
        relayCalls.push(method);
        if (method === 'listsuspendedpubkeys') return new Response(JSON.stringify(suspendedList));
        if (method === 'getbannedevent' && bannedEvent) return new Response(JSON.stringify({ result: bannedEvent }));
        return new Response(JSON.stringify({ error: 'unexpected' }));
      }
      throw new Error(`unexpected fetch ${url}`);
    }));
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("passes a non-suspended author's snapshot through and writes no row", async () => {
    suspendedList = { result: [{ pubkey: '1'.repeat(64) }] };
    const res = await get(EVENT_ID);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(caseBody());
    expect(relayCalls).toEqual(['listsuspendedpubkeys']);
    expect(inserts).toEqual([]);
  });

  it("withholds a suspended author's snapshot without snapshot=1, and the rest of the case is intact", async () => {
    const res = await get(EVENT_ID);
    expect(res.status).toBe(200);
    const text = await res.text();
    expectNoMedia(text);
    expect(JSON.parse(text)).toEqual(redactedCase('suspended'));
    expect(inserts).toEqual([]);
    expect(loginCalls).toBe(1); // the plain poll's cached check, not a fresh one per poll
  });

  it('withholds it on any other single-case path the Durable Object answers with the case', async () => {
    for (const path of [`${EVENT_ID}/`, `${EVENT_ID}/anything`, `${EVENT_ID}//history`]) {
      const res = await get(path);
      expectNoMedia(await res.text());
    }
    expect(inserts).toEqual([]);
  });

  it('serves it with snapshot=1 and a verified login, writing one sexual-quarantine row', async () => {
    const res = await get(`${EVENT_ID}?snapshot=1`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(caseBody());
    expect(res.headers.get('Cache-Control')).toContain('no-store');
    // moderator, target, scope, event_id, page_until, surface, events_served
    expect(inserts).toEqual([[MOD, AUTHOR, 'event', EVENT_ID, null, 'sexual-quarantine', 1]]);
    expect(statements.some(s => /moderation_decisions/i.test(s))).toBe(false);
  });

  it('refuses snapshot=1 without a verified login with 401 and no case body', async () => {
    const res = await get(`${EVENT_ID}?snapshot=1`, false);
    expect(res.status).toBe(401);
    const text = await res.text();
    expect(JSON.parse(text).code).toBe('moderator_login_required');
    expect(text).not.toContain(SNAPSHOT_CONTENT);
    expect(text).not.toContain('sexual-content');
    expect(inserts).toEqual([]);
  });

  it('the snapshot=1 GET verifies the login fresh', async () => {
    await get(`${EVENT_ID}?snapshot=1`);
    loginOk = false;
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const res = await get(`${EVENT_ID}?snapshot=1`);
    expect(loginCalls).toBe(2);
    expect(res.status).toBe(401);
    expect(inserts).toHaveLength(1);
  });

  describe("when the suspension status can't be told", () => {
    const cases: Array<[string, () => void]> = [
      ['the list read fails', () => { suspendedList = { error: 'boom' }; }],
      ['the list is not a list', () => { suspendedList = { result: {} }; }],
      ['the snapshot event has no 64-hex pubkey', () => { (doBody as ReturnType<typeof caseBody>).snapshot.event.pubkey = 'x'; }],
    ];

    it.each(cases)("a poll withholds the media, marked 'unknown', and keeps the case usable when %s", async (_name, arrange) => {
      vi.spyOn(console, 'error').mockImplementation(() => {});
      arrange();
      const res = await get(EVENT_ID);
      expect(res.status).toBe(200);
      const text = await res.text();
      expectNoMedia(text);
      expect(JSON.parse(text)).toEqual(redactedCase('unknown'));
      expect(inserts).toEqual([]);
    });

    it.each(cases)('snapshot=1 fails closed with 503 and no case body when %s', async (_name, arrange) => {
      vi.spyOn(console, 'error').mockImplementation(() => {});
      arrange();
      const res = await get(`${EVENT_ID}?snapshot=1`);
      expect(res.status).toBe(503);
      const text = await res.text();
      expect(JSON.parse(text).code).toBe('suspension_status_unavailable');
      expect(text).not.toContain(SNAPSHOT_CONTENT);
      expect(text).not.toContain('sexual-content');
      expect(inserts).toEqual([]);
    });
  });

  describe('the suspended-list read', () => {
    let now: number;
    beforeEach(() => {
      now = 1_800_000_000_000;
      vi.spyOn(Date, 'now').mockImplementation(() => now);
    });
    const listReads = () => relayCalls.filter(m => m === 'listsuspendedpubkeys').length;

    it('background polls reuse a read up to 30 s old, in this isolate', async () => {
      await get(EVENT_ID);
      now += 30_000;
      await get(EVENT_ID);
      expect(listReads()).toBe(1);
      now += 1;
      await get(EVENT_ID);
      expect(listReads()).toBe(2);
    });

    it('a failed read is not reused', async () => {
      vi.spyOn(console, 'error').mockImplementation(() => {});
      suspendedList = { error: 'boom' };
      await get(EVENT_ID);
      suspendedList = { result: [{ pubkey: AUTHOR }] };
      await get(EVENT_ID);
      expect(listReads()).toBe(2);
    });

    it('snapshot=1 always reads fresh, even right after a poll', async () => {
      await get(EVENT_ID);
      await get(`${EVENT_ID}?snapshot=1`);
      await get(`${EVENT_ID}?snapshot=1`);
      expect(listReads()).toBe(3);
    });

    it("a poll's stale 'not suspended' never reaches the audited open", async () => {
      suspendedList = { result: [] };
      expect(await (await get(EVENT_ID)).json()).toEqual(caseBody());
      // Suspended a moment later: the explicit open must see it and audit.
      suspendedList = { result: [{ pubkey: AUTHOR }] };
      const res = await get(`${EVENT_ID}?snapshot=1`);
      expect(res.status).toBe(200);
      expect(inserts).toHaveLength(1);
    });

    it('the decision POST reads fresh', async () => {
      await get(EVENT_ID);
      doStatus = 202;
      await worker.fetch(new Request(`https://worker.test/api/report-watcher/sexual-quarantine/${EVENT_ID}`, {
        method: 'POST',
        headers: { 'X-Admin-Key': 'test-admin-key', 'Content-Type': 'application/json' },
        body: JSON.stringify({ revision: 3, decision: 'remove', reason: 'r' }),
      }), env(), ctx);
      expect(listReads()).toBe(2);
    });

    it("relay-rpc's getbannedevent author check reads fresh after a poll", async () => {
      await get(EVENT_ID);
      bannedEvent = caseBody().snapshot.event;
      const res = await worker.fetch(new Request('https://worker.test/api/relay-rpc', {
        method: 'POST',
        headers: { 'X-Admin-Key': 'test-admin-key', 'Content-Type': 'application/json' },
        body: JSON.stringify({ method: 'getbannedevent', params: [EVENT_ID] }),
      }), env(), ctx);
      expect(res.status).toBe(403);
      expect(listReads()).toBe(2);
    });

  });

  it('fails closed with 503 when the audit insert throws', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    insertMode = 'throw';
    const res = await get(`${EVENT_ID}?snapshot=1`);
    expect(res.status).toBe(503);
    const text = await res.text();
    expect(JSON.parse(text).code).toBe('audit_unavailable');
    expect(text).not.toContain(SNAPSHOT_CONTENT);
  });

  it('fails closed with 503 without DB', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await worker.fetch(new Request(`https://worker.test/api/report-watcher/sexual-quarantine/${EVENT_ID}?snapshot=1`, {
      headers: { 'X-Admin-Key': 'test-admin-key', 'X-Divine-Login-Token': TOKEN },
    }), env(false), ctx);
    expect(res.status).toBe(503);
    expect(await res.text()).not.toContain(SNAPSHOT_CONTENT);
  });

  it("strips a suspended author's snapshot from the decision POST's 202, and when the list can't be read", async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    doStatus = 202;
    const decide = () => worker.fetch(new Request(`https://worker.test/api/report-watcher/sexual-quarantine/${EVENT_ID}`, {
      method: 'POST',
      headers: { 'X-Admin-Key': 'test-admin-key', 'X-Divine-Login-Token': TOKEN, 'Content-Type': 'application/json' },
      body: JSON.stringify({ revision: 3, decision: 'remove', reason: 'r' }),
    }), env(), ctx);
    for (const [arrange, withheld] of [
      [() => {}, 'suspended'],
      [() => { suspendedList = { error: 'boom' }; }, 'unknown'],
    ] as const) {
      arrange();
      const res = await decide();
      expect(res.status).toBe(202);
      const text = await res.text();
      expectNoMedia(text);
      expect(JSON.parse(text)).toEqual(redactedCase(withheld));
    }
    expect(inserts).toEqual([]);
  });

  it("leaves a non-suspended author's decision response untouched", async () => {
    suspendedList = { result: [] };
    doStatus = 202;
    const res = await worker.fetch(new Request(`https://worker.test/api/report-watcher/sexual-quarantine/${EVENT_ID}`, {
      method: 'POST',
      headers: { 'X-Admin-Key': 'test-admin-key', 'Content-Type': 'application/json' },
      body: JSON.stringify({ revision: 3, decision: 'remove', reason: 'r' }),
    }), env(), ctx);
    expect(await res.json()).toEqual(caseBody());
  });

  it('drops media identifiers from the case list, which names no author, with no relay call', async () => {
    doBody = { cases: [{ eventId: EVENT_ID, state: 'hidden', mediaHoldAssets: [VIDEO_HASH, THUMB_HASH] }], nextCursor: 'c' };
    const res = await worker.fetch(new Request('https://worker.test/api/report-watcher/sexual-quarantine', {
      headers: { 'X-Admin-Key': 'test-admin-key' },
    }), env(), ctx);
    const text = await res.text();
    expectNoMedia(text);
    expect(JSON.parse(text)).toEqual({ cases: [{ eventId: EVENT_ID, state: 'hidden' }], nextCursor: 'c' });
    expect(relayCalls).toEqual([]);
  });

  it('drops media identifiers from history entries, which name no author, keeping what the screen shows', async () => {
    doBody = [
      { at: 3, action: 'media_hold_intent', revision: 2, sha256: THUMB_HASH },
      { at: 2, action: 'remove', revision: 2, actor: 'c'.repeat(64), reason: 'explicit' },
      { at: 1, action: 'report', id: 'f'.repeat(64), pubkey: 'd'.repeat(64), reason: 'sexual-content', category: 'sexual-content',
        source: caseBody().firstReport.source, sourceRef: 'sexual-evidence:report:f' },
    ];
    const text = await (await get(`${EVENT_ID}/history`)).text();
    expectNoMedia(text);
    expect(JSON.parse(text)).toEqual([
      { at: 3, action: 'media_hold_intent', revision: 2 },
      { at: 2, action: 'remove', revision: 2, actor: 'c'.repeat(64), reason: 'explicit' },
      { at: 1, action: 'report', id: 'f'.repeat(64), pubkey: 'd'.repeat(64), reason: 'sexual-content', category: 'sexual-content', sourceRef: 'sexual-evidence:report:f' },
    ]);
    expect(relayCalls).toEqual([]);
  });

  it("a case with a hold list but no readable snapshot author withholds its media as 'unknown'", async () => {
    const { snapshot: _s, ...noSnapshot } = caseBody();
    doBody = noSnapshot;
    const text = await (await get(EVENT_ID)).text();
    expectNoMedia(text);
    expect(JSON.parse(text)).toEqual(redactedCase('unknown'));
    expect(relayCalls).toEqual([]);
  });

  describe('a case whose only media identifier is the first report', () => {
    // As SexualQuarantine.get() hydrates it: a legacy sourceRef filled in, no
    // snapshot captured yet, so no target author can be read.
    const sourceOnly = () => {
      const { snapshot: _s, mediaHoldAssets: _m, ...rest } = caseBody();
      return rest;
    };
    const expected = () => {
      const { firstReport, ...rest } = sourceOnly();
      const { source: _src, ...report } = firstReport;
      // No snapshot exists to withhold, so no snapshotWithheld: the screen keeps
      // saying the snapshot is not available yet.
      return { ...rest, firstReport: report };
    };

    it('the GET drops the report event, with no relay call', async () => {
      doBody = sourceOnly();
      const text = await (await get(EVENT_ID)).text();
      expectNoMedia(text);
      expect(JSON.parse(text)).toEqual(expected());
      expect(relayCalls).toEqual([]);
    });

    it('snapshot=1 drops it too, with no audit row', async () => {
      doBody = sourceOnly();
      const res = await get(`${EVENT_ID}?snapshot=1`);
      expect(res.status).toBe(200);
      const text = await res.text();
      expectNoMedia(text);
      expect(JSON.parse(text)).toEqual(expected());
      expect(inserts).toEqual([]);
    });

    it('the decision response drops it', async () => {
      doBody = sourceOnly();
      doStatus = 202;
      const res = await worker.fetch(new Request(`https://worker.test/api/report-watcher/sexual-quarantine/${EVENT_ID}`, {
        method: 'POST',
        headers: { 'X-Admin-Key': 'test-admin-key', 'Content-Type': 'application/json' },
        body: JSON.stringify({ revision: 3, decision: 'remove', reason: 'r' }),
      }), env(), ctx);
      expect(res.status).toBe(202);
      const text = await res.text();
      expectNoMedia(text);
      expect(JSON.parse(text)).toEqual(expected());
    });
  });

  it('a case with no media identifier at all passes through, with no relay call', async () => {
    const { snapshot: _s, mediaHoldAssets: _m, firstReport, ...rest } = caseBody();
    const { source: _src, ...report } = firstReport;
    doBody = { ...rest, firstReport: report };
    expect(await (await get(EVENT_ID)).json()).toEqual(doBody);
    expect(relayCalls).toEqual([]);
  });

  it('leaves other routes and failed answers untouched, with no relay call', async () => {
    doBody = { running: true };
    expect(await (await worker.fetch(new Request('https://worker.test/api/report-watcher/status', {
      headers: { 'X-Admin-Key': 'test-admin-key' },
    }), env(), ctx)).json()).toEqual(doBody);
    doBody = { error: 'Case not found' };
    doStatus = 404;
    expect((await get(EVENT_ID)).status).toBe(404);
    expect(relayCalls).toEqual([]);
  });
});
