export const AGE_BANDS = ['under_13', 'age_13_15', 'age_16_plus_claimed'] as const;
export type AgeBand = typeof AGE_BANDS[number];

// States match MinorReviewCaseState from divine-mobile PR #3531
export const AGE_REVIEW_STATES = [
  'open_reported',
  'under_moderator_review',
  'restricted_pending_user_response',
  'restricted_pending_parental_consent',
  'restricted_pending_support_email',
  'submitted_for_review',
  'needs_follow_up',
  'cleared',
  'denied_closed',
] as const;
export type AgeReviewState = typeof AGE_REVIEW_STATES[number];

export const TERMINAL_STATES: readonly AgeReviewState[] = ['cleared', 'denied_closed'];

export const ACCOUNT_RESTRICTED_AGE_REVIEW_STATES = [
  'restricted_pending_user_response',
  'restricted_pending_parental_consent',
  'restricted_pending_support_email',
] as const satisfies readonly AgeReviewState[];

export function isAccountRestrictedAgeReviewState(state: AgeReviewState): boolean {
  return ACCOUNT_RESTRICTED_AGE_REVIEW_STATES.includes(
    state as typeof ACCOUNT_RESTRICTED_AGE_REVIEW_STATES[number]
  );
}

// The moderator queue's top axis. Kept as three coarse views; the per-state
// chips below the tabs sub-divide within whichever one is active.
export type AgeReviewListView = 'active' | 'closed' | 'all';

// The non-terminal states, in canonical order — everything the Active view
// lists. Derived from AGE_REVIEW_STATES minus the terminal ones so a new state
// joins Active automatically unless it is added to TERMINAL_STATES.
export const ACTIVE_AGE_REVIEW_STATES: readonly AgeReviewState[] =
  AGE_REVIEW_STATES.filter((s) => !TERMINAL_STATES.includes(s));

/** The states a queue view drills into, for the per-state chip filter under the
 * tab strip: Active spans the non-terminal states, Closed the terminal ones,
 * All every state. One source for both the chip row and each view's total. */
export function statesForTab(view: AgeReviewListView): readonly AgeReviewState[] {
  if (view === 'closed') return TERMINAL_STATES;
  if (view === 'active') return ACTIVE_AGE_REVIEW_STATES;
  return AGE_REVIEW_STATES;
}

/** The `state` param for GET /api/age-review/cases given the active view and an
 * optional drill-down chip. A chip is an exact state that overrides the view.
 * 'active' and 'closed' are themselves accepted filters; 'all' means no filter. */
export function listStateParam(
  view: AgeReviewListView,
  chip: AgeReviewState | null,
): string | undefined {
  if (chip) return chip;
  return view === 'all' ? undefined : view;
}

/** Fold a `SELECT state, COUNT(*) AS n ... GROUP BY state` result into a
 * per-state count map. Drives the queue's drill-down chip counts, computed
 * server-side so they are exact regardless of the list query's LIMIT. */
export function foldByState(rows: Iterable<{ state: string; n: number }>): Record<string, number> {
  const by_state: Record<string, number> = {};
  for (const row of rows) by_state[row.state] = (by_state[row.state] ?? 0) + (Number(row.n) || 0);
  return by_state;
}

/** Response body for GET /api/age-review/counts. */
export interface AgeReviewCountsResponse {
  success: boolean;
  by_state: Record<string, number>;
}

export type ResponseClockState = 'running' | 'paused' | 'expired' | 'not_applicable' | 'unknown';

export interface MinorReviewResponseDeadline {
  clock: ResponseClockState;
  /** Server time captured for this response, for offsetting an inaccurate device clock. */
  serverNow: string | null;
  /** Present only while the clock is running or has expired. */
  deadlineAt: string | null;
  pausedAt: string | null;
  remainingDaysWhenPaused: number | null;
}

export type ModerationStatusResponse =
  | { restriction: { status: 'active' } }
  | {
      restriction: { status: 'restricted_minor_review' };
      minorReviewCase: {
        id: string;
        state: AgeReviewState;
        suspectedAgeBand: AgeBand;
        allowedResolution: ResolutionType;
        instructions: string | null;
        supportEmail: string;
        moderationConversationPubkey: string | null;
        moderationConversationId: string | null;
        responseDeadline: MinorReviewResponseDeadline;
      };
    };

/** Normalize stored ISO or SQLite datetime values to absolute UTC ISO-8601. */
export function toUtcIso(value: string | null): string | null {
  if (!value) return null;

  const sqliteMatch = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?)$/.exec(value);
  const normalized = sqliteMatch ? `${sqliteMatch[1]}T${sqliteMatch[2]}Z` : value;
  const millis = Date.parse(normalized);
  return Number.isFinite(millis) ? new Date(millis).toISOString() : null;
}

export function deriveResponseClock(
  c: Pick<AgeReviewCase, 'state' | 'deadline_at' | 'clock_paused' | 'clock_paused_at' | 'remaining_days_when_paused'>,
  now: Date,
): MinorReviewResponseDeadline {
  const serverNow = Number.isFinite(now.getTime()) ? now.toISOString() : null;
  const empty = (clock: ResponseClockState): MinorReviewResponseDeadline => ({
    clock,
    serverNow,
    deadlineAt: null,
    pausedAt: null,
    remainingDaysWhenPaused: null,
  });

  if (!isAccountRestrictedAgeReviewState(c.state)) return empty('not_applicable');

  if (c.clock_paused !== 0 && c.clock_paused !== 1) return empty('unknown');

  const deadlineAt = toUtcIso(c.deadline_at);
  if (c.clock_paused === 1) {
    const pausedAt = toUtcIso(c.clock_paused_at);
    const remaining = c.remaining_days_when_paused;
    if (!deadlineAt || !pausedAt || remaining == null || !Number.isFinite(remaining) || remaining < 0) {
      return empty('unknown');
    }
    return {
      clock: 'paused',
      serverNow,
      deadlineAt: null,
      pausedAt,
      remainingDaysWhenPaused: remaining,
    };
  }

  if (
    !deadlineAt ||
    c.clock_paused_at !== null ||
    c.remaining_days_when_paused !== null ||
    !Number.isFinite(now.getTime())
  ) return empty('unknown');

  return {
    clock: Date.parse(deadlineAt) <= now.getTime() ? 'expired' : 'running',
    serverNow,
    deadlineAt,
    pausedAt: null,
    remainingDaysWhenPaused: null,
  };
}

export const VALID_TRANSITIONS: Record<AgeReviewState, readonly AgeReviewState[]> = {
  open_reported: ['under_moderator_review', 'cleared', 'denied_closed'],
  under_moderator_review: ['restricted_pending_user_response', 'restricted_pending_support_email', 'needs_follow_up', 'cleared', 'denied_closed'],
  restricted_pending_user_response: ['restricted_pending_parental_consent', 'restricted_pending_support_email', 'submitted_for_review', 'needs_follow_up', 'cleared', 'denied_closed'],
  restricted_pending_parental_consent: ['submitted_for_review', 'needs_follow_up', 'cleared', 'denied_closed'],
  restricted_pending_support_email: ['submitted_for_review', 'needs_follow_up', 'cleared', 'denied_closed'],
  submitted_for_review: ['under_moderator_review', 'needs_follow_up', 'cleared', 'denied_closed'],
  needs_follow_up: ['under_moderator_review', 'cleared', 'denied_closed'],
  cleared: [],
  denied_closed: [],
};

export const RESOLUTION_TYPES = [
  'support_email_only',
  'parent_video_or_email',
  'support_review_only',
] as const;
export type ResolutionType = typeof RESOLUTION_TYPES[number];

export const AGE_REVIEW_ACTION = {
  caseCreated: 'age_review_case_created',
  stateChanged: 'age_review_state_changed',
  clockPaused: 'age_review_clock_paused',
  clockResumed: 'age_review_clock_resumed',
  caseClosed: 'age_review_case_closed',
} as const;

export const DEADLINE_DAYS = 15;

export function defaultResolutionForBand(band: AgeBand): ResolutionType {
  switch (band) {
    case 'under_13': return 'support_email_only';
    case 'age_13_15': return 'parent_video_or_email';
    case 'age_16_plus_claimed': return 'support_review_only';
  }
}

export function getDaysRemaining(c: AgeReviewCase): number | null {
  if (c.clock_paused && c.remaining_days_when_paused != null) {
    return c.remaining_days_when_paused;
  }
  if (!c.deadline_at) return null;
  return (new Date(c.deadline_at).getTime() - Date.now()) / (24 * 60 * 60 * 1000);
}

export interface AgeReviewCase {
  id: string;
  pubkey: string;
  reporter_pubkey: string | null;
  report_id: string | null;
  suspected_age_band: AgeBand;
  state: AgeReviewState;
  allowed_resolution: ResolutionType;
  parent_contact_email: string | null;
  deadline_at: string | null;
  clock_paused: number;
  clock_paused_at: string | null;
  remaining_days_when_paused: number | null;
  moderator_pubkey: string | null;
  resolution_note: string | null;
  last_alerted_at: string | null;
  zendesk_ticket_id: number | null;
  created_via: string | null;
  claim_link_url: string | null;
  claim_link_expires_at: string | null;
  /**
   * Human-readable identity for the reported account, captured when the case was
   * created. Enforcement hides a suspended account's content from relay queries,
   * so these cannot be resolved on read after the fact.
   *
   * identity_captured_at is stamped whenever the lookup reached a confirmed
   * answer, including a confirmed "this account has no profile". Null means no
   * confirmed answer -- the lookup never ran, or it ran and timed out, errored,
   * or found no relay configured. Either way the row is still worth re-querying,
   * which is what the backfill keys on; null never means "looked and found
   * nothing".
   */
  account_name: string | null;
  account_nip05: string | null;
  account_vine_username: string | null;
  identity_captured_at: string | null;
  created_at: string;
  updated_at: string;
  version: number;
}

// --- Case-update enforcement contract (shared by the worker API and the admin client) ---

export type EnforcementLegStatus = 'not_attempted' | 'ok' | 'failed';

// Per-leg outcome of the enforcement a case update triggers: relay suspend/ban,
// bulk media/content action, and Keycast account status.
export interface AgeReviewEnforcement {
  relay: EnforcementLegStatus;
  relayError?: string;
  bulk: EnforcementLegStatus;
  bulkError?: string;
  keycast: EnforcementLegStatus;
  keycastError?: string;
  /** Keycast verified_minor clear on revoke/deny (issue #147). Optional so
   * payloads from an older worker still type-check. */
  keycastMinorClear?: EnforcementLegStatus;
  keycastMinorClearError?: string;
  /** Durable protected-subject clear. It precedes the Keycast projection clear. */
  subjectClear?: EnforcementLegStatus;
  subjectClearError?: string;
}

// Response body for a case GET/PATCH. On a partial-enforcement PATCH the worker
// returns HTTP 207 with `enforcementComplete: false`. `enforcement` is optional
// so an older client still works against a worker that predates this contract.
export interface AgeReviewCaseResponse {
  success: boolean;
  case: AgeReviewCase;
  keycastUpdated?: boolean;
  bulkActionTriggered?: string;
  enforcementComplete?: boolean;
  enforcement?: AgeReviewEnforcement;
}

// Greenlight consent funnel: moderation (D1) outcome counts for one age band.
export interface FunnelModerationCounts {
  in_progress: number;
  approved: { total: number; restored: number; new_minor: number };
  denied_expired: number;
}

// Exact Zendesk Search queries behind each helpdesk funnel stage. Single source
// of truth: the worker counts with these, and the UI surfaces them verbatim in
// tooltips, so the displayed criteria can never drift from what is counted.
// Reports vs requests are a clean partition of all `age-review` tickets: a
// third-party in-app report carries `age-review` only, while a parent/teen who
// reaches the helpdesk also carries `age-review-response`. Not band-filtered
// (Zendesk does not tag age band), so these count all ages.
export const FUNNEL_ZENDESK_QUERIES = {
  reports_in: 'type:ticket tags:age-review -tags:age-review-response',
  requests_in: 'type:ticket tags:age-review-response',
  video_received: 'type:ticket tags:consent_video_received',
} as const;

// Full funnel payload returned by GET /api/age-review/funnel. Helpdesk counts
// are nullable: a Zendesk failure nulls that half while moderation still returns.
export interface AgeReviewFunnelResponse {
  success: boolean;
  age_band: AgeBand;
  helpdesk: {
    source: 'zendesk';
    band_scope: 'all_bands';
    reports_in: number | null;
    requests_in: number | null;
    video_received: number | null;
  };
  moderation: FunnelModerationCounts & { source: 'd1'; band_scope: AgeBand };
  generated_at: string;
}
