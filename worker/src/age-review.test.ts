import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  handleGetAgeReviewCases,
  handleGetAgeReviewCase,
  handleGetActiveAgeReviewCase,
  handleUpdateAgeReviewCase,
  handleGetModerationStatus,
  handleParentContact,
  handleAgeReviewReplyWebhook,
  handleCreateMinorAccount,
  checkAgeReviewDeadlines,
  sendDbUnavailableAlert,
  syncAgeReviewTicketResolution,
  getAgeReviewConfig,
  updateAgeReviewConfig,
  bucketModerationCounts,
  fetchZendeskTagCount,
  handleGetAgeReviewFunnel,
  ageReviewActiveGuard,
  composeContactNotes,
  buildParentOutreachBody,
  type AgeReviewEnv,
} from './age-review';
import type { AgeReviewCase, MinorReviewResponseDeadline } from '../../shared/age-review';
import { deriveResponseClock, FUNNEL_ZENDESK_QUERIES, toUtcIso } from '../../shared/age-review';
import { suspendUser, unsuspendUser, banUser, clearVerifiedMinor, createMinorAccount } from './keycast-client';
import { suspendPubkey, unsuspendPubkey, banPubkey } from './nip86';

vi.mock('./keycast-client', () => ({
  suspendUser: vi.fn().mockResolvedValue({ success: true }),
  unsuspendUser: vi.fn().mockResolvedValue({ success: true }),
  banUser: vi.fn().mockResolvedValue({ success: true }),
  clearVerifiedMinor: vi.fn().mockResolvedValue({ success: true }),
  createMinorAccount: vi.fn().mockResolvedValue({ success: true, pubkey: 'a'.repeat(64), claim_url: 'https://login.test/claim/abc' }),
}));

// Isolate the handler from the relay: these tests exercise state transitions +
// Keycast wiring, not bulk content moderation. By default the bulk leg succeeds;
// individual tests can override to assert failure-surfacing.
vi.mock('./bulk-moderate', () => ({
  // age-review enforcement now calls runBulkModeration directly (synchronous,
  // returns a BulkModerateResult), not the async HTTP enqueue path.
  runBulkModeration: vi.fn().mockResolvedValue({ success: true, eventsProcessed: 0, mediaProcessed: 0, failures: [] }),
}));

// Relay-level NIP-86 enforcement. Stubbed to succeed by default; the
// real wire contract is verified separately in nip86.test.ts.
vi.mock('./nip86', () => ({
  suspendPubkey: vi.fn().mockResolvedValue({ success: true }),
  unsuspendPubkey: vi.fn().mockResolvedValue({ success: true }),
  banPubkey: vi.fn().mockResolvedValue({ success: true }),
}));

const corsHeaders = { 'Access-Control-Allow-Origin': '*' };

function makeEnv(db?: unknown, overrides: Partial<AgeReviewEnv> = {}): AgeReviewEnv {
  return {
    NOSTR_NSEC: 'nsec1test',
    RELAY_URL: 'wss://relay.test',
    ...(db !== undefined ? { DB: db as D1Database } : {}),
    ...overrides,
  };
}

function makeCase(overrides: Partial<AgeReviewCase> = {}): AgeReviewCase {
  return {
    id: 'case-1',
    pubkey: 'a'.repeat(64),
    reporter_pubkey: 'b'.repeat(64),
    report_id: 'r'.repeat(64),
    suspected_age_band: 'age_13_15',
    state: 'open_reported',
    allowed_resolution: 'parent_video_or_email',
    parent_contact_email: null,
    deadline_at: new Date(Date.now() + 10 * 24 * 60 * 60 * 1000).toISOString(),
    clock_paused: 0,
    clock_paused_at: null,
    remaining_days_when_paused: null,
    moderator_pubkey: null,
    resolution_note: null,
    last_alerted_at: null,
    zendesk_ticket_id: null,
    created_via: null,
    claim_link_url: null,
    claim_link_expires_at: null,
    account_name: null,
    account_nip05: null,
    account_vine_username: null,
    identity_captured_at: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    version: 0,
    ...overrides,
  };
}

type MockDb = { prepare: ReturnType<typeof vi.fn> };

function createMockDb(cases: AgeReviewCase[] = []): MockDb {
  const caseMap = new Map(cases.map(c => [c.id, c]));

  return {
    prepare: vi.fn().mockImplementation((sql: string) => ({
      bind: vi.fn().mockReturnValue({
        all: vi.fn().mockResolvedValue({ results: cases }),
        first: vi.fn().mockImplementation(async () => {
          if (sql.includes('WHERE id = ?')) {
            return caseMap.get(cases[0]?.id) ?? null;
          }
          if (sql.includes('WHERE pubkey = ?')) {
            return cases.find(c => !['cleared', 'denied_closed'].includes(c.state)) ?? null;
          }
          return null;
        }),
        run: vi.fn().mockResolvedValue({ meta: { changes: 1 } }),
      }),
    })),
  };
}

// -- handleGetAgeReviewCases --------------------------------------------------

describe('handleGetAgeReviewCases', () => {
  it('returns cases from DB', async () => {
    const c = makeCase();
    const db = createMockDb([c]);
    const req = new Request('https://api.test/api/age-review/cases');
    const res = await handleGetAgeReviewCases(req, makeEnv(db), corsHeaders);
    const body = await res.json() as { success: boolean; cases: AgeReviewCase[] };

    expect(res.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.cases).toHaveLength(1);
  });

  it('returns 500 when DB not configured', async () => {
    const req = new Request('https://api.test/api/age-review/cases');
    const res = await handleGetAgeReviewCases(req, makeEnv(), corsHeaders);
    expect(res.status).toBe(500);
  });
});

// -- handleGetAgeReviewCase ---------------------------------------------------

describe('handleGetAgeReviewCase', () => {
  it('returns a single case', async () => {
    const c = makeCase();
    const db = createMockDb([c]);
    const res = await handleGetAgeReviewCase('case-1', makeEnv(db), corsHeaders);
    const body = await res.json() as { success: boolean; case: AgeReviewCase };

    expect(res.status).toBe(200);
    expect(body.case.id).toBe('case-1');
  });

  it('returns 404 for unknown case', async () => {
    const db = createMockDb([]);
    const res = await handleGetAgeReviewCase('nonexistent', makeEnv(db), corsHeaders);
    expect(res.status).toBe(404);
  });
});

// -- handleGetActiveAgeReviewCase ---------------------------------------------

describe('handleGetActiveAgeReviewCase', () => {
  it('returns the active case for a pubkey', async () => {
    const c = makeCase({ state: 'restricted_pending_user_response' });
    const res = await handleGetActiveAgeReviewCase(c.pubkey, makeEnv(createMockDb([c])), corsHeaders);
    expect(res.status).toBe(200);
    const body = await res.json() as { success: boolean; case: AgeReviewCase | null };
    expect(body.success).toBe(true);
    expect(body.case?.id).toBe(c.id);
  });

  it('returns a null case when the pubkey has no active case', async () => {
    const res = await handleGetActiveAgeReviewCase('a'.repeat(64), makeEnv(createMockDb([])), corsHeaders);
    expect(res.status).toBe(200);
    const body = await res.json() as { success: boolean; case: AgeReviewCase | null };
    expect(body.success).toBe(true);
    expect(body.case).toBeNull();
  });

  it("returns null when the pubkey's only case is terminal (cleared)", async () => {
    const c = makeCase({ state: 'cleared' });
    const res = await handleGetActiveAgeReviewCase(c.pubkey, makeEnv(createMockDb([c])), corsHeaders);
    expect(res.status).toBe(200);
    const body = await res.json() as { success: boolean; case: AgeReviewCase | null };
    expect(body.case).toBeNull();
  });

  it('rejects an invalid pubkey', async () => {
    const res = await handleGetActiveAgeReviewCase('not-a-pubkey', makeEnv(createMockDb([])), corsHeaders);
    expect(res.status).toBe(400);
  });
});

// -- handleUpdateAgeReviewCase ------------------------------------------------

describe('handleUpdateAgeReviewCase', () => {
  let db: MockDb;
  let activeCase: AgeReviewCase;

  beforeEach(() => {
    activeCase = makeCase({ state: 'open_reported' });
    db = createMockDb([activeCase]);
    vi.mocked(suspendUser).mockClear();
    vi.mocked(unsuspendUser).mockClear();
    vi.mocked(banUser).mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('transitions state', async () => {
    const req = new Request('https://api.test/api/age-review/cases/case-1', {
      method: 'PATCH',
      body: JSON.stringify({ state: 'under_moderator_review' }),
    });
    const res = await handleUpdateAgeReviewCase(req, 'case-1', makeEnv(db), corsHeaders);
    expect(res.status).toBe(200);

    const updateCall = db.prepare.mock.calls.find(
      (c: string[]) => c[0]?.includes('UPDATE age_review_cases')
    );
    expect(updateCall).toBeTruthy();
  });

  it('rejects invalid state', async () => {
    const req = new Request('https://api.test/api/age-review/cases/case-1', {
      method: 'PATCH',
      body: JSON.stringify({ state: 'bogus_state' }),
    });
    const res = await handleUpdateAgeReviewCase(req, 'case-1', makeEnv(db), corsHeaders);
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toContain('Invalid state');
  });

  it('rejects invalid state transition', async () => {
    const req = new Request('https://api.test/api/age-review/cases/case-1', {
      method: 'PATCH',
      body: JSON.stringify({ state: 'submitted_for_review' }),
    });
    const res = await handleUpdateAgeReviewCase(req, 'case-1', makeEnv(db), corsHeaders);
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toContain('Cannot transition');
  });

  it('rejects update on terminal case', async () => {
    const closedCase = makeCase({ state: 'cleared' });
    const closedDb = createMockDb([closedCase]);
    const req = new Request('https://api.test/api/age-review/cases/case-1', {
      method: 'PATCH',
      body: JSON.stringify({ state: 'under_moderator_review' }),
    });
    const res = await handleUpdateAgeReviewCase(req, 'case-1', makeEnv(closedDb), corsHeaders);
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toContain('closed case');
  });

  it('pauses clock and records remaining days', async () => {
    const req = new Request('https://api.test/api/age-review/cases/case-1', {
      method: 'PATCH',
      body: JSON.stringify({ clock_paused: true }),
    });
    const res = await handleUpdateAgeReviewCase(req, 'case-1', makeEnv(db), corsHeaders);
    expect(res.status).toBe(200);

    const updateCall = db.prepare.mock.calls.find(
      (c: string[]) => c[0]?.includes('UPDATE') && c[0]?.includes('clock_paused = 1')
    );
    expect(updateCall).toBeTruthy();
  });

  it('clamps an expired clock to zero when pausing it', async () => {
    const expiredCase = makeCase({ deadline_at: '2026-08-25T12:00:00.000Z' });
    const pausedCase = {
      ...expiredCase,
      clock_paused: 1,
      clock_paused_at: '2026-08-26T12:00:00.000Z',
      remaining_days_when_paused: 0,
    };
    const bound: unknown[][] = [];
    let selectCount = 0;
    const expiredDb = {
      prepare: vi.fn().mockImplementation((sql: string) => ({
        bind: vi.fn().mockImplementation((...params: unknown[]) => {
          bound.push(params);
          return {
            first: vi.fn().mockImplementation(async () => {
              if (sql === 'SELECT * FROM age_review_cases WHERE id = ?') {
                selectCount += 1;
                return selectCount === 1 ? expiredCase : pausedCase;
              }
              return null;
            }),
            run: vi.fn().mockResolvedValue({ meta: { changes: 1 } }),
          };
        }),
      })),
    };
    vi.useFakeTimers();
    vi.setSystemTime('2026-08-26T12:00:00.000Z');

    const req = new Request('https://api.test/api/age-review/cases/case-1', {
      method: 'PATCH',
      body: JSON.stringify({ clock_paused: true }),
    });
    const res = await handleUpdateAgeReviewCase(req, 'case-1', makeEnv(expiredDb), corsHeaders);

    expect(res.status).toBe(200);
    expect(bound).toContainEqual(['2026-08-26T12:00:00.000Z', 0, 'case-1', 0]);
  });

  it('resumes clock and sets new deadline', async () => {
    const pausedCase = makeCase({
      clock_paused: 1,
      remaining_days_when_paused: 7.5,
      clock_paused_at: new Date().toISOString(),
    });
    const pausedDb = createMockDb([pausedCase]);

    const req = new Request('https://api.test/api/age-review/cases/case-1', {
      method: 'PATCH',
      body: JSON.stringify({ clock_paused: false }),
    });
    const res = await handleUpdateAgeReviewCase(req, 'case-1', makeEnv(pausedDb), corsHeaders);
    expect(res.status).toBe(200);

    const updateCall = pausedDb.prepare.mock.calls.find(
      (c: string[]) => c[0]?.includes('UPDATE') && c[0]?.includes('clock_paused = 0')
    );
    expect(updateCall).toBeTruthy();
  });

  it('validates email format', async () => {
    const req = new Request('https://api.test/api/age-review/cases/case-1', {
      method: 'PATCH',
      body: JSON.stringify({ parent_contact_email: 'not-an-email' }),
    });
    const res = await handleUpdateAgeReviewCase(req, 'case-1', makeEnv(db), corsHeaders);
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toContain('email');
  });

  it('accepts null email (clears it)', async () => {
    const req = new Request('https://api.test/api/age-review/cases/case-1', {
      method: 'PATCH',
      body: JSON.stringify({ parent_contact_email: null }),
    });
    const res = await handleUpdateAgeReviewCase(req, 'case-1', makeEnv(db), corsHeaders);
    expect(res.status).toBe(200);
  });

  it('syncs Zendesk ticket when transitioning to terminal state', async () => {
    const reviewCase = makeCase({
      state: 'under_moderator_review',
      zendesk_ticket_id: 55,
    });
    const reviewDb = createMockDb([reviewCase]);

    const mockFetch = vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({}) });
    vi.stubGlobal('fetch', mockFetch);

    const req = new Request('https://api.test/api/age-review/cases/case-1', {
      method: 'PATCH',
      body: JSON.stringify({ state: 'cleared', resolution_note: 'Age verified' }),
    });
    const res = await handleUpdateAgeReviewCase(req, 'case-1', makeEnv(reviewDb, {
      ZENDESK_SUBDOMAIN: 'test',
      ZENDESK_API_TOKEN: 'tok',
      ZENDESK_EMAIL: 'agent@test.com',
      ZENDESK_GROUP_ID: '15225535020687',
    }), corsHeaders);
    expect(res.status).toBe(200);

    const zendeskCall = mockFetch.mock.calls.find(
      (call: unknown[]) => (call[0] as string).includes('zendesk.com/api/v2/tickets/55')
    );
    expect(zendeskCall).toBeTruthy();
    const payload = JSON.parse(zendeskCall![1].body);
    expect(payload.ticket.status).toBe('solved');
    expect(payload.ticket.comment.body).toContain('cleared');
    // Routes to the configured group (Trust & Safety), not a personal assignee.
    expect(payload.ticket.group_id).toBe(15225535020687);
    expect(payload.ticket.assignee_email).toBeUndefined();

    vi.unstubAllGlobals();
  });

  it('creates an internal Zendesk ticket when transitioning into a restricted state', async () => {
    const reviewCase = makeCase({
      state: 'under_moderator_review',
      suspected_age_band: 'age_16_plus_claimed',
      deadline_at: '2026-05-30T12:00:00.000Z',
    });
    const updatedCase = {
      ...reviewCase,
      state: 'restricted_pending_support_email',
    };

    const bindCalls: Array<{ sql: string; params: unknown[] }> = [];
    let selectCount = 0;
    const db = {
      prepare: vi.fn().mockImplementation((sql: string) => ({
        bind: vi.fn().mockImplementation((...params: unknown[]) => {
          bindCalls.push({ sql, params });
          return {
            first: vi.fn().mockImplementation(async () => {
              if (sql === 'SELECT * FROM age_review_cases WHERE id = ?') {
                selectCount += 1;
                return selectCount === 1 ? reviewCase : updatedCase;
              }
              return null;
            }),
            run: vi.fn().mockResolvedValue({ meta: { changes: 1 } }),
          };
        }),
      })),
    };

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ ticket: { id: 321 } }),
    });
    vi.stubGlobal('fetch', mockFetch);

    const req = new Request('https://api.test/api/age-review/cases/case-1', {
      method: 'PATCH',
      body: JSON.stringify({ state: 'restricted_pending_support_email' }),
    });
    const res = await handleUpdateAgeReviewCase(req, 'case-1', makeEnv(db, {
      ZENDESK_SUBDOMAIN: 'test',
      ZENDESK_API_TOKEN: 'tok',
      ZENDESK_EMAIL: 'agent@test.com',
      ZENDESK_FIELD_CATEGORY: '1001',
      ZENDESK_FIELD_ISSUE: '1002',
      ZENDESK_FIELD_AGE_REVIEW_DEADLINE: '1003',
    }), corsHeaders);
    const body = await res.json() as { success: boolean; case: AgeReviewCase };

    expect(res.status).toBe(200);
    expect(body.case.zendesk_ticket_id).toBe(321);
    expect(mockFetch).toHaveBeenCalledOnce();
    expect(mockFetch.mock.calls[0][0]).toBe('https://test.zendesk.com/api/v2/tickets');

    const payload = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(payload.ticket.subject).toBe('Age review: 16+ (claimed) account restricted [case-1]');
    expect(payload.ticket.comment.public).toBe(false);
    expect(payload.ticket.tags).toEqual(['age-review', 'age-band-age_16_plus_claimed', 'internal']);
    expect(payload.ticket.custom_fields).toEqual([
      { id: 1001, value: 'trust___safety' },
      { id: 1002, value: 'content_report_under_16' },
      { id: 1003, value: '2026-05-30' },
    ]);

    const ticketStoreCall = bindCalls.find(
      (call) => call.sql.includes('SET zendesk_ticket_id = ?') && call.params[0] === 321 && call.params[1] === 'case-1'
    );
    expect(ticketStoreCall).toBeTruthy();

    vi.unstubAllGlobals();
  });

  // Identity capture (#213). The note previously carried a bare pubkey and no
  // way to reach the case it described, so an agent reading the ticket could
  // not tell which account it concerned or open the review.
  it('puts the case deeplink and captured identity in the internal ticket note', async () => {
    const reviewCase = makeCase({
      state: 'under_moderator_review',
      account_name: 'Some One',
      account_nip05: '_@someuser.divine.video',
    });
    const updatedCase = { ...reviewCase, state: 'restricted_pending_support_email' };

    let selectCount = 0;
    const db = {
      prepare: vi.fn().mockImplementation((sql: string) => ({
        bind: vi.fn().mockImplementation(() => ({
          first: vi.fn().mockImplementation(async () => {
            if (sql === 'SELECT * FROM age_review_cases WHERE id = ?') {
              selectCount += 1;
              return selectCount === 1 ? reviewCase : updatedCase;
            }
            return null;
          }),
          run: vi.fn().mockResolvedValue({ meta: { changes: 1 } }),
        })),
      })),
    };

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ ticket: { id: 322 } }),
    });
    vi.stubGlobal('fetch', mockFetch);

    const req = new Request('https://api.test/api/age-review/cases/case-1', {
      method: 'PATCH',
      body: JSON.stringify({ state: 'restricted_pending_support_email' }),
    });
    await handleUpdateAgeReviewCase(req, 'case-1', makeEnv(db, {
      ZENDESK_SUBDOMAIN: 'test',
      ZENDESK_API_TOKEN: 'tok',
      ZENDESK_EMAIL: 'agent@test.com',
    }), corsHeaders);

    const payload = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(payload.ticket.comment.body).toContain('/age-review?case=case-1');
    expect(payload.ticket.comment.body).toContain('Some One');
    expect(payload.ticket.comment.body).toContain('a'.repeat(64));
    // Agent-only: this block carries the pubkey and must never go public.
    expect(payload.ticket.comment.public).toBe(false);

    vi.unstubAllGlobals();
  });
});

// -- Keycast suspension wiring ------------------------------------------------

describe('Keycast suspension wiring', () => {
  beforeEach(() => {
    vi.mocked(suspendUser).mockClear().mockResolvedValue({ success: true });
    vi.mocked(unsuspendUser).mockClear().mockResolvedValue({ success: true });
    vi.mocked(banUser).mockClear().mockResolvedValue({ success: true });
    vi.mocked(clearVerifiedMinor).mockClear().mockResolvedValue({ success: true });
  });

  it('calls suspendUser when transitioning to restricted_pending_user_response', async () => {
    const reviewCase = makeCase({ state: 'under_moderator_review' });
    const updatedCase = { ...reviewCase, state: 'restricted_pending_user_response' as const };

    let selectCount = 0;
    const db = {
      prepare: vi.fn().mockImplementation((sql: string) => ({
        bind: vi.fn().mockReturnValue({
          first: vi.fn().mockImplementation(async () => {
            if (sql.includes('WHERE id = ?')) {
              selectCount += 1;
              return selectCount === 1 ? reviewCase : updatedCase;
            }
            return null;
          }),
          run: vi.fn().mockResolvedValue({ meta: { changes: 1 } }),
        }),
      })),
    };

    const req = new Request('https://api.test/api/age-review/cases/case-1', {
      method: 'PATCH',
      body: JSON.stringify({ state: 'restricted_pending_user_response' }),
    });
    const res = await handleUpdateAgeReviewCase(req, 'case-1', makeEnv(db), corsHeaders);
    const body = await res.json() as { success: boolean; keycastUpdated: boolean };

    expect(res.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.keycastUpdated).toBe(true);
    expect(suspendUser).toHaveBeenCalledOnce();
    expect(suspendUser).toHaveBeenCalledWith(reviewCase.pubkey, 'age_review', expect.objectContaining({ DB: expect.anything() }));
  });

  it('calls unsuspendUser when transitioning to cleared', async () => {
    const restrictedCase = makeCase({ state: 'restricted_pending_user_response' });
    const updatedCase = { ...restrictedCase, state: 'cleared' as const };

    let selectCount = 0;
    const db = {
      prepare: vi.fn().mockImplementation((sql: string) => ({
        bind: vi.fn().mockReturnValue({
          first: vi.fn().mockImplementation(async () => {
            if (sql.includes('WHERE id = ?')) {
              selectCount += 1;
              return selectCount === 1 ? restrictedCase : updatedCase;
            }
            return null;
          }),
          run: vi.fn().mockResolvedValue({ meta: { changes: 1 } }),
        }),
      })),
    };

    const req = new Request('https://api.test/api/age-review/cases/case-1', {
      method: 'PATCH',
      body: JSON.stringify({ state: 'cleared' }),
    });
    const res = await handleUpdateAgeReviewCase(req, 'case-1', makeEnv(db), corsHeaders);
    const body = await res.json() as { success: boolean; keycastUpdated: boolean };

    expect(res.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.keycastUpdated).toBe(true);
    expect(unsuspendUser).toHaveBeenCalledOnce();
    expect(unsuspendUser).toHaveBeenCalledWith(restrictedCase.pubkey, expect.objectContaining({ DB: expect.anything() }));
  });

  it('calls unsuspendUser when clearing a case that was never restricted', async () => {
    const reviewCase = makeCase({ state: 'under_moderator_review' });
    const updatedCase = { ...reviewCase, state: 'cleared' as const };

    let selectCount = 0;
    const db = {
      prepare: vi.fn().mockImplementation((sql: string) => ({
        bind: vi.fn().mockReturnValue({
          first: vi.fn().mockImplementation(async () => {
            if (sql.includes('WHERE id = ?')) {
              selectCount += 1;
              return selectCount === 1 ? reviewCase : updatedCase;
            }
            return null;
          }),
          run: vi.fn().mockResolvedValue({ meta: { changes: 1 } }),
        }),
      })),
    };

    const req = new Request('https://api.test/api/age-review/cases/case-1', {
      method: 'PATCH',
      body: JSON.stringify({ state: 'cleared' }),
    });
    const res = await handleUpdateAgeReviewCase(req, 'case-1', makeEnv(db), corsHeaders);
    const body = await res.json() as { success: boolean; keycastUpdated: boolean };

    expect(res.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.keycastUpdated).toBe(true);
    expect(unsuspendUser).toHaveBeenCalledOnce();
  });

  it('does not re-suspend when transitioning between restricted states', async () => {
    const restrictedCase = makeCase({ state: 'restricted_pending_user_response' });
    const updatedCase = { ...restrictedCase, state: 'restricted_pending_parental_consent' as const };

    let selectCount = 0;
    const db = {
      prepare: vi.fn().mockImplementation((sql: string) => ({
        bind: vi.fn().mockReturnValue({
          first: vi.fn().mockImplementation(async () => {
            if (sql.includes('WHERE id = ?')) {
              selectCount += 1;
              return selectCount === 1 ? restrictedCase : updatedCase;
            }
            return null;
          }),
          run: vi.fn().mockResolvedValue({ meta: { changes: 1 } }),
        }),
      })),
    };

    const req = new Request('https://api.test/api/age-review/cases/case-1', {
      method: 'PATCH',
      body: JSON.stringify({ state: 'restricted_pending_parental_consent' }),
    });
    const res = await handleUpdateAgeReviewCase(req, 'case-1', makeEnv(db), corsHeaders);
    const body = await res.json() as { success: boolean; keycastUpdated: boolean; bulkActionTriggered?: string };

    expect(res.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.keycastUpdated).toBe(false);
    expect(body.bulkActionTriggered).toBeUndefined();
    expect(suspendUser).not.toHaveBeenCalled();
  });

  it('unsuspends when clearing after submitted_for_review (was previously restricted)', async () => {
    const submittedCase = makeCase({ state: 'submitted_for_review' });
    const updatedCase = { ...submittedCase, state: 'cleared' as const };

    let selectCount = 0;
    const db = {
      prepare: vi.fn().mockImplementation((sql: string) => ({
        bind: vi.fn().mockReturnValue({
          first: vi.fn().mockImplementation(async () => {
            if (sql.includes('WHERE id = ?')) {
              selectCount += 1;
              return selectCount === 1 ? submittedCase : updatedCase;
            }
            return null;
          }),
          run: vi.fn().mockResolvedValue({ meta: { changes: 1 } }),
        }),
      })),
    };

    const req = new Request('https://api.test/api/age-review/cases/case-1', {
      method: 'PATCH',
      body: JSON.stringify({ state: 'cleared' }),
    });
    const res = await handleUpdateAgeReviewCase(req, 'case-1', makeEnv(db), corsHeaders);
    const body = await res.json() as { success: boolean; keycastUpdated: boolean };

    expect(res.status).toBe(200);
    expect(body.keycastUpdated).toBe(true);
    expect(unsuspendUser).toHaveBeenCalledOnce();
    expect(unsuspendUser).toHaveBeenCalledWith(submittedCase.pubkey, expect.objectContaining({ DB: expect.anything() }));
  });

  it('unsuspends when clearing after needs_follow_up (may have been restricted)', async () => {
    const followUpCase = makeCase({ state: 'needs_follow_up' });
    const updatedCase = { ...followUpCase, state: 'cleared' as const };

    let selectCount = 0;
    const db = {
      prepare: vi.fn().mockImplementation((sql: string) => ({
        bind: vi.fn().mockReturnValue({
          first: vi.fn().mockImplementation(async () => {
            if (sql.includes('WHERE id = ?')) {
              selectCount += 1;
              return selectCount === 1 ? followUpCase : updatedCase;
            }
            return null;
          }),
          run: vi.fn().mockResolvedValue({ meta: { changes: 1 } }),
        }),
      })),
    };

    const req = new Request('https://api.test/api/age-review/cases/case-1', {
      method: 'PATCH',
      body: JSON.stringify({ state: 'cleared' }),
    });
    const res = await handleUpdateAgeReviewCase(req, 'case-1', makeEnv(db), corsHeaders);
    const body = await res.json() as { success: boolean; keycastUpdated: boolean };

    expect(res.status).toBe(200);
    expect(body.keycastUpdated).toBe(true);
    expect(unsuspendUser).toHaveBeenCalledOnce();
    expect(unsuspendUser).toHaveBeenCalledWith(followUpCase.pubkey, expect.objectContaining({ DB: expect.anything() }));
  });

  it('calls banUser when transitioning to denied_closed', async () => {
    const restrictedCase = makeCase({ state: 'restricted_pending_user_response' });
    const updatedCase = { ...restrictedCase, state: 'denied_closed' as const };

    let selectCount = 0;
    // The denied path also reads age_review_config via prepare().first() (no
    // bind), so the mock exposes a top-level first() as well as bind().first().
    const firstFor = (sql: string) => async () => {
      if (sql.includes('WHERE id = ?')) {
        selectCount += 1;
        return selectCount === 1 ? restrictedCase : updatedCase;
      }
      return null; // age_review_config -> default config
    };
    const db = {
      prepare: vi.fn().mockImplementation((sql: string) => ({
        first: vi.fn().mockImplementation(firstFor(sql)),
        bind: vi.fn().mockReturnValue({
          first: vi.fn().mockImplementation(firstFor(sql)),
          run: vi.fn().mockResolvedValue({ meta: { changes: 1 } }),
        }),
      })),
    };

    const req = new Request('https://api.test/api/age-review/cases/case-1', {
      method: 'PATCH',
      body: JSON.stringify({ state: 'denied_closed' }),
    });
    const res = await handleUpdateAgeReviewCase(req, 'case-1', makeEnv(db), corsHeaders);
    const body = await res.json() as { success: boolean; keycastUpdated: boolean };

    expect(res.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.keycastUpdated).toBe(true);
    expect(banUser).toHaveBeenCalledOnce();
    expect(banUser).toHaveBeenCalledWith(restrictedCase.pubkey, 'age_review_denied', expect.objectContaining({ DB: expect.anything() }));
  });

  // Issue #147: revoke/deny composes a verified_minor clear with the status leg.
  const makeDbFor = (existing: ReturnType<typeof makeCase>, updated: ReturnType<typeof makeCase>) => {
    let selectCount = 0;
    const firstFor = (sql: string) => async () => {
      if (sql.includes('WHERE id = ?')) {
        selectCount += 1;
        return selectCount === 1 ? existing : updated;
      }
      return null; // age_review_config -> default config
    };
    return {
      prepare: vi.fn().mockImplementation((sql: string) => ({
        first: vi.fn().mockImplementation(firstFor(sql)),
        bind: vi.fn().mockReturnValue({
          first: vi.fn().mockImplementation(firstFor(sql)),
          run: vi.fn().mockResolvedValue({ meta: { changes: 1 } }),
        }),
      })),
    };
  };

  it('clears verified_minor (with actor + deny reason) when transitioning to denied_closed', async () => {
    const moderator = 'b'.repeat(64);
    const restrictedCase = makeCase({ state: 'restricted_pending_user_response', moderator_pubkey: moderator });
    const updatedCase = { ...restrictedCase, state: 'denied_closed' as const };

    const req = new Request('https://api.test/api/age-review/cases/case-1', {
      method: 'PATCH',
      body: JSON.stringify({ state: 'denied_closed' }),
    });
    const res = await handleUpdateAgeReviewCase(req, 'case-1', makeEnv(makeDbFor(restrictedCase, updatedCase)), corsHeaders);
    const body = await res.json() as { success: boolean; enforcement: { keycastMinorClear: string } };

    expect(res.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.enforcement.keycastMinorClear).toBe('ok');
    expect(clearVerifiedMinor).toHaveBeenCalledOnce();
    expect(clearVerifiedMinor).toHaveBeenCalledWith(
      restrictedCase.pubkey,
      moderator,
      'age_review_denied',
      expect.objectContaining({ DB: expect.anything() }),
    );
  });

  it('clears verified_minor with an undefined actor when the case has no moderator_pubkey', async () => {
    // relay-manager auths with a shared admin pubkey, so a case row may carry a
    // null moderator_pubkey. The clear must still fire, with actor `undefined`
    // (keycast then falls back to a log-only audit row). Locks the handler's
    // `(updated ?? existing) ?? undefined` fallback on the interactive path.
    const restrictedCase = makeCase({ state: 'restricted_pending_user_response', moderator_pubkey: null });
    const updatedCase = { ...restrictedCase, state: 'denied_closed' as const };

    const req = new Request('https://api.test/api/age-review/cases/case-1', {
      method: 'PATCH',
      body: JSON.stringify({ state: 'denied_closed' }),
    });
    const res = await handleUpdateAgeReviewCase(req, 'case-1', makeEnv(makeDbFor(restrictedCase, updatedCase)), corsHeaders);
    const body = await res.json() as { enforcement: { keycastMinorClear: string } };

    expect(res.status).toBe(200);
    expect(body.enforcement.keycastMinorClear).toBe('ok');
    expect(clearVerifiedMinor).toHaveBeenCalledWith(
      restrictedCase.pubkey,
      undefined,
      'age_review_denied',
      expect.objectContaining({ DB: expect.anything() }),
    );
  });

  it('does NOT clear verified_minor on a cleared transition (favorable outcome keeps a confirmed minor protected)', async () => {
    // `cleared` restores a 13-15 consent-verified account (a confirmed protected
    // minor who must keep verified_minor). Only deny/revoke removes the flag.
    const restrictedCase = makeCase({ state: 'restricted_pending_user_response' });
    const updatedCase = { ...restrictedCase, state: 'cleared' as const };

    const req = new Request('https://api.test/api/age-review/cases/case-1', {
      method: 'PATCH',
      body: JSON.stringify({ state: 'cleared' }),
    });
    const res = await handleUpdateAgeReviewCase(req, 'case-1', makeEnv(makeDbFor(restrictedCase, updatedCase)), corsHeaders);

    expect(res.status).toBe(200);
    expect(clearVerifiedMinor).not.toHaveBeenCalled();
    const body = await res.json() as { enforcement: { keycastMinorClear: string } };
    expect(body.enforcement.keycastMinorClear).toBe('not_attempted');
  });

  it('surfaces a verified_minor clear failure as incomplete enforcement (207)', async () => {
    vi.mocked(clearVerifiedMinor).mockResolvedValueOnce({ success: false, error: 'Connection refused' });

    const restrictedCase = makeCase({ state: 'restricted_pending_user_response' });
    const updatedCase = { ...restrictedCase, state: 'denied_closed' as const };

    const req = new Request('https://api.test/api/age-review/cases/case-1', {
      method: 'PATCH',
      body: JSON.stringify({ state: 'denied_closed' }),
    });
    const res = await handleUpdateAgeReviewCase(req, 'case-1', makeEnv(makeDbFor(restrictedCase, updatedCase)), corsHeaders);
    const body = await res.json() as {
      success: boolean; enforcementComplete: boolean;
      enforcement: { keycastMinorClear: string; keycastMinorClearError: string; keycast: string };
      case: { state: string };
    };

    expect(res.status).toBe(207);
    expect(body.success).toBe(false);
    expect(body.enforcementComplete).toBe(false);
    expect(body.enforcement.keycastMinorClear).toBe('failed');
    expect(body.enforcement.keycastMinorClearError).toContain('Connection refused');
    // Other legs unaffected; the flag failure must not mask or be masked.
    expect(body.enforcement.keycast).toBe('ok');
    // DB transition still persisted (enforcement remediation is out-of-band).
    expect(body.case.state).toBe('denied_closed');
  });

  it('does not clear verified_minor on a restricting transition', async () => {
    const reviewCase = makeCase({ state: 'under_moderator_review' });
    const updatedCase = { ...reviewCase, state: 'restricted_pending_user_response' as const };

    const req = new Request('https://api.test/api/age-review/cases/case-1', {
      method: 'PATCH',
      body: JSON.stringify({ state: 'restricted_pending_user_response' }),
    });
    const res = await handleUpdateAgeReviewCase(req, 'case-1', makeEnv(makeDbFor(reviewCase, updatedCase)), corsHeaders);

    expect(res.status).toBe(200);
    expect(clearVerifiedMinor).not.toHaveBeenCalled();
    const body = await res.json() as { enforcement: { keycastMinorClear: string } };
    expect(body.enforcement.keycastMinorClear).toBe('not_attempted');
  });

  it('surfaces a Keycast failure (success:false / 207) but still applies the state transition', async () => {
    vi.mocked(suspendUser).mockResolvedValue({ success: false, error: 'Connection refused' });

    const reviewCase = makeCase({ state: 'under_moderator_review' });
    const updatedCase = { ...reviewCase, state: 'restricted_pending_user_response' as const };

    let selectCount = 0;
    const db = {
      prepare: vi.fn().mockImplementation((sql: string) => ({
        bind: vi.fn().mockReturnValue({
          first: vi.fn().mockImplementation(async () => {
            if (sql.includes('WHERE id = ?')) {
              selectCount += 1;
              return selectCount === 1 ? reviewCase : updatedCase;
            }
            return null;
          }),
          run: vi.fn().mockResolvedValue({ meta: { changes: 1 } }),
        }),
      })),
    };

    const req = new Request('https://api.test/api/age-review/cases/case-1', {
      method: 'PATCH',
      body: JSON.stringify({ state: 'restricted_pending_user_response' }),
    });
    const res = await handleUpdateAgeReviewCase(req, 'case-1', makeEnv(db), corsHeaders);
    const body = await res.json() as {
      success: boolean; keycastUpdated: boolean;
      enforcement: { keycast: string }; case: { state: string };
    };

    // the failure is surfaced, not masked as success...
    expect(res.status).toBe(207);
    expect(body.success).toBe(false);
    expect(body.keycastUpdated).toBe(false);
    expect(body.enforcement.keycast).toBe('failed');
    // ...but the DB state transition still persisted (enforcement is best-effort,
    // retryable; it does not roll back the case state).
    expect(body.case.state).toBe('restricted_pending_user_response');
  });

  it('surfaces a thrown Keycast error (success:false / 207) but still applies the state transition', async () => {
    vi.mocked(banUser).mockRejectedValue(new Error('Network error'));

    const restrictedCase = makeCase({ state: 'restricted_pending_user_response' });
    const updatedCase = { ...restrictedCase, state: 'denied_closed' as const };

    let selectCount = 0;
    const firstFor = (sql: string) => async () => {
      if (sql.includes('WHERE id = ?')) {
        selectCount += 1;
        return selectCount === 1 ? restrictedCase : updatedCase;
      }
      return null; // age_review_config -> default config
    };
    const db = {
      prepare: vi.fn().mockImplementation((sql: string) => ({
        first: vi.fn().mockImplementation(firstFor(sql)),
        bind: vi.fn().mockReturnValue({
          first: vi.fn().mockImplementation(firstFor(sql)),
          run: vi.fn().mockResolvedValue({ meta: { changes: 1 } }),
        }),
      })),
    };

    const req = new Request('https://api.test/api/age-review/cases/case-1', {
      method: 'PATCH',
      body: JSON.stringify({ state: 'denied_closed' }),
    });
    const res = await handleUpdateAgeReviewCase(req, 'case-1', makeEnv(db), corsHeaders);
    const body = await res.json() as {
      success: boolean; enforcement: { keycast: string }; case: { state: string };
    };

    expect(res.status).toBe(207);
    expect(body.success).toBe(false);
    expect(body.enforcement.keycast).toBe('failed');
    expect(body.case.state).toBe('denied_closed');
  });
});

// -- Relay pubkey enforcement wiring --------------------------------

describe('Relay pubkey enforcement wiring', () => {
  beforeEach(() => {
    vi.mocked(suspendPubkey).mockClear().mockResolvedValue({ success: true });
    vi.mocked(unsuspendPubkey).mockClear().mockResolvedValue({ success: true });
    vi.mocked(banPubkey).mockClear().mockResolvedValue({ success: true });
  });

  function dbReturning(before: AgeReviewCase, after: AgeReviewCase) {
    let n = 0;
    const firstFor = (sql: string) => async () => {
      if (sql.includes('WHERE id = ?')) { n += 1; return n === 1 ? before : after; }
      return null;
    };
    return {
      prepare: vi.fn().mockImplementation((sql: string) => ({
        first: vi.fn().mockImplementation(firstFor(sql)),
        bind: vi.fn().mockReturnValue({
          first: vi.fn().mockImplementation(firstFor(sql)),
          run: vi.fn().mockResolvedValue({ meta: { changes: 1 } }),
        }),
      })),
    };
  }

  async function patchState(before: string, to: string) {
    const c = makeCase({ state: before as AgeReviewCase['state'] });
    const db = dbReturning(c, { ...c, state: to as AgeReviewCase['state'] });
    const req = new Request('https://api.test/api/age-review/cases/case-1', {
      method: 'PATCH', body: JSON.stringify({ state: to }),
    });
    await handleUpdateAgeReviewCase(req, 'case-1', makeEnv(db), corsHeaders);
    return c;
  }

  it('suspends the pubkey at the relay on restrict', async () => {
    const c = await patchState('under_moderator_review', 'restricted_pending_user_response');
    expect(suspendPubkey).toHaveBeenCalledWith(c.pubkey, 'age_review', expect.objectContaining({ DB: expect.anything() }));
    expect(unsuspendPubkey).not.toHaveBeenCalled();
    expect(banPubkey).not.toHaveBeenCalled();
  });

  it('un-suspends the pubkey at the relay on clear', async () => {
    const c = await patchState('restricted_pending_user_response', 'cleared');
    expect(unsuspendPubkey).toHaveBeenCalledWith(c.pubkey, expect.objectContaining({ DB: expect.anything() }));
    expect(suspendPubkey).not.toHaveBeenCalled();
  });

  it('bans the pubkey at the relay on deny', async () => {
    const c = await patchState('restricted_pending_user_response', 'denied_closed');
    expect(banPubkey).toHaveBeenCalledWith(c.pubkey, 'age_review_denied', expect.objectContaining({ DB: expect.anything() }));
  });

  it('a failed relay leg is surfaced as success:false / 207', async () => {
    vi.mocked(suspendPubkey).mockResolvedValue({ success: false, error: 'relay 403' });
    const c = makeCase({ state: 'under_moderator_review' });
    const db = dbReturning(c, { ...c, state: 'restricted_pending_user_response' });
    const req = new Request('https://api.test/api/age-review/cases/case-1', {
      method: 'PATCH', body: JSON.stringify({ state: 'restricted_pending_user_response' }),
    });
    const res = await handleUpdateAgeReviewCase(req, 'case-1', makeEnv(db), corsHeaders);
    const body = await res.json() as { success: boolean; enforcement: { relay: string } };
    expect(res.status).toBe(207);
    expect(body.success).toBe(false);
    expect(body.enforcement.relay).toBe('failed');
  });

  it('cron auto-close bans the pubkey at the relay on expiry', async () => {
    const expiredCase = makeCase({ state: 'restricted_pending_user_response', deadline_at: new Date(Date.now() - 1000).toISOString() });
    const db = {
      prepare: vi.fn().mockImplementation((sql: string) => ({
        first: vi.fn().mockResolvedValue(null), // config -> default
        bind: vi.fn().mockReturnValue({
          all: vi.fn().mockResolvedValue({ results: sql.includes('+2 days') ? [] : [expiredCase] }),
          first: vi.fn().mockResolvedValue(null),
          run: vi.fn().mockResolvedValue({ meta: { changes: 1 } }),
        }),
      })),
    };
    await checkAgeReviewDeadlines(makeEnv(db));
    expect(banPubkey).toHaveBeenCalledWith(expiredCase.pubkey, 'age_review_expired', expect.objectContaining({ DB: expect.anything() }));
  });
});

// -- handleGetModerationStatus ------------------------------------------------

describe('deriveResponseClock', () => {
  const now = new Date('2026-08-26T12:00:00.000Z');
  const applicableCase = (overrides: Partial<AgeReviewCase> = {}) => makeCase({
    state: 'restricted_pending_user_response',
    ...overrides,
  });

  it.each([
    ['running', applicableCase({ deadline_at: '2026-08-27T12:00:00.000Z' }), {
      clock: 'running', serverNow: now.toISOString(), deadlineAt: '2026-08-27T12:00:00.000Z', pausedAt: null, remainingDaysWhenPaused: null,
    }],
    ['resumed', applicableCase({ deadline_at: '2026-08-28 12:00:00', clock_paused: 0, clock_paused_at: null, remaining_days_when_paused: null }), {
      clock: 'running', serverNow: now.toISOString(), deadlineAt: '2026-08-28T12:00:00.000Z', pausedAt: null, remainingDaysWhenPaused: null,
    }],
    ['expired', applicableCase({ deadline_at: '2026-08-25T12:00:00Z' }), {
      clock: 'expired', serverNow: now.toISOString(), deadlineAt: '2026-08-25T12:00:00.000Z', pausedAt: null, remainingDaysWhenPaused: null,
    }],
    ['paused', applicableCase({ clock_paused: 1, clock_paused_at: '2026-08-24 09:30:00', remaining_days_when_paused: 7.5 }), {
      clock: 'paused', serverNow: now.toISOString(), deadlineAt: null, pausedAt: '2026-08-24T09:30:00.000Z', remainingDaysWhenPaused: 7.5,
    }],
  ] as const)('derives a %s clock', (_label, c, expected) => {
    expect(deriveResponseClock(c, now)).toEqual(expected);
  });

  it.each(['under_moderator_review', 'submitted_for_review', 'needs_follow_up', 'cleared', 'denied_closed'] as const)(
    'returns not_applicable for %s even when a stored deadline exists',
    (state) => {
      expect(deriveResponseClock(makeCase({ state, deadline_at: '2026-08-27T12:00:00.000Z' }), now)).toEqual({
        clock: 'not_applicable', serverNow: now.toISOString(), deadlineAt: null, pausedAt: null, remainingDaysWhenPaused: null,
      });
    },
  );

  it.each([
    ['missing deadline', applicableCase({ deadline_at: null })],
    ['malformed deadline', applicableCase({ deadline_at: 'not-a-date' })],
    ['missing paused time', applicableCase({ clock_paused: 1, clock_paused_at: null, remaining_days_when_paused: 4 })],
    ['missing paused duration', applicableCase({ clock_paused: 1, clock_paused_at: '2026-08-24T09:30:00Z', remaining_days_when_paused: null })],
    ['negative paused duration', applicableCase({ clock_paused: 1, clock_paused_at: '2026-08-24T09:30:00Z', remaining_days_when_paused: -1 })],
    ['missing source deadline while paused', applicableCase({ deadline_at: null, clock_paused: 1, clock_paused_at: '2026-08-24T09:30:00Z', remaining_days_when_paused: 4 })],
    ['unsupported pause flag', applicableCase({ clock_paused: 2 })],
    ['stale paused time while running', applicableCase({ clock_paused_at: '2026-08-24T09:30:00Z' })],
    ['stale paused duration while running', applicableCase({ remaining_days_when_paused: 4 })],
  ] as const)('returns unknown for %s', (_label, c) => {
    expect(deriveResponseClock(c, now)).toEqual({
      clock: 'unknown', serverNow: now.toISOString(), deadlineAt: null, pausedAt: null, remainingDaysWhenPaused: null,
    });
  });

  it('normalizes SQLite and offset timestamps to UTC with milliseconds', () => {
    expect(toUtcIso('2026-08-26 09:30:00')).toBe('2026-08-26T09:30:00.000Z');
    expect(toUtcIso('2026-08-26T09:30:00-05:00')).toBe('2026-08-26T14:30:00.000Z');
    expect(toUtcIso('invalid')).toBeNull();
  });
});

describe('handleGetModerationStatus', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns active when no case exists', async () => {
    const db = createMockDb([]);
    const res = await handleGetModerationStatus('a'.repeat(64), makeEnv(db), corsHeaders);
    const body = await res.json() as { restriction: { status: string } };

    expect(res.status).toBe(200);
    expect(body.restriction.status).toBe('active');
  });

  it('returns restricted_minor_review when active case exists', async () => {
    vi.useFakeTimers();
    vi.setSystemTime('2026-08-26T12:00:00.000Z');
    const c = makeCase({ state: 'restricted_pending_user_response' });
    const db = createMockDb([c]);
    // Override first() to return the case for the pubkey query
    db.prepare.mockImplementation((sql: string) => ({
      bind: vi.fn().mockReturnValue({
        first: vi.fn().mockResolvedValue(
          sql.includes('WHERE pubkey = ?') ? c : null
        ),
      }),
    }));

    const res = await handleGetModerationStatus(c.pubkey, makeEnv(db), corsHeaders);
    const body = await res.json() as {
      restriction: { status: string };
      minorReviewCase: {
        id: string;
        state: string;
        suspectedAgeBand: string;
        allowedResolution: string;
        responseDeadline: MinorReviewResponseDeadline;
      };
    };

    // The mobile client keys off snake_case wire values; the whole contract
    // (top-level status AND the nested enum values) must stay snake_case.
    expect(body.restriction.status).toBe('restricted_minor_review');
    expect(body.minorReviewCase.id).toBe('case-1');
    expect(body.minorReviewCase.state).toBe('restricted_pending_user_response');
    expect(body.minorReviewCase.suspectedAgeBand).toBe('age_13_15');
    expect(body.minorReviewCase.allowedResolution).toBe('parent_video_or_email');
    expect(body.minorReviewCase.responseDeadline).toEqual({
      clock: 'running',
      serverNow: '2026-08-26T12:00:00.000Z',
      deadlineAt: c.deadline_at,
      pausedAt: null,
      remainingDaysWhenPaused: null,
    });
  });

  it('returns active for open_reported case (pre-moderator review)', async () => {
    const c = makeCase({ state: 'open_reported' });
    const db = createMockDb([c]);
    // The query now filters by RESTRICTED_STATES, so open_reported won't match
    db.prepare.mockImplementation((sql: string) => ({
      bind: vi.fn().mockReturnValue({
        first: vi.fn().mockResolvedValue(
          sql.includes('WHERE pubkey = ?') ? null : null
        ),
      }),
    }));

    const res = await handleGetModerationStatus(c.pubkey, makeEnv(db), corsHeaders);
    const body = await res.json() as { restriction: { status: string } };

    expect(res.status).toBe(200);
    expect(body.restriction.status).toBe('active');
  });

  it('returns active (fail-open) when DB unavailable, logging a greppable alert marker', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const res = await handleGetModerationStatus('a'.repeat(64), makeEnv(), corsHeaders);
    const body = await res.json() as { restriction: { status: string } };

    expect(res.status).toBe(200);
    expect(body.restriction.status).toBe('active');
    // Distinct marker so this fail-open path is alertable via log monitoring,
    // separate from the general Slack-based cron alert (#197).
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('MODERATION_STATUS_DB_UNAVAILABLE'),
      'a'.repeat(64),
    );

    errorSpy.mockRestore();
  });
});

// -- sendDbUnavailableAlert ---------------------------------------------------

describe('sendDbUnavailableAlert', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('posts the DB-unavailable message with the environment to the webhook and returns true on success', async () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', mockFetch);

    const result = await sendDbUnavailableAlert('https://hooks.slack.com/test', 'staging');

    expect(result).toBe(true);
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockFetch.mock.calls[0][0]).toBe('https://hooks.slack.com/test');
    const options = mockFetch.mock.calls[0][1] as { method: string; headers: Record<string, string>; body: string };
    expect(options.method).toBe('POST');
    const payload = JSON.parse(options.body) as { text: string };
    expect(payload.text).toContain('D1 unavailable');
    expect(payload.text).toContain('failing open');
    expect(payload.text).toContain('[staging]');
  });

  it('returns false when Slack responds non-ok', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 500 }));

    const result = await sendDbUnavailableAlert('https://hooks.slack.com/test', 'production');

    expect(result).toBe(false);
  });

  it('returns false when fetch throws', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down')));

    const result = await sendDbUnavailableAlert('https://hooks.slack.com/test', 'production');

    expect(result).toBe(false);
  });
});

// -- handleParentContact ------------------------------------------------------

describe('handleParentContact', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('saves email and pauses clock for age_13_15 case', async () => {
    const c = makeCase({
      state: 'restricted_pending_user_response',
      deadline_at: '2026-08-25T12:00:00.000Z',
    });
    const db = createMockDb([c]);
    // Override: first returns case when queried by id+pubkey
    db.prepare.mockImplementation((sql: string) => ({
      bind: vi.fn().mockReturnValue({
        first: vi.fn().mockResolvedValue(
          sql.includes('WHERE id = ? AND pubkey = ?') ? c : null
        ),
        run: vi.fn().mockResolvedValue({ meta: { changes: 1 } }),
      }),
    }));
    vi.useFakeTimers();
    vi.setSystemTime('2026-08-26T12:00:00.000Z');

    const req = new Request('https://api.test/v1/minor-review-cases/case-1/parent-contact', {
      method: 'POST',
      body: JSON.stringify({ email: 'parent@example.com' }),
    });
    const res = await handleParentContact(req, 'case-1', c.pubkey, makeEnv(db), corsHeaders);
    expect(res.status).toBe(200);

    const updateCall = db.prepare.mock.calls.find(
      (call: string[]) => call[0]?.includes('UPDATE') && call[0]?.includes('clock_paused = 1')
    );
    expect(updateCall).toBeTruthy();
    const updateIndex = db.prepare.mock.calls.indexOf(updateCall!);
    expect(db.prepare.mock.results[updateIndex].value.bind).toHaveBeenCalledWith(
      'parent@example.com',
      '2026-08-26T12:00:00.000Z',
      0,
      'case-1',
    );
  });

  it('rejects request for under_13 case', async () => {
    const c = makeCase({ suspected_age_band: 'under_13', state: 'restricted_pending_user_response' });
    const db = createMockDb([c]);
    db.prepare.mockImplementation((sql: string) => ({
      bind: vi.fn().mockReturnValue({
        first: vi.fn().mockResolvedValue(
          sql.includes('WHERE id = ? AND pubkey = ?') ? c : null
        ),
      }),
    }));

    const req = new Request('https://api.test/v1/minor-review-cases/case-1/parent-contact', {
      method: 'POST',
      body: JSON.stringify({ email: 'parent@example.com' }),
    });
    const res = await handleParentContact(req, 'case-1', c.pubkey, makeEnv(db), corsHeaders);
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toContain('Under-13');
  });

  it('rejects wrong pubkey (cannot access another user case)', async () => {
    const c = makeCase();
    const db = createMockDb([c]);
    // first() returns null because pubkey doesn't match
    db.prepare.mockImplementation(() => ({
      bind: vi.fn().mockReturnValue({
        first: vi.fn().mockResolvedValue(null),
      }),
    }));

    const req = new Request('https://api.test/v1/minor-review-cases/case-1/parent-contact', {
      method: 'POST',
      body: JSON.stringify({ email: 'parent@example.com' }),
    });
    const res = await handleParentContact(req, 'case-1', 'c'.repeat(64), makeEnv(db), corsHeaders);
    expect(res.status).toBe(404);
  });

  it('rejects closed case', async () => {
    const c = makeCase({ state: 'denied_closed' });
    const db = createMockDb([c]);
    db.prepare.mockImplementation((sql: string) => ({
      bind: vi.fn().mockReturnValue({
        first: vi.fn().mockResolvedValue(
          sql.includes('WHERE id = ? AND pubkey = ?') ? c : null
        ),
      }),
    }));

    const req = new Request('https://api.test/v1/minor-review-cases/case-1/parent-contact', {
      method: 'POST',
      body: JSON.stringify({ email: 'parent@example.com' }),
    });
    const res = await handleParentContact(req, 'case-1', c.pubkey, makeEnv(db), corsHeaders);
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toContain('closed');
  });

  it('rejects parent contact from invalid state (open_reported)', async () => {
    const c = makeCase({ state: 'open_reported' });
    const db = createMockDb([c]);
    db.prepare.mockImplementation((sql: string) => ({
      bind: vi.fn().mockReturnValue({
        first: vi.fn().mockResolvedValue(
          sql.includes('WHERE id = ? AND pubkey = ?') ? c : null
        ),
        run: vi.fn().mockResolvedValue({ meta: { changes: 1 } }),
      }),
    }));

    const req = new Request('https://api.test/v1/minor-review-cases/case-1/parent-contact', {
      method: 'POST',
      body: JSON.stringify({ email: 'parent@example.com' }),
    });
    const res = await handleParentContact(req, 'case-1', c.pubkey, makeEnv(db), corsHeaders);
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toContain('Cannot submit parent contact');
  });

  it('rejects invalid email', async () => {
    const c = makeCase({ state: 'restricted_pending_user_response' });
    const db = createMockDb([c]);
    db.prepare.mockImplementation((sql: string) => ({
      bind: vi.fn().mockReturnValue({
        first: vi.fn().mockResolvedValue(
          sql.includes('WHERE id = ? AND pubkey = ?') ? c : null
        ),
      }),
    }));

    const req = new Request('https://api.test/v1/minor-review-cases/case-1/parent-contact', {
      method: 'POST',
      body: JSON.stringify({ email: 'not-valid' }),
    });
    const res = await handleParentContact(req, 'case-1', c.pubkey, makeEnv(db), corsHeaders);
    expect(res.status).toBe(400);
  });
});

// -- checkAgeReviewDeadlines --------------------------------------------------

describe('checkAgeReviewDeadlines', () => {
  beforeEach(() => {
    vi.mocked(suspendUser).mockClear().mockResolvedValue({ success: true });
    vi.mocked(unsuspendUser).mockClear().mockResolvedValue({ success: true });
    vi.mocked(banUser).mockClear().mockResolvedValue({ success: true });
    vi.mocked(clearVerifiedMinor).mockClear().mockResolvedValue({ success: true });
  });

  it('does nothing when DB unavailable', async () => {
    await checkAgeReviewDeadlines(makeEnv());
    // No throw — just returns
  });

  it('auto-closes expired cases and syncs Zendesk', async () => {
    const expiredCase = makeCase({
      deadline_at: new Date(Date.now() - 1000).toISOString(),
      state: 'restricted_pending_user_response',
      zendesk_ticket_id: 55,
    });
    const runMock = vi.fn().mockResolvedValue({ meta: { changes: 1 } });
    const mockFetch = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', mockFetch);

    const db = {
      prepare: vi.fn().mockImplementation((sql: string) => ({
        bind: vi.fn().mockReturnValue({
          all: vi.fn().mockResolvedValue({
            results: sql.includes('+2 days') ? [] : [expiredCase],
          }),
          first: vi.fn().mockResolvedValue(
            sql.includes('zendesk_ticket_id') ? { zendesk_ticket_id: 55 } : null
          ),
          run: runMock,
        }),
      })),
    };

    await checkAgeReviewDeadlines(makeEnv(db, {
      ZENDESK_SUBDOMAIN: 'test',
      ZENDESK_API_TOKEN: 'tok',
      ZENDESK_EMAIL: 'agent@test.com',
    }));

    const closeCalls = db.prepare.mock.calls.filter(
      (c: string[]) => c[0]?.includes('UPDATE age_review_cases') && c[0]?.includes('denied_closed')
    );
    expect(closeCalls.length).toBe(1);

    // Verify Zendesk ticket was resolved
    const zendeskCall = mockFetch.mock.calls.find(
      (call: unknown[]) => (call[0] as string).includes('zendesk.com/api/v2/tickets/55')
    );
    expect(zendeskCall).toBeTruthy();
    const payload = JSON.parse((zendeskCall as [string, RequestInit])[1].body as string);
    expect(payload.ticket.status).toBe('solved');

    // Verify Keycast ban was sent for the expired case
    expect(banUser).toHaveBeenCalledOnce();
    expect(banUser).toHaveBeenCalledWith(expiredCase.pubkey, 'age_review_expired', expect.objectContaining({ DB: expect.anything() }));

    // Auto-deny must also clear verified_minor (#147) — system actor (undefined),
    // so a deadline-expired account isn't left banned with the flag still set.
    expect(clearVerifiedMinor).toHaveBeenCalledWith(expiredCase.pubkey, undefined, 'age_review_expired', expect.objectContaining({ DB: expect.anything() }));

    vi.unstubAllGlobals();
  });

  it('does not let Keycast failure block auto-close', async () => {
    vi.mocked(banUser).mockResolvedValue({ success: false, error: 'Connection refused' });

    const expiredCase = makeCase({
      deadline_at: new Date(Date.now() - 1000).toISOString(),
      state: 'restricted_pending_user_response',
    });
    const runMock = vi.fn().mockResolvedValue({ meta: { changes: 1 } });

    const db = {
      prepare: vi.fn().mockImplementation((sql: string) => ({
        bind: vi.fn().mockReturnValue({
          all: vi.fn().mockResolvedValue({
            results: sql.includes('+2 days') ? [] : [expiredCase],
          }),
          first: vi.fn().mockResolvedValue(null),
          run: runMock,
        }),
      })),
    };

    await checkAgeReviewDeadlines(makeEnv(db));

    const closeCalls = db.prepare.mock.calls.filter(
      (c: string[]) => c[0]?.includes('UPDATE age_review_cases') && c[0]?.includes('denied_closed')
    );
    expect(closeCalls.length).toBe(1);
    expect(banUser).toHaveBeenCalledOnce();
  });

  it('sends Slack alert for approaching deadlines', async () => {
    const approachingCase = makeCase({
      deadline_at: new Date(Date.now() + 1 * 24 * 60 * 60 * 1000).toISOString(),
      state: 'restricted_pending_user_response',
    });
    const mockFetch = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', mockFetch);

    const db = {
      prepare: vi.fn().mockImplementation((sql: string) => ({
        bind: vi.fn().mockReturnValue({
          all: vi.fn().mockResolvedValue({
            results: sql.includes('+2 days') ? [approachingCase] : [],
          }),
          run: vi.fn().mockResolvedValue({ meta: { changes: 0 } }),
        }),
      })),
    };

    await checkAgeReviewDeadlines(makeEnv(db, {
      SLACK_WEBHOOK_URL: 'https://hooks.slack.com/test',
    }));

    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockFetch.mock.calls[0][0]).toBe('https://hooks.slack.com/test');

    const stampCalls = db.prepare.mock.calls.filter(
      (c: string[]) => c[0]?.includes('UPDATE') && c[0]?.includes('last_alerted_at')
    );
    expect(stampCalls.length).toBe(1);

    vi.unstubAllGlobals();
  });

  it('does not stamp last_alerted_at when Slack send fails', async () => {
    const approachingCase = makeCase({
      deadline_at: new Date(Date.now() + 1 * 24 * 60 * 60 * 1000).toISOString(),
      state: 'restricted_pending_user_response',
    });
    const mockFetch = vi.fn().mockResolvedValue({ ok: false, status: 500 });
    vi.stubGlobal('fetch', mockFetch);

    const db = {
      prepare: vi.fn().mockImplementation((sql: string) => ({
        bind: vi.fn().mockReturnValue({
          all: vi.fn().mockResolvedValue({
            results: sql.includes('+2 days') ? [approachingCase] : [],
          }),
          run: vi.fn().mockResolvedValue({ meta: { changes: 0 } }),
        }),
      })),
    };

    await checkAgeReviewDeadlines(makeEnv(db, {
      SLACK_WEBHOOK_URL: 'https://hooks.slack.com/test',
    }));

    const stampCalls = db.prepare.mock.calls.filter(
      (c: string[]) => c[0]?.includes('UPDATE') && c[0]?.includes('last_alerted_at')
    );
    expect(stampCalls.length).toBe(0);

    vi.unstubAllGlobals();
  });

  it('does not send Slack alert when no webhook configured', async () => {
    const approachingCase = makeCase({
      deadline_at: new Date(Date.now() + 1 * 24 * 60 * 60 * 1000).toISOString(),
    });
    const mockFetch = vi.fn();
    vi.stubGlobal('fetch', mockFetch);

    const db = {
      prepare: vi.fn().mockImplementation((sql: string) => ({
        bind: vi.fn().mockReturnValue({
          all: vi.fn().mockResolvedValue({
            results: sql.includes('+2 days') ? [approachingCase] : [],
          }),
          run: vi.fn().mockResolvedValue({ meta: { changes: 0 } }),
        }),
      })),
    };

    await checkAgeReviewDeadlines(makeEnv(db));
    expect(mockFetch).not.toHaveBeenCalled();

    vi.unstubAllGlobals();
  });
});

// -- Contact notes composition (#213) -----------------------------------------

describe('composeContactNotes', () => {
  const BLOCK = 'Age review: 13-15, case case-1';
  const START = '--- [Divine age review] ---';
  const END = '--- [end Divine age review] ---';

  it('appends the block when the contact has no notes', () => {
    expect(composeContactNotes('', BLOCK)).toBe([START, BLOCK, END].join('\n'));
  });

  it('keeps text an agent wrote above the block', () => {
    const out = composeContactNotes('Spoke by phone.', BLOCK);
    expect(out).toContain('Spoke by phone.');
    expect(out.indexOf('Spoke by phone.')).toBeLessThan(out.indexOf(START));
  });

  // The bottom of the field is where an agent naturally adds a line, and it is
  // exactly what a head-only splice would drop.
  it('keeps text an agent wrote below the block', () => {
    const existing = [START, 'stale block', END, 'Consent confirmed by phone.'].join('\n');
    const out = composeContactNotes(existing, BLOCK);
    expect(out).toContain('Consent confirmed by phone.');
    expect(out).not.toContain('stale block');
  });

  // A re-submitted parent address, or two cases sharing one address, writes to
  // the same contact more than once.
  it('replaces a previous block rather than stacking another copy', () => {
    const existing = [START, 'stale block', END].join('\n');
    const out = composeContactNotes(existing, BLOCK);
    expect(out.split(START).length - 1).toBe(1);
    expect(out.split(END).length - 1).toBe(1);
    expect(out).not.toContain('stale block');
  });

  it('preserves both sides at once', () => {
    const existing = ['Above.', START, 'stale', END, 'Below.'].join('\n');
    const out = composeContactNotes(existing, BLOCK);
    expect(out).toBe(['Above.', START, BLOCK, END, 'Below.'].join('\n'));
  });

  // A start marker with no end marker means we cannot tell where our block
  // stopped and an agent's text began -- an older write, or an agent who
  // edited or part-copied a marker. Keep the remainder: a visible duplicate is
  // recoverable by the agent who owns this field, silent deletion is not.
  it('keeps text after a start marker that has no end marker', () => {
    const out = composeContactNotes(['Above.', START, 'AGENT TEXT'].join('\n'), BLOCK);
    expect(out).toContain('Above.');
    expect(out).toContain('AGENT TEXT');
  });

  it('keeps text after a marker an agent pasted mid-line', () => {
    expect(composeContactNotes(`agent said ${START} inline`, BLOCK)).toContain('inline');
  });
});

// -- Parent contact record (#213) ---------------------------------------------

describe('parent contact record', () => {
  /** Routes Zendesk calls by URL and method so a contact write can be observed. */
  function makeZendeskFetch(existingNotes: string | null = null) {
    return vi.fn().mockImplementation((url: string, init?: { method?: string }) => {
      if (url.includes('/users/') && (init?.method ?? 'GET') === 'GET') {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({
            user: { id: 77, role: 'end-user', email: 'parent@example.com', notes: existingNotes },
          }),
        });
      }
      if (url.includes('/users/')) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ user: { id: 77 } }) });
      }
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ ticket: { id: 42, requester_id: 77 } }),
      });
    });
  }

  function makeParentDb(c: AgeReviewCase) {
    return {
      prepare: vi.fn().mockImplementation((sql: string) => ({
        bind: vi.fn().mockReturnValue({
          first: vi.fn().mockResolvedValue(sql.includes('WHERE id = ? AND pubkey = ?') ? c : null),
          run: vi.fn().mockResolvedValue({ meta: { changes: 1 } }),
        }),
      })),
    };
  }

  const zendeskEnv = {
    ZENDESK_SUBDOMAIN: 'test',
    ZENDESK_API_TOKEN: 'tok',
    ZENDESK_EMAIL: 'agent@test.com',
  };

  function parentRequest() {
    return new Request('https://api.test/v1/minor-review-cases/case-1/parent-contact', {
      method: 'POST',
      body: JSON.stringify({ email: 'parent@example.com' }),
    });
  }

  afterEach(() => vi.unstubAllGlobals());

  // The outreach goes to an address the teen supplied and nobody has verified,
  // and Zendesk renders the stored contact name into the To: header. The
  // address is the join key and is safe there; the handle is not, until the
  // parent has replied.
  it('names the contact by address alone at attach time, never by handle', async () => {
    const c = makeCase({ state: 'restricted_pending_user_response', account_name: 'Some One' });
    const mockFetch = makeZendeskFetch();
    vi.stubGlobal('fetch', mockFetch);

    await handleParentContact(parentRequest(), 'case-1', c.pubkey, makeEnv(makeParentDb(c), zendeskEnv), corsHeaders);

    const ticketCall = mockFetch.mock.calls.find((call: unknown[]) => /\/tickets(\/|$|\?)/.test(call[0] as string));
    const payload = JSON.parse((ticketCall![1] as { body: string }).body);
    expect(payload.ticket.requester.name).toBe('parent@example.com');
    expect(payload.ticket.requester.name).not.toContain('Claimed parent');
    expect(payload.ticket.requester.name).not.toBe('Parent/Guardian');
    // The To: header stays address-only. The message body now does name the
    // account -- a deliberate reversal of #222 for the body alone -- so this
    // asserts the split rather than a blanket ban on the handle.
    expect(payload.ticket.comment.html_body).toContain('Some One');
  });

  it('writes the identity block to the contact notes', async () => {
    const c = makeCase({ state: 'restricted_pending_user_response', account_name: 'Some One' });
    const mockFetch = makeZendeskFetch();
    vi.stubGlobal('fetch', mockFetch);

    await handleParentContact(parentRequest(), 'case-1', c.pubkey, makeEnv(makeParentDb(c), zendeskEnv), corsHeaders);

    const put = mockFetch.mock.calls.find(
      (call: unknown[]) => (call[0] as string).includes('/users/') && (call[1] as { method?: string })?.method === 'PUT',
    );
    expect(put).toBeTruthy();
    const notes = JSON.parse((put![1] as { body: string }).body).user.notes;
    expect(notes).toContain('/age-review?case=case-1');
    expect(notes).toContain('Some One');
  });

  // notes is a single free-text field an agent may already have written in.
  it('appends to existing contact notes rather than clobbering them', async () => {
    const c = makeCase({ state: 'restricted_pending_user_response', account_name: 'Some One' });
    const mockFetch = makeZendeskFetch('Spoke to this parent on the phone 2026-08-01.');
    vi.stubGlobal('fetch', mockFetch);

    await handleParentContact(parentRequest(), 'case-1', c.pubkey, makeEnv(makeParentDb(c), zendeskEnv), corsHeaders);

    const put = mockFetch.mock.calls.find(
      (call: unknown[]) => (call[0] as string).includes('/users/') && (call[1] as { method?: string })?.method === 'PUT',
    );
    const notes = JSON.parse((put![1] as { body: string }).body).user.notes;
    expect(notes).toContain('Spoke to this parent on the phone 2026-08-01.');
    expect(notes).toContain('/age-review?case=case-1');
  });

  // Enrichment must never cost the parent their outreach. Asserting only on the
  // 200 would prove nothing -- handleParentContact already swallows everything
  // this function throws -- so assert the failure was contained at the contact
  // write itself, and that the ticket the parent was mailed still got recorded.
  it('contains a contact-write failure without disturbing the outreach', async () => {
    const c = makeCase({ state: 'restricted_pending_user_response', account_name: 'Some One' });
    const db = makeParentDb(c);
    const mockFetch = vi.fn().mockImplementation((url: string) => {
      if (url.includes('/users/')) return Promise.reject(new Error('Zendesk user API down'));
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ ticket: { id: 42, requester_id: 77 } }) });
    });
    vi.stubGlobal('fetch', mockFetch);
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});

    const res = await handleParentContact(parentRequest(), 'case-1', c.pubkey, makeEnv(db, zendeskEnv), corsHeaders);
    expect(res.status).toBe(200);

    // Handled at the contact write, not bubbled up to the generic ticket handler.
    const messages = errorLog.mock.calls.map((call) => String(call[0]));
    expect(messages).toContain('[age-review] Failed to write parent contact notes:');
    expect(messages).not.toContain('[age-review] Failed to create Zendesk ticket:');

    // The parent was mailed, so the ticket must still be linked to the case.
    const storeCall = db.prepare.mock.calls.find((call: string[]) => call[0]?.includes('zendesk_ticket_id'));
    expect(storeCall).toBeTruthy();

    errorLog.mockRestore();
  });

  // The address is supplied by the teen under review and validated only as
  // email-shaped. Zendesk resolves an existing user by email and allows agents
  // to be requesters, so a teen naming a Divine staff address makes that staff
  // member the requester. A Zendesk display name is global, so renaming them
  // would put a minor's handle in the header of every mail they later send.
  // A 403/404 from Zendesk is the realistic failure here, and it returns a
  // Response rather than rejecting -- so a network-error test does not
  // exercise it. Both !ok branches must surface, not return quietly.
  it.each([
    ['contact read', 'GET'],
    ['contact write', 'PUT'],
  ])('surfaces a rejected %s rather than failing silently', async (_label, failingMethod) => {
    const c = makeCase({ state: 'restricted_pending_user_response', account_name: 'Some One' });
    const mockFetch = vi.fn().mockImplementation((url: string, init?: { method?: string }) => {
      const method = init?.method ?? 'GET';
      if (url.includes('/users/') && method === failingMethod) {
        // json() is supplied deliberately, and returns a body that would
        // otherwise sail through verification. Without it, deleting the guard
        // would throw a TypeError that lands in the same catch and emits the
        // same log -- so the test would pass whether the guard exists or not.
        return Promise.resolve({
          ok: false,
          status: 403,
          text: () => Promise.resolve('Forbidden'),
          json: () => Promise.resolve({ user: { id: 77, role: 'end-user', email: 'parent@example.com', notes: '' } }),
        });
      }
      if (url.includes('/users/') && method === 'GET') {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ user: { id: 77, role: 'end-user', email: 'parent@example.com', notes: '' } }),
        });
      }
      if (url.includes('/users/')) return Promise.resolve({ ok: true, json: () => Promise.resolve({ user: { id: 77 } }) });
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ ticket: { id: 42, requester_id: 77 } }) });
    });
    vi.stubGlobal('fetch', mockFetch);
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});

    const res = await handleParentContact(parentRequest(), 'case-1', c.pubkey, makeEnv(makeParentDb(c), zendeskEnv), corsHeaders);

    expect(res.status).toBe(200);
    expect(errorLog.mock.calls.map((call) => String(call[0])))
      .toContain('[age-review] Failed to write parent contact notes:');
    errorLog.mockRestore();
  });

  // The early-return guard on the attach path. Each clause stops a distinct way
  // of writing a useless or misleading block onto a real parent's contact: no
  // requester means no contact to write to, and a missing pubkey or case id
  // would render an identity block that identifies nothing and a deeplink that
  // goes nowhere. Without a parent address there is nothing to verify against.
  it.each([
    ['no requester id on the ticket', { ticket: { id: 42 } }],
    ['no requester id at all', { ticket: { id: 42, requester_id: null } }],
  ])('writes no contact notes when the ticket yields %s', async (_label, ticketBody) => {
    const c = makeCase({ state: 'restricted_pending_user_response', account_name: 'Some One' });
    const mockFetch = vi.fn().mockImplementation((url: string) => {
      if (url.includes('/users/')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ user: { id: 77, role: 'end-user', email: 'parent@example.com', notes: '' } }),
        });
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve(ticketBody) });
    });
    vi.stubGlobal('fetch', mockFetch);

    await handleParentContact(parentRequest(), 'case-1', c.pubkey, makeEnv(makeParentDb(c), zendeskEnv), corsHeaders);

    // The guard returns before Zendesk's user API is touched at all.
    expect(mockFetch.mock.calls.filter((call: unknown[]) => (call[0] as string).includes('/users/'))).toEqual([]);
  });

  it('writes no contact notes when the case has no pubkey to identify', async () => {
    const c = makeCase({ state: 'restricted_pending_user_response', account_name: 'Some One', pubkey: '' });
    const mockFetch = makeZendeskFetch();
    vi.stubGlobal('fetch', mockFetch);

    await handleParentContact(parentRequest(), 'case-1', '', makeEnv(makeParentDb(c), zendeskEnv), corsHeaders);

    expect(mockFetch.mock.calls.filter((call: unknown[]) => (call[0] as string).includes('/users/'))).toEqual([]);
  });

  it('refuses to write to a contact that is not an end user', async () => {
    const c = makeCase({ state: 'restricted_pending_user_response', account_name: 'Some One' });
    const mockFetch = vi.fn().mockImplementation((url: string, init?: { method?: string }) => {
      if (url.includes('/users/') && (init?.method ?? 'GET') === 'GET') {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ user: { id: 77, role: 'admin', email: 'parent@example.com', notes: '' } }),
        });
      }
      if (url.includes('/users/')) return Promise.resolve({ ok: true, json: () => Promise.resolve({ user: { id: 77 } }) });
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ ticket: { id: 42, requester_id: 77 } }) });
    });
    vi.stubGlobal('fetch', mockFetch);

    await handleParentContact(parentRequest(), 'case-1', c.pubkey, makeEnv(makeParentDb(c), zendeskEnv), corsHeaders);

    const put = mockFetch.mock.calls.find(
      (call: unknown[]) => (call[0] as string).includes('/users/') && (call[1] as { method?: string })?.method === 'PUT',
    );
    expect(put).toBeUndefined();
  });

  // Belt and braces on the same attack: even an end user must be the address we
  // were actually given, or the ticket's requester is not who we think.
  it('refuses to write to a contact whose email is not the parent address', async () => {
    const c = makeCase({ state: 'restricted_pending_user_response', account_name: 'Some One' });
    const mockFetch = vi.fn().mockImplementation((url: string, init?: { method?: string }) => {
      if (url.includes('/users/') && (init?.method ?? 'GET') === 'GET') {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ user: { id: 77, role: 'end-user', email: 'someone.else@example.com', notes: '' } }),
        });
      }
      if (url.includes('/users/')) return Promise.resolve({ ok: true, json: () => Promise.resolve({ user: { id: 77 } }) });
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ ticket: { id: 42, requester_id: 77 } }) });
    });
    vi.stubGlobal('fetch', mockFetch);

    await handleParentContact(parentRequest(), 'case-1', c.pubkey, makeEnv(makeParentDb(c), zendeskEnv), corsHeaders);

    const put = mockFetch.mock.calls.find(
      (call: unknown[]) => (call[0] as string).includes('/users/') && (call[1] as { method?: string })?.method === 'PUT',
    );
    expect(put).toBeUndefined();
  });

  // Structural, not a guard: createAgeReviewInternalTicket sets no requester and
  // never reaches the contact write, so the admin-requester case cannot arise on
  // that path. This pins that structure against a future call being added.
  it('touches no contact record when the case has no parent email', async () => {
    const reviewCase = makeCase({ state: 'under_moderator_review', account_name: 'Some One' });
    const updatedCase = { ...reviewCase, state: 'restricted_pending_support_email' };
    let selectCount = 0;
    const db = {
      prepare: vi.fn().mockImplementation((sql: string) => ({
        bind: vi.fn().mockReturnValue({
          first: vi.fn().mockImplementation(async () => {
            if (sql === 'SELECT * FROM age_review_cases WHERE id = ?') {
              selectCount += 1;
              return selectCount === 1 ? reviewCase : updatedCase;
            }
            return null;
          }),
          run: vi.fn().mockResolvedValue({ meta: { changes: 1 } }),
        }),
      })),
    };
    const mockFetch = makeZendeskFetch();
    vi.stubGlobal('fetch', mockFetch);

    const req = new Request('https://api.test/api/age-review/cases/case-1', {
      method: 'PATCH',
      body: JSON.stringify({ state: 'restricted_pending_support_email' }),
    });
    await handleUpdateAgeReviewCase(req, 'case-1', makeEnv(db, zendeskEnv), corsHeaders);

    const userCalls = mockFetch.mock.calls.filter((call: unknown[]) => (call[0] as string).includes('/users/'));
    expect(userCalls).toEqual([]);
  });
});

// -- handleParentContact + Zendesk ticket creation ----------------------------

describe('handleParentContact Zendesk integration', () => {
  it('creates Zendesk ticket on parent email submission', async () => {
    const c = makeCase({ state: 'restricted_pending_user_response' });
    const runMock = vi.fn().mockResolvedValue({ meta: { changes: 1 } });
    const db = {
      prepare: vi.fn().mockImplementation((sql: string) => ({
        bind: vi.fn().mockReturnValue({
          first: vi.fn().mockResolvedValue(
            sql.includes('WHERE id = ? AND pubkey = ?') ? c : null
          ),
          run: runMock,
        }),
      })),
    };

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ ticket: { id: 42 } }),
    });
    vi.stubGlobal('fetch', mockFetch);

    const req = new Request('https://api.test/v1/minor-review-cases/case-1/parent-contact', {
      method: 'POST',
      body: JSON.stringify({ email: 'parent@example.com' }),
    });
    const res = await handleParentContact(req, 'case-1', c.pubkey, makeEnv(db, {
      ZENDESK_SUBDOMAIN: 'test',
      ZENDESK_API_TOKEN: 'tok',
      ZENDESK_EMAIL: 'agent@test.com',
    }), corsHeaders);
    expect(res.status).toBe(200);

    // Zendesk API was called to create ticket
    const zendeskCall = mockFetch.mock.calls.find(
      (call: unknown[]) => (call[0] as string).includes('zendesk.com/api/v2/tickets')
    );
    expect(zendeskCall).toBeTruthy();
    const ticketPayload = JSON.parse(zendeskCall![1].body);
    expect(ticketPayload.ticket.requester.email).toBe('parent@example.com');
    expect(ticketPayload.ticket.tags).toContain('age-review');

    // Ticket ID was stored back on the case
    const storeCall = db.prepare.mock.calls.find(
      (call: string[]) => call[0]?.includes('zendesk_ticket_id')
    );
    expect(storeCall).toBeTruthy();

    vi.unstubAllGlobals();
  });

  it('succeeds even when Zendesk ticket creation fails', async () => {
    const c = makeCase({ state: 'restricted_pending_user_response' });
    const db = {
      prepare: vi.fn().mockImplementation((sql: string) => ({
        bind: vi.fn().mockReturnValue({
          first: vi.fn().mockResolvedValue(
            sql.includes('WHERE id = ? AND pubkey = ?') ? c : null
          ),
          run: vi.fn().mockResolvedValue({ meta: { changes: 1 } }),
        }),
      })),
    };

    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      text: () => Promise.resolve('Internal Server Error'),
    });
    vi.stubGlobal('fetch', mockFetch);

    const req = new Request('https://api.test/v1/minor-review-cases/case-1/parent-contact', {
      method: 'POST',
      body: JSON.stringify({ email: 'parent@example.com' }),
    });
    const res = await handleParentContact(req, 'case-1', c.pubkey, makeEnv(db, {
      ZENDESK_SUBDOMAIN: 'test',
      ZENDESK_API_TOKEN: 'tok',
      ZENDESK_EMAIL: 'agent@test.com',
    }), corsHeaders);

    // Still succeeds — Zendesk is non-critical
    expect(res.status).toBe(200);

    vi.unstubAllGlobals();
  });

  it('skips Zendesk when credentials missing', async () => {
    const c = makeCase({ state: 'restricted_pending_user_response' });
    const db = {
      prepare: vi.fn().mockImplementation((sql: string) => ({
        bind: vi.fn().mockReturnValue({
          first: vi.fn().mockResolvedValue(
            sql.includes('WHERE id = ? AND pubkey = ?') ? c : null
          ),
          run: vi.fn().mockResolvedValue({ meta: { changes: 1 } }),
        }),
      })),
    };

    const mockFetch = vi.fn();
    vi.stubGlobal('fetch', mockFetch);

    const req = new Request('https://api.test/v1/minor-review-cases/case-1/parent-contact', {
      method: 'POST',
      body: JSON.stringify({ email: 'parent@example.com' }),
    });
    const res = await handleParentContact(req, 'case-1', c.pubkey, makeEnv(db), corsHeaders);

    expect(res.status).toBe(200);
    // No Zendesk API call made
    expect(mockFetch).not.toHaveBeenCalled();

    vi.unstubAllGlobals();
  });

  it('updates existing Zendesk ticket when case already has a zendesk_ticket_id', async () => {
    const c = makeCase({ state: 'restricted_pending_user_response', zendesk_ticket_id: 99 });
    const db = {
      prepare: vi.fn().mockImplementation((sql: string) => ({
        bind: vi.fn().mockReturnValue({
          first: vi.fn().mockResolvedValue(
            sql.includes('WHERE id = ? AND pubkey = ?') ? c : null
          ),
          run: vi.fn().mockResolvedValue({ meta: { changes: 1 } }),
        }),
      })),
    };

    // Must supply json(): the ticket PUT's response is read to resolve the
    // requester, and a bare { ok: true } throws a TypeError that this handler
    // swallows -- which would silently skip everything after the PUT while the
    // test still went green.
    const mockFetch = vi.fn().mockImplementation((url: string, init?: { method?: string }) => {
      if (url.includes('/users/') && (init?.method ?? 'GET') === 'GET') {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ user: { id: 77, role: 'end-user', email: 'parent@example.com', notes: '' } }),
        });
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ ticket: { id: 99, requester_id: 77 } }) });
    });
    vi.stubGlobal('fetch', mockFetch);

    const req = new Request('https://api.test/v1/minor-review-cases/case-1/parent-contact', {
      method: 'POST',
      body: JSON.stringify({ email: 'parent@example.com' }),
    });
    const res = await handleParentContact(req, 'case-1', c.pubkey, makeEnv(db, {
      ZENDESK_SUBDOMAIN: 'test',
      ZENDESK_API_TOKEN: 'tok',
      ZENDESK_EMAIL: 'agent@test.com',
    }), corsHeaders);

    expect(res.status).toBe(200);
    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe('https://test.zendesk.com/api/v2/tickets/99');
    expect(opts.method).toBe('PUT');
    const payload = JSON.parse(opts.body);
    expect(payload.ticket.requester.email).toBe('parent@example.com');
    expect(payload.ticket.comment.public).toBe(true);

    vi.unstubAllGlobals();
  });

  // The attach-to-existing-ticket branch. Its requester write is the riskier of
  // the two -- it reassigns the requester on a ticket that already exists -- and
  // it was previously reachable only through a test whose mock aborted it.
  it('attaches identity on the existing-ticket branch without leaking a handle', async () => {
    const c = makeCase({
      state: 'restricted_pending_user_response',
      zendesk_ticket_id: 99,
      account_name: 'Some One',
    });
    const db = {
      prepare: vi.fn().mockImplementation((sql: string) => ({
        bind: vi.fn().mockReturnValue({
          first: vi.fn().mockResolvedValue(sql.includes('WHERE id = ? AND pubkey = ?') ? c : null),
          run: vi.fn().mockResolvedValue({ meta: { changes: 1 } }),
        }),
      })),
    };

    const mockFetch = vi.fn().mockImplementation((url: string, init?: { method?: string }) => {
      if (url.includes('/users/') && (init?.method ?? 'GET') === 'GET') {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ user: { id: 77, role: 'end-user', email: 'parent@example.com', notes: '' } }),
        });
      }
      if (url.includes('/users/')) return Promise.resolve({ ok: true, json: () => Promise.resolve({ user: { id: 77 } }) });
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ ticket: { id: 99, requester_id: 77 } }) });
    });
    vi.stubGlobal('fetch', mockFetch);

    const req = new Request('https://api.test/v1/minor-review-cases/case-1/parent-contact', {
      method: 'POST',
      body: JSON.stringify({ email: 'parent@example.com' }),
    });
    await handleParentContact(req, 'case-1', c.pubkey, makeEnv(db, {
      ZENDESK_SUBDOMAIN: 'test',
      ZENDESK_API_TOKEN: 'tok',
      ZENDESK_EMAIL: 'agent@test.com',
    }), corsHeaders);

    // Requester-visible: address only, no handle.
    const ticketPut = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(ticketPut.ticket.requester.name).toBe('parent@example.com');
    expect(ticketPut.ticket.requester.name).not.toContain('Some One');

    // The body does name the account, on this path too -- the parent cannot act
    // on the review without knowing which account it is. Only the To: header is
    // held back until a reply proves the address.
    expect(ticketPut.ticket.comment.html_body).toContain('Some One');

    // Zendesk sends `body` when both are present, so a plain body reappearing
    // here would silently revert the message to text. This is the branch a
    // moderator-restricted case takes, so it needs the guard as much as create.
    expect(ticketPut.ticket.comment.body).toBeUndefined();

    // Agent-only: the block reached the contact, with the right case.
    const contactPut = mockFetch.mock.calls.find(
      (call: unknown[]) => (call[0] as string).includes('/users/') && (call[1] as { method?: string })?.method === 'PUT',
    );
    expect(contactPut).toBeTruthy();
    const notes = JSON.parse((contactPut![1] as { body: string }).body).user.notes;
    expect(notes).toContain('/age-review?case=case-1');
    expect(notes).toContain('Some One');

    vi.unstubAllGlobals();
  });

  it('sends the outreach as html_body so Zendesk renders it as rich mail', async () => {
    const c = makeCase({ state: 'restricted_pending_user_response' });
    const db = {
      prepare: vi.fn().mockImplementation((sql: string) => ({
        bind: vi.fn().mockReturnValue({
          first: vi.fn().mockResolvedValue(
            sql.includes('WHERE id = ? AND pubkey = ?') ? c : null
          ),
          run: vi.fn().mockResolvedValue({ meta: { changes: 1 } }),
        }),
      })),
    };

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ ticket: { id: 42 } }),
    });
    vi.stubGlobal('fetch', mockFetch);

    const req = new Request('https://api.test/v1/minor-review-cases/case-1/parent-contact', {
      method: 'POST',
      body: JSON.stringify({ email: 'parent@example.com' }),
    });
    await handleParentContact(req, 'case-1', c.pubkey, makeEnv(db, {
      ZENDESK_SUBDOMAIN: 'test',
      ZENDESK_API_TOKEN: 'tok',
      ZENDESK_EMAIL: 'agent@test.com',
    }), corsHeaders);

    const zendeskCall = mockFetch.mock.calls.find(
      (call: unknown[]) => (call[0] as string).includes('zendesk.com/api/v2/tickets')
    );
    const { comment } = JSON.parse(zendeskCall![1].body).ticket;
    // A plain `body` alongside html_body would be the one Zendesk sent, so the
    // markup has to be the only thing supplied.
    expect(comment.body).toBeUndefined();
    expect(comment.html_body).toContain('<a href="https://divine.video/family">');

    vi.unstubAllGlobals();
  });
});

// -- parent outreach copy -----------------------------------------------------

describe('buildParentOutreachBody', () => {
  it('leads with what we need rather than asking who they are', () => {
    const html = buildParentOutreachBody();
    expect(html).toContain('reply to this email with a short private video');
    // The message this replaces asked only for a confirmation, which parents
    // answered with "yes" -- worthless as consent. That ask must not survive.
    expect(html).not.toContain('confirm you are the parent or legal guardian');
  });

  it('carries no age-band label, so one template serves both bands', () => {
    const html = buildParentOutreachBody();
    for (const label of ['13-15', '16+ (claimed)', 'Under 13', 'age range']) {
      expect(html).not.toContain(label);
    }
    expect(html).toContain('possibly belonging to someone under 16');
  });

  it('states the video requirements, the deadline, and the 16+ path', () => {
    const html = buildParentOutreachBody();
    expect(html).toContain('a parent or guardian speaking on camera');
    // divine.video/kids and /age-review both require the age statement. This
    // email is the primary instruction channel now, so dropping it here sends
    // families back for a second video -- the round trip this copy exists to end.
    expect(html).toContain('that the teen is between 13 and 15');
    expect(html).toContain('the country or countries where you live');
    expect(html).toContain('Please do NOT send government IDs');
    expect(html).toContain('Please reply within 15 days');
    expect(html).toContain('you are 16 or older');
  });

  it('links the family and kids pages as anchors, not bare URLs', () => {
    const html = buildParentOutreachBody();
    expect(html).toContain('<a href="https://divine.video/family">For Families page</a>');
    expect(html).toContain('<a href="https://divine.video/kids">how accounts work for kids on Divine</a>');
  });

  it('names the account so the parent knows which one this is about', () => {
    const html = buildParentOutreachBody({
      pubkey: 'a'.repeat(64),
      account_name: 'Star Girl',
      account_nip05: '_@stargirl.divine.video',
    }, 'divine.video');
    expect(html).toContain('The account under review:');
    expect(html).toContain('Display name: Star Girl');
    // NIP-05 root identifiers display as the bare domain, so the stored
    // `_@stargirl.divine.video` must not reach a parent with its prefix.
    expect(html).toContain('Username: stargirl.divine.video');
    expect(html).not.toContain('_@');
    expect(html).toMatch(/ID: npub1[a-z0-9]+/);
  });

  it('leaves a non-root NIP-05 local part alone', () => {
    const html = buildParentOutreachBody({
      pubkey: 'a'.repeat(64),
      account_nip05: 'alice@divine.video',
    }, 'divine.video');
    expect(html).toContain('Username: alice@divine.video');
  });

  it('drops a NIP-05 whose local part is hostname-shaped, even on a domain we issue', () => {
    // The host gate constrains only the domain. NIP-05 permits `.` in the local
    // part, so an unverified kind-0 value can smuggle a hostname there and still
    // pass the gate on our own domain. looksLinkish screens the local part.
    const html = buildParentOutreachBody({
      pubkey: 'a'.repeat(64),
      account_nip05: 'www.evil.example@divine.video',
    }, 'divine.video');
    expect(html).not.toContain('Username:');
    expect(html).not.toContain('www.evil.example');
  });

  it('drops a NIP-05 on a domain we do not issue', () => {
    // A NIP-05 is a bare hostname, so looksLinkish cannot screen it without
    // rejecting every real one. The issuing domain is the screen instead: this
    // value is unverified kind-0, and rendering it would mail an
    // attacker-chosen, highly linkifiable hostname under Divine branding.
    const html = buildParentOutreachBody({
      pubkey: 'a'.repeat(64),
      account_nip05: '_@claim-your-teen-account.example',
    }, 'divine.video');
    expect(html).not.toContain('Username:');
    expect(html).not.toContain('claim-your-teen-account');
  });

  it('renders no username at all when no issuing domain is configured', () => {
    // Staging deliberately leaves NIP05_DOMAIN unset. No username beats one we
    // cannot vouch for.
    const html = buildParentOutreachBody({
      pubkey: 'a'.repeat(64),
      account_nip05: '_@stargirl.divine.video',
    });
    expect(html).not.toContain('Username:');
  });

  it('accepts a subdomain of the issuing domain but not a lookalike', () => {
    expect(buildParentOutreachBody(
      { pubkey: 'a'.repeat(64), account_nip05: '_@kid.divine.video' }, 'divine.video',
    )).toContain('Username: kid.divine.video');
    // `notdivine.video` ends with the domain as a substring but is not ours.
    expect(buildParentOutreachBody(
      { pubkey: 'a'.repeat(64), account_nip05: '_@notdivine.video' }, 'divine.video',
    )).not.toContain('Username:');
  });

  it('escapes an ID that could not be encoded as an npub', () => {
    // toNpub hands back its input unchanged rather than throwing when the
    // pubkey will not encode, so the ID row is not automatically safe just
    // because npubs are alphanumeric.
    const html = buildParentOutreachBody({ pubkey: '<img src=x onerror=alert(1)>' });
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
  });

  it('drops a display name that is trying to look like a link', () => {
    // The account picks this string AND supplies the address we mail it to, so
    // a name carrying a URL turns this message into attacker-chosen delivery.
    // Escaping does not help: mail clients auto-link bare URLs in text.
    const html = buildParentOutreachBody({
      pubkey: 'a'.repeat(64),
      account_name: 'Star Girl verify at http://not-divine.example/claim',
      account_nip05: '_@stargirl.divine.video',
    }, 'divine.video');
    expect(html).not.toContain('Display name:');
    expect(html).not.toContain('not-divine.example');
    // Failing safe still leaves the parent able to identify the account.
    expect(html).toContain('Username: stargirl.divine.video');
    expect(html).toMatch(/ID: npub1[a-z0-9]+/);
  });

  it('drops a NIP-05 that is not actually a NIP-05', () => {
    // The issuing domain must be supplied, or this asserts nothing: without it
    // displayNip05 returns early and the shape check never runs.
    const html = buildParentOutreachBody({
      pubkey: 'a'.repeat(64),
      account_nip05: 'http://not-divine.example/claim',
    }, 'divine.video');
    expect(html).not.toContain('Username:');
    expect(html).not.toContain('not-divine.example');
  });

  it('drops a NIP-05 smuggling a URL in front of a domain we do issue', () => {
    // The host really is divine.video, so the domain gate passes it. Only the
    // shape check stands between this and a live link to evil.example in mail
    // sent under Divine branding.
    const html = buildParentOutreachBody({
      pubkey: 'a'.repeat(64),
      account_nip05: 'http://evil.example/claim@divine.video',
    }, 'divine.video');
    expect(html).not.toContain('Username:');
    expect(html).not.toContain('evil.example');
  });

  it('drops a NIP-05 carrying markup in front of a domain we do issue', () => {
    const html = buildParentOutreachBody({
      pubkey: 'a'.repeat(64),
      account_nip05: '<script>alert(1)</script>@divine.video',
    }, 'divine.video');
    expect(html).not.toContain('Username:');
    expect(html).not.toContain('script');
  });

  it('prints no empty row for a NIP-05 that is only the root prefix', () => {
    const html = buildParentOutreachBody(
      { pubkey: 'a'.repeat(64), account_nip05: '_@' }, 'divine.video',
    );
    expect(html).not.toContain('Username:');
  });

  it('caps an overlong display name and marks it as cut', () => {
    const html = buildParentOutreachBody({
      pubkey: 'a'.repeat(64),
      account_name: 'Q'.repeat(300),
    });
    expect(html).toContain(`Display name: ${'Q'.repeat(80)}\u2026`);
    expect(html).not.toContain('Q'.repeat(81));
  });

  it('truncates by code point, so an emoji is never cut in half', () => {
    // A lone surrogate in html_body is malformed and Zendesk may reject the
    // whole comment, which would drop the outreach entirely.
    const html = buildParentOutreachBody({
      pubkey: 'a'.repeat(64),
      account_name: `${'x'.repeat(79)}\u{1F600}extra`,
    });
    expect(html).toContain(`${'x'.repeat(79)}\u{1F600}\u2026`);
    expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(html)).toBe(false);
  });

  it('drops a display name carrying a bare IP address', () => {
    // No letters after the final dot, so the hostname rule alone does not see
    // this one.
    const html = buildParentOutreachBody({
      pubkey: 'a'.repeat(64),
      account_name: 'Star Girl go to 93.184.216.34/claim',
    });
    expect(html).not.toContain('Display name:');
  });

  it('drops a display name using a unicode dot to hide a hostname', () => {
    // UTS-46 maps U+3002 to '.', so a mail client resolves this as a hostname
    // even though an ASCII-only check does not see one.
    const html = buildParentOutreachBody({
      pubkey: 'a'.repeat(64),
      account_name: 'Star Girl go to evil\u3002example',
    });
    expect(html).not.toContain('Display name:');
  });

  it('drops a display name hiding a dot behind a zero-width character', () => {
    const html = buildParentOutreachBody({
      pubkey: 'a'.repeat(64),
      account_name: 'Star Girl evil\u200b.example',
    });
    expect(html).not.toContain('Display name:');
  });

  it('drops a name hiding a dot behind an invisible format character outside the zero-width block', () => {
    // U+2062 (INVISIBLE TIMES) is a Cf character the enumerated strip missed:
    // looksLinkish cannot match across it, but a mail client ignores it and
    // parses `evil.example`.
    const html = buildParentOutreachBody({
      pubkey: 'a'.repeat(64),
      account_name: 'Star Girl evil\u2062.example',
    });
    expect(html).not.toContain('Display name:');
  });

  it('drops a name carrying a bidi override and never emits one into the body', () => {
    // U+202E (RIGHT-TO-LEFT OVERRIDE), left unterminated, reorders the rest of
    // the paragraph it lands in -- and the npub row shares that paragraph.
    const html = buildParentOutreachBody({
      pubkey: 'a'.repeat(64),
      account_name: 'Star Girl evil\u202e.example',
    });
    expect(html).not.toContain('Display name:');
    expect(html).not.toContain('\u202e');
  });

  it('drops a name hiding a dot behind a variation selector', () => {
    // U+FE0F is Default_Ignorable but not Cf, so the \p{Cf} half of the strip
    // never reaches it -- and it is the ordinary emoji presentation selector, so
    // it turns up in real display names rather than only in crafted ones. ICU
    // resolves `evil️.example` to `evil.example`, so without
    // \p{Default_Ignorable_Code_Point} this renders a live hostname.
    const html = buildParentOutreachBody({
      pubkey: 'a'.repeat(64),
      account_name: 'Star Girl evil️.example',
    });
    expect(html).not.toContain('Display name:');
  });

  it('drops a display name whose IP address is written in fullwidth digits', () => {
    // The IPv4 rule matches ASCII \d only, and the explicit dot replacement does
    // not touch the digits. NFKC is the only thing that folds this to
    // `93.184.216.34` -- which is exactly what a UTS-46 resolver sees.
    const html = buildParentOutreachBody({
      pubkey: 'a'.repeat(64),
      account_name: 'Star Girl go to ９３．１８４．２１６．３４',
    });
    expect(html).not.toContain('Display name:');
  });

  it('drops a display name carrying a scheme even when the host has no dot', () => {
    // The hostname rule needs a dot after the label, so an intranet or localhost
    // target is caught by the scheme check alone.
    const html = buildParentOutreachBody({
      pubkey: 'a'.repeat(64),
      account_name: 'Star Girl go to http://localhost/claim',
    });
    expect(html).not.toContain('Display name:');
  });

  it('accepts a NIP-05 that arrived with surrounding whitespace', () => {
    // Capture stores kind-0 verbatim and never trims, so a padded value reaches
    // the anchored shape check as-is and would be dropped without the trim.
    const html = buildParentOutreachBody({
      pubkey: 'a'.repeat(64),
      account_nip05: '  _@stargirl.divine.video\n',
    }, 'divine.video');
    expect(html).toContain('Username: stargirl.divine.video');
  });

  it('omits the rows it has no value for rather than printing empties', () => {
    // Capture is best effort: an account whose profile was already hidden by
    // enforcement yields no name and no NIP-05. The npub always resolves.
    const html = buildParentOutreachBody({ pubkey: 'a'.repeat(64) });
    expect(html).toContain('The account under review:');
    expect(html).not.toContain('Display name:');
    expect(html).not.toContain('Username:');
    expect(html).toMatch(/ID: npub1[a-z0-9]+/);
  });

  it('drops the block entirely when nothing was captured', () => {
    expect(buildParentOutreachBody({})).not.toContain('The account under review');
  });

  it('escapes an account-controlled display name', () => {
    // account_name is stored raw from the account's own kind-0 (#222 stores raw
    // on purpose, so each render surface sanitizes for its own medium). This is
    // the only thing between it and a parent's inbox.
    const html = buildParentOutreachBody({
      pubkey: 'a'.repeat(64),
      account_name: '<script>alert(1)</script> & "friends"',
    });
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt; &amp; &quot;friends&quot;');
  });
});

// -- syncAgeReviewTicketResolution ---------------------------------------------

describe('syncAgeReviewTicketResolution', () => {
  it('returns early when case has no zendesk_ticket_id', async () => {
    const mockFetch = vi.fn();
    vi.stubGlobal('fetch', mockFetch);

    const db = {
      prepare: vi.fn().mockImplementation(() => ({
        bind: vi.fn().mockReturnValue({
          first: vi.fn().mockResolvedValue({ zendesk_ticket_id: null }),
        }),
      })),
    };

    await syncAgeReviewTicketResolution('case-1', 'cleared', 'All good', makeEnv(db, {
      ZENDESK_SUBDOMAIN: 'test',
      ZENDESK_API_TOKEN: 'tok',
      ZENDESK_EMAIL: 'agent@test.com',
    }));

    expect(mockFetch).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it('solves Zendesk ticket with internal note on resolution', async () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', mockFetch);

    const db = {
      prepare: vi.fn().mockImplementation(() => ({
        bind: vi.fn().mockReturnValue({
          first: vi.fn().mockResolvedValue({ zendesk_ticket_id: 42 }),
        }),
      })),
    };

    await syncAgeReviewTicketResolution('case-1', 'denied_closed', 'Expired', makeEnv(db, {
      ZENDESK_SUBDOMAIN: 'test',
      ZENDESK_API_TOKEN: 'tok',
      ZENDESK_EMAIL: 'agent@test.com',
    }));

    expect(mockFetch).toHaveBeenCalledOnce();
    const [url, opts] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('/api/v2/tickets/42');
    const payload = JSON.parse(opts.body as string);
    expect(payload.ticket.status).toBe('solved');
    expect(payload.ticket.comment.public).toBe(false);
    expect(payload.ticket.comment.body).toContain('denied_closed');

    vi.unstubAllGlobals();
  });

  it('includes custom fields when env vars are set', async () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', mockFetch);

    const db = {
      prepare: vi.fn().mockImplementation(() => ({
        bind: vi.fn().mockReturnValue({
          first: vi.fn().mockResolvedValue({ zendesk_ticket_id: 42 }),
        }),
      })),
    };

    await syncAgeReviewTicketResolution('case-1', 'cleared', null, makeEnv(db, {
      ZENDESK_SUBDOMAIN: 'test',
      ZENDESK_API_TOKEN: 'tok',
      ZENDESK_EMAIL: 'agent@test.com',
      ZENDESK_FIELD_CATEGORY: '12345',
      ZENDESK_FIELD_ISSUE: '67890',
    }));

    const payload = JSON.parse((mockFetch.mock.calls[0] as [string, RequestInit])[1].body as string);
    expect(payload.ticket.custom_fields).toEqual([
      { id: 12345, value: 'trust___safety' },
      { id: 67890, value: 'content_report_under_16' },
    ]);

    vi.unstubAllGlobals();
  });
});

// -- handleAgeReviewReplyWebhook ------------------------------------------------

// -- Contact name upgrade on parent reply (#213) ------------------------------

describe('contact name upgrade on parent reply', () => {
  function makeReplyDb(c: AgeReviewCase) {
    return {
      prepare: vi.fn().mockImplementation((sql: string) => ({
        bind: vi.fn().mockReturnValue({
          first: vi.fn().mockResolvedValue(sql.includes('zendesk_ticket_id') ? c : null),
          run: vi.fn().mockResolvedValue({ meta: { changes: 1 } }),
        }),
      })),
    };
  }

  function makeTicketFetch() {
    return vi.fn().mockImplementation((url: string, init?: { method?: string }) => {
      if (url.includes('/users/') && init?.method === 'PUT') {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ user: { id: 77 } }) });
      }
      if (url.includes('/users/')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ user: { id: 77, role: 'end-user', email: 'parent@example.com' } }),
        });
      }
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ ticket: { id: 42, requester_id: 77 } }),
      });
    });
  }

  const zendeskEnv = {
    ZENDESK_SUBDOMAIN: 'test',
    ZENDESK_API_TOKEN: 'tok',
    ZENDESK_EMAIL: 'agent@test.com',
  };

  function replyRequest() {
    return new Request('https://api.test/api/zendesk/age-review-reply', {
      method: 'POST',
      body: JSON.stringify({ ticket_id: 42 }),
    });
  }

  afterEach(() => vi.unstubAllGlobals());

  function namePutFrom(mockFetch: ReturnType<typeof vi.fn>) {
    return mockFetch.mock.calls.find(
      (call: unknown[]) => (call[0] as string).includes('/users/') && (call[1] as { method?: string })?.method === 'PUT',
    );
  }

  // By the time the parent has replied the address is demonstrably live and
  // held by someone engaging with the review, so the handle can go in the name
  // that Zendesk renders into the To: header. This is what makes the agent
  // queue readable: the Requester column shows the name and nothing else.
  it('renames the contact to claim the handle once the parent replies', async () => {
    const c = makeCase({
      state: 'restricted_pending_parental_consent',
      zendesk_ticket_id: 42,
      parent_contact_email: 'parent@example.com',
      account_name: 'Some One',
    });
    const mockFetch = makeTicketFetch();
    vi.stubGlobal('fetch', mockFetch);

    await handleAgeReviewReplyWebhook(replyRequest(), makeEnv(makeReplyDb(c), zendeskEnv), corsHeaders);

    const put = namePutFrom(mockFetch);
    expect(put).toBeTruthy();
    // "Claimed" is deliberate: whether they are the parent is exactly what the
    // review exists to establish, so the name must not assert it as fact.
    expect(JSON.parse((put![1] as { body: string }).body).user.name).toBe('Claimed parent of Some One');
  });

  // The rename swallows its own errors and the handler answers 200 either way,
  // so Zendesk never redelivers on a failure. If the rename only ran on the
  // delivery that won the CAS, one transient Zendesk blip would leave the
  // Requester column showing a bare email for the life of the case. A later
  // reply arrives with the case already advanced, so that delivery has to be
  // able to heal it.
  it('still renames on a later reply, after the case has already advanced', async () => {
    const c = makeCase({
      state: 'submitted_for_review',
      zendesk_ticket_id: 42,
      parent_contact_email: 'parent@example.com',
      account_name: 'Some One',
    });
    const mockFetch = makeTicketFetch();
    vi.stubGlobal('fetch', mockFetch);

    const res = await handleAgeReviewReplyWebhook(replyRequest(), makeEnv(makeReplyDb(c), zendeskEnv), corsHeaders);

    // The state machine still declines to advance; only the rename is retried.
    expect(res.status).toBe(200);
    const put = namePutFrom(mockFetch);
    expect(put).toBeTruthy();
    expect(JSON.parse((put![1] as { body: string }).body).user.name).toBe('Claimed parent of Some One');
  });

  it('still renames when the state advance loses to a concurrent write', async () => {
    const c = makeCase({
      state: 'restricted_pending_parental_consent',
      zendesk_ticket_id: 42,
      parent_contact_email: 'parent@example.com',
      account_name: 'Some One',
    });
    // Every UPDATE reports zero rows changed: the CAS never lands.
    const db = {
      prepare: vi.fn().mockImplementation((sql: string) => ({
        bind: vi.fn().mockReturnValue({
          first: vi.fn().mockResolvedValue(sql.includes('zendesk_ticket_id') ? c : c),
          run: vi.fn().mockResolvedValue({ meta: { changes: 0 } }),
        }),
      })),
    };
    const mockFetch = makeTicketFetch();
    vi.stubGlobal('fetch', mockFetch);

    await handleAgeReviewReplyWebhook(replyRequest(), makeEnv(db, zendeskEnv), corsHeaders);

    expect(namePutFrom(mockFetch)).toBeTruthy();
  });

  it('leaves the contact alone when no handle was captured', async () => {
    const c = makeCase({
      state: 'restricted_pending_parental_consent',
      zendesk_ticket_id: 42,
      parent_contact_email: 'parent@example.com',
      account_name: null,
      account_nip05: null,
      account_vine_username: null,
    });
    const mockFetch = makeTicketFetch();
    vi.stubGlobal('fetch', mockFetch);

    await handleAgeReviewReplyWebhook(replyRequest(), makeEnv(makeReplyDb(c), zendeskEnv), corsHeaders);

    expect(namePutFrom(mockFetch)).toBeUndefined();
  });

  // No parent address means the requester is the API caller -- an admin. A
  // rename would retitle a live staff profile after a teenager's account.
  it('leaves the contact alone when the case has no parent email', async () => {
    const c = makeCase({
      state: 'restricted_pending_parental_consent',
      zendesk_ticket_id: 42,
      parent_contact_email: null,
      account_name: 'Some One',
    });
    const mockFetch = makeTicketFetch();
    vi.stubGlobal('fetch', mockFetch);
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});

    await handleAgeReviewReplyWebhook(replyRequest(), makeEnv(makeReplyDb(c), zendeskEnv), corsHeaders);

    // Asserting only on the absent PUT would prove nothing: with the guard
    // removed, the flow still writes nothing because it crashes comparing a
    // null address and the crash is swallowed. So assert on what the guard
    // uniquely achieves -- returning before Zendesk is touched at all, and
    // without an error being logged.
    expect(mockFetch).not.toHaveBeenCalled();
    expect(errorLog).not.toHaveBeenCalled();
    errorLog.mockRestore();
  });

  // A Zendesk display name is global. Renaming a staff member would put a
  // minor's handle in the header of every mail they subsequently send, on any
  // ticket. The case row saying a parent exists does not prove the ticket's
  // requester is that parent: the row is written before the Zendesk call, and
  // that call's failure is swallowed.
  it('refuses to rename a contact that is not an end user', async () => {
    const c = makeCase({
      state: 'restricted_pending_parental_consent',
      zendesk_ticket_id: 42,
      parent_contact_email: 'parent@example.com',
      account_name: 'Some One',
    });
    const mockFetch = vi.fn().mockImplementation((url: string, init?: { method?: string }) => {
      if (url.includes('/users/') && (init?.method ?? 'GET') === 'GET') {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ user: { id: 77, role: 'admin', email: 'parent@example.com' } }),
        });
      }
      if (url.includes('/users/')) return Promise.resolve({ ok: true, json: () => Promise.resolve({ user: { id: 77 } }) });
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ ticket: { id: 42, requester_id: 77 } }) });
    });
    vi.stubGlobal('fetch', mockFetch);

    await handleAgeReviewReplyWebhook(replyRequest(), makeEnv(makeReplyDb(c), zendeskEnv), corsHeaders);

    expect(namePutFrom(mockFetch)).toBeUndefined();
  });

  it('refuses to rename a contact whose email is not the parent address', async () => {
    const c = makeCase({
      state: 'restricted_pending_parental_consent',
      zendesk_ticket_id: 42,
      parent_contact_email: 'parent@example.com',
      account_name: 'Some One',
    });
    const mockFetch = vi.fn().mockImplementation((url: string, init?: { method?: string }) => {
      if (url.includes('/users/') && (init?.method ?? 'GET') === 'GET') {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ user: { id: 77, role: 'end-user', email: 'admin@divine.video' } }),
        });
      }
      if (url.includes('/users/')) return Promise.resolve({ ok: true, json: () => Promise.resolve({ user: { id: 77 } }) });
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ ticket: { id: 42, requester_id: 77 } }) });
    });
    vi.stubGlobal('fetch', mockFetch);

    await handleAgeReviewReplyWebhook(replyRequest(), makeEnv(makeReplyDb(c), zendeskEnv), corsHeaders);

    expect(namePutFrom(mockFetch)).toBeUndefined();
  });

  it('still advances the case when the rename fails', async () => {
    const c = makeCase({
      state: 'restricted_pending_parental_consent',
      zendesk_ticket_id: 42,
      parent_contact_email: 'parent@example.com',
      account_name: 'Some One',
    });
    const mockFetch = vi.fn().mockRejectedValue(new Error('Zendesk down'));
    vi.stubGlobal('fetch', mockFetch);

    const res = await handleAgeReviewReplyWebhook(replyRequest(), makeEnv(makeReplyDb(c), zendeskEnv), corsHeaders);
    const body = await res.json() as { success: boolean; new_state: string };

    expect(res.status).toBe(200);
    expect(body.new_state).toBe('submitted_for_review');
  });

  it('sanitizes an attacker-chosen account name before it reaches the contact', async () => {
    const c = makeCase({
      state: 'restricted_pending_parental_consent',
      zendesk_ticket_id: 42,
      parent_contact_email: 'parent@example.com',
      account_name: 'Evil\nDivine Support',
    });
    const mockFetch = makeTicketFetch();
    vi.stubGlobal('fetch', mockFetch);

    await handleAgeReviewReplyWebhook(replyRequest(), makeEnv(makeReplyDb(c), zendeskEnv), corsHeaders);

    const name = JSON.parse((namePutFrom(mockFetch)![1] as { body: string }).body).user.name;
    expect(name).not.toContain('\n');
  });
});

describe('handleAgeReviewReplyWebhook', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('transitions pending case to submitted_for_review', async () => {
    const c = makeCase({
      state: 'restricted_pending_parental_consent',
      zendesk_ticket_id: 42,
    });
    const runMock = vi.fn().mockResolvedValue({ meta: { changes: 1 } });
    const db = {
      prepare: vi.fn().mockImplementation((sql: string) => ({
        bind: vi.fn().mockReturnValue({
          first: vi.fn().mockResolvedValue(
            sql.includes('zendesk_ticket_id') ? c : null
          ),
          run: runMock,
        }),
      })),
    };

    const req = new Request('https://api.test/api/zendesk/age-review-reply', {
      method: 'POST',
      body: JSON.stringify({ ticket_id: 42 }),
    });
    const res = await handleAgeReviewReplyWebhook(req, makeEnv(db), corsHeaders);
    const body = await res.json() as { success: boolean; new_state: string };

    expect(res.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.new_state).toBe('submitted_for_review');

    const updateCall = db.prepare.mock.calls.find(
      (call: string[]) => call[0]?.includes('submitted_for_review')
    );
    expect(updateCall).toBeTruthy();
    expect(updateCall![0]).toContain('clock_paused = 1');
  });

  it.each([
    ['preserves positive time', '2026-08-31T12:00:00.000Z', 5],
    ['clamps expired time', '2026-08-25T12:00:00.000Z', 0],
  ] as const)('re-pauses a resumed clock and %s', async (_label, deadlineAt, expectedRemaining) => {
    const c = makeCase({
      state: 'restricted_pending_parental_consent',
      zendesk_ticket_id: 42,
      clock_paused: 0,
      deadline_at: deadlineAt,
    });
    const runMock = vi.fn().mockResolvedValue({ meta: { changes: 1 } });
    const boundValues: unknown[] = [];
    const db = {
      prepare: vi.fn().mockImplementation((sql: string) => ({
        bind: vi.fn().mockImplementation((...args: unknown[]) => {
          if (sql.includes('submitted_for_review')) boundValues.push(...args);
          return {
            first: vi.fn().mockResolvedValue(
              sql.includes('zendesk_ticket_id') ? c : null
            ),
            run: runMock,
          };
        }),
      })),
    };
    vi.useFakeTimers();
    vi.setSystemTime('2026-08-26T12:00:00.000Z');

    const req = new Request('https://api.test/api/zendesk/age-review-reply', {
      method: 'POST',
      body: JSON.stringify({ ticket_id: 42 }),
    });
    const res = await handleAgeReviewReplyWebhook(req, makeEnv(db), corsHeaders);
    expect(res.status).toBe(200);

    // Both sides matter: preserving positive time avoids premature closure on resume,
    // while flooring expired time keeps the stored paused tuple valid.
    expect(boundValues.length).toBeGreaterThanOrEqual(2);
    expect(boundValues[0]).toBe('2026-08-26T12:00:00.000Z');
    expect(boundValues[1]).toBe(expectedRemaining);
  });

  it('returns 404 when no case linked to ticket', async () => {
    const db = {
      prepare: vi.fn().mockImplementation(() => ({
        bind: vi.fn().mockReturnValue({
          first: vi.fn().mockResolvedValue(null),
        }),
      })),
    };

    const req = new Request('https://api.test/api/zendesk/age-review-reply', {
      method: 'POST',
      body: JSON.stringify({ ticket_id: 999 }),
    });
    const res = await handleAgeReviewReplyWebhook(req, makeEnv(db), corsHeaders);
    expect(res.status).toBe(404);
  });

  it('does not transition if case is not in pending state', async () => {
    const c = makeCase({
      state: 'under_moderator_review',
      zendesk_ticket_id: 42,
    });
    const db = {
      prepare: vi.fn().mockImplementation((sql: string) => ({
        bind: vi.fn().mockReturnValue({
          first: vi.fn().mockResolvedValue(
            sql.includes('zendesk_ticket_id') ? c : null
          ),
          run: vi.fn().mockResolvedValue({ meta: { changes: 1 } }),
        }),
      })),
    };

    const req = new Request('https://api.test/api/zendesk/age-review-reply', {
      method: 'POST',
      body: JSON.stringify({ ticket_id: 42 }),
    });
    const res = await handleAgeReviewReplyWebhook(req, makeEnv(db), corsHeaders);
    const body = await res.json() as { success: boolean; message: string };

    expect(res.status).toBe(200);
    expect(body.message).toContain('not in a state that can advance');
  });

  it('returns 400 when ticket_id missing', async () => {
    const db = createMockDb([]);
    const req = new Request('https://api.test/api/zendesk/age-review-reply', {
      method: 'POST',
      body: JSON.stringify({}),
    });
    const res = await handleAgeReviewReplyWebhook(req, makeEnv(db), corsHeaders);
    expect(res.status).toBe(400);
  });
});

// -- Age review config --------------------------------------------------------

describe('getAgeReviewConfig', () => {
  it('returns default config when no rows exist', async () => {
    const db = {
      prepare: vi.fn().mockReturnValue({
        first: vi.fn().mockResolvedValue(null),
      }),
    };
    const config = await getAgeReviewConfig(db as unknown as D1Database);
    expect(config.auto_delete_on_deny).toBe(true);
  });

  it('reads stored config value', async () => {
    const db = {
      prepare: vi.fn().mockReturnValue({
        first: vi.fn().mockResolvedValue({ value: 'false' }),
      }),
    };
    const config = await getAgeReviewConfig(db as unknown as D1Database);
    expect(config.auto_delete_on_deny).toBe(false);
  });
});

describe('updateAgeReviewConfig', () => {
  it('writes config and returns updated value', async () => {
    const db = {
      prepare: vi.fn().mockImplementation((sql: string) => {
        if (sql.includes('INSERT')) {
          return { bind: vi.fn().mockReturnValue({ run: vi.fn().mockResolvedValue({}) }) };
        }
        return { first: vi.fn().mockResolvedValue({ value: 'false' }) };
      }),
    };
    const config = await updateAgeReviewConfig(db as unknown as D1Database, { auto_delete_on_deny: false });
    expect(config.auto_delete_on_deny).toBe(false);
  });
});

// -- handleCreateMinorAccount -------------------------------------------------

describe('handleCreateMinorAccount', () => {
  const mockCreateMinorAccount = createMinorAccount as ReturnType<typeof vi.fn>;

  function makeRequest(body: unknown) {
    return new Request('https://api.test/api/age-review/minor-account', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  function makeMinorDb(runImpl?: () => Promise<unknown>) {
    const execute = runImpl ?? (() => Promise.resolve({ success: true, meta: { changes: 1 } }));
    return {
      prepare: vi.fn().mockImplementation(() => {
        const bound = { run: vi.fn().mockImplementation(execute), first: vi.fn().mockResolvedValue(null) };
        return { bind: vi.fn().mockReturnValue(bound), run: vi.fn().mockImplementation(execute), first: vi.fn().mockResolvedValue(null) };
      }),
      batch: vi.fn().mockImplementation(async () => { await execute(); return [{ meta: { changes: 1 } }]; }),
    } as unknown as D1Database;
  }

  beforeEach(() => {
    mockCreateMinorAccount.mockReset();
    mockCreateMinorAccount.mockResolvedValue({
      success: true,
      pubkey: 'a'.repeat(64),
      claim_url: 'https://login.test/claim/abc',
      expires_at: '2026-06-15T00:00:00Z',
    });
  });

  it('creates account and returns success with claim_url', async () => {
    const db = makeMinorDb();
    const res = await handleCreateMinorAccount(makeRequest({ username: 'testuser' }), makeEnv(db), corsHeaders);
    const body = await res.json() as Record<string, unknown>;

    expect(res.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.claim_url).toBe('https://login.test/claim/abc');
    expect(body.pubkey).toBe('a'.repeat(64));
    expect(body.case_id).toBeDefined();
  });

  // Identity capture (#213). This path is handed the username and display name
  // directly, so unlike the report paths it needs no relay lookup -- it just has
  // to store what it already knows.
  /**
   * The identity binds, by position. Membership assertions cannot tell
   * account_name from account_nip05, so a swap between the two columns would
   * pass while writing each value into the other's column.
   */
  function identityBinds(db: { prepare: unknown }) {
    const prepareMock = db.prepare as ReturnType<typeof vi.fn>;
    const insertIdx = prepareMock.mock.calls.findIndex(
      (c: unknown[]) => String(c[0]).includes('INSERT INTO age_review_cases'),
    );
    const sql = String(prepareMock.mock.calls[insertIdx][0]);
    const binds = prepareMock.mock.results[insertIdx].value.bind.mock.calls.flat();
    return {
      sql,
      accountName: binds[5],
      accountNip05: binds[6],
      accountVineUsername: binds[7],
      identityCapturedAt: binds[8],
    };
  }

  it('records the supplied display name as the account identity', async () => {
    const db = makeMinorDb();
    await handleCreateMinorAccount(
      makeRequest({ username: 'someuser', display_name: 'Some One' }),
      makeEnv(db), corsHeaders,
    );

    const { sql, accountName } = identityBinds(db);
    expect(sql).toContain('account_name');
    expect(accountName).toBe('Some One');
  });

  // The backfill treats a null identity_captured_at as "never looked", so a row
  // that skipped this stamp would be re-queried forever -- and one that stamps
  // it without meaning to would be excluded from recovery permanently.
  it('stamps identity_captured_at so the row is not re-queried by a backfill', async () => {
    const db = makeMinorDb();
    await handleCreateMinorAccount(
      makeRequest({ username: 'someuser', display_name: 'Some One' }),
      makeEnv(db), corsHeaders,
    );

    const { sql, identityCapturedAt } = identityBinds(db);
    expect(sql).toContain('identity_captured_at');
    expect(identityCapturedAt).toEqual(expect.any(String));
    expect(new Date(identityCapturedAt as string).toString()).not.toBe('Invalid Date');
  });

  // account_name prefers display_name, so without this the operator-supplied
  // username is dropped whenever a display name is present -- and these rows
  // stamp identity_captured_at, which excludes them from any backfill keyed on
  // IS NULL. Divine's NIP-05 is the subdomain form, so the username survives
  // inside it and stays recoverable.
  it('derives the account nip05 from the username so it is not discarded', async () => {
    const db = makeMinorDb();
    await handleCreateMinorAccount(
      makeRequest({ username: 'someuser', display_name: 'Some One' }),
      makeEnv(db, { NIP05_DOMAIN: 'divine.video' }), corsHeaders,
    );

    const { sql, accountName, accountNip05 } = identityBinds(db);
    expect(sql).toContain('account_nip05');
    // Positional: the display name and the derived NIP-05 must land in their
    // own columns, not each other's.
    expect(accountName).toBe('Some One');
    expect(accountNip05).toBe('_@someuser.divine.video');
  });

  // Staging accounts do not live under the production identity domain, so a
  // hardcoded fallback would write a wrong address into an agent-facing record.
  // Storing nothing is the honest outcome when the domain is not configured.
  it('stores no nip05 when the identity domain is not configured', async () => {
    const db = makeMinorDb();
    await handleCreateMinorAccount(
      makeRequest({ username: 'someuser', display_name: 'Some One' }),
      makeEnv(db), corsHeaders,
    );

    expect(identityBinds(db).accountNip05).toBeNull();
  });

  // Storing the username only inside a derived NIP-05 loses it wherever
  // NIP05_DOMAIN is unset -- which is staging, deliberately. And this path
  // stamps identity_captured_at, so the backfill's IS NULL keying never returns
  // to the row: the loss is permanent, in exactly the environment shipped
  // without the config. The username has to survive on its own.
  it('keeps the username even when the identity domain is not configured', async () => {
    const db = makeMinorDb();
    await handleCreateMinorAccount(
      makeRequest({ username: 'someuser', display_name: 'Some One' }),
      makeEnv(db), corsHeaders,
    );

    const binds = identityBinds(db);
    expect(binds.accountNip05).toBeNull();
    expect(binds.accountVineUsername).toBe('someuser');
    // The display name still wins account_name; this is a second home, not a swap.
    expect(binds.accountName).toBe('Some One');
  });

  it('keeps the username alongside the derived nip05 when the domain is configured', async () => {
    const db = makeMinorDb();
    await handleCreateMinorAccount(
      makeRequest({ username: 'someuser', display_name: 'Some One' }),
      makeEnv(db, { NIP05_DOMAIN: 'divine.video' }), corsHeaders,
    );

    const binds = identityBinds(db);
    expect(binds.accountNip05).toBe('_@someuser.divine.video');
    expect(binds.accountVineUsername).toBe('someuser');
  });

  it('falls back to the username when no display name is given', async () => {
    const db = makeMinorDb();
    await handleCreateMinorAccount(makeRequest({ username: 'someuser' }), makeEnv(db), corsHeaders);

    expect(identityBinds(db).accountName).toBe('someuser');
  });

  it('rejects missing username', async () => {
    const db = makeMinorDb();
    const res = await handleCreateMinorAccount(makeRequest({}), makeEnv(db), corsHeaders);
    expect(res.status).toBe(400);
    expect(mockCreateMinorAccount).not.toHaveBeenCalled();
  });

  it('rejects invalid username characters', async () => {
    const db = makeMinorDb();
    const res = await handleCreateMinorAccount(makeRequest({ username: 'BAD USER!' }), makeEnv(db), corsHeaders);
    expect(res.status).toBe(400);
    expect(mockCreateMinorAccount).not.toHaveBeenCalled();
  });

  it('rejects non-string display_name', async () => {
    const db = makeMinorDb();
    const res = await handleCreateMinorAccount(
      makeRequest({ username: 'test', display_name: 12345 }),
      makeEnv(db),
      corsHeaders,
    );
    expect(res.status).toBe(400);
    expect(mockCreateMinorAccount).not.toHaveBeenCalled();
  });

  it('strips empty display_name before calling Keycast', async () => {
    const db = makeMinorDb();
    await handleCreateMinorAccount(makeRequest({ username: 'test', display_name: '  ' }), makeEnv(db), corsHeaders);
    expect(mockCreateMinorAccount).toHaveBeenCalledWith('test', undefined, expect.anything(), expect.any(String));
  });

  it('rejects non-integer zendesk_ticket_id', async () => {
    const db = makeMinorDb();
    const res = await handleCreateMinorAccount(
      makeRequest({ username: 'test', zendesk_ticket_id: 'abc' }),
      makeEnv(db),
      corsHeaders,
    );
    expect(res.status).toBe(400);
    expect(mockCreateMinorAccount).not.toHaveBeenCalled();
  });

  it('returns 500 without calling Keycast when the operation ledger write fails', async () => {
    const db = makeMinorDb(() => Promise.reject(new Error('D1 write failed')));
    const res = await handleCreateMinorAccount(makeRequest({ username: 'testuser' }), makeEnv(db), corsHeaders);
    const body = await res.json() as Record<string, unknown>;

    expect(res.status).toBe(500);
    expect(body.success).toBe(false);
    expect(body.claim_url).toBeUndefined();
    expect(body.pubkey).toBeUndefined();
    expect(body.error).toContain('no account was created');
    expect(mockCreateMinorAccount).not.toHaveBeenCalled();
  });

  it('maps Keycast 409 to 409 status', async () => {
    mockCreateMinorAccount.mockResolvedValue({ success: false, error: '409: Username taken' });
    const db = makeMinorDb();
    const res = await handleCreateMinorAccount(makeRequest({ username: 'taken' }), makeEnv(db), corsHeaders);
    expect(res.status).toBe(409);
  });

  it('maps other Keycast 4xx to 400 status', async () => {
    mockCreateMinorAccount.mockResolvedValue({ success: false, error: '422: Invalid input' });
    const db = makeMinorDb();
    const res = await handleCreateMinorAccount(makeRequest({ username: 'test' }), makeEnv(db), corsHeaders);
    expect(res.status).toBe(400);
  });

  it('maps Keycast server errors to 502 status', async () => {
    mockCreateMinorAccount.mockResolvedValue({ success: false, error: 'Connection refused' });
    const db = makeMinorDb();
    const res = await handleCreateMinorAccount(makeRequest({ username: 'test' }), makeEnv(db), corsHeaders);
    expect(res.status).toBe(502);
  });

  it('persists claim_link_expires_at from the Keycast response', async () => {
    const db = makeMinorDb();

    const res = await handleCreateMinorAccount(
      makeRequest({ username: 'testuser' }),
      makeEnv(db),
      corsHeaders,
    );

    expect(res.status).toBe(200);
    // INSERT bind order: caseId, pubkey, claim_url, claim_link_expires_at, zendesk_ticket_id.
    // Assert positionally so this also guards the column/bind ordering.
    const values = identityBinds(db).sql;
    expect(values).toContain('claim_link_expires_at');
    const prepareMock = db.prepare as ReturnType<typeof vi.fn>;
    const insert = prepareMock.mock.calls.findIndex((call: unknown[]) => String(call[0]).includes('INSERT INTO age_review_cases'));
    const bindArgs = prepareMock.mock.results[insert].value.bind.mock.calls[0];
    expect(bindArgs[2]).toBe('https://login.test/claim/abc');
    expect(bindArgs[3]).toBe('2026-06-15T00:00:00Z');
  });

  it('persists null claim_link_expires_at when Keycast omits expires_at', async () => {
    mockCreateMinorAccount.mockResolvedValue({
      success: true,
      pubkey: 'a'.repeat(64),
      claim_url: 'https://login.test/claim/abc',
    });

    const db = makeMinorDb();

    const res = await handleCreateMinorAccount(
      makeRequest({ username: 'testuser' }),
      makeEnv(db),
      corsHeaders,
    );

    expect(res.status).toBe(200);
    // claim_url is present (binds at index 2), but expires_at is absent -> bound as null at index 3.
    // Assert positionally: toContain(null) would also match the null zendesk_ticket_id.
    const prepareMock = db.prepare as ReturnType<typeof vi.fn>;
    const insert = prepareMock.mock.calls.findIndex((call: unknown[]) => String(call[0]).includes('INSERT INTO age_review_cases'));
    const bindArgs = prepareMock.mock.results[insert].value.bind.mock.calls[0];
    expect(bindArgs[2]).toBe('https://login.test/claim/abc');
    expect(bindArgs[3]).toBeNull();
  });
});

describe('bucketModerationCounts', () => {
  it('sums non-terminal states into in_progress and splits approved by created_via', () => {
    const result = bucketModerationCounts([
      { state: 'cleared', created_via: 'report', c: 3 },
      { state: 'cleared', created_via: 'minor_onboarding', c: 2 },
      { state: 'denied_closed', created_via: 'report', c: 1 },
      { state: 'submitted_for_review', created_via: 'report', c: 4 },
      { state: 'restricted_pending_parental_consent', created_via: 'report', c: 5 },
    ]);
    expect(result.in_progress).toBe(9);
    expect(result.approved).toEqual({ total: 5, restored: 3, new_minor: 2 });
    expect(result.denied_expired).toBe(1);
  });

  it('returns zeroes for an empty set', () => {
    expect(bucketModerationCounts([])).toEqual({
      in_progress: 0,
      approved: { total: 0, restored: 0, new_minor: 0 },
      denied_expired: 0,
    });
  });

  it('treats an unknown/future state as in_progress (open) by design', () => {
    const result = bucketModerationCounts([
      { state: 'some_future_state', created_via: 'report', c: 6 },
    ]);
    expect(result.in_progress).toBe(6);
    expect(result.approved.total).toBe(0);
    expect(result.denied_expired).toBe(0);
  });

  it('counts a cleared row with null created_via as restored', () => {
    const result = bucketModerationCounts([
      { state: 'cleared', created_via: null, c: 4 },
    ]);
    expect(result.approved).toEqual({ total: 4, restored: 4, new_minor: 0 });
  });
});

describe('fetchZendeskTagCount', () => {
  const config = { auth: btoa('a@b.co/token:tok'), baseUrl: 'https://rabblelabs.zendesk.com/api/v2' };

  afterEach(() => { vi.unstubAllGlobals(); });

  it('builds the search/count URL from the config and returns the count', async () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ count: 7 }) });
    vi.stubGlobal('fetch', mockFetch);

    const result = await fetchZendeskTagCount(config, 'type:ticket tags:age-review-response');

    expect(result).toBe(7);
    const [calledUrl, init] = mockFetch.mock.calls[0];
    expect(calledUrl).toContain('https://rabblelabs.zendesk.com/api/v2/search/count.json?query=');
    expect(calledUrl).toContain(encodeURIComponent('type:ticket tags:age-review-response'));
    expect((init as RequestInit).headers).toMatchObject({ Authorization: `Basic ${config.auth}` });
  });

  it('returns null on a non-ok response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, json: async () => ({}) }));
    expect(await fetchZendeskTagCount(config, 'q')).toBeNull();
  });

  it('returns null when fetch throws', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network')));
    expect(await fetchZendeskTagCount(config, 'q')).toBeNull();
  });
});

describe('handleGetAgeReviewFunnel', () => {
  const cors = { 'Access-Control-Allow-Origin': '*' };
  const groupRows = [
    { state: 'cleared', created_via: 'report', c: 3 },
    { state: 'cleared', created_via: 'minor_onboarding', c: 2 },
    { state: 'denied_closed', created_via: 'report', c: 1 },
    { state: 'submitted_for_review', created_via: 'report', c: 4 },
  ];
  const makeMockDb = () => ({
    prepare: vi.fn().mockReturnValue({
      bind: vi.fn().mockReturnValue({ all: vi.fn().mockResolvedValue({ results: groupRows }) }),
    }),
  });
  const req = new Request('https://api.test/api/age-review/funnel?age_band=age_13_15');

  afterEach(() => { vi.unstubAllGlobals(); });

  it('returns moderation counts and nulls helpdesk when Zendesk creds are absent', async () => {
    const env = makeEnv(makeMockDb()); // no ZENDESK_* set
    const res = await handleGetAgeReviewFunnel(req, env, cors);
    const body = await res.json() as import('../../shared/age-review').AgeReviewFunnelResponse;

    expect(res.status).toBe(200);
    expect(body.moderation.approved).toEqual({ total: 5, restored: 3, new_minor: 2 });
    expect(body.moderation.in_progress).toBe(4);
    expect(body.moderation.denied_expired).toBe(1);
    expect(body.helpdesk).toMatchObject({ reports_in: null, requests_in: null, video_received: null });
    expect(body.age_band).toBe('age_13_15');
  });

  it('populates helpdesk counts when Zendesk creds resolve', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ count: 9 }) }));
    const env = makeEnv(makeMockDb(), {
      ZENDESK_SUBDOMAIN: 'rabblelabs', ZENDESK_EMAIL: 'a@b.co', ZENDESK_API_TOKEN: 'tok',
    });
    const res = await handleGetAgeReviewFunnel(req, env, cors);
    const body = await res.json() as import('../../shared/age-review').AgeReviewFunnelResponse;

    expect(body.helpdesk.requests_in).toBe(9);
    expect(body.helpdesk.video_received).toBe(9);
    expect(body.helpdesk.reports_in).toBe(9);
  });

  it('keeps moderation counts and nulls helpdesk when Zendesk creds resolve but the call fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('zendesk down')));
    const env = makeEnv(makeMockDb(), {
      ZENDESK_SUBDOMAIN: 'rabblelabs', ZENDESK_EMAIL: 'a@b.co', ZENDESK_API_TOKEN: 'tok',
    });
    const res = await handleGetAgeReviewFunnel(req, env, cors);
    const body = await res.json() as import('../../shared/age-review').AgeReviewFunnelResponse;

    expect(res.status).toBe(200);
    expect(body.moderation.approved).toEqual({ total: 5, restored: 3, new_minor: 2 });
    expect(body.moderation.in_progress).toBe(4);
    expect(body.helpdesk).toMatchObject({ reports_in: null, requests_in: null, video_received: null });
  });

  it('keeps moderation counts and nulls helpdesk when Zendesk secret resolution fails', async () => {
    const env = makeEnv(makeMockDb(), {
      ZENDESK_SUBDOMAIN: { get: vi.fn().mockRejectedValue(new Error('secret store down')) },
      ZENDESK_EMAIL: 'a@b.co',
      ZENDESK_API_TOKEN: 'tok',
    });
    const res = await handleGetAgeReviewFunnel(req, env, cors);
    const body = await res.json() as import('../../shared/age-review').AgeReviewFunnelResponse;

    expect(res.status).toBe(200);
    expect(body.moderation.approved).toEqual({ total: 5, restored: 3, new_minor: 2 });
    expect(body.moderation.in_progress).toBe(4);
    expect(body.helpdesk).toMatchObject({ reports_in: null, requests_in: null, video_received: null });
  });

  it('counts each helpdesk stage with the exact shared criteria query', async () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ count: 9 }) });
    vi.stubGlobal('fetch', mockFetch);
    const env = makeEnv(makeMockDb(), {
      ZENDESK_SUBDOMAIN: 'rabblelabs', ZENDESK_EMAIL: 'a@b.co', ZENDESK_API_TOKEN: 'tok',
    });
    await handleGetAgeReviewFunnel(req, env, cors);

    // The displayed tooltip criteria are sourced from these same constants, so
    // asserting the worker queries with them keeps explanation == measurement.
    const calledUrls = mockFetch.mock.calls.map((c) => c[0] as string);
    for (const query of Object.values(FUNNEL_ZENDESK_QUERIES)) {
      expect(calledUrls.some((u) => u.includes(encodeURIComponent(query)))).toBe(true);
    }
  });
});

describe('ageReviewActiveGuard — non-canonical pubkey', () => {
  // Skipped in BOTH modes, deliberately. A case is keyed to a real lowercase pubkey,
  // so a non-canonical value cannot have one to skip past -- there is nothing for the
  // guard to protect. handleRelayRpc rejects these outright on the enforce direction;
  // the reverse direction is allowed to carry them so a row banned with a bad value
  // stays removable, and that only works if the guard lets it through.
  const CORS = { 'Access-Control-Allow-Origin': 'https://app.divine.video' };
  const envWithDb = { DB: { prepare: () => ({ bind: () => ({ first: async () => null }) }) } } as unknown as AgeReviewEnv;

  it('proceeds under failClosed, because no case can be keyed to it', async () => {
    const response = await ageReviewActiveGuard('NOT_CANONICAL_HEX', envWithDb, CORS, 'err', { failClosed: true });
    expect(response).toBeNull();
  });

  it('proceeds when not failing closed', async () => {
    const response = await ageReviewActiveGuard('NOT_CANONICAL_HEX', envWithDb, CORS, 'err');
    expect(response).toBeNull();
  });
});
