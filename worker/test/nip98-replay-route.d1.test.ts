// Real-D1 (Miniflare SQLite) end-to-end validation for the #195 replay-nonce
// route wiring: drives a REAL NIP-98 request through worker.fetch (not just
// consumeNip98Nonce in isolation, which test/nip98-nonce.d1.test.ts already
// covers) to prove the route actually rejects a replayed Authorization header.
import { Miniflare } from 'miniflare';
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { finalizeEvent, generateSecretKey } from 'nostr-tools';
import { ensureSchema } from '../src/db';
import worker from '../src/index';

const OWN = 'https://api-relay-prod.divine.video/v1/account/moderation-status';
const ctx = {} as ExecutionContext;

let mf: Miniflare;
let DB: D1Database;

beforeAll(async () => {
  mf = new Miniflare({
    modules: true,
    script: 'export default { fetch() { return new Response("ok"); } };',
    compatibilityDate: '2024-12-01',
    compatibilityFlags: ['nodejs_compat'],
    d1Databases: ['DB'],
  });
  DB = (await mf.getD1Database('DB')) as unknown as D1Database;
});

afterAll(async () => {
  await mf?.dispose();
});

async function reset() {
  await ensureSchema(DB);
  await DB.prepare('DELETE FROM nip98_used_nonces').run();
  await DB.prepare('DELETE FROM age_review_cases').run();
}

// Mirrors nip98-auth.test.ts / nip86.ts:99-112.
function signedAuthHeader(): string {
  const sk = generateSecretKey();
  const evt = finalizeEvent(
    {
      kind: 27235,
      content: '',
      tags: [['u', OWN], ['method', 'GET']],
      created_at: Math.floor(Date.now() / 1000),
    },
    sk,
  );
  return 'Nostr ' + btoa(JSON.stringify(evt));
}

function request(authHeader: string): Request {
  return new Request(OWN, { method: 'GET', headers: { Authorization: authHeader } });
}

describe('NIP-98 replay rejection through worker.fetch (real D1)', () => {
  beforeEach(reset);
  afterEach(() => vi.restoreAllMocks());

  it('first use succeeds (200), identical replay is rejected (401)', async () => {
    // The no-case branch of handleGetModerationStatus doesn't log, but scope a
    // spy anyway so any incidental logging elsewhere in the route doesn't dirty
    // test output.
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});

    const authHeader = signedAuthHeader();

    const first = await worker.fetch(request(authHeader), { DB } as never, ctx);
    expect(first.status).toBe(200);
    const firstBody = await first.json() as { restriction: { status: string } };
    // No age_review_cases row for this pubkey -> handler falls through to 'active'.
    expect(firstBody.restriction.status).toBe('active');

    // Same signed event, same Authorization header, replayed verbatim.
    const second = await worker.fetch(request(authHeader), { DB } as never, ctx);
    expect(second.status).toBe(401);
    const secondBody = await second.json() as { success: boolean; error: string };
    expect(secondBody.success).toBe(false);
    expect(secondBody.error).toBe('Replayed NIP-98 token');

    // Mutation check (reasoned, not re-run against a mutated build): the 401 above
    // is produced by `if (authResult.eventId && !(await consumeNip98Nonce(...)))`
    // at index.ts:429. Remove that route's consume call (or stub consumeNip98Nonce
    // to always return true) and the second request would fall through to
    // handleGetModerationStatus and return 200 like the first -- i.e. this
    // assertion is load-bearing on the nonce consume, not just on auth validity.
  });
});
