// ABOUTME: Pure reconciliation of a mutated age-review case into cached list
// ABOUTME: data — every list cache must tell the truth about a case we just wrote

import { TERMINAL_STATES, type AgeReviewCase } from "../../shared/age-review";

/** The list-query param shapes used by the AgeReview page (mirrors the
 * worker's handleGetAgeReviewCases filters). */
export interface AgeReviewListParams {
  state?: string;
  age_band?: string;
}

/** Whether `c` belongs in a list fetched with `params` (client-side mirror
 * of the worker's WHERE clause: active = not terminal, closed = terminal,
 * a specific state matches exactly, absent = all; band matches exactly). */
export function caseBelongsInList(params: AgeReviewListParams, c: AgeReviewCase): boolean {
  if (params.state === 'active' && TERMINAL_STATES.includes(c.state)) return false;
  if (params.state === 'closed' && !TERMINAL_STATES.includes(c.state)) return false;
  if (params.state && params.state !== 'active' && params.state !== 'closed' && c.state !== params.state) return false;
  if (params.age_band && c.suspected_age_band !== params.age_band) return false;
  return true;
}

/**
 * Reconcile a freshly mutated case into one cached list: replace the row when
 * it still belongs, drop it when it no longer does (e.g. a terminal action on
 * an active list). A belonging-but-absent case is left for the refetch to add
 * — absence can't render stale controls, which is the failure this prevents:
 * a retained pre-action row shadows the repaired per-case cache while the
 * list refetch is pending or failed (review).
 */
export function reconcileCaseIntoList(
  params: AgeReviewListParams,
  cases: AgeReviewCase[],
  updated: AgeReviewCase,
): AgeReviewCase[] {
  if (!caseBelongsInList(params, updated)) {
    return cases.filter(c => c.id !== updated.id);
  }
  return cases.map(c => (c.id === updated.id ? updated : c));
}
