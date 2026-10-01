// Real-D1 (Miniflare SQLite) validation of the kind-scoped bulk delete job:
// ensureBulkJobsTable adds the `kind` column to a bulk_jobs table created before
// it existed, the job row round-trips the kind, and the per-event decision rows
// land with the requesting moderator and report. The decision write is
// non-critical and swallows its own errors, so a column-name mistake there
// would pass every mocked test; only real SQLite catches it.
import { Miniflare } from 'miniflare';
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { ensureSchema } from '../src/db';
import {
  ensureBulkJobsTable,
  handleBulkModerateEnqueue,
  handleBulkJobStatus,
  processBulkJob,
  type BulkModerateEnv,
} from '../src/bulk-moderate';
import type { BulkJob, BulkJobMessage, BulkEnqueueResponse } from '../../shared/bulk-moderation';
import { banEvent } from '../src/nip86';

vi.mock('../src/nip86', () => ({
  getAdminPubkey: vi.fn().mockResolvedValue('f'.repeat(64)),
  banEvent: vi.fn().mockResolvedValue({ success: true }),
}));
vi.mock('../src/zendesk-sync', () => ({
  syncZendeskAfterAction: vi.fn().mockResolvedValue(undefined),
}));

const PUBKEY = 'a'.repeat(64);
const MODERATOR = 'd'.repeat(64);
const REPORT_ID = 'e'.repeat(64);

let mf: Miniflare;
let DB: D1Database;

beforeAll(async () => {
  mf = new Miniflare({
    modules: true,
    script: 'export default { fetch() { return new Response("ok"); } };',
    compatibilityDate: '2024-12-01',
    compatibilityFlags: ['nodejs_compat'],
    d1Databases: ['DB'],
  });
  DB = (await mf.getD1Database('DB')) as unknown as D1Database;
  // A bulk_jobs table as it exists today, before the kind column, holding a job.
  await DB.prepare(
    `CREATE TABLE bulk_jobs (
      job_id TEXT PRIMARY KEY, pubkey TEXT NOT NULL, action TEXT NOT NULL, status TEXT NOT NULL,
      events_processed INTEGER NOT NULL DEFAULT 0, media_processed INTEGER NOT NULL DEFAULT 0,
      failures TEXT NOT NULL DEFAULT '[]', failures_dropped INTEGER NOT NULL DEFAULT 0,
      version INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    )`
  ).run();
  await DB.prepare(
    `INSERT INTO bulk_jobs (job_id, pubkey, action, status, created_at, updated_at) VALUES ('legacy-job', ?, 'delete-all', 'done', 't', 't')`
  ).bind(PUBKEY).run();
  await ensureSchema(DB); // moderation_decisions
});

afterAll(async () => {
  await mf?.dispose();
});

describe('bulk_jobs kind column on a real D1', () => {
  it('adds the kind column to an existing table and leaves old jobs unscoped', async () => {
    await ensureBulkJobsTable(DB);

    const cols = await DB.prepare(`SELECT name FROM pragma_table_info('bulk_jobs')`).all<{ name: string }>();
    expect(cols.results.map((c) => c.name)).toContain('kind');
    const legacy = await (await handleBulkJobStatus('legacy-job', { DB, RELAY_URL: 'wss://relay.test' } as BulkModerateEnv, {})).json() as BulkJob;
    expect(legacy.status).toBe('done');
    expect('kind' in legacy).toBe(false);
  });

  it('round-trips the kind and writes attributed decision rows for each deleted event', async () => {
    const sent: BulkJobMessage[] = [];
    const env = {
      NOSTR_NSEC: 'unused',
      RELAY_URL: 'wss://relay.test',
      DB,
      BULK_QUEUE: { send: async (m: BulkJobMessage) => { sent.push(m); } },
    } as unknown as BulkModerateEnv;
    const req = new Request('https://test/api/bulk-moderate', {
      method: 'POST',
      body: JSON.stringify({ pubkey: PUBKEY, action: 'delete-kind', kind: 7, reason: 'spam', moderatorPubkey: MODERATOR, reportId: REPORT_ID }),
    });
    const { jobId } = await (await handleBulkModerateEnqueue(req, env, {})).json() as BulkEnqueueResponse;

    const relayEvents = [
      { id: '1'.repeat(64), kind: 7, content: '', tags: [], created_at: 2 },
      { id: '2'.repeat(64), kind: 7, content: '', tags: [], created_at: 1 },
    ];
    vi.spyOn(globalThis, 'WebSocket').mockImplementation((function () {
      const listeners = new Map<string, Array<(value?: unknown) => void>>();
      const emit = (type: string, value?: unknown) => listeners.get(type)?.forEach((h) => h(value));
      queueMicrotask(() => emit('open'));
      return {
        addEventListener: (t: string, h: (value?: unknown) => void) => listeners.set(t, [...(listeners.get(t) || []), h]),
        send: (payload: string) => {
          const data = JSON.parse(payload);
          if (data[0] !== 'REQ') return;
          queueMicrotask(() => {
            // Like the relay, stop listing an event once it is banned.
            const banned = new Set(vi.mocked(banEvent).mock.calls.map((c) => c[0]));
            for (const ev of relayEvents.filter((e) => !banned.has(e.id))) emit('message', { data: JSON.stringify(['EVENT', data[1], ev]) });
            emit('message', { data: JSON.stringify(['EOSE', data[1]]) });
          });
        },
        close: () => {},
      };
    } as unknown as typeof WebSocket));

    // Drain: the sweep that deletes both, then the empty sweep that confirms it.
    for (let next = sent.shift(), n = 0; next && n < 10; next = sent.shift(), n++) {
      await processBulkJob(next, env);
    }

    const job = await (await handleBulkJobStatus(jobId, env, {})).json() as BulkJob;
    expect(job).toMatchObject({ status: 'done', kind: 7, eventsProcessed: 2, failures: [] });
    const decisions = await DB.prepare(
      `SELECT target_id, action, reason, moderator_pubkey, report_id FROM moderation_decisions ORDER BY target_id`
    ).all();
    expect(decisions.results).toEqual([
      { target_id: '1'.repeat(64), action: 'delete_event', reason: 'spam', moderator_pubkey: MODERATOR, report_id: REPORT_ID },
      { target_id: '2'.repeat(64), action: 'delete_event', reason: 'spam', moderator_pubkey: MODERATOR, report_id: REPORT_ID },
    ]);
  });
});
