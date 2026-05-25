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
  created_at: string;
  updated_at: string;
}
