import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  handleGetAgeReviewCases,
  handleGetAgeReviewCase,
  handleUpdateAgeReviewCase,
  handleGetModerationStatus,
  handleParentContact,
  checkAgeReviewDeadlines,
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

  it('auto-closes expired cases', async () => {
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
          run: runMock,
        }),
      })),
    };

    await checkAgeReviewDeadlines({ DB: db as unknown as D1Database });

    const closeCalls = db.prepare.mock.calls.filter(
      (c: string[]) => c[0]?.includes('denied_closed')
    );
    expect(closeCalls.length).toBe(1);
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
