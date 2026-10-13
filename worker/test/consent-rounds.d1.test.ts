// Real-D1 (Miniflare SQLite) checks that a consent clip a moderator sent back
// for a new round is kept until retention disposes of it, under the same
// rules and legal holds as the current clip (#302).
import { Miniflare } from 'miniflare';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ensureSchema } from '../src/db';
import { handleParentConsent } from '../src/age-review';
import { findConsentClip } from '../src/consent-video';
import { runRetentionDisposal } from '../src/retention';

let mf: Miniflare;
let DB: D1Database;
const OWNER = 'a'.repeat(64);
const KEY = 'synthetic-retention-key-for-tests';

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
  await DB.prepare('DELETE FROM retention_legal_holds').run();
  await DB.prepare('DELETE FROM age_review_cases').run();
});

function fakeBucket(keys: string[]) {
  const objects = new Set(keys);
  const deleted: string[] = [];
  const bucket = {
    head: async (key: string) => (objects.has(key) ? { size: 4 } : null),
    delete: async (key: string) => { objects.delete(key); deleted.push(key); },
    createMultipartUpload: async (key: string) => ({
      uploadPart: async (n: number) => ({ partNumber: n, etag: `e${n}` }),
      complete: async () => { objects.add(key); return {}; },
      abort: async () => {},
    }),
  };
  return { bucket: bucket as unknown as R2Bucket, objects, deleted };
}

// A case a moderator sent back: version 3, while the commented submission
// was recorded at version 2.
async function sentBackCase(closedAt: string | null = null) {
  await DB.prepare(`INSERT INTO age_review_cases
    (id, pubkey, state, suspected_age_band, zendesk_ticket_id, deadline_at, clock_paused, version, closed_at)
    VALUES ('round-case', ?, 'restricted_pending_parental_consent', 'age_13_15', 42, ?, 0, 3, ?)`)
    .bind(OWNER, new Date(Date.now() + 9 * 864e5).toISOString(), closedAt).run();
  await DB.prepare(`INSERT INTO age_review_parent_consent_submissions
    (case_id, status, lease_until, created_at, receipt_id, object_key, content_type, size_bytes, case_version)
    VALUES ('round-case', 'commented', 0, unixepoch(), 'r-old', 'k-old', 'video/mp4', 4, 2)`).run();
}

function badEmailRequest() {
  const form = new FormData();
  form.set('email', 'not-an-email');
  form.set('video', new File(['clip'], 'clip.mp4', { type: 'video/mp4' }));
  return new Request('https://api.test/v1/minor-review-cases/round-case/parent-consent', { method: 'POST', body: form });
}

describe('consent clips from earlier rounds', () => {
  it('keeps the previous clip and its receipt when a new-round request is rejected', async () => {
    await sentBackCase();
    const { bucket, objects } = fakeBucket(['k-old']);
    const env = {
      DB, CONSENT_VIDEO_BUCKET: bucket,
      CONSENT_ACCESS_TEAM_DOMAIN: 'team.cloudflareaccess.com', CONSENT_ACCESS_AUD: 'aud',
    } as Parameters<typeof handleParentConsent>[3];

    const res = await handleParentConsent(badEmailRequest(), 'round-case', OWNER, env, {});

    expect(res.status).toBe(400);
    expect(objects.has('k-old')).toBe(true);
    expect(await findConsentClip(DB, 'r-old')).toMatchObject({ object_key: 'k-old', size_bytes: 4 });
  });

  it('disposes of an earlier round 120 days after closure, and a legal hold keeps it', async () => {
    const closedLongAgo = new Date(Date.now() - 121 * 864e5).toISOString();
    await DB.prepare(`INSERT INTO age_review_cases (id, pubkey, state, closed_at)
      VALUES ('free-case', ?, 'denied_closed', ?), ('held-case', ?, 'denied_closed', ?)`)
      .bind(OWNER, closedLongAgo, OWNER, closedLongAgo).run();
    await DB.prepare(`INSERT INTO age_review_parent_consent_superseded
      (receipt_id, case_id, object_key, content_type, size_bytes, superseded_at)
      VALUES ('r-free', 'free-case', 'k-free', 'video/mp4', 4, unixepoch()),
             ('r-held', 'held-case', 'k-held', 'video/mp4', 4, unixepoch())`).run();
    await DB.prepare(`INSERT INTO retention_legal_holds
      (id, record_type, record_key, disposal_stage, authorized_role, starts_at, review_at)
      VALUES ('hold', 'age_review_case', 'held-case', 'consent_video', 'privacy/legal', '2020-01-01T00:00:00Z', '2030-01-01T00:00:00Z')`).run();
    const { bucket, deleted } = fakeBucket(['k-free', 'k-held']);

    const result = await runRetentionDisposal({ DB, PROTECTED_MINOR_TOMBSTONE_KEY: KEY, CONSENT_VIDEO_BUCKET: bucket });

    expect(deleted).toEqual(['k-free']);
    expect(result.consentVideosDeleted).toBe(1);
    expect(await findConsentClip(DB, 'r-free')).toBeNull();
    expect(await findConsentClip(DB, 'r-held')).toMatchObject({ object_key: 'k-held' });
  });

  it('keeps the case until an earlier round is disposed of', async () => {
    const closedYearsAgo = new Date(Date.now() - 400 * 864e5).toISOString();
    await DB.prepare(`INSERT INTO age_review_cases (id, pubkey, state, closed_at)
      VALUES ('old-case', ?, 'denied_closed', ?)`).bind(OWNER, closedYearsAgo).run();
    await DB.prepare(`INSERT INTO age_review_parent_consent_superseded
      (receipt_id, case_id, object_key, content_type, size_bytes, superseded_at)
      VALUES ('r-old', 'old-case', 'k-old', 'video/mp4', 4, unixepoch())`).run();
    await DB.prepare(`INSERT INTO retention_legal_holds
      (id, record_type, record_key, disposal_stage, authorized_role, starts_at, review_at)
      VALUES ('hold', 'age_review_case', 'old-case', 'consent_video', 'privacy/legal', '2020-01-01T00:00:00Z', '2030-01-01T00:00:00Z')`).run();

    await runRetentionDisposal({ DB, PROTECTED_MINOR_TOMBSTONE_KEY: KEY, CONSENT_VIDEO_BUCKET: fakeBucket(['k-old']).bucket });

    expect(await DB.prepare("SELECT id FROM age_review_cases WHERE id = 'old-case'").first()).toEqual({ id: 'old-case' });
  });
});
