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
      // Defensive rather than hot: NRelay1 currently breaks on CLOSED without
      // forwarding it, so in practice a relay-side close surfaces here as the
      // timeout below (an AbortError) rather than through this branch. CLOSED is
      // part of the message contract and the typings advertise it, so handle it
      // explicitly instead of relying on that implementation detail.
      throw new RelayReadError('Relay closed the subscription before the read completed');
    }
  }

  // No EOSE and no CLOSED. In practice this is the no-route case: an aborted or
  // timed-out read does not fall through here, it throws AbortError out of the
  // iterator (NPool's Machina rejects on abort). Either way we never established
  // what the relay holds, so we must not answer.
  if (!complete) {
    throw new RelayReadError('Relay read did not complete');
  }

  return events;
}

/**
 * The relay's verbatim answer when an event exists but is not banned. Source:
 * funnelcake `crates/clickhouse/src/management.rs` ("Event not found or not
 * banned"). Anchored deliberately, see below.
 */
const RELAY_NOT_BANNED = /^event not found or not banned$/i;

/**
 * True when a `callRelayRpc` rejection is the relay definitively answering "no"
 * rather than us failing to ask.
 *
 * The HTTP status cannot be used to tell those apart. The worker collapses
 * *every* management-RPC failure into HTTP 400 (`handleRelayRpc`), and turns any
 * non-ok response from the relay into the prose `Relay error: <status> <text>`
 * (`callNip86Rpc`). So a misrouted management URL arrives here as
 * `ApiError("Relay error: 404 Not Found", 400)`: a 400 whose message contains
 * "not found", indistinguishable by shape from a real negative.
 *
 * Hence an exact match on the relay's own sentence and nothing else. The failure
 * mode matters: if the relay ever rewords it, this returns false, the error
 * propagates, and the moderator sees "couldn't load" instead of "not
 * retrievable". That is the safe direction. Loose matching fails the other way,
 * telling a moderator content was deleted when the relay was simply unreachable.
 */
export function isDefinitiveRpcNegative(error: unknown): boolean {
  if (!(error instanceof ApiError)) return false;
  // Belt and braces: the relay's negative is delivered as a 400 (or, for a
  // non-HTTP RPC failure, with no status at all). Anything else is not it.
  if (error.statusCode !== undefined && error.statusCode !== 400) return false;
  return RELAY_NOT_BANNED.test(error.message.trim());
}
