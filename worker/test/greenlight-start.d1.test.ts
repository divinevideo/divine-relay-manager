import { Miniflare } from 'miniflare';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ensureSchema } from '../src/db';
import { handleStartGreenlight, handleGetModerationStatus } from '../src/age-review';

let mf: Miniflare;
let DB: D1Database;
const owner = 'a'.repeat(64);
const other = 'b'.repeat(64);
beforeAll(async () => {
  mf = new Miniflare({ modules: true, script: 'export default { fetch() { return new Response("ok"); } };', compatibilityDate: '2024-12-01', d1Databases: ['DB'] });
  DB = (await mf.getD1Database('DB')) as unknown as D1Database;
  await ensureSchema(DB);
});
afterAll(async () => { await mf.dispose(); });
beforeEach(async () => { await DB.prepare('DELETE FROM age_review_cases').run(); });

async function start(pubkey = owner) {
  return handleStartGreenlight(pubkey, { DB }, {});
}
describe('starting the existing Greenlight consent process', () => {
  it('creates a real owned 13–15 case without making a voluntary application a moderation restriction', async () => {
    const response = await start();
    expect(response.status).toBe(201);
    const status = await response.json() as any;
    expect(status.restriction.status).toBe('active');
    expect(status.minorReviewCase.suspectedAgeBand).toBe('age_13_15');
    expect(status.minorReviewCase.allowedResolution).toBe('parent_video_or_email');
    expect(status.minorReviewCase.id).toBeTruthy();
    const row = await DB.prepare('SELECT * FROM age_review_cases WHERE id = ?').bind(status.minorReviewCase.id).first<any>();
    expect(row.pubkey).toBe(owner);
    expect(row.state).toBe('open_reported');
    expect(row.deadline_at).toBeNull();
    const reloaded = await (await handleGetModerationStatus(owner, { DB }, {})).json() as any;
    expect(reloaded.restriction.status).toBe('active');
    expect(reloaded.minorReviewCase.id).toBe(status.minorReviewCase.id);
    expect(reloaded.minorReviewCase.responseDeadline.clock).toBe('not_applicable');
  });
  it('resumes the same case on retries and concurrent starts', async () => {
    const responses = await Promise.all([start(), start(), start()]);
    const bodies = await Promise.all(responses.map((response) => response.json() as Promise<any>));
    expect(new Set(bodies.map((body) => body.minorReviewCase.id)).size).toBe(1);
    expect((await DB.prepare('SELECT COUNT(*) AS count FROM age_review_cases').first<any>()).count).toBe(1);
  });
  it('does not reuse another account’s application', async () => {
    const first = await (await start()).json() as any;
    const second = await (await start(other)).json() as any;
    expect(second.minorReviewCase.id).not.toBe(first.minorReviewCase.id);
  });
  it('uses an unreviewed report without losing its provenance or imposing a restriction', async () => {
    await DB.prepare("INSERT INTO age_review_cases (id, pubkey, state, suspected_age_band, allowed_resolution, created_via, report_id, reporter_pubkey) VALUES ('reported', ?, 'open_reported', 'age_13_15', 'parent_video_or_email', 'report', 'report-1', ?)")
      .bind(owner, other).run();
    const response = await start();
    expect(response.status).toBe(200);
    const body = await response.json() as any;
    expect(body.restriction.status).toBe('active');
    expect(body.minorReviewCase.id).toBe('reported');
    const row = await DB.prepare("SELECT * FROM age_review_cases WHERE id = 'reported'").first<any>();
    expect(row.created_via).toBe('report');
    expect(row.report_id).toBe('report-1');
    expect(row.reporter_pubkey).toBe(other);
    expect(row.greenlight_requested_at).toBeTruthy();
  });
  it('does not change a report already assigned to a moderator', async () => {
    await DB.prepare("INSERT INTO age_review_cases (id, pubkey, state, suspected_age_band, allowed_resolution, created_via, moderator_pubkey) VALUES ('assigned', ?, 'open_reported', 'age_13_15', 'parent_video_or_email', 'report', ?)")
      .bind(owner, other).run();
    expect((await start()).status).toBe(409);
    expect((await DB.prepare("SELECT greenlight_requested_at FROM age_review_cases WHERE id = 'assigned'").first<any>()).greenlight_requested_at).toBeNull();
  });
  it('keeps an existing moderator restriction and reuses its eligible case', async () => {
    await DB.prepare("INSERT INTO age_review_cases (id, pubkey, state, suspected_age_band, allowed_resolution) VALUES ('restricted', ?, 'restricted_pending_parental_consent', 'age_13_15', 'parent_video_or_email')").bind(owner).run();
    const response = await start();
    const body = await response.json() as any;
    expect(response.status).toBe(200);
    expect(body.restriction.status).toBe('restricted_minor_review');
    expect(body.minorReviewCase.id).toBe('restricted');
  });
  it('does not overwrite an under-13 or 16+ review case with a 13–15 application', async () => {
    for (const band of ['under_13', 'age_16_plus_claimed']) {
      await DB.prepare('DELETE FROM age_review_cases').run();
      await DB.prepare("INSERT INTO age_review_cases (id, pubkey, suspected_age_band, allowed_resolution) VALUES ('existing', ?, ?, 'support_review_only')").bind(owner, band).run();
      expect((await start()).status).toBe(409);
      expect((await DB.prepare('SELECT suspected_age_band FROM age_review_cases').first<any>()).suspected_age_band).toBe(band);
    }
  });
});
