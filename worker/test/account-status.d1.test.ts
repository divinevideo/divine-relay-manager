// Real-D1 validation that the moderator account-status lookup reports the D1
// protected-minor registry alongside keycast (#192). An approved minor who holds
// their own key has no keycast account, so the registry is the only place the
// case view can learn the account is protected.
import { Miniflare } from 'miniflare';
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { ensureSchema } from '../src/db';
import { createSubjectWithBinding, clearSubject } from '../src/protected-minors';
import { handleAccountStatus } from '../src/account-status';

let mf: Miniflare;
let DB: D1Database;

const PK = 'a'.repeat(64);
const OTHER_PK = 'b'.repeat(64);
const CORS = { 'Access-Control-Allow-Origin': '*' };

function env() {
  return { KEYCAST_URL: 'https://login.test.divine.video', KEYCAST_SERVICE_TOKEN: 'test-service-token', DB };
}

function stubKeycast(response: { ok: boolean; status: number; body?: unknown }) {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
    ok: response.ok,
    status: response.status,
    json: () => Promise.resolve(response.body),
    text: () => Promise.resolve(JSON.stringify(response.body ?? '')),
  }));
}

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
afterAll(async () => { await mf?.dispose(); });

beforeEach(async () => {
  await ensureSchema(DB);
  await DB.prepare('DELETE FROM protected_minor_projection_jobs').run();
  await DB.prepare('DELETE FROM protected_minor_account_bindings').run();
  await DB.prepare('DELETE FROM protected_minor_subjects').run();
});
afterEach(() => vi.unstubAllGlobals());

describe('handleAccountStatus protected_minor (registry)', () => {
  it('reports a self-custody approved minor as protected', async () => {
    await createSubjectWithBinding(DB, 'case-1', PK);
    stubKeycast({ ok: false, status: 404, body: { error: 'user not found' } });

    const body = await (await handleAccountStatus(PK, env(), CORS)).json();

    expect(body).toMatchObject({ success: false, not_found: true, protected_minor: true });
  });

  it('reports protected_minor alongside keycast fields for a Divine login account', async () => {
    await createSubjectWithBinding(DB, 'case-1', PK);
    stubKeycast({ ok: true, status: 200, body: { pubkey: PK, status: 'active', verified_minor: false } });

    const body = await (await handleAccountStatus(PK, env(), CORS)).json();

    expect(body).toMatchObject({ success: true, verified_minor: false, protected_minor: true });
  });

  it('reports protected_minor while keycast is unavailable', async () => {
    await createSubjectWithBinding(DB, 'case-1', PK);
    stubKeycast({ ok: false, status: 500, body: 'boom' });

    const body = await (await handleAccountStatus(PK, env(), CORS)).json() as Record<string, unknown>;

    expect(body.success).toBe(false);
    expect(body.not_found).toBeFalsy();
    expect(body.protected_minor).toBe(true);
  });

  it('is false for a pubkey with no registry subject', async () => {
    await createSubjectWithBinding(DB, 'case-1', OTHER_PK);
    stubKeycast({ ok: false, status: 404, body: { error: 'user not found' } });

    const body = await (await handleAccountStatus(PK, env(), CORS)).json();

    expect(body).toMatchObject({ protected_minor: false });
  });

  it('is false once the subject is cleared by a denial', async () => {
    await createSubjectWithBinding(DB, 'case-1', PK);
    const cleared = await clearSubject(DB, PK, undefined, 'age_review_denied');
    expect(cleared.success).toBe(true);
    stubKeycast({ ok: false, status: 404, body: { error: 'user not found' } });

    const body = await (await handleAccountStatus(PK, env(), CORS)).json();

    expect(body).toMatchObject({ protected_minor: false });
  });
});
