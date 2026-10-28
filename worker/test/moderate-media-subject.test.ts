// The account check on /api/moderate-media (#299).
//
// A "still hidden" note's Restore sends SAFE with `from: 'QUARANTINE'` and the
// account the note belongs to. `from` alone cannot tell a stale note's file
// from one a newer age review is holding: both read QUARANTINE. So when the
// request names an account, the worker also refuses, before it writes:
//   - a pubkey that is not 64 lowercase hex;
//   - while that account has an open age review (fail-closed: a lookup that
//     cannot run refuses);
//   - unless the media server says that account owns the file (fail-closed);
//   - a SAFE over a file the media server shows blocked, deleted or behind the
//     18+ gate: the restore is for a hidden file, and SAFE would make any of
//     those public.
// A request without a pubkey is unchanged: none of this runs.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import worker from '../src/index';

const SHA = '5'.repeat(64);
const ACCOUNT = 'a1'.repeat(32);
const OTHER = 'b2'.repeat(32);

type Call = { url: string; method: string; body: unknown };
let calls: Call[];
let sqls: Array<{ sql: string; binds: unknown[] }>;
let openCase: Record<string, unknown> | null;
let lookupThrows: boolean;
let markThrows: boolean;
let blobOwner: string | number;
let blobStatus: string;
let blobReads: string[];

function moderationApi(status: string) {
  return {
    async fetch(request: Request): Promise<Response> {
      const url = new URL(request.url);
      const body = request.method === 'POST' ? await request.clone().json() : null;
      calls.push({ url: url.pathname, method: request.method, body });
      if (url.pathname.startsWith('/check-result/')) return Response.json({ sha256: SHA, status, moderated: true });
      if (url.pathname === '/api/v1/moderate') return Response.json({ success: true, sha256: SHA, action: 'SAFE' });
      return new Response('not found', { status: 404 });
    },
  };
}

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
      async run() {
        sqls.push({ sql, binds });
        if (/UPDATE bulk_job_notes/i.test(sql) && markThrows) throw new Error('D1 write failed');
        return { meta: { changes: 1 } };
      },
    };
    return stmt;
  },
};

function env(record = 'quarantine', extra: Record<string, unknown> = {}) {
  return {
    ADMIN_API_KEY: 'k',
    SERVICE_API_TOKEN: 'service-token',
    MODERATION_API: moderationApi(record),
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

const restore = (extra: Record<string, unknown> = {}) => ({ sha256: SHA, action: 'SAFE', from: 'QUARANTINE', pubkey: ACCOUNT, ...extra });
const writes = () => calls.filter((c) => c.url === '/api/v1/moderate');
const caseLookups = () => sqls.filter((s) => /FROM age_review_cases/i.test(s.sql));
const marks = () => sqls.filter((s) => /UPDATE bulk_job_notes/i.test(s.sql));

beforeEach(() => {
  calls = [];
  sqls = [];
  openCase = null;
  lookupThrows = false;
  markThrows = false;
  blobOwner = ACCOUNT;
  blobStatus = 'restricted';
  blobReads = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation((async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    if (url.host === 'media.example' && url.pathname.startsWith('/admin/api/blob/')) {
      blobReads.push(url.pathname.slice('/admin/api/blob/'.length));
      const auth = new Headers(init?.headers).get('Authorization');
      if (auth !== 'Bearer blossom-secret') return new Response('unauthorized', { status: 401 });
      if (typeof blobOwner === 'number') return new Response('err', { status: blobOwner });
      return Response.json({ sha256: SHA, type: 'video/mp4', owner: blobOwner, status: blobStatus });
    }
    return new Response('not found', { status: 404 });
  }) as typeof fetch);
});

afterEach(() => vi.restoreAllMocks());

describe('/api/moderate-media account check', () => {
  it('restores, and marks the file\'s still-hidden notes restored, when the account has no open review and owns the file', async () => {
    const res = await worker.fetch(post(restore()), env(), {} as ExecutionContext);
    expect(res.status).toBe(200);
    expect(writes()).toHaveLength(1);
    expect(caseLookups()[0].binds[0]).toBe(ACCOUNT);
    expect(blobReads).toEqual([SHA]);
    expect(marks()).toHaveLength(1);
    expect(marks()[0].binds).toEqual([expect.any(String), SHA]);
  });

  it.each(['A1'.repeat(32), ` ${ACCOUNT}`, 'a1'.repeat(31), 'npub1abc'])('refuses the pubkey %j, and checks nothing else', async (pubkey) => {
    const res = await worker.fetch(post(restore({ pubkey })), env(), {} as ExecutionContext);
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ success: false, code: 'invalid_pubkey' });
    expect(writes()).toHaveLength(0);
    expect(caseLookups()).toHaveLength(0);
  });

  it('refuses a hash that is not 64 hex when an account is named', async () => {
    const res = await worker.fetch(post(restore({ sha256: 'abc' })), env(), {} as ExecutionContext);
    expect(res.status).toBe(400);
    expect(writes()).toHaveLength(0);
  });

  // The owner read puts the hash in a path on the media server's admin API,
  // with its key attached: a crafted hash must never reach it, with or
  // without `from`.
  it('never reads the media server with a hash that is not 64 hex', async () => {
    const res = await worker.fetch(
      post({ sha256: `../user/${ACCOUNT}`, action: 'SAFE', pubkey: ACCOUNT }), env(), {} as ExecutionContext,
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: 'invalid_sha256' });
    expect(blobReads).toEqual([]);
    expect(writes()).toHaveLength(0);
  });

  it('marks notes restored only for a SAFE', async () => {
    const res = await worker.fetch(post({ sha256: SHA, action: 'QUARANTINE', pubkey: ACCOUNT }), env(), {} as ExecutionContext);
    expect(res.status).toBe(200);
    expect(writes()).toHaveLength(1);
    expect(marks()).toHaveLength(0);
  });

  it('refuses while the account has an open age review', async () => {
    openCase = { id: 'case-open', pubkey: ACCOUNT, state: 'restricted_pending_user_response' };
    const res = await worker.fetch(post(restore()), env(), {} as ExecutionContext);
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ success: false, code: 'age_review_active', caseId: 'case-open' });
    expect(writes()).toHaveLength(0);
    expect(marks()).toHaveLength(0);
  });

  it('refuses when the age-review lookup fails', async () => {
    lookupThrows = true;
    const res = await worker.fetch(post(restore()), env(), {} as ExecutionContext);
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ success: false, code: 'age_review_check_failed' });
    expect(writes()).toHaveLength(0);
  });

  it('refuses when there is no database to look the review up in', async () => {
    const res = await worker.fetch(post(restore()), env('quarantine', { DB: undefined }), {} as ExecutionContext);
    expect(res.status).toBe(503);
    expect(writes()).toHaveLength(0);
  });

  it('refuses when another account owns the file', async () => {
    blobOwner = OTHER;
    const res = await worker.fetch(post(restore()), env(), {} as ExecutionContext);
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ success: false, code: 'owner_mismatch' });
    expect(writes()).toHaveLength(0);
  });

  it.each([
    ['names an owner that is not a pubkey', () => { blobOwner = 'not-a-pubkey'; }, {}],
    ['answers 500', () => { blobOwner = 500; }, {}],
    ['answers 404', () => { blobOwner = 404; }, {}],
    ['has no key to ask with', () => {}, { BLOSSOM_WEBHOOK_SECRET: undefined }],
  ] as const)('refuses when the media server %s for the owner', async (_label, arrange, extra) => {
    arrange();
    const res = await worker.fetch(post(restore()), env('quarantine', extra), {} as ExecutionContext);
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ success: false, code: 'owner_unreadable' });
    expect(writes()).toHaveLength(0);
  });

  it('still refuses on `from` when the account checks pass, and marks nothing', async () => {
    const res = await worker.fetch(post(restore()), env('permanent_ban'), {} as ExecutionContext);
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: 'state_mismatch', current: 'PERMANENT_BAN' });
    expect(writes()).toHaveLength(0);
    expect(marks()).toHaveLength(0);
  });

  // The file is already public: the restore the note offered has happened, so
  // its notes are marked restored too, and a reload shows Restored. Only
  // after the account checks passed, only for SAFE found SAFE, and only when
  // the media server serves it too.
  it('marks the notes restored when it refuses because the file is already public', async () => {
    blobStatus = 'active';
    const res = await worker.fetch(post(restore()), env('safe'), {} as ExecutionContext);
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: 'state_mismatch', current: 'SAFE' });
    expect(writes()).toHaveLength(0);
    expect(marks()).toHaveLength(1);
    expect(marks()[0].binds).toEqual([expect.any(String), SHA]);
  });

  it('marks nothing on an already-public refusal for a request that named no account', async () => {
    const res = await worker.fetch(post({ sha256: SHA, action: 'SAFE', from: 'QUARANTINE' }), env('safe'), {} as ExecutionContext);
    expect(res.status).toBe(409);
    expect(marks()).toHaveLength(0);
  });

  it('marks nothing when a non-SAFE action finds the file public', async () => {
    const res = await worker.fetch(post({ sha256: SHA, action: 'QUARANTINE', from: 'PERMANENT_BAN', pubkey: ACCOUNT }), env('safe'), {} as ExecutionContext);
    expect(res.status).toBe(409);
    expect(marks()).toHaveLength(0);
  });

  // The notes store lowercase hashes: the already-public refusal marks the
  // lowercase hash for an uppercase request, as a landed restore does.
  it('marks an uppercase hash in lowercase when it refuses because the file is already public', async () => {
    blobStatus = 'active';
    const res = await worker.fetch(post(restore({ sha256: 'A'.repeat(64) })), env('safe'), {} as ExecutionContext);
    expect(res.status).toBe(409);
    expect(await res.json()).not.toHaveProperty('mediaServer');
    expect(writes()).toHaveLength(0);
    expect(marks()).toHaveLength(1);
    expect(marks()[0].binds[1]).toBe('a'.repeat(64));
  });

  // The record can say SAFE while the media server still hides the file (a
  // status set in its own admin UI, or a SAFE whose media-server call failed).
  // That file is not restored: no mark, and the refusal says what the media
  // server shows.
  it.each(['restricted', 'banned', 'age_restricted', 'deleted'])(
    'marks nothing when the record says public but the media server has the file %s, and says so',
    async (status) => {
      blobStatus = status;
      const res = await worker.fetch(post(restore()), env('safe'), {} as ExecutionContext);
      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({ code: 'state_mismatch', current: 'SAFE', mediaServer: status });
      expect(writes()).toHaveLength(0);
      expect(marks()).toHaveLength(0);
    },
  );

  it('says nothing about the media server on a refusal that does not find the record public', async () => {
    const res = await worker.fetch(post(restore()), env('permanent_ban'), {} as ExecutionContext);
    expect(await res.json()).not.toHaveProperty('mediaServer');
  });

  // The moderation record is keyed case-sensitively: once an account is named,
  // the owner read, the write and the mark all use the one lowercase hash.
  it.each([
    ['with', { from: 'QUARANTINE' }],
    ['without', {}],
  ])('reads, writes and marks an uppercase hash in lowercase, %s `from`', async (_label, extra) => {
    const res = await worker.fetch(
      post({ sha256: 'A'.repeat(64), action: 'SAFE', pubkey: ACCOUNT, ...extra }), env(), {} as ExecutionContext,
    );
    expect(res.status).toBe(200);
    expect(blobReads).toEqual(['a'.repeat(64)]);
    expect((writes()[0].body as { sha256: string }).sha256).toBe('a'.repeat(64));
    expect(marks()[0].binds[1]).toBe('a'.repeat(64));
  });

  it('still answers the already-public refusal when marking fails', async () => {
    blobStatus = 'active';
    markThrows = true;
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await worker.fetch(post(restore()), env('safe'), {} as ExecutionContext);
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: 'state_mismatch', current: 'SAFE' });
    expect(errors).toHaveBeenCalled();
  });

  it('restores even when marking the notes fails', async () => {
    markThrows = true;
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await worker.fetch(post(restore()), env(), {} as ExecutionContext);
    expect(res.status).toBe(200);
    expect(writes()).toHaveLength(1);
    expect(errors).toHaveBeenCalled();
  });

  // Restore is for a file the withhold hid. The media server's own admin can
  // block, delete or 18+-gate it later without telling moderation-service, so
  // the record still reads QUARANTINE and `from` passes; SAFE would then make
  // the file public. The status the owner check already read refuses it.
  it.each([
    ['banned', { from: 'QUARANTINE' }],
    ['deleted', { from: 'QUARANTINE' }],
    ['age_restricted', { from: 'QUARANTINE' }],
    ['banned', {}],
  ] as const)('refuses a SAFE over a file the media server has %s, %j, and marks nothing', async (status, extra) => {
    blobStatus = status;
    const res = await worker.fetch(post({ sha256: SHA, action: 'SAFE', pubkey: ACCOUNT, ...extra }), env(), {} as ExecutionContext);
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ success: false, code: 'media_server_state', mediaServer: status });
    expect(writes()).toHaveLength(0);
    expect(marks()).toHaveLength(0);
  });

  it.each(['restricted', 'active', 'pending'])('restores a file the media server has %s', async (status) => {
    blobStatus = status;
    const res = await worker.fetch(post(restore()), env(), {} as ExecutionContext);
    expect(res.status).toBe(200);
    expect(writes()).toHaveLength(1);
    expect(marks()).toHaveLength(1);
  });

  it('leaves an action other than SAFE to the media server state it finds', async () => {
    blobStatus = 'banned';
    const res = await worker.fetch(post({ sha256: SHA, action: 'QUARANTINE', pubkey: ACCOUNT }), env(), {} as ExecutionContext);
    expect(res.status).toBe(200);
    expect(writes()).toHaveLength(1);
  });

  it('checks no account, reads no owner and marks no notes when the request names no account', async () => {
    const res = await worker.fetch(post({ sha256: SHA, action: 'SAFE', from: 'QUARANTINE' }), env(), {} as ExecutionContext);
    expect(res.status).toBe(200);
    expect(writes()).toHaveLength(1);
    expect(caseLookups()).toHaveLength(0);
    expect(blobReads).toEqual([]);
    expect(marks()).toHaveLength(0);
  });
});
