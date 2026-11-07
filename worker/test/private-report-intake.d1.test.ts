// ABOUTME: POST /api/internal/private-reports against a real D1, through the Worker's
// ABOUTME: fetch handler: Coop handoff, under-16 age-review cases, idempotency and retries.

import { Miniflare } from 'miniflare';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import worker from '../src/index';
import { ensureSchema } from '../src/db';
import { createSubjectWithBinding } from '../src/protected-minors';
import { fetchAccountIdentity } from '../src/relay-profile';

// The age-review case captures the account's profile from the relay. That read
// is the only relay contact the route may make, and it is a read.
vi.mock('../src/relay-profile', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/relay-profile')>(),
  fetchAccountIdentity: vi.fn(),
}));

const MOD_KEY = 'test-only-mod-relay-key';
const COOP_URL = 'https://coop.example.test';
const COOP_ITEMS_URL = `${COOP_URL}/api/v1/items/async/`;
const REPORTED = 'a1'.repeat(32);
const REPORTER = 'b2'.repeat(32);
const GIFT_WRAP = 'c3'.repeat(32);
const ctx = { waitUntil: vi.fn(), passThroughOnException: vi.fn() } as unknown as ExecutionContext;

let mf: Miniflare;
let DB: D1Database;

beforeAll(async () => {
  mf = new Miniflare({ modules: true, script: 'export default { fetch() { return new Response("ok"); } };',
    compatibilityDate: '2024-12-01', compatibilityFlags: ['nodejs_compat'], d1Databases: ['DB'] });
  DB = (await mf.getD1Database('DB')) as unknown as D1Database;
  await ensureSchema(DB);
});
afterAll(async () => mf.dispose());

let fetchMock: ReturnType<typeof vi.fn>;
let socketMock: ReturnType<typeof vi.fn>;

beforeEach(async () => {
  await DB.prepare('DELETE FROM private_report_intake').run();
  await DB.prepare('DELETE FROM age_review_cases').run();
  await DB.prepare('DELETE FROM moderation_decisions').run();
  await DB.prepare('DELETE FROM protected_minor_account_bindings').run();
  await DB.prepare('DELETE FROM protected_minor_subjects').run();
  vi.mocked(fetchAccountIdentity).mockReset();
  vi.mocked(fetchAccountIdentity).mockResolvedValue({ completed: true, profile: null });
  fetchMock = vi.fn(async () => new Response(null, { status: 202 }));
  vi.stubGlobal('fetch', fetchMock);
  // No relay connection of any kind: nothing is published and nothing enforced.
  socketMock = vi.fn(() => { throw new Error('no relay connection expected'); });
  vi.stubGlobal('WebSocket', socketMock);
});
afterEach(() => vi.unstubAllGlobals());

function testEnv(overrides: Record<string, unknown> = {}) {
  return {
    DB,
    ALLOWED_ORIGINS: '',
    RELAY_URL: 'wss://relay.example.test',
    MOD_RELAY_ADMIN_KEY: { get: async () => MOD_KEY },
    COOP_URL,
    COOP_API_KEY: 'test-only-ingestion-key',
    COOP_USER_TYPE_ID: 'test-only-user-type',
    ...overrides,
  };
}

function report(overrides: Record<string, unknown> = {}) {
  return {
    reportId: crypto.randomUUID(),
    reportedPubkey: REPORTED,
    reporterPubkey: REPORTER,
    reportType: 'harassment',
    reportedAt: '2026-11-07T10:00:00.000Z',
    hasExcerpt: true,
    giftWrapId: GIFT_WRAP,
    ...overrides,
  };
}

async function post(body: unknown, env: Record<string, unknown> = testEnv()) {
  return worker.fetch(new Request('https://api.test/api/internal/private-reports', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Admin-Key': MOD_KEY },
    body: JSON.stringify(body),
  }), env as never, ctx);
}

async function intakeRow(reportId: string) {
  return DB.prepare('SELECT * FROM private_report_intake WHERE report_id = ?').bind(reportId)
    .first<Record<string, unknown>>();
}

function coopCalls() {
  return fetchMock.mock.calls.filter(([url]) => String(url) === COOP_ITEMS_URL);
}

describe('POST /api/internal/private-reports: Coop handoff', () => {
  it.each([
    ['csam', 'csam'],
    ['child_safety', 'child_safety'],
    ['sexual_content', 'nudity'],
    ['violence', 'violence'],
    ['harassment', 'harassment'],
    ['spam', 'spam'],
    ['ai_generated', 'ai_generated'],
    ['copyright', 'other'],
    ['false_information', 'other'],
    ['other', 'other'],
    ['a_type_added_later', 'other'],
  ])('queues a %s report in Coop as a nostr_user item with report_reason %s, and nothing else', async (type, token) => {
    const body = report({ reportType: type });
    const res = await post(body);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true, outcome: 'queued_in_coop', duplicate: false });
    // The one outbound call is Coop's: no relay publish, no Zendesk, no enforcement.
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(socketMock).not.toHaveBeenCalled();
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(COOP_ITEMS_URL);
    expect(init.method).toBe('POST');
    expect(init.redirect).toBe('manual');
    expect(init.headers).toEqual({ 'Content-Type': 'application/json', 'x-api-key': 'test-only-ingestion-key' });
    // Only fields Coop's nostr_user schema declares, and none of the report:
    // no reporter, no excerpt flag, no gift wrap, no report id.
    expect(JSON.parse(String(init.body))).toEqual({
      items: [{ id: REPORTED, typeId: 'test-only-user-type', data: { pubkey: REPORTED, report_reason: token } }],
    });

    const row = await intakeRow(body.reportId);
    expect(row).toMatchObject({
      reported_pubkey: REPORTED, reporter_pubkey: REPORTER, report_type: type,
      gift_wrap_id: GIFT_WRAP, has_excerpt: 1, outcome: 'queued_in_coop', attempts: 1, last_error: null,
    });
    expect(row!.completed_at).toEqual(expect.any(String));
  });

  it('answers a repeated reportId with the stored outcome and does not call Coop again', async () => {
    const body = report({ reportType: 'csam' });
    expect((await post(body)).status).toBe(200);

    const again = await post(body);
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual({ success: true, outcome: 'queued_in_coop', duplicate: true });
    expect(coopCalls()).toHaveLength(1);
    expect((await intakeRow(body.reportId))!.attempts).toBe(1);
  });

  it('keeps the row incomplete after a Coop refusal, and the retry completes it once', async () => {
    const body = report({ reportType: 'child_safety' });
    fetchMock.mockResolvedValueOnce(new Response('down', { status: 500 }));

    const failed = await post(body);
    expect(failed.status).toBe(503);
    expect(await failed.json()).toMatchObject({ success: false, code: 'coop_status_500' });
    const pending = await intakeRow(body.reportId);
    expect(pending).toMatchObject({ outcome: null, completed_at: null, attempts: 1, last_error: 'coop_status_500' });

    const retried = await post(body);
    expect(retried.status).toBe(200);
    expect(await retried.json()).toEqual({ success: true, outcome: 'queued_in_coop', duplicate: false });
    expect(await intakeRow(body.reportId)).toMatchObject({ outcome: 'queued_in_coop', attempts: 2, last_error: null });

    expect(await (await post(body)).json()).toMatchObject({ duplicate: true });
    expect(coopCalls()).toHaveLength(2);
  });

  it('treats a Coop redirect as a refusal rather than following it', async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 302, headers: { Location: 'https://elsewhere.example.test/' } }));
    const res = await post(report());
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ code: 'coop_status_302' });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('answers 503 when Coop cannot be reached, and keeps the row for a retry', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('network down'));
    const body = report();
    const res = await post(body);
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ code: 'coop_unreachable' });
    expect(await intakeRow(body.reportId)).toMatchObject({ completed_at: null, last_error: 'coop_unreachable' });
  });

  it.each(['COOP_URL', 'COOP_API_KEY', 'COOP_USER_TYPE_ID'])('answers 503 without calling Coop when %s is unset', async (unset) => {
    const body = report();
    const res = await post(body, testEnv({ [unset]: undefined }));
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ success: false, code: 'coop_not_configured' });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await intakeRow(body.reportId)).toMatchObject({ completed_at: null, last_error: 'coop_not_configured' });
  });

  it('forwards the dedicated Access pair to Coop when it is bound', async () => {
    const res = await post(report(), testEnv({
      COOP_API_KEY: { get: async () => 'test-only-ingestion-key' },
      COOP_ACCESS_CLIENT_ID: { get: async () => 'test-only-access-id' },
      COOP_ACCESS_CLIENT_SECRET: { get: async () => 'test-only-access-secret' },
    }));
    expect(res.status).toBe(200);
    expect((fetchMock.mock.calls[0] as [string, RequestInit])[1].headers).toEqual({
      'Content-Type': 'application/json', 'x-api-key': 'test-only-ingestion-key',
      'CF-Access-Client-Id': 'test-only-access-id', 'CF-Access-Client-Secret': 'test-only-access-secret',
    });
  });

  it('never reads the shared Access pair for Coop', async () => {
    const sharedId = vi.fn(async () => 'test-only-shared-id');
    const res = await post(report(), testEnv({ CF_ACCESS_CLIENT_ID: { get: sharedId }, CF_ACCESS_CLIENT_SECRET: 'test-only-shared-secret' }));
    expect(res.status).toBe(200);
    expect(sharedId).not.toHaveBeenCalled();
    expect((fetchMock.mock.calls[0] as [string, RequestInit])[1].headers).not.toHaveProperty('CF-Access-Client-Id');
  });

  it.each([
    ['half an Access pair', { COOP_ACCESS_CLIENT_ID: 'test-only-access-id' }],
    ['an Access pair over plain HTTP', {
      COOP_URL: 'http://coop.example.test',
      COOP_ACCESS_CLIENT_ID: 'test-only-access-id', COOP_ACCESS_CLIENT_SECRET: 'test-only-access-secret',
    }],
  ])('refuses to send the report with %s', async (_label, overrides) => {
    const res = await post(report(), testEnv(overrides));
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ code: 'coop_not_configured' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('answers 503 and calls nothing while another attempt holds the report', async () => {
    const body = report();
    await DB.prepare(`INSERT INTO private_report_intake
      (report_id, reported_pubkey, reporter_pubkey, report_type, gift_wrap_id, has_excerpt, reported_at,
       attempts, lease_until, first_received_at, last_attempt_at)
      VALUES (?, ?, ?, ?, ?, 1, ?, 1, ?, ?, ?)`)
      .bind(body.reportId, REPORTED, REPORTER, body.reportType, GIFT_WRAP, body.reportedAt,
        Date.now() + 60_000, body.reportedAt, body.reportedAt).run();

    const res = await post(body);
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ code: 'attempt_in_progress' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuses, without calling Coop, a reportId already recorded for a different report', async () => {
    const body = report({ reportType: 'spam' });
    expect((await post(body)).status).toBe(200);

    for (const changed of [{ reportedPubkey: 'd4'.repeat(32) }, { reporterPubkey: 'e5'.repeat(32) }, { reportType: 'csam' }]) {
      const res = await post({ ...body, ...changed });
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ success: false, code: 'report_id_conflict' });
    }
    expect(coopCalls()).toHaveLength(1);
  });

  it('stores and sends lowercase identifiers', async () => {
    const reportId = crypto.randomUUID().toUpperCase();
    const res = await post(report({ reportId, reportedPubkey: REPORTED.toUpperCase(), reporterPubkey: REPORTER.toUpperCase() }));
    expect(res.status).toBe(200);
    const payload = JSON.parse(String((fetchMock.mock.calls[0] as [string, RequestInit])[1].body));
    expect(payload.items[0]).toMatchObject({ id: REPORTED, data: { pubkey: REPORTED } });
    expect(await intakeRow(reportId.toLowerCase())).toMatchObject({ reported_pubkey: REPORTED, reporter_pubkey: REPORTER });
  });
});

describe('POST /api/internal/private-reports: under-16 reports', () => {
  // Zendesk credentials are bound on purpose: a private report must not reach it.
  const zendeskEnv = () => testEnv({
    ZENDESK_SUBDOMAIN: 'test-only-subdomain', ZENDESK_EMAIL: 'agent@example.test', ZENDESK_API_TOKEN: 'test-only-token',
  });

  it('opens an age-review case for the reported account, and calls neither Coop nor Zendesk', async () => {
    const body = report({ reportType: 'underage_user' });
    const res = await post(body, zendeskEnv());

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true, outcome: 'age_review_opened', duplicate: false });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(socketMock).not.toHaveBeenCalled();
    expect(fetchAccountIdentity).toHaveBeenCalledWith(REPORTED, 'wss://relay.example.test');

    const cases = await DB.prepare('SELECT * FROM age_review_cases WHERE pubkey = ?').bind(REPORTED)
      .all<Record<string, unknown>>();
    expect(cases.results).toHaveLength(1);
    // Opened for review only: open_reported is never auto-closed or enforced by the cron.
    expect(cases.results[0]).toMatchObject({
      state: 'open_reported', created_via: 'private_report', reporter_pubkey: REPORTER,
      report_id: null, zendesk_ticket_id: null,
    });
    expect(cases.results[0].deadline_at).toEqual(expect.any(String));

    const decision = await DB.prepare('SELECT * FROM moderation_decisions WHERE target_id = ?').bind(REPORTED)
      .first<Record<string, unknown>>();
    expect(decision).toMatchObject({
      target_type: 'pubkey', action: 'age_review_case_created', report_id: body.reportId, reporter_pubkey: REPORTER,
    });
    expect(String(decision!.reason)).toMatch(/^Under-16 private report: age review case [0-9a-f-]{36} created/);
    expect(await intakeRow(body.reportId)).toMatchObject({ outcome: 'age_review_opened', case_id: cases.results[0].id });
  });

  it('answers a repeated reportId with the stored outcome and opens no second case', async () => {
    const body = report({ reportType: 'underage_user' });
    expect((await post(body)).status).toBe(200);
    const again = await post(body);
    expect(await again.json()).toEqual({ success: true, outcome: 'age_review_opened', duplicate: true });
    expect(fetchAccountIdentity).toHaveBeenCalledOnce();
    const count = await DB.prepare('SELECT COUNT(*) AS n FROM age_review_cases WHERE pubkey = ?').bind(REPORTED)
      .first<{ n: number }>();
    expect(count!.n).toBe(1);
  });

  it('answers age_review_exists when the account already has an active case', async () => {
    expect((await post(report({ reportType: 'underage_user' }))).status).toBe(200);
    const second = report({ reportType: 'underage_user', reporterPubkey: 'f6'.repeat(32) });
    const res = await post(second, zendeskEnv());
    expect(await res.json()).toEqual({ success: true, outcome: 'age_review_exists', duplicate: false });
    expect(fetchMock).not.toHaveBeenCalled();
    const count = await DB.prepare('SELECT COUNT(*) AS n FROM age_review_cases WHERE pubkey = ?').bind(REPORTED)
      .first<{ n: number }>();
    expect(count!.n).toBe(1);
    expect(await intakeRow(second.reportId)).toMatchObject({ outcome: 'age_review_exists' });
  });

  it('records an approved minor as already cleared, as a kind-1984 report does', async () => {
    await createSubjectWithBinding(DB, 'case-approved-earlier', REPORTED);
    const res = await post(report({ reportType: 'underage_user' }));
    expect(await res.json()).toEqual({ success: true, outcome: 'age_review_opened', duplicate: false });
    const row = await DB.prepare('SELECT state, created_via FROM age_review_cases WHERE pubkey = ?')
      .bind(REPORTED).first();
    expect(row).toEqual({ state: 'cleared', created_via: 'private_report' });
  });

  it('keeps the row incomplete when the case cannot be written, and the retry opens it', async () => {
    const next = report({ reportType: 'underage_user' });
    const failingDb = new Proxy(DB, {
      get(target, prop, receiver) {
        if (prop !== 'prepare') return Reflect.get(target, prop, receiver);
        return (sql: string) => {
          if (sql.includes('INSERT INTO age_review_cases')) throw new Error('D1 write failed');
          return target.prepare(sql);
        };
      },
    });
    const failed = await post(next, testEnv({ DB: failingDb }));
    expect(failed.status).toBe(503);
    expect(await failed.json()).toMatchObject({ code: 'age_review_failed' });
    expect(await intakeRow(next.reportId)).toMatchObject({ completed_at: null, last_error: 'age_review_failed' });

    expect(await (await post(next)).json()).toEqual({ success: true, outcome: 'age_review_opened', duplicate: false });
  });
});
