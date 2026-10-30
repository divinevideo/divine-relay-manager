// The age-review lift guard on /api/moderate-media (#335).
//
// A file whose owner has an open age review is only made public (SAFE), or a
// file it hides put behind the 18+ gate (AGE_RESTRICTED; once the case has
// restricted the account, any file), through that case, whoever sends the
// request. The guard does not wait for the caller
// to name the account (#333's opt-in check): it reads the file's owner from the
// media server and runs the age-review guard on that owner, fail-closed.
//   - Hash not 64 hex: 400, and the media server is never asked.
//   - The media server has no record of the file (404): 409, not "try again".
//   - The owner cannot be read: 503.
//   - The owner has an open case: 409, naming it. The lookup cannot run: 503.
// Actions that make nothing more visible skip it and read nothing.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import worker from '../src/index';

const SHA = '5'.repeat(64);
const OWNER = 'a1'.repeat(32);

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

function post(body: Record<string, unknown>) {
  return new Request('https://relay.example/api/moderate-media', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Admin-Key': 'k' },
    body: JSON.stringify(body),
  });
}

const send = (body: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
  worker.fetch(post(body), env(extra), {} as ExecutionContext);
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

describe('/api/moderate-media age-review lift guard: SAFE', () => {
  it("refuses a SAFE while the file's owner has an open age review, though the request names no account", async () => {
    openCase = { id: 'case-open', pubkey: OWNER, state: 'restricted_pending_user_response' };
    const res = await send({ sha256: SHA, action: 'SAFE', reason: 'Unblocked' });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({
      success: false,
      code: 'age_review_active',
      caseId: 'case-open',
      error: 'The account that owns this file has an open age review, so its files can only be made public through that case.',
    });
    expect(caseLookups()[0].binds[0]).toBe(OWNER);
    expect(writes()).toHaveLength(0);
  });

  // moderation-service uppercases the action before it validates and writes it,
  // so a lowercase SAFE is a SAFE.
  it.each(['safe', 'Safe'])('refuses a SAFE sent as %j during an open case', async (action) => {
    openCase = { id: 'case-open', pubkey: OWNER, state: 'open_reported' };
    const res = await send({ sha256: SHA, action });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: 'age_review_active', caseId: 'case-open' });
    expect(writes()).toHaveLength(0);
  });

  // The guard reads only a string action. Anything else is refused here, so
  // its safety never rests on moderation-service rejecting it.
  it.each([[['SAFE']], [{ toString: 'SAFE' }], [1]])('refuses the action %j before reading or writing anything', async (action) => {
    openCase = { id: 'case-open', pubkey: OWNER, state: 'open_reported' };
    const res = await send({ sha256: SHA, action });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ success: false, code: 'invalid_action' });
    expect(blobReads).toEqual([]);
    expect(writes()).toHaveLength(0);
  });

  // Unlike an AGE_RESTRICTED, a SAFE is refused over a public file too: it
  // also clears the relay's quarantine for the event.
  it('refuses a SAFE over a file both sources show public during an open case', async () => {
    blobStatus = 'active';
    recordStatus = 'safe';
    openCase = { id: 'case-open', pubkey: OWNER, state: 'open_reported' };
    const res = await send({ sha256: SHA, action: 'SAFE' });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: 'age_review_active', caseId: 'case-open' });
    expect(writes()).toHaveLength(0);
  });

  it('refuses before it reads the expected state, so `from` cannot carry a SAFE past it', async () => {
    openCase = { id: 'case-open', pubkey: OWNER, state: 'open_reported' };
    const res = await send({ sha256: SHA, action: 'SAFE', from: 'PERMANENT_BAN' });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: 'age_review_active' });
    expect(stateReads()).toHaveLength(0);
    expect(writes()).toHaveLength(0);
  });

  // An Unblock is a SAFE over a blocked file. With no open case it goes
  // through: #333's "Restore only a hidden file" rule is for a named account.
  it.each(['banned', 'restricted', 'age_restricted', 'deleted', 'active'])(
    'lets a SAFE through over a file the media server has %s when the owner has no open case',
    async (status) => {
      blobStatus = status;
      const res = await send({ sha256: SHA, action: 'SAFE' });
      expect(res.status).toBe(200);
      expect(blobReads).toEqual([SHA]);
      expect(caseLookups()).toHaveLength(1);
      expect(writes()).toHaveLength(1);
    },
  );

  // The guard checks the lowercase hash, so the write must use it too: the
  // moderation record is keyed case-sensitively.
  it('checks and writes an uppercase hash in lowercase', async () => {
    const res = await send({ sha256: 'A'.repeat(64), action: 'SAFE' });
    expect(res.status).toBe(200);
    expect(blobReads).toEqual(['a'.repeat(64)]);
    expect((writes()[0].body as { sha256: string }).sha256).toBe('a'.repeat(64));
  });

  it.each(['abc', `../user/${OWNER}`, 'g'.repeat(64)])('refuses the hash %j, and never asks the media server', async (sha256) => {
    const res = await send({ sha256, action: 'SAFE' });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ success: false, code: 'invalid_sha256' });
    expect(blobReads).toEqual([]);
    expect(writes()).toHaveLength(0);
  });

  it('refuses as non-retryable when the media server has no record of the file', async () => {
    blobOwner = 404;
    const res = await send({ sha256: SHA, action: 'SAFE' });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({
      success: false,
      code: 'media_record_missing',
      error: "The media server has no record of this file, so it can't be checked for an open age review; nothing was changed.",
    });
    expect(caseLookups()).toHaveLength(0);
    expect(writes()).toHaveLength(0);
  });

  it.each([
    ['answers 500', () => { blobOwner = 500; }, {}],
    ['answers 401', () => {}, { BLOSSOM_WEBHOOK_SECRET: 'wrong' }],
    ['names an owner that is not a pubkey', () => { blobOwner = 'not-a-pubkey'; }, {}],
    ['answers a status this worker does not know', () => { blobStatus = 'quarantined'; }, {}],
    ['has no key to ask with', () => {}, { BLOSSOM_WEBHOOK_SECRET: undefined }],
  ] as const)('refuses with 503 when the media server %s', async (_label, arrange, extra) => {
    arrange();
    const res = await send({ sha256: SHA, action: 'SAFE' }, extra);
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ success: false, code: 'owner_unreadable' });
    expect(caseLookups()).toHaveLength(0);
    expect(writes()).toHaveLength(0);
  });

  it('refuses with 503 when the age-review lookup fails', async () => {
    lookupThrows = true;
    const res = await send({ sha256: SHA, action: 'SAFE' });
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ success: false, code: 'age_review_check_failed' });
    expect(writes()).toHaveLength(0);
  });

  it('refuses with 503 when there is no database to look the review up in', async () => {
    const res = await send({ sha256: SHA, action: 'SAFE' }, { DB: undefined });
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ success: false, code: 'age_review_check_failed' });
    expect(writes()).toHaveLength(0);
  });

  // #333's account check already read the owner and ran the guard on it.
  it('does not repeat the owner read or the case lookup when the request names the account', async () => {
    blobStatus = 'restricted';
    const res = await send({ sha256: SHA, action: 'SAFE', pubkey: OWNER });
    expect(res.status).toBe(200);
    expect(blobReads).toEqual([SHA]);
    expect(caseLookups()).toHaveLength(1);
  });
});

// An AGE_RESTRICTED lifts a file that is hidden, blocked or deleted: the 18+
// gate shows it to signed-in adults, and it clears the relay's quarantine. On
// a public file it only tightens, and goes through during a case that has not
// restricted the account: such a case hides nothing yet, and refusing would
// leave the file fully public. Hidden is read from the media server and,
// because its status is cached for up to 5 minutes, from moderation-service's
// record too, which the case's withhold writes at once. Both are consulted
// only while the owner has an open case, and the record is read only then (the
// media server is read every time, for the owner). Once the case has restricted
// the account, every AGE_RESTRICTED is refused.
describe('/api/moderate-media age-review lift guard: AGE_RESTRICTED', () => {
  // A case that has not restricted the account: the withhold has not run, so
  // whether the file is hidden decides.
  const OPEN = { id: 'case-open', pubkey: OWNER, state: 'open_reported' };
  const AGE_GATE_RESTRICTED = "This file's owner is restricted by an open age review, so its files can't be put behind the 18+ gate, which would show them to adults. The case decides when they become public.";
  const AGE_GATE_HIDDEN = "This file is withheld (hidden, blocked or deleted) and its owner has an open age review, so it can't be put behind the 18+ gate, which would show it to adults. The case decides when it becomes public.";

  it.each(['restricted', 'banned', 'deleted'])(
    "refuses an AGE_RESTRICTED over a file the media server has %s while the owner's case is open",
    async (status) => {
      blobStatus = status;
      recordStatus = 'safe';
      openCase = OPEN;
      const res = await send({ sha256: SHA, action: 'AGE_RESTRICTED' });
      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({ success: false, code: 'age_review_active', caseId: 'case-open', error: AGE_GATE_HIDDEN });
      expect(caseLookups()[0].binds[0]).toBe(OWNER);
      expect(writes()).toHaveLength(0);
    },
  );

  // The media server's cached status can still read public, or 18+ gated,
  // right after the withhold; the record cannot.
  it.each(['active', 'pending', 'age_restricted'].flatMap((status) =>
    ['quarantine', 'permanent_ban', 'delete'].map((record) => [status, record])))(
    'refuses an AGE_RESTRICTED over a file the media server shows %s when the record says %s, during an open case',
    async (status, record) => {
      blobStatus = status;
      recordStatus = record;
      openCase = OPEN;
      const res = await send({ sha256: SHA, action: 'AGE_RESTRICTED' });
      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({ code: 'age_review_active', caseId: 'case-open', error: AGE_GATE_HIDDEN });
      expect(stateReads()).toEqual([expect.objectContaining({ url: `/check-result/${SHA}` })]);
      expect(writes()).toHaveLength(0);
    },
  );

  it.each([
    ['active', 'safe'],
    ['active', 'unknown'],
    ['pending', 'review'],
    ['age_restricted', 'age_restricted'],
  ])('lets an AGE_RESTRICTED through during an open case when the media server has the file %s and the record says %s', async (status, record) => {
    blobStatus = status;
    recordStatus = record;
    openCase = OPEN;
    const res = await send({ sha256: SHA, action: 'AGE_RESTRICTED' });
    expect(res.status).toBe(200);
    expect((writes()[0].body as { action: string }).action).toBe('AGE_RESTRICTED');
  });

  // Once the case restricts the account, the withhold has hidden its files,
  // and for up to 5 minutes after it the media server can still read them
  // public. A REVIEW from any caller rewrites the record without hiding
  // anything, so in that window neither source can be trusted to say hidden.
  // Every AGE_RESTRICTED is refused while the case is restricted.
  it.each(['restricted_pending_user_response', 'restricted_pending_parental_consent', 'restricted_pending_support_email'])(
    'refuses an AGE_RESTRICTED over a file both sources show public while the case is %s',
    async (state) => {
      blobStatus = 'active';
      recordStatus = 'review';
      openCase = { ...OPEN, state };
      const res = await send({ sha256: SHA, action: 'AGE_RESTRICTED' });
      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({ code: 'age_review_active', caseId: 'case-open', state, error: AGE_GATE_RESTRICTED });
      expect(stateReads()).toHaveLength(0);
      expect(writes()).toHaveLength(0);
    },
  );

  // A case can reach these without ever restricting the account, so they
  // say nothing about the withhold: whether the file is hidden decides.
  it.each(['under_moderator_review', 'submitted_for_review', 'needs_follow_up'])(
    'lets an AGE_RESTRICTED through over a file both sources show public while the case is %s',
    async (state) => {
      blobStatus = 'active';
      recordStatus = 'safe';
      openCase = { ...OPEN, state };
      const res = await send({ sha256: SHA, action: 'AGE_RESTRICTED' });
      expect(res.status).toBe(200);
      expect(writes()).toHaveLength(1);
    },
  );

  it.each([500, 400])('refuses with 503 when the record cannot be read (%i) during an open case', async (code) => {
    blobStatus = 'active';
    recordStatus = code;
    openCase = OPEN;
    const res = await send({ sha256: SHA, action: 'AGE_RESTRICTED' });
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ success: false, code: 'state_unreadable' });
    expect(writes()).toHaveLength(0);
  });

  it('does not read the record when the media server already shows the file hidden', async () => {
    blobStatus = 'restricted';
    openCase = OPEN;
    await send({ sha256: SHA, action: 'AGE_RESTRICTED' });
    expect(stateReads()).toHaveLength(0);
  });

  it.each(['age_restricted', 'Age_Restricted'])('refuses an AGE_RESTRICTED sent as %j over a hidden file during an open case', async (action) => {
    blobStatus = 'restricted';
    openCase = OPEN;
    const res = await send({ sha256: SHA, action });
    expect(res.status).toBe(409);
    expect(writes()).toHaveLength(0);
  });

  it('lets an AGE_RESTRICTED through when the owner has no open case, reads no record, and writes the lowercase hash', async () => {
    blobStatus = 'restricted';
    const res = await send({ sha256: 'A'.repeat(64), action: 'AGE_RESTRICTED' });
    expect(res.status).toBe(200);
    expect(blobReads).toEqual(['a'.repeat(64)]);
    expect(stateReads()).toHaveLength(0);
    expect((writes()[0].body as { sha256: string; action: string })).toMatchObject({ sha256: 'a'.repeat(64), action: 'AGE_RESTRICTED' });
  });

  it('refuses an AGE_RESTRICTED as non-retryable when the media server has no record of the file', async () => {
    blobOwner = 404;
    const res = await send({ sha256: SHA, action: 'AGE_RESTRICTED' });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: 'media_record_missing' });
    expect(writes()).toHaveLength(0);
  });

  it('refuses an AGE_RESTRICTED with 503 when the owner cannot be read', async () => {
    blobOwner = 500;
    const res = await send({ sha256: SHA, action: 'AGE_RESTRICTED' });
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ code: 'owner_unreadable' });
    expect(writes()).toHaveLength(0);
  });

  it('refuses an AGE_RESTRICTED with 503 when the age-review lookup fails', async () => {
    blobStatus = 'active';
    recordStatus = 'safe';
    lookupThrows = true;
    const res = await send({ sha256: SHA, action: 'AGE_RESTRICTED' });
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ code: 'age_review_check_failed' });
    expect(writes()).toHaveLength(0);
  });

  it('refuses an AGE_RESTRICTED whose hash is not 64 hex, and never asks the media server', async () => {
    const res = await send({ sha256: `../user/${OWNER}`, action: 'AGE_RESTRICTED' });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: 'invalid_sha256' });
    expect(blobReads).toEqual([]);
  });
});

describe('/api/moderate-media age-review lift guard: actions that make nothing more visible', () => {
  it.each(['PERMANENT_BAN', 'QUARANTINE', 'DELETE', 'REVIEW'])(
    'lets a %s through during an open case, reading neither the owner nor the case',
    async (action) => {
      openCase = { id: 'case-open', pubkey: OWNER, state: 'open_reported' };
      const res = await send({ sha256: SHA, action });
      expect(res.status).toBe(200);
      expect(blobReads).toEqual([]);
      expect(caseLookups()).toHaveLength(0);
      expect(writes()).toHaveLength(1);
    },
  );
});
