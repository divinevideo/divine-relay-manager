// ABOUTME: Canonical protected-record retention periods and clearance classification.
// ABOUTME: Shared by D1 schema writers, disposal jobs, and focused retention tests.

export const RETENTION_DAYS = {
  falsePositive: 30,
  validPriorClassification: 365,
  provisioningDetail: 30,
  projectionComplete: 30,
  ageReviewDetail: 30,
  ageReviewDecision: 365,
  // Greenlight consent clips: deleted 120 days after the case closes, never
  // on a fixed age-since-upload clock, and only when no legal hold applies.
  consentVideo: 120,
  // The reporter link on a private report handed to Coop: cleared a year after
  // the handoff, as moderation-service deletes its own DM copy after a year.
  privateReportCoopLink: 365,
  // Unfinished handoffs keep a reporter link for at most a year from receipt.
  privateReportPendingLink: 365,
  pendingOperationalDeadline: 1,
} as const;

export const FALSE_POSITIVE_CLEAR_REASON = 'false_positive' as const;

export const VALID_PRIOR_CLEAR_REASONS = [
  'age_review_denied',
  'age_review_expired',
  'age_up',
  'age_verified',
] as const;

export type ClearReasonClass = 'false_positive' | 'valid_prior' | 'unclassified';

export function classifyClearReason(reason: string): ClearReasonClass {
  if (reason === FALSE_POSITIVE_CLEAR_REASON) return 'false_positive';
  if ((VALID_PRIOR_CLEAR_REASONS as readonly string[]).includes(reason)) return 'valid_prior';
  return 'unclassified';
}
