// ABOUTME: Renders a user-stat count for display, showing "?" when the relay
// ABOUTME: read that produced it did not complete so a truncated read never
// ABOUTME: appears as a confident number (#210).

/** Tooltip for a count whose read did not complete. */
export const STAT_UNKNOWN_TITLE =
  'Relay read did not complete, so this count may be incomplete.';

/**
 * The count as text, or "?" when `incomplete` — a cut-short read understates
 * (a zero proves nothing, a non-zero only lower-bounds), so it is never stated
 * as the count. A completed read renders its number, including a verified 0.
 */
export function statCountText(
  count: number | undefined,
  incomplete: boolean | undefined,
): string {
  return incomplete ? '?' : String(count ?? 0);
}

/**
 * Accessible name for a count span, or undefined when the read completed (the
 * visible number reads fine on its own). For an incomplete read it spells out
 * the "?" so a screen reader announces the meaning instead of a bare "question
 * mark". `unit` is the count's noun, e.g. "events".
 */
export function statCountAriaLabel(
  unit: string,
  incomplete: boolean | undefined,
): string | undefined {
  return incomplete ? `${unit} count unavailable, relay read did not complete` : undefined;
}
