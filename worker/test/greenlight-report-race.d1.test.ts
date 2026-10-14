import { Miniflare } from 'miniflare';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { ensureSchema } from '../src/db';
import { handleStartGreenlight } from '../src/age-review';
import { ReportWatcher, type ReportEvent } from '../src/ReportWatcher';
import { fetchAccountIdentity } from '../src/relay-profile';

vi.mock('../src/relay-profile', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/relay-profile')>(),
  fetchAccountIdentity: vi.fn(),
}));

let mf: Miniflare;
let DB: D1Database;
beforeAll(async () => {
  mf = new Miniflare({ modules: true, script: 'export default { fetch() { return new Response("ok"); } };', compatibilityDate: '2024-12-01', d1Databases: ['DB'] });
  DB = (await mf.getD1Database('DB')) as unknown as D1Database;
  await ensureSchema(DB);
});
afterAll(async () => { await mf.dispose(); });

describe('a Greenlight start racing an incoming age report', () => {
  it.each(['open_reported', 'submitted_for_review'])('attaches an incoming report to a %s family case without replacing an earlier reporter', async (caseState) => {
    await DB.prepare('DELETE FROM age_review_cases').run();
    vi.mocked(fetchAccountIdentity).mockResolvedValue({ completed: true, profile: null });
    const state = { storage: { get: async () => undefined, put: async () => {} }, blockConcurrencyWhile: async (callback: () => Promise<void>) => callback() } as unknown as DurableObjectState;
    const watcher = new ReportWatcher(state, { DB });
    const owner = 'd'.repeat(64);
    await handleStartGreenlight(owner, { DB }, {});
    await DB.prepare('UPDATE age_review_cases SET state = ? WHERE pubkey = ?').bind(caseState, owner).run();
    const event: ReportEvent = { id: 'e'.repeat(64), pubkey: 'f'.repeat(64), kind: 1984, content: '', tags: [['p', owner]], created_at: Math.floor(Date.now() / 1000) };
    await watcher['createAgeReviewCase'](event, owner);
    await watcher['createAgeReviewCase']({ ...event, id: '1'.repeat(64), pubkey: '2'.repeat(64) }, owner);
    const row = await DB.prepare('SELECT report_id, reporter_pubkey, created_via FROM age_review_cases WHERE pubkey = ?').bind(owner).first();
    expect(row).toEqual({ report_id: event.id, reporter_pubkey: event.pubkey, created_via: 'greenlight_application' });
  });
  it('keeps one active case when the family starts during the report identity lookup', async () => {
    let releaseLookup!: () => void;
    let lookupStarted!: () => void;
    const lookupGate = new Promise<void>((resolve) => { releaseLookup = resolve; });
    const lookupEntered = new Promise<void>((resolve) => { lookupStarted = resolve; });
    vi.mocked(fetchAccountIdentity).mockImplementation(async () => {
      lookupStarted();
      await lookupGate;
      return { completed: true, profile: null };
    });
    const state = {
      storage: { get: async () => undefined, put: async () => {} },
      blockConcurrencyWhile: async (callback: () => Promise<void>) => callback(),
    } as unknown as DurableObjectState;
    const watcher = new ReportWatcher(state, { DB });
    const owner = 'a'.repeat(64);
    const event: ReportEvent = { id: 'c'.repeat(64), pubkey: 'b'.repeat(64), kind: 1984,
      content: '', tags: [['p', owner]], created_at: Math.floor(Date.now() / 1000) };
    // Exercise the real report-case routine against D1; the only paused port
    // is its external identity lookup, after the first active-case read.
    const report = watcher['createAgeReviewCase'](event, owner);
    await lookupEntered;
    const response = await handleStartGreenlight(owner, { DB }, {});
    releaseLookup();
    await report;
    expect(response.status).toBe(201);
    const row = await DB.prepare('SELECT report_id, reporter_pubkey FROM age_review_cases WHERE pubkey = ?').bind(owner).first<{ report_id: string; reporter_pubkey: string }>();
    expect(row).toEqual({ report_id: event.id, reporter_pubkey: event.pubkey });
    expect((await DB.prepare("SELECT COUNT(*) AS count FROM age_review_cases WHERE pubkey = ? AND state NOT IN ('cleared', 'denied_closed')").bind(owner).first<{ count: number }>())?.count).toBe(1);
    expect((await DB.prepare("SELECT COUNT(*) AS count FROM moderation_decisions WHERE action = 'age_review_case_created'").first<{ count: number }>())?.count).toBe(0);
  });
});
