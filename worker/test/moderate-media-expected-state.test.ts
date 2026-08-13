// The expected-state check on /api/moderate-media.
//
// The endpoint is a state SETTER, not a transition: `SAFE` means "make this blob
// Active", not "undo the age-restriction I applied". So any caller can move any
// blob from any state to any other one, and the intent is lost -- nothing
// distinguishes a moderator reversing their own age-restrict from one clearing an
// age-review quarantine on a minor's content. They are the same request.
//
// That is not theoretical. Age review hides a minor's media with QUARANTINE and
// clears it with SAFE (worker/src/bulk-moderate.ts), and its own comment says
// AGE_RESTRICTED must NOT be used for a minor because it serves full bytes to any
// signed-in viewer. COOP's Un-Restrict-Media button also sends SAFE. relay-manager
// refuses this class of reversal elsewhere -- ageReviewActiveGuard returns 409
// age_review_active for unbanpubkey/unsuspendpubkey -- but that guard is
// pubkey-keyed and this endpoint is hash-keyed, so it was never wired here.
//
// `from` lets a caller declare what it believes it is undoing. A mismatch is
// refused, so the button can only reverse the thing it is named for.
//
// Status codes follow the convention age-review.ts already sets: 409 when there IS
// a conflicting state, 503 when we could not determine one, because "could not
// check" is a different answer from "no conflict" and must not read as success.
import { describe, it, expect, beforeEach } from 'vitest';
import worker from '../src/index';

const SHA = 'dd44' + '0'.repeat(59) + '4';

type Call = { url: string; method: string; body: unknown };

let calls: Call[];

/**
 * Stands in for moderation-service. `status` is what check-result reports.
 *
 * The two failure options are deliberately different shapes, because the real
 * handler produces both and only one of them exercises the status check.
 * `checkFails` returns a non-JSON body, so `.json()` throws on its own;
 * `checkRejects` returns a well-formed JSON error, which parses fine and is
 * caught only by an explicit look at `response.ok`. See the test below.
 */
function moderationApi(
  status: string | null,
  opts: { checkFails?: boolean; checkRejects?: boolean; checkOmitsStatus?: boolean } = {},
) {
  return {
    async fetch(request: Request): Promise<Response> {
      const url = new URL(request.url);
      let body: unknown = null;
      if (request.method === 'POST') {
        try {
          body = await request.clone().json();
        } catch {
          body = null;
        }
      }
      calls.push({ url: url.pathname, method: request.method, body });

      if (url.pathname.startsWith('/check-result/')) {
        if (opts.checkFails) return new Response('upstream down', { status: 500 });
        // Copied from handlePublicCheckResult in divine-moderation-service
        // (src/index.mjs:1494) -- a rejected sha256 answers 400 with this exact
        // body. A fake that only ever fails with unparseable text would let a
        // regression through; see the test that uses this.
        if (opts.checkRejects) return Response.json({ error: 'Invalid sha256' }, { status: 400 });
        // A 200 that carries no `status` at all. handlePublicCheckResult never
        // does this, which is the point: it models the contract having moved.
        if (opts.checkOmitsStatus) return Response.json({ sha256: SHA, moderated: true });

        // Answer for the REQUESTED hash, not unconditionally. A fake that
        // returns the same state for every path lets the read target the wrong
        // blob -- or a constant -- with the suite still green, which is the one
        // mutation that matters most here.
        //
        // Lowercased on the way in because that is what moderation-service does
        // before its SELECT (src/index.mjs:1497), so this models a case-folding
        // read over a case-SENSITIVE table.
        const requested = decodeURIComponent(url.pathname.slice('/check-result/'.length)).toLowerCase();
        if (requested !== SHA) {
          return Response.json({ sha256: requested, status: 'unknown', moderated: false });
        }
        if (status === null) {
          return Response.json({ sha256: SHA, status: 'unknown', moderated: false });
        }
        return Response.json({ sha256: SHA, status, moderated: true });
      }
      if (url.pathname === '/api/v1/moderate') {
        return Response.json({ success: true, sha256: SHA, action: 'SAFE' });
      }
      return new Response('not found', { status: 404 });
    },
  };
}

function env(api: ReturnType<typeof moderationApi>) {
  return {
    ADMIN_API_KEY: 'k',
    // handleModerateMedia requires one of SERVICE_API_TOKEN or CF Access creds
    // before it will proxy anything; without it every case 500s on auth and the
    // assertions below would be measuring the harness, not the feature.
    SERVICE_API_TOKEN: 'service-token',
    MODERATION_API: api,
    MODERATION_SERVICE_URL: 'https://moderation.example',
    MODERATION_ADMIN_URL: 'https://moderation.example',
  } as unknown as Parameters<typeof worker.fetch>[1];
}

function post(body: Record<string, unknown>) {
  return new Request('https://relay.example/api/moderate-media', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Admin-Key': 'k' },
    body: JSON.stringify(body),
  });
}

const moderateCalls = () => calls.filter((c) => c.url === '/api/v1/moderate');

beforeEach(() => {
  calls = [];
});

describe('/api/moderate-media expected-state check', () => {
  it('refuses to clear a state the caller did not expect, and does not act', async () => {
    // The scenario that matters: media is QUARANTINE because its owner is under
    // age review. COOP's Un-Restrict-Media expects to be undoing an age-restrict.
    const res = await worker.fetch(
      post({ sha256: SHA, action: 'SAFE', from: 'AGE_RESTRICTED' }),
      env(moderationApi('quarantine')),
      {} as ExecutionContext,
    );

    expect(res.status).toBe(409);
    const payload = (await res.json()) as { success: boolean; error: string; from?: string; current?: string };
    expect(payload.success).toBe(false);
    // The error has to name BOTH states, or an operator cannot tell this apart
    // from any other 409 and will retry it.
    expect(payload.current).toBe('QUARANTINE');
    expect(payload.from).toBe('AGE_RESTRICTED');
    // The whole point: nothing was changed.
    expect(moderateCalls()).toHaveLength(0);
  });

  it('proceeds when the current state is the one the caller expected', async () => {
    const res = await worker.fetch(
      post({ sha256: SHA, action: 'SAFE', from: 'AGE_RESTRICTED' }),
      env(moderationApi('age_restricted')),
      {} as ExecutionContext,
    );

    expect(res.status).toBe(200);
    expect(moderateCalls()).toHaveLength(1);
    expect((moderateCalls()[0].body as { action: string }).action).toBe('SAFE');
  });

  it('refuses when nothing has been moderated at all', async () => {
    // `from` says "undo the age-restrict"; there is no moderation to undo. Letting
    // this through would set Active on a blob no one had acted on.
    const res = await worker.fetch(
      post({ sha256: SHA, action: 'SAFE', from: 'AGE_RESTRICTED' }),
      env(moderationApi(null)),
      {} as ExecutionContext,
    );

    expect(res.status).toBe(409);
    expect(moderateCalls()).toHaveLength(0);
  });

  it('fails closed when the current state cannot be read', async () => {
    // 503, not 409, and not success: "could not check" is a different answer from
    // "no conflict". Same reasoning as ageReviewActiveGuard's failClosed.
    const res = await worker.fetch(
      post({ sha256: SHA, action: 'SAFE', from: 'AGE_RESTRICTED' }),
      env(moderationApi('age_restricted', { checkFails: true })),
      {} as ExecutionContext,
    );

    expect(res.status).toBe(503);
    expect(moderateCalls()).toHaveLength(0);
  });

  it('treats a non-ok check-result as unreadable even when its body is valid JSON', async () => {
    // The sibling test above fails closed for the wrong reason: its 500 carries
    // unparseable text, so `.json()` throws whether or not the code inspects the
    // status. Deleting the `!checkResponse.ok` guard leaves that test green.
    //
    // moderation-service answers a rejected sha256 with 400 AND a well-formed
    // JSON body (handlePublicCheckResult, src/index.mjs:1494). That parses
    // cleanly, `status` comes back undefined, and the state would read as
    // 'UNKNOWN' -- so the caller would be told "nothing has been moderated"
    // when what actually happened is the request was refused. Same class of
    // mistake as answering 409 for an unreadable state: an operator reads it as
    // information about the blob rather than about the failure.
    const res = await worker.fetch(
      post({ sha256: SHA, action: 'SAFE', from: 'AGE_RESTRICTED' }),
      env(moderationApi('age_restricted', { checkRejects: true })),
      {} as ExecutionContext,
    );

    expect(res.status).toBe(503);
    const payload = (await res.json()) as { code?: string; current?: string };
    expect(payload.code).toBe('state_unreadable');
    // Must NOT report a current state: there isn't one, and naming a fictional
    // 'UNKNOWN' here is the exact confusion this test exists to prevent.
    expect(payload.current).toBeUndefined();
    expect(moderateCalls()).toHaveLength(0);
  });

  it('refuses an empty `from` rather than silently skipping the check', async () => {
    // `if (body.from)` treats '' as absent, so a caller whose `from` came out
    // empty -- an unmapped action name, a template that rendered nothing -- gets
    // the OLD unguarded behaviour and a 200. Silently downgrading a guard is the
    // worst available outcome on this path: the caller believes it asked for
    // the check and is told it succeeded.
    //
    // Omitting the field means "no check" and stays supported.
    // Sending it empty or JSON null means the caller tried to declare a state
    // and failed to, which is a bug in the caller and must be visible to it.
    // Whitespace-only counts as empty for the same reason: it is what a caller
    // produces by accident, never on purpose.
    for (const empty of ['', '   ', '\t\n', null]) {
      calls = [];
      const res = await worker.fetch(
        post({ sha256: SHA, action: 'SAFE', from: empty }),
        env(moderationApi('quarantine')),
        {} as ExecutionContext,
      );

      expect(res.status, `from=${JSON.stringify(empty)}`).toBe(400);
      expect(((await res.json()) as { code?: string }).code).toBe('invalid_from');
      expect(moderateCalls(), `from=${JSON.stringify(empty)}`).toHaveLength(0);
    }
  });

  it('refuses a non-string `from` with 400 rather than a 500', async () => {
    // A number/array/object reaches `body.from.toUpperCase()` and throws, which
    // the outer handler turns into a 500 carrying the raw TypeError text
    // ("body.from.toUpperCase is not a function"). It does fail closed, so this
    // is about the answer being wrong and useless rather than unsafe: 500 tells
    // the caller to retry an identical request that cannot ever succeed, and
    // leaks an internal detail while doing it.
    for (const bad of [123, ['AGE_RESTRICTED'], { state: 'AGE_RESTRICTED' }, true]) {
      calls = [];
      const res = await worker.fetch(
        post({ sha256: SHA, action: 'SAFE', from: bad }),
        env(moderationApi('quarantine')),
        {} as ExecutionContext,
      );

      expect(res.status, `from=${JSON.stringify(bad)}`).toBe(400);
      const payload = (await res.json()) as { code?: string; error?: string };
      expect(payload.code, `from=${JSON.stringify(bad)}`).toBe('invalid_from');
      expect(payload.error).not.toContain('toUpperCase');
      expect(moderateCalls(), `from=${JSON.stringify(bad)}`).toHaveLength(0);
    }
  });

  it('refuses a sha256 that is not a hash, rather than reading whatever path it names', async () => {
    // `sha256` is interpolated into the state-read URL, and the URL constructor
    // resolves `..` before the request is sent. So a sha256 of
    // '../../api/v1/decisions' does not read /check-result/ at all -- it reads
    // moderation-service's admin decisions endpoint, carrying relay-manager's
    // service token, and whatever `status` that response happens to have is what
    // the guard compares against.
    //
    // Two things go wrong at once: a GET to an arbitrary upstream path with our
    // credentials, and a comparison satisfied by an endpoint that has nothing to
    // do with the blob.
    //
    // Neither is a bypass -- `from` is optional, so a caller wanting no check
    // omits it. The cost is the credentialed GET, and a caller being told it
    // verified state when it read something unrelated.
    //
    // Checked only on this path. The POST body's sha256 is forwarded to
    // moderation-service, which validates it itself (handlePublicCheckResult and
    // its siblings), so callers that send no `from` keep working exactly as
    // before and nothing here narrows what they may send.
    const traversals = [
      '../../api/v1/decisions',
      '..%2F..%2Fapi%2Fv1%2Fdecisions',
      'not-a-hash',
      SHA + '/../../api/v1/decisions',
      SHA.slice(0, 63),
      SHA + 'f',
      // RegExp.test stringifies its argument, so [SHA] looks like a hash and
      // then body.sha256.toLowerCase throws. Must be 400, not a 500 TypeError.
      [SHA],
      123,
    ];
    for (const sha256 of traversals) {
      calls = [];
      const res = await worker.fetch(
        post({ sha256, action: 'SAFE', from: 'AGE_RESTRICTED' }),
        env(moderationApi('age_restricted')),
        {} as ExecutionContext,
      );

      expect(res.status, `sha256=${sha256}`).toBe(400);
      expect(((await res.json()) as { code?: string }).code).toBe('invalid_sha256');
      // Nothing upstream was contacted at all: not the state read, not the write.
      expect(calls, `sha256=${sha256}`).toHaveLength(0);
    }
  });

  it('reads the state of the blob it is about to write, not some other one', async () => {
    // Without this, replacing the interpolated hash with a constant leaves every
    // other test green: nothing else looks at which path the read went to. A
    // refactor that threads the wrong variable in here would compare an
    // unrelated blob's state and the guard would still report success.
    const res = await worker.fetch(
      post({ sha256: SHA, action: 'SAFE', from: 'AGE_RESTRICTED' }),
      env(moderationApi('age_restricted')),
      {} as ExecutionContext,
    );

    expect(res.status).toBe(200);
    const reads = calls.filter((c) => c.url.startsWith('/check-result/'));
    expect(reads).toHaveLength(1);
    expect(reads[0].url).toBe(`/check-result/${SHA}`);
  });

  it('verifies and writes the same row when the hash arrives uppercased', async () => {
    // moderation-service lowercases before its SELECT (src/index.mjs:1497) but
    // /api/v1/moderate binds sha256 RAW into `INSERT ... ON CONFLICT(sha256)`,
    // and the column is `sha256 TEXT PRIMARY KEY` with no COLLATE NOCASE, so
    // BINARY collation makes an uppercase hash a different key.
    //
    // Unnormalised, the guard reads row dd44... and the write lands on row
    // DD44... -- it reports "verified" for a record it did not touch. Concretely:
    // a QUARANTINE written with an uppercase hash leaves the lowercase row still
    // saying AGE_RESTRICTED, so Un-Restrict-Media passes its check against the
    // stale row and clears the restriction anyway. That is the reversal this
    // whole change exists to refuse.
    const res = await worker.fetch(
      post({ sha256: SHA.toUpperCase(), action: 'SAFE', from: 'AGE_RESTRICTED' }),
      env(moderationApi('age_restricted')),
      {} as ExecutionContext,
    );

    expect(res.status).toBe(200);
    // Both hops must name the same, canonical row.
    const reads = calls.filter((c) => c.url.startsWith('/check-result/'));
    expect(reads[0].url).toBe(`/check-result/${SHA}`);
    expect((moderateCalls()[0].body as { sha256: string }).sha256).toBe(SHA);
  });

  it('answers 503 when the moderation URL is unconfigured, not 500', async () => {
    // getModerationServiceUrl throws when MODERATION_SERVICE_URL is missing. If
    // that throw happens outside the guard's try, the caller gets a 500 naming an
    // internal binding instead of the 503 this block otherwise commits to -- and
    // "misconfigured" is exactly the "could not check" case the fail-closed
    // reasoning says must be retryable and must not read as success.
    const broken = env(moderationApi('age_restricted')) as unknown as Record<string, unknown>;
    delete broken.MODERATION_SERVICE_URL;

    const res = await worker.fetch(
      post({ sha256: SHA, action: 'SAFE', from: 'AGE_RESTRICTED' }),
      broken as Parameters<typeof worker.fetch>[1],
      {} as ExecutionContext,
    );

    expect(res.status).toBe(503);
    const payload = (await res.json()) as { code?: string; error?: string };
    expect(payload.code).toBe('state_unreadable');
    // Must not name the binding: that is internal detail, and it tells the caller
    // nothing it can act on.
    expect(payload.error).not.toContain('MODERATION_SERVICE_URL');
    expect(moderateCalls()).toHaveLength(0);
  });

  it('treats a response with no `status` as unreadable, not as "nothing moderated"', async () => {
    // handlePublicCheckResult always emits `status` -- 'unknown' when there is no
    // row, the lowercased action when there is (src/index.mjs:1508, :1520). So a
    // 200 that omits the field is not a blob in an unknown state; it is a
    // response this code does not understand, which means the contract moved or
    // something else answered.
    //
    // Folding that into 'unknown' would answer 409 "expected AGE_RESTRICTED,
    // found UNKNOWN" -- telling an operator a fact about the blob that was never
    // established. 503 says the true thing: the state could not be read.
    const res = await worker.fetch(
      post({ sha256: SHA, action: 'SAFE', from: 'AGE_RESTRICTED' }),
      env(moderationApi(null, { checkOmitsStatus: true })),
      {} as ExecutionContext,
    );

    expect(res.status).toBe(503);
    expect(((await res.json()) as { code?: string }).code).toBe('state_unreadable');
    expect(moderateCalls()).toHaveLength(0);
  });

  it('is backwards compatible: no `from` means no check and no behaviour change', async () => {
    // Every existing caller omits it. They must keep working, and must not pay for
    // a read they did not ask for.
    const res = await worker.fetch(
      post({ sha256: SHA, action: 'SAFE' }),
      env(moderationApi('quarantine')),
      {} as ExecutionContext,
    );

    expect(res.status).toBe(200);
    expect(moderateCalls()).toHaveLength(1);
    expect(calls.filter((c) => c.url.startsWith('/check-result/'))).toHaveLength(0);
  });

  it('compares case-insensitively and ignores surrounding whitespace', async () => {
    // check-result reports the action lowercased, so case must not decide
    // whether a reversal is allowed. The padding is here because `from` is
    // normalised with trim() before the comparison, and without this the trim
    // could be deleted with the suite still green.
    const res = await worker.fetch(
      post({ sha256: SHA, action: 'SAFE', from: '  age_restricted \n' }),
      env(moderationApi('AGE_RESTRICTED')),
      {} as ExecutionContext,
    );

    expect(res.status).toBe(200);
    expect(moderateCalls()).toHaveLength(1);
  });

  it('reports the normalised `from` on a mismatch, not the raw one', async () => {
    // The error string and the `from` field are what an operator reads to work
    // out what happened. Echoing the raw value shows padding they cannot see and
    // a case that differs from the state that was actually compared.
    const res = await worker.fetch(
      post({ sha256: SHA, action: 'SAFE', from: '  age_restricted  ' }),
      env(moderationApi('quarantine')),
      {} as ExecutionContext,
    );

    expect(res.status).toBe(409);
    const payload = (await res.json()) as { from?: string; error?: string };
    expect(payload.from).toBe('AGE_RESTRICTED');
    expect(payload.error).toContain('expected current state AGE_RESTRICTED, found QUARANTINE');
  });
});
