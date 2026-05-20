import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  handleGetAgeReviewCases,
  handleGetAgeReviewCase,
  handleUpdateAgeReviewCase,
  handleGetModerationStatus,
  handleParentContact,
  handleAgeReviewReplyWebhook,
  checkAgeReviewDeadlines,
  syncAgeReviewTicketResolution,
} from './age-review';
import type { AgeReviewCase } from '../../shared/age-review';

const corsHeaders = { 'Access-Control-Allow-Origin': '*' };

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
    const res = await handleGetAgeReviewCases(req, { DB: db as unknown as D1Database }, corsHeaders);
    const body = await res.json() as { success: boolean; cases: AgeReviewCase[] };

    expect(res.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.cases).toHaveLength(1);
  });

  it('returns 500 when DB not configured', async () => {
    const req = new Request('https://api.test/api/age-review/cases');
    const res = await handleGetAgeReviewCases(req, {}, corsHeaders);
    expect(res.status).toBe(500);
  });
});

// -- handleGetAgeReviewCase ---------------------------------------------------

describe('handleGetAgeReviewCase', () => {
  it('returns a single case', async () => {
    const c = makeCase();
    const db = createMockDb([c]);
    const res = await handleGetAgeReviewCase('case-1', { DB: db as unknown as D1Database }, corsHeaders);
    const body = await res.json() as { success: boolean; case: AgeReviewCase };

    expect(res.status).toBe(200);
    expect(body.case.id).toBe('case-1');
  });

  it('returns 404 for unknown case', async () => {
    const db = createMockDb([]);
    const res = await handleGetAgeReviewCase('nonexistent', { DB: db as unknown as D1Database }, corsHeaders);
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
  });

  it('transitions state', async () => {
    const req = new Request('https://api.test/api/age-review/cases/case-1', {
      method: 'PATCH',
      body: JSON.stringify({ state: 'under_moderator_review' }),
    });
    const res = await handleUpdateAgeReviewCase(req, 'case-1', { DB: db as unknown as D1Database }, corsHeaders);
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
    const res = await handleUpdateAgeReviewCase(req, 'case-1', { DB: db as unknown as D1Database }, corsHeaders);
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toContain('Invalid state');
  });

  it('rejects invalid state transition', async () => {
    const req = new Request('https://api.test/api/age-review/cases/case-1', {
      method: 'PATCH',
      body: JSON.stringify({ state: 'submitted_for_review' }),
    });
    const res = await handleUpdateAgeReviewCase(req, 'case-1', { DB: db as unknown as D1Database }, corsHeaders);
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
    const res = await handleUpdateAgeReviewCase(req, 'case-1', { DB: closedDb as unknown as D1Database }, corsHeaders);
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toContain('closed case');
  });

  it('pauses clock and records remaining days', async () => {
    const req = new Request('https://api.test/api/age-review/cases/case-1', {
      method: 'PATCH',
      body: JSON.stringify({ clock_paused: true }),
    });
    const res = await handleUpdateAgeReviewCase(req, 'case-1', { DB: db as unknown as D1Database }, corsHeaders);
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
    const res = await handleUpdateAgeReviewCase(req, 'case-1', { DB: pausedDb as unknown as D1Database }, corsHeaders);
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
    const res = await handleUpdateAgeReviewCase(req, 'case-1', { DB: db as unknown as D1Database }, corsHeaders);
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toContain('email');
  });

  it('accepts null email (clears it)', async () => {
    const req = new Request('https://api.test/api/age-review/cases/case-1', {
      method: 'PATCH',
      body: JSON.stringify({ parent_contact_email: null }),
    });
    const res = await handleUpdateAgeReviewCase(req, 'case-1', { DB: db as unknown as D1Database }, corsHeaders);
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
    const res = await handleUpdateAgeReviewCase(req, 'case-1', {
      DB: reviewDb as unknown as D1Database,
      ZENDESK_SUBDOMAIN: 'test',
      ZENDESK_API_TOKEN: 'tok',
      ZENDESK_EMAIL: 'agent@test.com',
    }, corsHeaders);
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
    const res = await handleUpdateAgeReviewCase(req, 'case-1', {
      DB: db as unknown as D1Database,
      ZENDESK_SUBDOMAIN: 'test',
      ZENDESK_API_TOKEN: 'tok',
      ZENDESK_EMAIL: 'agent@test.com',
      ZENDESK_FIELD_CATEGORY: '1001',
      ZENDESK_FIELD_ISSUE: '1002',
      ZENDESK_FIELD_AGE_REVIEW_DEADLINE: '1003',
    }, corsHeaders);
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
      { id: 1002, value: 'age_review' },
      { id: 1003, value: '2026-05-30' },
    ]);

    const ticketStoreCall = bindCalls.find(
      (call) => call.sql.includes('SET zendesk_ticket_id = ?') && call.params[0] === 321 && call.params[1] === 'case-1'
    );
    expect(ticketStoreCall).toBeTruthy();

    vi.unstubAllGlobals();
  });
});

// -- handleGetModerationStatus ------------------------------------------------

describe('handleGetModerationStatus', () => {
  it('returns active when no case exists', async () => {
    const db = createMockDb([]);
    const res = await handleGetModerationStatus('a'.repeat(64), { DB: db as unknown as D1Database }, corsHeaders);
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

    const res = await handleGetModerationStatus(c.pubkey, { DB: db as unknown as D1Database }, corsHeaders);
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

    const res = await handleGetModerationStatus(c.pubkey, { DB: db as unknown as D1Database }, corsHeaders);
    const body = await res.json() as { restriction: { status: string } };

    expect(res.status).toBe(200);
    expect(body.restriction.status).toBe('active');
  });

  it('returns active (fail-open) when DB unavailable', async () => {
    const res = await handleGetModerationStatus('a'.repeat(64), {}, corsHeaders);
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
    const res = await handleParentContact(req, 'case-1', c.pubkey, { DB: db as unknown as D1Database }, corsHeaders);
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
    const res = await handleParentContact(req, 'case-1', c.pubkey, { DB: db as unknown as D1Database }, corsHeaders);
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
    const res = await handleParentContact(req, 'case-1', 'c'.repeat(64), { DB: db as unknown as D1Database }, corsHeaders);
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
    const res = await handleParentContact(req, 'case-1', c.pubkey, { DB: db as unknown as D1Database }, corsHeaders);
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
    const res = await handleParentContact(req, 'case-1', c.pubkey, { DB: db as unknown as D1Database }, corsHeaders);
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
    const res = await handleParentContact(req, 'case-1', c.pubkey, { DB: db as unknown as D1Database }, corsHeaders);
    expect(res.status).toBe(400);
  });
});

// -- checkAgeReviewDeadlines --------------------------------------------------

describe('checkAgeReviewDeadlines', () => {
  it('does nothing when DB unavailable', async () => {
    await checkAgeReviewDeadlines({});
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

    await checkAgeReviewDeadlines({
      DB: db as unknown as D1Database,
      ZENDESK_SUBDOMAIN: 'test',
      ZENDESK_API_TOKEN: 'tok',
      ZENDESK_EMAIL: 'agent@test.com',
    });

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

    vi.unstubAllGlobals();
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

    await checkAgeReviewDeadlines({
      DB: db as unknown as D1Database,
      SLACK_WEBHOOK_URL: 'https://hooks.slack.com/test',
    });

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

    await checkAgeReviewDeadlines({
      DB: db as unknown as D1Database,
      SLACK_WEBHOOK_URL: 'https://hooks.slack.com/test',
    });

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

    await checkAgeReviewDeadlines({ DB: db as unknown as D1Database });
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
    const res = await handleParentContact(req, 'case-1', c.pubkey, {
      DB: db as unknown as D1Database,
      ZENDESK_SUBDOMAIN: 'test',
      ZENDESK_API_TOKEN: 'tok',
      ZENDESK_EMAIL: 'agent@test.com',
    }, corsHeaders);
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
    const res = await handleParentContact(req, 'case-1', c.pubkey, {
      DB: db as unknown as D1Database,
      ZENDESK_SUBDOMAIN: 'test',
      ZENDESK_API_TOKEN: 'tok',
      ZENDESK_EMAIL: 'agent@test.com',
    }, corsHeaders);

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
    const res = await handleParentContact(req, 'case-1', c.pubkey, {
      DB: db as unknown as D1Database,
    }, corsHeaders);

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
    const res = await handleParentContact(req, 'case-1', c.pubkey, {
      DB: db as unknown as D1Database,
      ZENDESK_SUBDOMAIN: 'test',
      ZENDESK_API_TOKEN: 'tok',
      ZENDESK_EMAIL: 'agent@test.com',
    }, corsHeaders);

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

    await syncAgeReviewTicketResolution('case-1', 'cleared', 'All good', {
      DB: db as unknown as D1Database,
      ZENDESK_SUBDOMAIN: 'test',
      ZENDESK_API_TOKEN: 'tok',
      ZENDESK_EMAIL: 'agent@test.com',
    });

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

    await syncAgeReviewTicketResolution('case-1', 'denied_closed', 'Expired', {
      DB: db as unknown as D1Database,
      ZENDESK_SUBDOMAIN: 'test',
      ZENDESK_API_TOKEN: 'tok',
      ZENDESK_EMAIL: 'agent@test.com',
    });

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

    await syncAgeReviewTicketResolution('case-1', 'cleared', null, {
      DB: db as unknown as D1Database,
      ZENDESK_SUBDOMAIN: 'test',
      ZENDESK_API_TOKEN: 'tok',
      ZENDESK_EMAIL: 'agent@test.com',
      ZENDESK_FIELD_CATEGORY: '12345',
      ZENDESK_FIELD_ISSUE: '67890',
    });

    const payload = JSON.parse((mockFetch.mock.calls[0] as [string, RequestInit])[1].body as string);
    expect(payload.ticket.custom_fields).toEqual([
      { id: 12345, value: 'trust___safety' },
      { id: 67890, value: 'age_review' },
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
    const res = await handleAgeReviewReplyWebhook(req, { DB: db as unknown as D1Database }, corsHeaders);
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
    const res = await handleAgeReviewReplyWebhook(req, { DB: db as unknown as D1Database }, corsHeaders);
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
    const res = await handleAgeReviewReplyWebhook(req, { DB: db as unknown as D1Database }, corsHeaders);
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
    const res = await handleAgeReviewReplyWebhook(req, { DB: db as unknown as D1Database }, corsHeaders);
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
    const res = await handleAgeReviewReplyWebhook(req, { DB: db as unknown as D1Database }, corsHeaders);
    expect(res.status).toBe(400);
  });
});
