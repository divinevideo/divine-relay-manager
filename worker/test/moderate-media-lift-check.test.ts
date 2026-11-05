// The lift check, POST /api/moderate-media/lift-check
// (divine-moderation-service#231).
//
// moderation-service's own dashboard writes media decisions without coming
// through /api/moderate-media, so it is meant to ask here first whether a SAFE
// or AGE_RESTRICTED may go ahead. The answer is /api/moderate-media's lift
// guard (#335), the same function, run without the write:
//   - allowed: 200 { allowed: true, checked: true, sha256 } with the hash
//     lowercased, as /api/moderate-media would have written it;
//   - refused: the guard's own 400, 409 or 503, unchanged;
//   - PERMANENT_BAN, QUARANTINE, DELETE or REVIEW: 200 { allowed: true,
//     checked: false }, reading nothing, since the guard does not check them;
//   - any other action: 400 invalid_action, so a name it does not know is
//     refused rather than allowed.
// It never writes to moderation-service, and it accepts moderation-service's
// key, which /api/moderate-media does not.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import worker from '../src/index';

const SHA = '5'.repeat(64);
const OWNER = 'a1'.repeat(32);
const MOD_KEY = 'mod-relay-key';

type Call = { url: string; method: string; body: unknown };
let calls: Call[];
let sqls: Array<{ sql: string; binds: unknown[] }>;
let openCase: Record<string, unknown> | null;
let lookupThrows: boolean;
let blobOwner: string | number;
let blobStatus: string;
let blobReads: string[];
// What moderation-service's record says, or a number for a failed read.
let recordStatus: string | number;

const moderationApi = {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const body = request.method === 'POST' ? await request.clone().json() : null;
    calls.push({ url: url.pathname, method: request.method, body });
    if (url.pathname.startsWith('/check-result/')) {
      if (typeof recordStatus === 'number') return new Response('err', { status: recordStatus });
      return Response.json({ sha256: SHA, status: recordStatus, moderated: recordStatus !== 'unknown' });
    }
    if (url.pathname === '/api/v1/moderate') return Response.json({ success: true, sha256: SHA });
    return new Response('not found', { status: 404 });
  },
};

const db = {
  prepare(sql: string) {
    let binds: unknown[] = [];
    const stmt = {
      bind(...args: unknown[]) { binds = args; return stmt; },
      async first() {
        sqls.push({ sql, binds });
        if (/FROM age_review_cases/i.test(sql)) {
          if (lookupThrows) throw new Error('D1 unavailable');
          return openCase;
        }
        return null;
      },
      async all() { sqls.push({ sql, binds }); return { results: [] }; },
      async run() { sqls.push({ sql, binds }); return { meta: { changes: 0 } }; },
    };
    return stmt;
  },
  async batch() { return []; },
};

function env(extra: Record<string, unknown> = {}) {
  return {
    ADMIN_API_KEY: 'k',
    MOD_RELAY_ADMIN_KEY: { get: async () => MOD_KEY },
    SERVICE_API_TOKEN: 'service-token',
    MODERATION_API: moderationApi,
    MODERATION_SERVICE_URL: 'https://moderation.example',
    MODERATION_ADMIN_URL: 'https://moderation.example',
    BLOSSOM_WEBHOOK_SECRET: 'blossom-secret',
    CDN_DOMAIN: 'media.example',
    DB: db,
    ...extra,
  } as unknown as Parameters<typeof worker.fetch>[1];
}

function request(path: string, body: Record<string, unknown>, key = 'k', method = 'POST') {
  return new Request(`https://relay.example${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-Admin-Key': key },
    ...(method === 'POST' ? { body: JSON.stringify(body) } : {}),
  });
}

const check = (body: Record<string, unknown>, extra: Record<string, unknown> = {}, key = 'k') =>
  worker.fetch(request('/api/moderate-media/lift-check', body, key), env(extra), {} as ExecutionContext);
const moderate = (body: Record<string, unknown>, extra: Record<string, unknown> = {}, key = 'k') =>
  worker.fetch(request('/api/moderate-media', body, key), env(extra), {} as ExecutionContext);
const writes = () => calls.filter((c) => c.url === '/api/v1/moderate');
const stateReads = () => calls.filter((c) => c.url.startsWith('/check-result/'));
const caseLookups = () => sqls.filter((s) => /FROM age_review_cases/i.test(s.sql));

beforeEach(() => {
  calls = [];
  sqls = [];
  openCase = null;
  lookupThrows = false;
  blobOwner = OWNER;
  blobStatus = 'banned';
  blobReads = [];
  recordStatus = 'permanent_ban';
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(globalThis, 'fetch').mockImplementation((async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    if (url.host === 'media.example' && url.pathname.startsWith('/admin/api/blob/')) {
      blobReads.push(url.pathname.slice('/admin/api/blob/'.length));
      if (new Headers(init?.headers).get('Authorization') !== 'Bearer blossom-secret') return new Response('unauthorized', { status: 401 });
      if (typeof blobOwner === 'number') return new Response('err', { status: blobOwner });
      return Response.json({ sha256: SHA, type: 'video/mp4', owner: blobOwner, status: blobStatus });
    }
    return new Response('not found', { status: 404 });
  }) as typeof fetch);
});

afterEach(() => vi.restoreAllMocks());

describe('/api/moderate-media/lift-check', () => {
  it('allows a SAFE when the owner has no open case, naming the lowercase hash, and writes nothing', async () => {
    const res = await check({ sha256: 'A'.repeat(64), action: 'SAFE' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true, allowed: true, checked: true, sha256: 'a'.repeat(64) });
    expect(blobReads).toEqual(['a'.repeat(64)]);
    expect(caseLookups()[0].binds[0]).toBe(OWNER);
    expect(writes()).toHaveLength(0);
  });

  it("refuses a SAFE while the file's owner has an open age review, naming the case, and writes nothing", async () => {
    openCase = { id: 'case-open', pubkey: OWNER, state: 'open_reported' };
    const res = await check({ sha256: SHA, action: 'safe' });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({
      success: false,
      code: 'age_review_active',
      caseId: 'case-open',
      state: 'open_reported',
      error: 'The account that owns this file has an open age review, so its files can only be made public through that case.',
    });
    expect(writes()).toHaveLength(0);
  });

  it('refuses an AGE_RESTRICTED over a file the record shows hidden during an open case', async () => {
    blobStatus = 'active';
    recordStatus = 'quarantine';
    openCase = { id: 'case-open', pubkey: OWNER, state: 'open_reported' };
    const res = await check({ sha256: SHA, action: 'AGE_RESTRICTED' });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: 'age_review_active', caseId: 'case-open' });
    expect(stateReads()).toHaveLength(1);
    expect(writes()).toHaveLength(0);
  });

  it('allows an AGE_RESTRICTED over a public file during a case that has not restricted the account', async () => {
    blobStatus = 'active';
    recordStatus = 'safe';
    openCase = { id: 'case-open', pubkey: OWNER, state: 'open_reported' };
    const res = await check({ sha256: SHA, action: 'AGE_RESTRICTED' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true, allowed: true, checked: true, sha256: SHA });
    expect(writes()).toHaveLength(0);
  });

  it.each([
    ['the media server has no record of the file', () => { blobOwner = 404; }, {}, 409, 'media_record_missing'],
    ['the owner cannot be read', () => { blobOwner = 500; }, {}, 503, 'owner_unreadable'],
    ['the age-review lookup fails', () => { lookupThrows = true; }, {}, 503, 'age_review_check_failed'],
    ['there is no database', () => {}, { DB: undefined }, 503, 'age_review_check_failed'],
  ] as const)('refuses when %s', async (_label, arrange, extra, status, code) => {
    arrange();
    const res = await check({ sha256: SHA, action: 'SAFE' }, extra);
    expect(res.status).toBe(status);
    expect(await res.json()).toMatchObject({ success: false, code });
    expect(writes()).toHaveLength(0);
  });

  it('refuses with 503 when an AGE_RESTRICTED needs the record and it cannot be read', async () => {
    blobStatus = 'active';
    recordStatus = 500;
    openCase = { id: 'case-open', pubkey: OWNER, state: 'open_reported' };
    const res = await check({ sha256: SHA, action: 'AGE_RESTRICTED' });
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ success: false, code: 'state_unreadable' });
  });

  it.each(['abc', `../user/${OWNER}`, 'g'.repeat(64), 5])('refuses the hash %j, and never asks the media server', async (sha256) => {
    const res = await check({ sha256, action: 'SAFE' });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ success: false, code: 'invalid_sha256' });
    expect(blobReads).toEqual([]);
  });

  it('refuses a request with no hash', async () => {
    const res = await check({ action: 'SAFE' });
    expect(res.status).toBe(400);
    expect(blobReads).toEqual([]);
  });

  it.each([[undefined], [['SAFE']], [1], [''], ['APPROVE'], ['SAFE '], ['UNBLOCK']])(
    'refuses the action %j before reading anything',
    async (action) => {
      const res = await check({ sha256: SHA, action });
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ success: false, code: 'invalid_action' });
      expect(blobReads).toEqual([]);
      expect(caseLookups()).toHaveLength(0);
    },
  );

  it.each(['not json', 'null'])('refuses the body %j before reading anything', async (raw) => {
    const res = await worker.fetch(
      new Request('https://relay.example/api/moderate-media/lift-check', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Admin-Key': 'k' },
        body: raw,
      }),
      env(),
      {} as ExecutionContext,
    );
    expect(res.status).not.toBe(200);
    expect(await res.json()).toMatchObject({ success: false });
    expect(blobReads).toEqual([]);
  });

  // The answer is the lift guard's on the file's owner. A `pubkey` in the
  // request does not switch it to /api/moderate-media's account check.
  it('checks the owner the media server names, whatever `pubkey` the request sends', async () => {
    openCase = { id: 'case-open', pubkey: OWNER, state: 'open_reported' };
    const res = await check({ sha256: SHA, action: 'SAFE', pubkey: 'b2'.repeat(32) });
    expect(res.status).toBe(409);
    expect(caseLookups()[0].binds[0]).toBe(OWNER);
  });

  // The guard checks only what makes a file more visible. Asked about one of
  // moderation-service's other actions, the check says nothing needed checking.
  it.each(['PERMANENT_BAN', 'QUARANTINE', 'DELETE', 'REVIEW', 'review'])(
    'allows a %s without reading the owner, the case or the record',
    async (action) => {
      openCase = { id: 'case-open', pubkey: OWNER, state: 'open_reported' };
      const res = await check({ sha256: SHA, action });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ success: true, allowed: true, checked: false });
      expect(blobReads).toEqual([]);
      expect(sqls).toEqual([]);
      expect(calls).toEqual([]);
    },
  );

  // The schema bootstrap runs once per isolate on whichever route first reads
  // age-review cases, this one included. Past it, the check only reads.
  it('issues only reads to D1 once the schema is set up', async () => {
    openCase = { id: 'case-open', pubkey: OWNER, state: 'open_reported' };
    blobStatus = 'active';
    recordStatus = 'safe';
    await check({ sha256: SHA, action: 'AGE_RESTRICTED' });
    sqls = [];
    calls = [];
    for (const action of ['SAFE', 'AGE_RESTRICTED']) await check({ sha256: SHA, action });
    expect(caseLookups().length).toBeGreaterThan(0);
    expect(sqls.filter((s) => !/^\s*SELECT\b/i.test(s.sql))).toEqual([]);
    expect(stateReads().length).toBeGreaterThan(0);
    expect(writes()).toHaveLength(0);
  });

  // The check exists so moderation-service never has to restate the rules,
  // so its answer must be /api/moderate-media's, state for state.
  describe("agrees with /api/moderate-media's lift guard", () => {
    const blobStatuses = ['active', 'pending', 'age_restricted', 'restricted', 'banned', 'deleted'];
    const records = ['safe', 'unknown', 'review', 'age_restricted', 'quarantine', 'permanent_ban', 'delete'];
    const caseStates = [null, 'open_reported', 'under_moderator_review', 'restricted_pending_user_response'];
    const cases = ['SAFE', 'AGE_RESTRICTED'].flatMap((action) => blobStatuses.flatMap((b) =>
      records.flatMap((r) => caseStates.map((s) => [action, b, r, s] as const))));

    it.each(cases)('%s over a file at %s, record %s, case %s', async (action, b, r, s) => {
      const arrange = () => {
        calls = [];
        blobStatus = b;
        recordStatus = r;
        openCase = s ? { id: 'case-open', pubkey: OWNER, state: s } : null;
      };
      arrange();
      const fromCheck = await check({ sha256: SHA, action });
      expect(writes()).toHaveLength(0);
      arrange();
      const fromModerate = await moderate({ sha256: SHA, action });
      const wrote = writes().length === 1;

      expect(fromCheck.status === 200).toBe(wrote);
      if (wrote) {
        expect(await fromCheck.json()).toEqual({ success: true, allowed: true, checked: true, sha256: SHA });
        expect(writes()[0].body).toMatchObject({ sha256: SHA });
      } else {
        expect(fromCheck.status).toBe(fromModerate.status);
        expect(await fromCheck.json()).toEqual(await fromModerate.json());
      }
    });
  });
});

describe('/api/moderate-media/lift-check access', () => {
  it("accepts moderation-service's key", async () => {
    const res = await check({ sha256: SHA, action: 'SAFE' }, {}, MOD_KEY);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ allowed: true });
  });

  it("still refuses moderation-service's key on /api/moderate-media, which writes", async () => {
    const res = await moderate({ sha256: SHA, action: 'SAFE' }, {}, MOD_KEY);
    expect(res.status).toBe(401);
    expect(blobReads).toEqual([]);
    expect(writes()).toHaveLength(0);
  });

  it('refuses a wrong key', async () => {
    const res = await check({ sha256: SHA, action: 'SAFE' }, {}, 'wrong');
    expect(res.status).toBe(401);
    expect(blobReads).toEqual([]);
  });

  it("refuses moderation-service's key on a GET to the same path", async () => {
    const res = await worker.fetch(
      request('/api/moderate-media/lift-check', {}, MOD_KEY, 'GET'),
      env(),
      {} as ExecutionContext,
    );
    expect(res.status).toBe(401);
  });
});
