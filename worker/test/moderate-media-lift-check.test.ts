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
import { STATUS_READ_TIMEOUT_MS } from '../src/media-server';

const SHA = '5'.repeat(64);
const OWNER = 'a1'.repeat(32);
const MOD_KEY = 'mod-relay-key';

type Call = { url: string; method: string; body: unknown };
let calls: Call[];
let sqls: Array<{ sql: string; binds: unknown[] }>;
// The file owner's open case, if any, and any other account's. A lookup finds
// the one on the account it asks about.
let openCase: Record<string, unknown> | null;
let otherCases: Array<Record<string, unknown>>;
let lookupThrows: boolean;
// Accounts whose lookup alone fails.
let lookupThrowsFor: string[];
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
      // A read that never answers, unless its request is aborted.
      if (recordStatus === 'hang') {
        return new Promise((_, reject) => {
          request.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
        });
      }
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
      sql,
      get binds() { return binds; },
      bind(...args: unknown[]) { binds = args; return stmt; },
      async first() {
        sqls.push({ sql, binds });
        if (/FROM age_review_cases/i.test(sql)) {
          if (lookupThrows || lookupThrowsFor.includes(binds[0] as string)) throw new Error('D1 unavailable');
          return [openCase, ...otherCases].find((c) => c?.pubkey === binds[0]) ?? null;
        }
        return null;
      },
      async all() { sqls.push({ sql, binds }); return { results: [] }; },
      async run() { sqls.push({ sql, binds }); return { meta: { changes: 0 } }; },
    };
    return stmt;
  },
  async batch(stmts: Array<{ sql: string; binds: unknown[] }>) {
    for (const s of stmts) sqls.push({ sql: s.sql, binds: s.binds });
    return stmts.map(() => ({ results: [], meta: { changes: 0 } }));
  },
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
  otherCases = [];
  lookupThrows = false;
  lookupThrowsFor = [];
  blobOwner = OWNER;
  blobStatus = 'banned';
  blobReads = [];
  recordStatus = 'permanent_ban';
  vi.spyOn(console, 'error').mockImplementation(() => {});
  // The allowed calls to /api/moderate-media in the parity table below log a
  // line each from syncZendeskAfterAction.
  vi.spyOn(console, 'log').mockImplementation(() => {});
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

  it('refuses with 503 when an AGE_RESTRICTED needs the record and its read does not answer in time', async () => {
    let timeoutMs: number | undefined;
    const expire = new AbortController();
    vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms: number) => {
      timeoutMs = ms;
      return expire.signal;
    });
    blobStatus = 'active';
    recordStatus = 'hang';
    openCase = { id: 'case-open', pubkey: OWNER, state: 'open_reported' };
    const pending = check({ sha256: SHA, action: 'AGE_RESTRICTED' });
    await vi.waitFor(() => expect(stateReads()).toHaveLength(1));
    expire.abort();
    const res = await pending;
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ success: false, code: 'state_unreadable' });
    expect(timeoutMs).toBe(STATUS_READ_TIMEOUT_MS);
  });

  // This worker's credentials for moderation-service are used only to read its
  // record. A missing or unreadable one refuses only a check that needs that
  // read, and refuses it as an unreadable record does.
  const BROKEN_CREDENTIALS = [
    ['are not configured', { SERVICE_API_TOKEN: undefined }],
    ['cannot be read', { SERVICE_API_TOKEN: { get: async () => { throw new Error('secrets store down'); } } }],
  ] as const;

  it.each(BROKEN_CREDENTIALS)('allows a SAFE that reads no record while the credentials for moderation-service %s', async (_label, extra) => {
    const res = await check({ sha256: SHA, action: 'SAFE' }, extra);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true, allowed: true, checked: true, sha256: SHA });
  });

  it.each(BROKEN_CREDENTIALS)('refuses with 503 an AGE_RESTRICTED that needs the record while the credentials for moderation-service %s', async (_label, extra) => {
    blobStatus = 'active';
    recordStatus = 'safe';
    openCase = { id: 'case-open', pubkey: OWNER, state: 'open_reported' };
    const res = await check({ sha256: SHA, action: 'AGE_RESTRICTED' }, extra);
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ success: false, code: 'state_unreadable' });
    expect(stateReads()).toHaveLength(0);
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

  // This worker's credentials for moderation-service are used only by a check
  // that reads its record. An action the guard does not check is answered
  // before they are resolved, so a missing or unreadable credential cannot
  // refuse it.
  it.each([
    ['are not configured', { SERVICE_API_TOKEN: undefined }],
    ['cannot be read', { SERVICE_API_TOKEN: { get: async () => { throw new Error('secrets store down'); } } }],
  ])('allows an unchecked action while the credentials for moderation-service %s', async (_label, extra) => {
    for (const action of ['PERMANENT_BAN', 'QUARANTINE', 'DELETE', 'REVIEW']) {
      const res = await check({ sha256: SHA, action }, extra);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ success: true, allowed: true, checked: false });
    }
    expect(blobReads).toEqual([]);
    expect(sqls).toEqual([]);
    expect(calls).toEqual([]);
  });

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
      // Mixed case, so both routes have to agree on the hash a write uses too.
      const asked = 'aB'.repeat(32);
      arrange();
      const fromCheck = await check({ sha256: asked, action });
      expect(writes()).toHaveLength(0);
      arrange();
      const fromModerate = await moderate({ sha256: asked, action });
      const wrote = writes().length === 1;

      expect(fromCheck.status === 200).toBe(wrote);
      if (wrote) {
        expect(await fromCheck.json()).toEqual({ success: true, allowed: true, checked: true, sha256: asked.toLowerCase() });
        expect(writes()[0].body).toMatchObject({ sha256: asked.toLowerCase() });
      } else {
        expect(fromCheck.status).toBe(fromModerate.status);
        expect(await fromCheck.json()).toEqual(await fromModerate.json());
      }
    });
  });
});

// moderation-service keeps its own record of who uploaded a file, and that
// account can differ from the owner the media server names
// (divine-moderation-service#242). It sends the account as `uploader`, and the
// check runs the owner's case check on it too, with the same rules, after the
// owner. A refusal for it carries the owner's codes and fields, so the caller
// handles both the same way.
describe('/api/moderate-media/lift-check with the recorded uploader', () => {
  const UPLOADER = 'c3'.repeat(32);
  const OWNER_SAFE_ERROR = 'The account that owns this file has an open age review, so its files can only be made public through that case.';
  const uploaderCase = (state = 'open_reported') => ({ id: 'case-uploader', pubkey: UPLOADER, state });
  const lookedUp = () => caseLookups().map((s) => s.binds[0]);

  const INVALID_UPLOADERS: Array<[string, unknown]> = [
    ['uppercase', 'C3'.repeat(32)],
    ['63 characters', 'c'.repeat(63)],
    ['65 characters', 'c'.repeat(65)],
    ['not hex', 'g'.repeat(64)],
    ['empty', ''],
    ['null', null],
    ['a number', 5],
    ['an array', [UPLOADER]],
  ];

  it.each(['SAFE', 'AGE_RESTRICTED'].flatMap((action) => INVALID_UPLOADERS.map(([label, uploader]) => [action, label, uploader] as const)))(
    'refuses a %s whose uploader is %s, before reading anything',
    async (action, _label, uploader) => {
      const res = await check({ sha256: SHA, action, uploader });
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ success: false, code: 'invalid_uploader' });
      expect(blobReads).toEqual([]);
      expect(sqls).toEqual([]);
      expect(calls).toEqual([]);
    },
  );

  it('ignores `uploader` on an action it does not check, even one it would refuse', async () => {
    otherCases = [uploaderCase()];
    for (const action of ['PERMANENT_BAN', 'QUARANTINE', 'DELETE', 'REVIEW']) {
      for (const uploader of [UPLOADER, null, 'nope']) {
        const res = await check({ sha256: SHA, action, uploader });
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ success: true, allowed: true, checked: false });
      }
    }
    expect(blobReads).toEqual([]);
    expect(sqls).toEqual([]);
    expect(calls).toEqual([]);
  });

  it('checks only the owner when no uploader is sent', async () => {
    otherCases = [uploaderCase()];
    const res = await check({ sha256: SHA, action: 'SAFE' });
    expect(res.status).toBe(200);
    expect(lookedUp()).toEqual([OWNER]);
  });

  it("refuses a SAFE while the uploader has an open age review, naming the uploader's case, and writes nothing", async () => {
    otherCases = [uploaderCase()];
    const res = await check({ sha256: SHA, action: 'SAFE', uploader: UPLOADER });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      success: false,
      code: 'age_review_active',
      caseId: 'case-uploader',
      state: 'open_reported',
      error: "The account recorded as this file's uploader has an open age review, so the file can only be made public through that case.",
    });
    expect(lookedUp()).toEqual([OWNER, UPLOADER]);
    expect(writes()).toHaveLength(0);
  });

  it.each(['SAFE', 'AGE_RESTRICTED'])("refuses a %s with 503 when the uploader's lookup cannot run", async (action) => {
    blobStatus = 'active';
    recordStatus = 'safe';
    lookupThrowsFor = [UPLOADER];
    const res = await check({ sha256: SHA, action, uploader: UPLOADER });
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ success: false, code: 'age_review_check_failed' });
    expect(lookedUp()).toEqual([OWNER, UPLOADER]);
  });

  it.each(['SAFE', 'AGE_RESTRICTED'])('allows a %s when neither the owner nor the uploader has an open case, checking both', async (action) => {
    blobStatus = 'active';
    recordStatus = 'safe';
    const res = await check({ sha256: SHA, action, uploader: UPLOADER });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true, allowed: true, checked: true, sha256: SHA });
    expect(lookedUp()).toEqual([OWNER, UPLOADER]);
    expect(stateReads()).toHaveLength(0);
  });

  it('checks the account once when the uploader is the owner', async () => {
    const res = await check({ sha256: SHA, action: 'SAFE', uploader: OWNER });
    expect(res.status).toBe(200);
    expect(lookedUp()).toEqual([OWNER]);
  });

  it("answers as the owner, checking once, when the uploader is the owner and has an open case", async () => {
    openCase = { id: 'case-open', pubkey: OWNER, state: 'open_reported' };
    const res = await check({ sha256: SHA, action: 'SAFE', uploader: OWNER });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: 'age_review_active', caseId: 'case-open', error: OWNER_SAFE_ERROR });
    expect(lookedUp()).toEqual([OWNER]);
  });

  it("allows an AGE_RESTRICTED over a public file while the uploader's case has not restricted the account", async () => {
    blobStatus = 'active';
    recordStatus = 'safe';
    otherCases = [uploaderCase()];
    const res = await check({ sha256: SHA, action: 'AGE_RESTRICTED', uploader: UPLOADER });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true, allowed: true, checked: true, sha256: SHA });
    expect(stateReads()).toHaveLength(1);
  });

  it.each([
    ['the media server serves it restricted', 'restricted', 'safe', 0],
    ['the media server serves it banned', 'banned', 'safe', 0],
    ['the media server serves it deleted', 'deleted', 'safe', 0],
    ['the record shows QUARANTINE', 'active', 'quarantine', 1],
    ['the record shows PERMANENT_BAN', 'active', 'permanent_ban', 1],
    ['the record shows DELETE', 'active', 'delete', 1],
  ] as const)("refuses an AGE_RESTRICTED over a hidden file while the uploader has an open case: %s", async (_label, b, r, reads) => {
    blobStatus = b;
    recordStatus = r;
    otherCases = [uploaderCase()];
    const res = await check({ sha256: SHA, action: 'AGE_RESTRICTED', uploader: UPLOADER });
    expect(res.status).toBe(409);
    const body = await res.json() as { error: string };
    expect(body).toMatchObject({ success: false, code: 'age_review_active', caseId: 'case-uploader', state: 'open_reported' });
    expect(body.error).toBe("This file is withheld (hidden, blocked or deleted) and the account recorded as its uploader has an open age review, so it can't be put behind the 18+ gate, which would show it to adults. The case decides when it becomes public.");
    expect(stateReads()).toHaveLength(reads);
  });

  it.each(['restricted_pending_user_response', 'restricted_pending_parental_consent', 'restricted_pending_support_email'])(
    "refuses an AGE_RESTRICTED over a public file once the uploader's case is %s, without reading the record",
    async (state) => {
      blobStatus = 'active';
      recordStatus = 'safe';
      otherCases = [uploaderCase(state)];
      const res = await check({ sha256: SHA, action: 'AGE_RESTRICTED', uploader: UPLOADER });
      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({
        success: false,
        code: 'age_review_active',
        caseId: 'case-uploader',
        state,
        error: "The account recorded as this file's uploader is restricted by an open age review, so the file can't be put behind the 18+ gate, which would show it to adults. The case decides when it becomes public.",
      });
      expect(stateReads()).toHaveLength(0);
    },
  );

  it("refuses with 503 an AGE_RESTRICTED that needs the record for the uploader's case and cannot read it", async () => {
    blobStatus = 'active';
    recordStatus = 500;
    otherCases = [uploaderCase()];
    const res = await check({ sha256: SHA, action: 'AGE_RESTRICTED', uploader: UPLOADER });
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ success: false, code: 'state_unreadable' });
  });

  // As for the owner, this worker's credentials for moderation-service are
  // resolved only when the uploader's case makes the record worth reading.
  it('builds no credentials for a SAFE that the uploader does not refuse', async () => {
    const res = await check({ sha256: SHA, action: 'SAFE', uploader: UPLOADER }, { SERVICE_API_TOKEN: undefined });
    expect(res.status).toBe(200);
  });

  it("refuses with 503 an AGE_RESTRICTED that needs the record for the uploader's case while the credentials are not configured", async () => {
    blobStatus = 'active';
    recordStatus = 'safe';
    otherCases = [uploaderCase()];
    const res = await check({ sha256: SHA, action: 'AGE_RESTRICTED', uploader: UPLOADER }, { SERVICE_API_TOKEN: undefined });
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ success: false, code: 'state_unreadable' });
    expect(stateReads()).toHaveLength(0);
  });

  describe('when the owner and the uploader both have open cases', () => {
    beforeEach(() => {
      openCase = { id: 'case-owner', pubkey: OWNER, state: 'open_reported' };
      otherCases = [uploaderCase()];
    });

    it("answers a SAFE with the owner's refusal", async () => {
      const res = await check({ sha256: SHA, action: 'SAFE', uploader: UPLOADER });
      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({ code: 'age_review_active', caseId: 'case-owner', error: OWNER_SAFE_ERROR });
    });

    it("answers an AGE_RESTRICTED over a hidden file with the owner's refusal", async () => {
      blobStatus = 'restricted';
      const res = await check({ sha256: SHA, action: 'AGE_RESTRICTED', uploader: UPLOADER });
      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({ code: 'age_review_active', caseId: 'case-owner' });
    });

    it("answers with the owner's 503 when the owner's lookup cannot run", async () => {
      lookupThrowsFor = [OWNER];
      const res = await check({ sha256: SHA, action: 'SAFE', uploader: UPLOADER });
      expect(res.status).toBe(503);
      expect(await res.json()).toMatchObject({ code: 'age_review_check_failed' });
    });

    it('reads the record once for an AGE_RESTRICTED over a public file, and allows it', async () => {
      blobStatus = 'active';
      recordStatus = 'safe';
      const res = await check({ sha256: SHA, action: 'AGE_RESTRICTED', uploader: UPLOADER });
      expect(res.status).toBe(200);
      expect(lookedUp()).toEqual([OWNER, UPLOADER]);
      expect(stateReads()).toHaveLength(1);
    });

    it("refuses with the uploader's answer when only the uploader's case has restricted the account", async () => {
      blobStatus = 'active';
      recordStatus = 'safe';
      otherCases = [uploaderCase('restricted_pending_user_response')];
      const res = await check({ sha256: SHA, action: 'AGE_RESTRICTED', uploader: UPLOADER });
      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({ code: 'age_review_active', caseId: 'case-uploader', state: 'restricted_pending_user_response' });
      expect(stateReads()).toHaveLength(1);
    });
  });

  // /api/moderate-media names an account through `pubkey`, its account check;
  // `uploader` is the lift check's alone.
  it('is not read by /api/moderate-media, whose lift guard checks the owner', async () => {
    otherCases = [uploaderCase()];
    const res = await moderate({ sha256: SHA, action: 'SAFE', uploader: UPLOADER });
    expect(res.status).toBe(200);
    expect(lookedUp()).toEqual([OWNER]);
    expect(writes()).toHaveLength(1);
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
