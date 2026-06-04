import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  handleGetAgeReviewCases,
  handleGetAgeReviewCase,
  handleUpdateAgeReviewCase,
  handleGetModerationStatus,
  handleParentContact,
  handleAgeReviewReplyWebhook,
  handleCreateMinorAccount,
  checkAgeReviewDeadlines,
  syncAgeReviewTicketResolution,
  getAgeReviewConfig,
  updateAgeReviewConfig,
  type AgeReviewEnv,
} from './age-review';
import type { AgeReviewCase } from '../../shared/age-review';
import { suspendUser, unsuspendUser, banUser, createMinorAccount } from './keycast-client';

vi.mock('./keycast-client', () => ({
  suspendUser: vi.fn().mockResolvedValue({ success: true }),
  unsuspendUser: vi.fn().mockResolvedValue({ success: true }),
  banUser: vi.fn().mockResolvedValue({ success: true }),
  createMinorAccount: vi.fn().mockResolvedValue({ success: true, pubkey: 'a'.repeat(64), claim_url: 'https://login.test/claim/abc' }),
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
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
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
    }), corsHeaders);
    expect(res.status).toBe(200);

    const zendeskCall = mockFetch.mock.calls.find(
      (call: unknown[]) => (call[0] as string).includes('zendesk.com/api/v2/tickets/55')
    );
    expect(zendeskCall).toBeTruthy();
    const payload = JSON.parse(zendeskCall![1].body);
    expect(payload.ticket.status).toBe('solved');
    expect(payload.ticket.comment.body).toContain('cleared');

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
});

// -- Keycast suspension wiring ------------------------------------------------

describe('Keycast suspension wiring', () => {
  beforeEach(() => {
    vi.mocked(suspendUser).mockClear().mockResolvedValue({ success: true });
    vi.mocked(unsuspendUser).mockClear().mockResolvedValue({ success: true });
    vi.mocked(banUser).mockClear().mockResolvedValue({ success: true });
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

  it('does not block state transition when Keycast fails', async () => {
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
    const body = await res.json() as { success: boolean; keycastUpdated: boolean };

    expect(res.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.keycastUpdated).toBe(false);
  });

  it('does not block state transition when Keycast throws', async () => {
    vi.mocked(banUser).mockRejectedValue(new Error('Network error'));

    const restrictedCase = makeCase({ state: 'restricted_pending_user_response' });
    const updatedCase = { ...restrictedCase, state: 'denied_closed' as const };

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
      body: JSON.stringify({ state: 'denied_closed' }),
    });
    const res = await handleUpdateAgeReviewCase(req, 'case-1', makeEnv(db), corsHeaders);
    const body = await res.json() as { success: boolean };

    expect(res.status).toBe(200);
    expect(body.success).toBe(true);
  });
});

// -- handleGetModerationStatus ------------------------------------------------

describe('handleGetModerationStatus', () => {
  it('returns active when no case exists', async () => {
    const db = createMockDb([]);
    const res = await handleGetModerationStatus('a'.repeat(64), makeEnv(db), corsHeaders);
    const body = await res.json() as { restriction: { status: string } };

    expect(res.status).toBe(200);
    expect(body.restriction.status).toBe('active');
  });

  it('returns restrictedMinorReview when active case exists', async () => {
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
      minorReviewCase: { id: string; state: string };
    };

    expect(body.restriction.status).toBe('restrictedMinorReview');
    expect(body.minorReviewCase.id).toBe('case-1');
    expect(body.minorReviewCase.state).toBe('restricted_pending_user_response');
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

  it('returns active (fail-open) when DB unavailable', async () => {
    const res = await handleGetModerationStatus('a'.repeat(64), makeEnv(), corsHeaders);
    const body = await res.json() as { restriction: { status: string } };

    expect(res.status).toBe(200);
    expect(body.restriction.status).toBe('active');
  });
});

// -- handleParentContact ------------------------------------------------------

describe('handleParentContact', () => {
  it('saves email and pauses clock for age_13_15 case', async () => {
    const c = makeCase({ state: 'restricted_pending_user_response' });
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
            results: sql.includes('deadline_at > datetime') ? [] : [expiredCase],
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
      (c: string[]) => c[0]?.includes('denied_closed')
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
            results: sql.includes('deadline_at > datetime') ? [] : [expiredCase],
          }),
          first: vi.fn().mockResolvedValue(null),
          run: runMock,
        }),
      })),
    };

    await checkAgeReviewDeadlines(makeEnv(db));

    const closeCalls = db.prepare.mock.calls.filter(
      (c: string[]) => c[0]?.includes('denied_closed')
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
            results: sql.includes('deadline_at > datetime') ? [approachingCase] : [],
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
            results: sql.includes('deadline_at > datetime') ? [approachingCase] : [],
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
            results: sql.includes('deadline_at > datetime') ? [approachingCase] : [],
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
    const res = await handleParentContact(req, 'case-1', c.pubkey, makeEnv(db, {
    }), corsHeaders);

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

    const mockFetch = vi.fn().mockResolvedValue({ ok: true });
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
    expect(mockFetch).toHaveBeenCalledOnce();
    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe('https://test.zendesk.com/api/v2/tickets/99');
    expect(opts.method).toBe('PUT');
    const payload = JSON.parse(opts.body);
    expect(payload.ticket.requester.email).toBe('parent@example.com');
    expect(payload.ticket.comment.public).toBe(true);

    vi.unstubAllGlobals();
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

describe('handleAgeReviewReplyWebhook', () => {
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

  it('re-pauses clock when moderator had resumed it', async () => {
    const c = makeCase({
      state: 'restricted_pending_parental_consent',
      zendesk_ticket_id: 42,
      clock_paused: 0,
      deadline_at: new Date(Date.now() + 5 * 24 * 60 * 60 * 1000).toISOString(),
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

    const req = new Request('https://api.test/api/zendesk/age-review-reply', {
      method: 'POST',
      body: JSON.stringify({ ticket_id: 42 }),
    });
    const res = await handleAgeReviewReplyWebhook(req, makeEnv(db), corsHeaders);
    expect(res.status).toBe(200);

    // Should have bound an ISO timestamp and remaining days (~5)
    expect(boundValues.length).toBeGreaterThanOrEqual(2);
    const remainingDays = boundValues[1] as number;
    expect(remainingDays).toBeGreaterThan(4);
    expect(remainingDays).toBeLessThan(6);
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
    return {
      prepare: vi.fn().mockReturnValue({
        bind: vi.fn().mockReturnValue({
          run: vi.fn().mockImplementation(runImpl ?? (() => Promise.resolve({ success: true }))),
        }),
      }),
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
    expect(mockCreateMinorAccount).toHaveBeenCalledWith('test', undefined, expect.anything());
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

  it('returns 500 without claim_url when D1 insert fails after Keycast success', async () => {
    const db = makeMinorDb(() => Promise.reject(new Error('D1 write failed')));
    const res = await handleCreateMinorAccount(makeRequest({ username: 'testuser' }), makeEnv(db), corsHeaders);
    const body = await res.json() as Record<string, unknown>;

    expect(res.status).toBe(500);
    expect(body.success).toBe(false);
    expect(body.claim_url).toBeUndefined();
    expect(body.pubkey).toBe('a'.repeat(64));
    expect(body.error).toContain('audit record failed');
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
    const bindArgs: unknown[] = [];
    const db = {
      prepare: vi.fn().mockReturnValue({
        bind: vi.fn().mockImplementation((...args: unknown[]) => {
          bindArgs.push(...args);
          return { run: vi.fn().mockResolvedValue({ success: true }) };
        }),
      }),
    };

    const res = await handleCreateMinorAccount(
      makeRequest({ username: 'testuser' }),
      makeEnv(db),
      corsHeaders,
    );

    expect(res.status).toBe(200);
    // INSERT bind order: caseId, pubkey, claim_url, claim_link_expires_at, zendesk_ticket_id.
    // Assert positionally so this also guards the column/bind ordering.
    expect(bindArgs[2]).toBe('https://login.test/claim/abc');
    expect(bindArgs[3]).toBe('2026-06-15T00:00:00Z');
  });

  it('persists null claim_link_expires_at when Keycast omits expires_at', async () => {
    mockCreateMinorAccount.mockResolvedValue({
      success: true,
      pubkey: 'a'.repeat(64),
      claim_url: 'https://login.test/claim/abc',
    });

    const bindArgs: unknown[] = [];
    const db = {
      prepare: vi.fn().mockReturnValue({
        bind: vi.fn().mockImplementation((...args: unknown[]) => {
          bindArgs.push(...args);
          return { run: vi.fn().mockResolvedValue({ success: true }) };
        }),
      }),
    };

    const res = await handleCreateMinorAccount(
      makeRequest({ username: 'testuser' }),
      makeEnv(db),
      corsHeaders,
    );

    expect(res.status).toBe(200);
    // claim_url is present (binds at index 2), but expires_at is absent -> bound as null at index 3.
    // Assert positionally: toContain(null) would also match the null zendesk_ticket_id.
    expect(bindArgs[2]).toBe('https://login.test/claim/abc');
    expect(bindArgs[3]).toBeNull();
  });
});
