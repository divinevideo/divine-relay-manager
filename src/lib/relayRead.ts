// ABOUTME: Helpers for telling a completed relay read apart from a failed one.
// ABOUTME: NPool.query swallows relay errors and resolves with partial results,
// ABOUTME: so an empty array means "nothing found" AND "the read never worked".
// ABOUTME: Callers that report absence to a moderator must not conflate those.
import { ApiError } from './adminApi';

/**
 * Throws when a relay read was cut short by our own timeout rather than
 * completing.
 *
 * `NPool.query` documents that it "will return partial results instead of
 * throwing" and wraps its read loop in a bare catch, so a dead or slow relay
 * resolves to `[]` exactly like a genuinely empty result. Without this check a
 * failed read is indistinguishable from a verified absence, and any UI that
 * says "no content found" is making a claim it never established.
 *
 * `querySignal` is TanStack Query's own signal: if that aborted, the query was
 * cancelled (unmount, key change) and there is no failure to report.
 */
export function assertRelayReadCompleted(
  timeoutSignal: AbortSignal,
  querySignal: AbortSignal,
): void {
  if (timeoutSignal.aborted && !querySignal.aborted) {
    throw new Error('Relay read timed out before completing');
  }
}

/**
 * True when a `callRelayRpc` rejection is the relay definitively answering "no"
 * rather than us failing to ask.
 *
 * `getbannedevent` on an event that is not banned returns
 * `{"success":false,"error":"Event not found or not banned"}` (verified against
 * the live relay), which `callRelayRpc` surfaces as an `ApiError` with no HTTP
 * status. An `ApiError` that *does* carry a status is a transport or auth
 * failure (expired CF Access, worker 5xx), and any other error is unknown.
 * Both of those must propagate: reporting them as "not banned" would let a
 * moderator read an outage as a deletion.
 */
export function isDefinitiveRpcNegative(error: unknown): boolean {
  if (!(error instanceof ApiError)) return false;
  if (error.statusCode !== undefined) return false;
  return /not found|not banned/i.test(error.message);
}
