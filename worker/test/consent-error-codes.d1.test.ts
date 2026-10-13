// Real-D1 (Miniflare SQLite) checks for the parent-consent route's conflict
// codes that only a database race can reach, so a client can tell "retry"
// from "stop" by `code` rather than by the error text (#302).
import { Miniflare } from 'miniflare';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ensureSchema } from '../src/db';
import { handleParentConsent } from '../src/age-review';

let mf: Miniflare;
let DB: D1Database;
const OWNER = 'a'.repeat(64);

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
    (id, pubkey, state, suspected_age_band, zendesk_ticket_id, deadline_at, clock_paused, version)
    VALUES ('code-case', ?, 'restricted_pending_parental_consent', 'age_13_15', 42, ?, 0, 1)`)
    .bind(OWNER, new Date(Date.now() + 9 * 864e5).toISOString()).run();
});

// Reports zero changes for the statement whose SQL contains `marker`, as if
// another request had changed the row first.
function racing(marker: string): D1Database {
  return new Proxy(DB, {
    get(target, prop) {
      if (prop !== 'prepare') return Reflect.get(target, prop).bind(target);
      return (sql: string) => {
        const stmt = target.prepare(sql);
        if (!sql.includes(marker)) return stmt;
        return { bind: () => ({ run: async () => ({ meta: { changes: 0 } }) }) };
      };
    },
  }) as D1Database;
}

function envWith(db: D1Database) {
  const objects = new Set<string>();
  const bucket = {
    head: async (key: string) => (objects.has(key) ? { size: 4 } : null),
    delete: async (key: string) => { objects.delete(key); },
    createMultipartUpload: async (key: string) => ({
      uploadPart: async (n: number) => ({ partNumber: n, etag: `e${n}` }),
      complete: async () => { objects.add(key); return {}; },
      abort: async () => {},
    }),
  } as unknown as R2Bucket;
  return {
    DB: db, CONSENT_VIDEO_BUCKET: bucket,
    CONSENT_ACCESS_TEAM_DOMAIN: 'team.cloudflareaccess.com', CONSENT_ACCESS_AUD: 'aud',
    ZENDESK_SUBDOMAIN: 'test', ZENDESK_EMAIL: 'agent@test.com', ZENDESK_API_TOKEN: 'token',
  } as Parameters<typeof handleParentConsent>[3];
}

async function submit(db: D1Database) {
  const form = new FormData();
  form.set('email', 'parent@example.com');
  form.set('video', new File(['clip'], 'clip.mp4', { type: 'video/mp4' }));
  const res = await handleParentConsent(
    new Request('https://api.test/v1/minor-review-cases/code-case/parent-consent', { method: 'POST', body: form }),
    'code-case', OWNER, envWith(db), {});
  return { status: res.status, code: ((await res.json()) as { code?: string }).code };
}

describe('parent-consent conflict codes', () => {
  it('answers submission_changed when another request claims the row first', async () => {
    expect(await submit(racing('INSERT OR IGNORE INTO age_review_parent_consent_submissions')))
      .toEqual({ status: 409, code: 'submission_changed' });
  });

  it('answers case_changed when the case moves on while the clip is linked', async () => {
    // Zendesk accepts the reviewer-link comment and then lists it.
    let comment = '';
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.endsWith('/tickets/42')) {
        comment = (JSON.parse(String(init?.body)) as { ticket: { comment: { body: string } } }).ticket.comment.body;
        return new Response('{}', { status: 200 });
      }
      if (url.includes('/tickets/42/comments?')) return new Response(JSON.stringify({ comments: [{ body: comment }] }), { status: 200 });
      throw new Error(`Unexpected request: ${url}`);
    });
    expect(await submit(racing("SET parent_contact_email = ?, state = 'submitted_for_review'")))
      .toEqual({ status: 409, code: 'case_changed' });
  });
});
