import { Miniflare } from 'miniflare';
import { DEADLINE_DAYS, type AgeReviewCase } from '../../shared/age-review';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ensureSchema } from '../src/db';
import { handleStartGreenlight, handleGetModerationStatus, handleUpdateAgeReviewCase } from '../src/age-review';

type StartResponse = {
  restriction: { status: string };
  minorReviewCase: {
    id: string;
    suspectedAgeBand: string;
    allowedResolution: string;
    responseDeadline: { clock: string };
  };
};

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
afterEach(() => { vi.restoreAllMocks(); });

async function start(pubkey = owner) {
  return handleStartGreenlight(pubkey, { DB }, {});
}
describe('starting the existing Greenlight consent process', () => {
  it('creates a real owned 13–15 case without making a voluntary application a moderation restriction', async () => {
    const response = await start();
    expect(response.status).toBe(201);
    const status = await response.json() as StartResponse;
    expect(status.restriction.status).toBe('active');
    expect(status.minorReviewCase.suspectedAgeBand).toBe('age_13_15');
    expect(status.minorReviewCase.allowedResolution).toBe('parent_video_or_email');
    expect(status.minorReviewCase.id).toBeTruthy();
    const row = await DB.prepare('SELECT * FROM age_review_cases WHERE id = ?').bind(status.minorReviewCase.id).first<AgeReviewCase>();
    expect(row?.pubkey).toBe(owner);
    expect(row?.state).toBe('open_reported');
    expect(row?.deadline_at).toBeNull();
    const reloaded = await (await handleGetModerationStatus(owner, { DB }, {})).json() as StartResponse;
    expect(reloaded.restriction.status).toBe('active');
    expect(reloaded.minorReviewCase.id).toBe(status.minorReviewCase.id);
    expect(reloaded.minorReviewCase.responseDeadline.clock).toBe('not_applicable');
  });
  it('records moderator intervention without attribution and starts the existing response clock on restriction', async () => {
    const body = await (await start()).json() as StartResponse;
    const id = body.minorReviewCase.id;
    const patch = (state: string) => handleUpdateAgeReviewCase(new Request('https://api.test/case', {
      method: 'PATCH', body: JSON.stringify({ state }),
    }), id, { DB }, {}, undefined);
    await patch('under_moderator_review');
    const reviewed = await DB.prepare('SELECT * FROM age_review_cases WHERE id = ?').bind(id).first<AgeReviewCase>();
    expect(reviewed?.moderation_started_at).toBeTruthy();
    expect(reviewed?.moderator_pubkey).toBeNull();
    expect(reviewed?.deadline_at).toBeNull();
    const before = Date.now();
    await patch('restricted_pending_user_response');
    const restricted = await DB.prepare('SELECT * FROM age_review_cases WHERE id = ?').bind(id).first<AgeReviewCase>();
    expect(Date.parse(restricted!.deadline_at!)).toBeGreaterThanOrEqual(before + DEADLINE_DAYS * 864e5);
    expect(Date.parse(restricted!.deadline_at!)).toBeLessThanOrEqual(Date.now() + DEADLINE_DAYS * 864e5);
    expect(restricted?.moderation_started_at).toBe(reviewed?.moderation_started_at);
    const status = await (await handleGetModerationStatus(owner, { DB }, {})).json() as StartResponse;
    expect(status.restriction.status).toBe('restricted_minor_review');
    expect(status.minorReviewCase.responseDeadline.clock).toBe('running');
  });
  it('can pause the response clock in the same moderator action that first restricts a family case', async () => {
    const body = await (await start()).json() as StartResponse;
    const id = body.minorReviewCase.id;
    const patch = (body: Record<string, unknown>) => handleUpdateAgeReviewCase(new Request('https://api.test/case', {
      method: 'PATCH', body: JSON.stringify(body),
    }), id, { DB }, {}, undefined);
    await patch({ state: 'under_moderator_review' });
    await patch({ state: 'restricted_pending_user_response', clock_paused: true });
    const status = await (await handleGetModerationStatus(owner, { DB }, {})).json() as StartResponse;
    expect(status.minorReviewCase.responseDeadline.clock).toBe('paused');
  });
  // #178 phase 2: the PATCH no longer writes moderator_pubkey from its body, and
  // does not write the verified moderator there either. The column gates
  // voluntary-case detection and report attachment (moderator_pubkey IS NULL),
  // so writing it would change both.
  it('a greenlight case stays voluntary after a PATCH that names a moderator in the body', async () => {
    const body = await (await start()).json() as StartResponse;
    const id = body.minorReviewCase.id;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const res = await handleUpdateAgeReviewCase(new Request('https://api.test/case', {
      method: 'PATCH', body: JSON.stringify({ resolution_note: 'family called', moderator_pubkey: other }),
    }), id, { DB }, {}, 'e'.repeat(64));
    expect(res.status).toBe(200);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(`claimed moderator ${other} differs`));
    const row = await DB.prepare('SELECT * FROM age_review_cases WHERE id = ?').bind(id).first<AgeReviewCase>();
    expect(row?.moderator_pubkey).toBeNull();
    // A repeat start resumes the voluntary case instead of refusing it as another process.
    const again = await start();
    expect(again.status).toBe(200);
    expect((await again.json() as StartResponse).minorReviewCase.id).toBe(id);
  });
  it('an unreviewed report still takes a family application after a PATCH that names a moderator in the body', async () => {
    await DB.prepare("INSERT INTO age_review_cases (id, pubkey, state, suspected_age_band, allowed_resolution, created_via, report_id) VALUES ('named', ?, 'open_reported', 'age_13_15', 'parent_video_or_email', 'report', 'report-1')")
      .bind(owner).run();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const res = await handleUpdateAgeReviewCase(new Request('https://api.test/case', {
      method: 'PATCH', body: JSON.stringify({ resolution_note: 'looked', moderator_pubkey: other }),
    }), 'named', { DB }, {}, 'e'.repeat(64));
    expect(res.status).toBe(200);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(`claimed moderator ${other} differs`));
    const response = await start();
    expect(response.status).toBe(200);
    expect((await response.json() as StartResponse).minorReviewCase.id).toBe('named');
    const row = await DB.prepare("SELECT * FROM age_review_cases WHERE id = 'named'").first<AgeReviewCase>();
    expect(row?.greenlight_requested_at).toBeTruthy();
  });
  it('resumes the same case on retries and concurrent starts', async () => {
    const responses = await Promise.all([start(), start(), start()]);
    const bodies = await Promise.all(responses.map((response) => response.json() as Promise<StartResponse>));
    expect(new Set(bodies.map((body) => body.minorReviewCase.id)).size).toBe(1);
    expect((await DB.prepare('SELECT COUNT(*) AS count FROM age_review_cases').first<{ count: number }>())?.count).toBe(1);
  });
  it('does not reuse another account’s application', async () => {
    const first = await (await start()).json() as StartResponse;
    const second = await (await start(other)).json() as StartResponse;
    expect(second.minorReviewCase.id).not.toBe(first.minorReviewCase.id);
  });
  it('uses an unreviewed report without losing its provenance or imposing a restriction', async () => {
    await DB.prepare("INSERT INTO age_review_cases (id, pubkey, state, suspected_age_band, allowed_resolution, created_via, report_id, reporter_pubkey) VALUES ('reported', ?, 'open_reported', 'age_13_15', 'parent_video_or_email', 'report', 'report-1', ?)")
      .bind(owner, other).run();
    const response = await start();
    expect(response.status).toBe(200);
    const body = await response.json() as StartResponse;
    expect(body.restriction.status).toBe('active');
    expect(body.minorReviewCase.id).toBe('reported');
    const row = await DB.prepare("SELECT * FROM age_review_cases WHERE id = 'reported'").first<AgeReviewCase>();
    expect(row?.created_via).toBe('report');
    expect(row?.report_id).toBe('report-1');
    expect(row?.reporter_pubkey).toBe(other);
    expect(row?.greenlight_requested_at).toBeTruthy();
  });
  it('does not change a report already assigned to a moderator', async () => {
    await DB.prepare("INSERT INTO age_review_cases (id, pubkey, state, suspected_age_band, allowed_resolution, created_via, moderator_pubkey) VALUES ('assigned', ?, 'open_reported', 'age_13_15', 'parent_video_or_email', 'report', ?)")
      .bind(owner, other).run();
    expect((await start()).status).toBe(409);
    expect((await DB.prepare("SELECT greenlight_requested_at FROM age_review_cases WHERE id = 'assigned'").first<AgeReviewCase>())?.greenlight_requested_at).toBeNull();
  });
  it('keeps an existing moderator restriction and reuses its eligible case', async () => {
    await DB.prepare("INSERT INTO age_review_cases (id, pubkey, state, suspected_age_band, allowed_resolution) VALUES ('restricted', ?, 'restricted_pending_parental_consent', 'age_13_15', 'parent_video_or_email')").bind(owner).run();
    const response = await start();
    const body = await response.json() as StartResponse;
    expect(response.status).toBe(200);
    expect(body.restriction.status).toBe('restricted_minor_review');
    expect(body.minorReviewCase.id).toBe('restricted');
  });
  // A report case stored under the uppercase pubkey neither blocks the start
  // nor stands in for its case. All three of the start's checks match the
  // pubkey exactly (#313): the getActiveAgeReviewCase lookup before the insert,
  // the insert's NOT EXISTS guard, and the lookup after it. So an uppercase
  // case is invisible to the start.
  it('starts as before beside a report case stored under the uppercase pubkey', async () => {
    await DB.prepare("INSERT INTO age_review_cases (id, pubkey, state, suspected_age_band, allowed_resolution, created_via) VALUES ('report-upper', ?, 'open_reported', 'age_13_15', 'parent_video_or_email', 'report')")
      .bind(owner.toUpperCase()).run();
    const response = await start();
    expect(response.status).toBe(201);
    const body = await response.json() as StartResponse;
    expect(body.minorReviewCase.id).not.toBe('report-upper');
  });
  it('does not overwrite an under-13 or 16+ review case with a 13–15 application', async () => {
    for (const band of ['under_13', 'age_16_plus_claimed']) {
      await DB.prepare('DELETE FROM age_review_cases').run();
      await DB.prepare("INSERT INTO age_review_cases (id, pubkey, suspected_age_band, allowed_resolution) VALUES ('existing', ?, ?, 'support_review_only')").bind(owner, band).run();
      expect((await start()).status).toBe(409);
      expect((await DB.prepare('SELECT suspected_age_band FROM age_review_cases').first<AgeReviewCase>())?.suspected_age_band).toBe(band);
    }
  });
});
