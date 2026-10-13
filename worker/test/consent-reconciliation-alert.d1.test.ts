// Real-D1 (Miniflare SQLite) checks that a consent submission stuck for
// manual reconciliation alerts Slack once per throttle window, not on every
// retry, using its own timestamp so it cannot silence the case's deadline
// alerts (#302).
import { Miniflare } from 'miniflare';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ensureSchema } from '../src/db';
import { handleParentConsent } from '../src/age-review';

let mf: Miniflare;
let DB: D1Database;
const OWNER = 'a'.repeat(64);
const SLACK = 'https://hooks.slack.test/alerts';

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
afterEach(() => { vi.restoreAllMocks(); });

beforeEach(async () => {
  await ensureSchema(DB);
  await DB.prepare('DELETE FROM age_review_parent_consent_submissions').run();
  await DB.prepare('DELETE FROM age_review_cases').run();
  await DB.prepare(`INSERT INTO age_review_cases
    (id, pubkey, state, suspected_age_band, deadline_at, clock_paused, version)
    VALUES ('stuck-case', ?, 'restricted_pending_parental_consent', 'age_13_15', ?, 0, 1)`)
    .bind(OWNER, new Date(Date.now() + 9 * 864e5).toISOString()).run();
  // Stored, no ticket, and the creation attempt is past the idempotency window.
  await DB.prepare(`INSERT INTO age_review_parent_consent_submissions
    (case_id, status, lease_until, created_at, receipt_id, object_key, ticket_attempt_at)
    VALUES ('stuck-case', 'stored', 0, unixepoch(), 'r-stuck', 'k-stuck', unixepoch() - 3600)`).run();
});

function env() {
  const bucket = { head: async () => ({ size: 4 }) } as unknown as R2Bucket;
  return {
    DB, CONSENT_VIDEO_BUCKET: bucket,
    CONSENT_ACCESS_TEAM_DOMAIN: 'team.cloudflareaccess.com', CONSENT_ACCESS_AUD: 'aud',
    ZENDESK_SUBDOMAIN: 'test', ZENDESK_EMAIL: 'agent@test.com', ZENDESK_API_TOKEN: 'token',
    SLACK_WEBHOOK_URL: SLACK,
  } as Parameters<typeof handleParentConsent>[3];
}

function retry() {
  const form = new FormData();
  form.set('email', 'parent@example.com');
  form.set('video', new File(['clip'], 'clip.mp4', { type: 'video/mp4' }));
  return handleParentConsent(
    new Request('https://api.test/v1/minor-review-cases/stuck-case/parent-consent', { method: 'POST', body: form }),
    'stuck-case', OWNER, env(), {});
}

// The reconciliation 409 returns holding the 10-minute retry lease, so a
// retry inside it gets the in-progress 409 instead. Clear it, as if the lease
// had run out, so the next retry reaches the reconciliation path again.
async function leaseExpires() {
  await DB.prepare(`UPDATE age_review_parent_consent_submissions SET lease_until = 0 WHERE case_id = 'stuck-case'`).run();
}

function slackCalls(spy: { mock: { calls: unknown[][] } }) {
  return spy.mock.calls.filter(([url]) => String(url) === SLACK).length;
}

describe('the manual-reconciliation alert', () => {
  it('alerts once for repeated retries inside the throttle window', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('ok', { status: 200 }));
    expect((await retry()).status).toBe(409);
    await leaseExpires();
    expect((await retry()).status).toBe(409);
    expect(slackCalls(spy)).toBe(1);
  });

  it('alerts again on the next retry when Slack refused the first alert', async () => {
    const spy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response('nope', { status: 500 }))
      .mockResolvedValue(new Response('ok', { status: 200 }));
    await retry();
    await leaseExpires();
    await retry();
    expect(slackCalls(spy)).toBe(2);
  });

  it('alerts again once the throttle window has passed', async () => {
    await DB.prepare(`UPDATE age_review_parent_consent_submissions
      SET reconciliation_alerted_at = datetime('now', '-13 hours') WHERE case_id = 'stuck-case'`).run();
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('ok', { status: 200 }));
    await retry();
    expect(slackCalls(spy)).toBe(1);
  });

  it('still answers the non-retryable 409 when the alert bookkeeping fails', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('ok', { status: 200 }));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const failing = new Proxy(DB, {
      get(target, prop) {
        if (prop !== 'prepare') return Reflect.get(target, prop).bind(target);
        return (sql: string) => {
          if (sql.includes('reconciliation_alerted_at')) throw new Error('D1 unavailable');
          return target.prepare(sql);
        };
      },
    }) as D1Database;
    const form = new FormData();
    form.set('email', 'parent@example.com');
    form.set('video', new File(['clip'], 'clip.mp4', { type: 'video/mp4' }));
    const res = await handleParentConsent(
      new Request('https://api.test/v1/minor-review-cases/stuck-case/parent-consent', { method: 'POST', body: form }),
      'stuck-case', OWNER, { ...env(), DB: failing }, {});
    expect(res.status).toBe(409);
  });

  it('keeps the parent email on the case when the submission needs manual reconciliation', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('ok', { status: 200 }));
    expect((await retry()).status).toBe(409);
    const row = await DB.prepare("SELECT parent_contact_email, state FROM age_review_cases WHERE id = 'stuck-case'")
      .first<{ parent_contact_email: string | null; state: string }>();
    // Support reconciles by hand and needs the address the parent typed; the
    // case has not advanced, so it is still pending.
    expect(row).toEqual({ parent_contact_email: 'parent@example.com', state: 'restricted_pending_parental_consent' });
  });

  it('leaves the case deadline throttle alone', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('ok', { status: 200 }));
    await retry();
    const row = await DB.prepare("SELECT last_alerted_at FROM age_review_cases WHERE id = 'stuck-case'")
      .first<{ last_alerted_at: string | null }>();
    expect(row?.last_alerted_at).toBeNull();
  });
});
