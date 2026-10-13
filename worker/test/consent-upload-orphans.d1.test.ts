// Real-D1 (Miniflare SQLite) checks that a consent upload rejected after its
// clip reached R2 does not leave that clip behind. Both disposal sweeps start
// from D1 rows, so an object no row names would be kept forever (#302).
import { Miniflare } from 'miniflare';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
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

beforeEach(async () => {
  await ensureSchema(DB);
  await DB.prepare('DELETE FROM age_review_parent_consent_superseded').run();
  await DB.prepare('DELETE FROM age_review_parent_consent_submissions').run();
  await DB.prepare('DELETE FROM age_review_cases').run();
  await DB.prepare(`INSERT INTO age_review_cases
    (id, pubkey, state, suspected_age_band, zendesk_ticket_id, deadline_at, clock_paused, version)
    VALUES ('orphan-case', ?, 'restricted_pending_parental_consent', 'age_13_15', 42, ?, 0, 1)`)
    .bind(OWNER, new Date(Date.now() + 9 * 864e5).toISOString()).run();
});

// Completes multipart uploads into a set of stored keys, as R2 does.
function fakeBucket(keys: string[] = []) {
  const objects = new Set(keys);
  const bucket = {
    head: async (key: string) => (objects.has(key) ? { size: 4 } : null),
    delete: async (key: string) => { objects.delete(key); },
    createMultipartUpload: async (key: string) => ({
      uploadPart: async (n: number) => ({ partNumber: n, etag: `e${n}` }),
      complete: async () => { objects.add(key); return {}; },
      abort: async () => {},
    }),
  };
  return { bucket: bucket as unknown as R2Bucket, objects };
}

function envWith(bucket: R2Bucket) {
  return {
    DB, CONSENT_VIDEO_BUCKET: bucket,
    CONSENT_ACCESS_TEAM_DOMAIN: 'team.cloudflareaccess.com', CONSENT_ACCESS_AUD: 'aud',
  } as Parameters<typeof handleParentConsent>[3];
}

function consentRequest(parts: Array<[string, string | File]>) {
  const form = new FormData();
  for (const [name, value] of parts) form.append(name, value);
  return new Request('https://api.test/v1/minor-review-cases/orphan-case/parent-consent', { method: 'POST', body: form });
}

const clip = (name = 'clip.mp4') => new File(['clip'], name, { type: 'video/mp4' });

describe('a consent upload rejected after its clip is stored', () => {
  it('leaves no clip behind when a second video part is rejected', async () => {
    const { bucket, objects } = fakeBucket();
    const res = await handleParentConsent(
      consentRequest([['email', 'parent@example.com'], ['video', clip('a.mp4')], ['video', clip('b.mp4')]]),
      'orphan-case', OWNER, envWith(bucket), {});
    expect(res.status).toBe(400);
    expect([...objects]).toEqual([]);
  });

  it('leaves no clip behind when the email is invalid', async () => {
    const { bucket, objects } = fakeBucket();
    const res = await handleParentConsent(
      consentRequest([['video', clip()], ['email', 'not-an-email']]),
      'orphan-case', OWNER, envWith(bucket), {});
    expect(res.status).toBe(400);
    expect([...objects]).toEqual([]);
  });

  it('leaves no clip behind when another upload holds the retry lease', async () => {
    await DB.prepare(`INSERT INTO age_review_parent_consent_submissions
      (case_id, status, lease_until, created_at) VALUES ('orphan-case', 'processing', ?, unixepoch())`)
      .bind(Math.floor(Date.now() / 1000) + 600).run();
    const { bucket, objects } = fakeBucket();
    const res = await handleParentConsent(
      consentRequest([['email', 'parent@example.com'], ['video', clip()]]),
      'orphan-case', OWNER, envWith(bucket), {});
    expect(res.status).toBe(409);
    expect(((await res.json()) as { code?: string }).code).toBe('submission_in_progress');
    expect([...objects]).toEqual([]);
  });

  it('keeps a fresh clip once this request recorded it, even when the next step fails', async () => {
    // The row insert records this request's own key, then marking it stored
    // reports no change. The row names the key, so the clip must stay.
    const markNothing = new Proxy(DB, {
      get(target, prop) {
        if (prop !== 'prepare') return Reflect.get(target, prop).bind(target);
        return (sql: string) => {
          const stmt = target.prepare(sql);
          if (!sql.includes("SET status = 'stored'")) return stmt;
          return { bind: () => ({ run: async () => ({ meta: { changes: 0 } }) }) };
        };
      },
    }) as D1Database;
    const { bucket, objects } = fakeBucket();
    const env = { ...envWith(bucket), DB: markNothing } as Parameters<typeof handleParentConsent>[3];
    const res = await handleParentConsent(
      consentRequest([['email', 'parent@example.com'], ['video', clip()]]),
      'orphan-case', OWNER, env, {});
    expect(res.status).toBe(409);
    expect(((await res.json()) as { code?: string }).code).toBe('submission_changed');
    const row = await DB.prepare("SELECT object_key FROM age_review_parent_consent_submissions WHERE case_id = 'orphan-case'")
      .first<{ object_key: string }>();
    expect(row?.object_key).toBeTruthy();
    expect(objects.has(row!.object_key)).toBe(true);
  });

  it('never deletes a clip a submission row already names', async () => {
    // An earlier attempt recorded its key and stopped before marking it
    // stored. The retry reuses that key, so a rejection must leave it alone.
    await DB.prepare(`INSERT INTO age_review_parent_consent_submissions
      (case_id, status, lease_until, created_at, receipt_id, object_key)
      VALUES ('orphan-case', 'processing', 0, unixepoch(), 'r-kept', 'k-kept')`).run();
    const { bucket, objects } = fakeBucket(['k-kept']);
    const res = await handleParentConsent(
      consentRequest([['video', clip()], ['email', 'not-an-email']]),
      'orphan-case', OWNER, envWith(bucket), {});
    expect(res.status).toBe(400);
    expect(objects.has('k-kept')).toBe(true);
  });
});
