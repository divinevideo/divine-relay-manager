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
    // Only the watcher's lookup is paused; the family start captures its own.
    vi.mocked(fetchAccountIdentity).mockClear();
    vi.mocked(fetchAccountIdentity).mockResolvedValue({ completed: true, profile: null });
    vi.mocked(fetchAccountIdentity).mockImplementationOnce(async () => {
      lookupStarted();
      await lookupGate;
      return { completed: true, profile: { name: 'Synthetic name', nip05: null, vineUsername: 'synthetic' } };
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
    expect(fetchAccountIdentity).toHaveBeenCalledTimes(2);
    expect((await DB.prepare("SELECT COUNT(*) AS count FROM age_review_cases WHERE pubkey = ? AND state NOT IN ('cleared', 'denied_closed')").bind(owner).first<{ count: number }>())?.count).toBe(1);
    expect((await DB.prepare("SELECT COUNT(*) AS count FROM moderation_decisions WHERE action = 'age_review_case_created'").first<{ count: number }>())?.count).toBe(0);
  });
  it('keeps the report identity when the family case opened without a completed capture', async () => {
    await DB.prepare('DELETE FROM age_review_cases').run();
    let releaseLookup!: () => void;
    let lookupStarted!: () => void;
    const lookupGate = new Promise<void>((resolve) => { releaseLookup = resolve; });
    const lookupEntered = new Promise<void>((resolve) => { lookupStarted = resolve; });
    vi.mocked(fetchAccountIdentity).mockResolvedValue({ completed: false, profile: null });
    vi.mocked(fetchAccountIdentity).mockImplementationOnce(async () => {
      lookupStarted();
      await lookupGate;
      return { completed: true, profile: { name: 'Synthetic name', nip05: null, vineUsername: 'synthetic' } };
    });
    const state = {
      storage: { get: async () => undefined, put: async () => {} },
      blockConcurrencyWhile: async (callback: () => Promise<void>) => callback(),
    } as unknown as DurableObjectState;
    const watcher = new ReportWatcher(state, { DB });
    const owner = '3'.repeat(64);
    const event: ReportEvent = { id: '4'.repeat(64), pubkey: '5'.repeat(64), kind: 1984,
      content: '', tags: [['p', owner]], created_at: Math.floor(Date.now() / 1000) };
    const report = watcher['createAgeReviewCase'](event, owner);
    await lookupEntered;
    await handleStartGreenlight(owner, { DB }, {});
    releaseLookup();
    await report;
    const row = await DB.prepare('SELECT account_name, account_vine_username, identity_captured_at FROM age_review_cases WHERE pubkey = ?')
      .bind(owner).first<{ account_name: string; account_vine_username: string; identity_captured_at: string | null }>();
    expect(row).toMatchObject({ account_name: 'Synthetic name', account_vine_username: 'synthetic' });
    expect(row?.identity_captured_at).toBeTruthy();
  });
  it('captures the account identity when a family starts, before any restriction can hide it', async () => {
    await DB.prepare('DELETE FROM age_review_cases').run();
    vi.mocked(fetchAccountIdentity).mockReset();
    vi.mocked(fetchAccountIdentity).mockResolvedValue({ completed: true, profile: { name: 'Synthetic name', nip05: null, vineUsername: 'synthetic' } });
    const owner = '6'.repeat(64);
    await handleStartGreenlight(owner, { DB }, {});
    // A resume reuses the case and does not look again.
    await handleStartGreenlight(owner, { DB }, {});
    expect(fetchAccountIdentity).toHaveBeenCalledTimes(1);
    const row = await DB.prepare('SELECT account_name, account_vine_username, identity_captured_at FROM age_review_cases WHERE pubkey = ?')
      .bind(owner).first<{ account_name: string; account_vine_username: string; identity_captured_at: string | null }>();
    expect(row).toMatchObject({ account_name: 'Synthetic name', account_vine_username: 'synthetic' });
    expect(row?.identity_captured_at).toBeTruthy();
  });
});
