// ABOUTME: Relay reads that fail loudly, for callers that report absence to a
// ABOUTME: moderator. NPool.query swallows relay errors and resolves with partial
// ABOUTME: results, so an empty array means both "nothing found" and "the read
// ABOUTME: never worked". Anything that says "no content" must tell those apart.
import type { NostrEvent, NostrFilter } from '@nostrify/nostrify';
import { ApiError } from './adminApi';

/** The slice of NPool that queryStrict needs, kept structural so it is testable. */
export interface ReqCapable {
  req(
    filters: NostrFilter[],
    opts?: { signal?: AbortSignal },
  ): AsyncIterable<[string, ...unknown[]]>;
}

export class RelayReadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RelayReadError';
  }
}

/**
 * Reads events and treats anything other than a completed read as an error.
 *
 * `NPool.query` is unusable for this: it documents that it "will return partial
 * results instead of throwing", breaks out of its loop on `CLOSED`, wraps
 * everything in a bare catch, and returns immediately when no relay routes
 * match. Every one of those paths yields `[]`, indistinguishable from a genuine
 * absence. Funnelcake closes subscriptions with "could not complete query" when
 * its query layer degrades, so this is a live path, not a theoretical one.
 *
 * Driving `req` directly lets us insist on the one signal that actually means
 * "the relay finished answering": EOSE.
 */
export async function queryStrict(
  nostr: ReqCapable,
  filters: NostrFilter[],
  opts: { signal: AbortSignal; timeoutMs: number },
): Promise<NostrEvent[]> {
  const timeout = AbortSignal.timeout(opts.timeoutMs);
  const combined = AbortSignal.any([opts.signal, timeout]);

  const events: NostrEvent[] = [];
  let complete = false;

  for await (const msg of nostr.req(filters, { signal: combined })) {
    if (msg[0] === 'EVENT') {
      events.push(msg[2] as NostrEvent);
    } else if (msg[0] === 'EOSE') {
      complete = true;
      break;
    } else if (msg[0] === 'CLOSED') {
      throw new RelayReadError('Relay closed the subscription before the read completed');
    }
  }

  // No EOSE: timed out, aborted, or no relay was routed to at all. Whatever the
  // cause, we did not establish what the relay holds, so we must not answer.
  if (!complete) {
    throw new RelayReadError('Relay read did not complete');
  }

  return events;
}

/**
 * True when a `callRelayRpc` rejection is the relay definitively answering "no"
 * rather than us failing to ask.
 *
 * `getbannedevent` for an event that is not banned answers
 * `{"success":false,"error":"Event not found or not banned"}`, which the worker
 * returns as **HTTP 400** (verified end to end against production, including the
 * status code). So a 400 means the relay was reached and refused; the message
 * distinguishes this refusal from some other relay-side failure. A 401/403/5xx,
 * or any non-ApiError, means we never got an answer, and reporting that as
 * "not banned" would let a moderator read an outage as a deletion.
 */
export function isDefinitiveRpcNegative(error: unknown): boolean {
  if (!(error instanceof ApiError)) return false;
  const reachedRelay = error.statusCode === undefined || error.statusCode === 400;
  if (!reachedRelay) return false;
  return /not found|not banned/i.test(error.message);
}
