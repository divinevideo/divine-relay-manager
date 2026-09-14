// ABOUTME: Canonical protected-record retention periods and clearance classification.
// ABOUTME: Shared by D1 schema writers, disposal jobs, and focused retention tests.

export const RETENTION_DAYS = {
  falsePositive: 30,
  validPriorClassification: 365,
  provisioningDetail: 30,
  projectionComplete: 30,
  // A converged enforcement leg is a completed job record. Unresolved legs
  // (failed / abandoned) are deliberately NOT disposed: they are evidence of an
  // enforcement gap nobody has closed yet.
  enforcementLegResolved: 30,
  ageReviewDetail: 30,
  ageReviewDecision: 365,
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
