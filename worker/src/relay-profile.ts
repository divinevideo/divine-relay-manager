// ABOUTME: Shared relay query helpers and best-effort account identity lookup.
// ABOUTME: Extracted from index.ts so ReportWatcher and age-review can use them without a circular import.

import { parseKind0Profile, type ReportedProfile } from './report-note';

// Query relay for events matching a filter.
//
// Follows the #186 contract: `success` answers "did the relay confirm the end
// of the set (EOSE)?" -- a timeout, an early close, or a NIP-01 CLOSED are all
// `success: false`, so an absence-sensitive caller (/api/reports, reopen's
// label cleanup) can never mistake an unconfirmed read for a confirmed empty
// one. Every outcome still carries the events that did arrive. `complete` is
// retained (optional, only set on EOSE) so callers that adopted the interim
// flag-based contract keep type-checking; it is an alias of the confirmed path.
export async function queryRelay(
  filter: object,
  relayUrl: string
): Promise<{ success: boolean; events?: object[]; error?: string; complete?: boolean }> {
  return new Promise((resolve) => {
    try {
      const ws = new WebSocket(relayUrl);
      let resolved = false;
      const events: object[] = [];
      const subId = `query-${Date.now()}`;

      // Closing is best-effort cleanup, so a throw from it must not escape and
      // strand the promise. Every exit resolves before closing, so swallowing
      // here is what guarantees settlement.
      const closeQuietly = () => {
        try {
          ws.close();
        } catch (err) {
          console.warn('[queryRelay] socket close threw:', err);
        }
      };

      const timeout = setTimeout(() => {
        if (!resolved) {
          resolved = true;
          resolve({ success: false, events: events.slice(), error: `Relay query timed out before EOSE (${events.length} events received)` });
          closeQuietly();
        }
      }, 5000);

      ws.addEventListener('open', () => {
        ws.send(JSON.stringify(['REQ', subId, filter]));
      });

      ws.addEventListener('message', (msg) => {
        if (resolved) return;
        try {
          const data = JSON.parse(msg.data as string);
          if (data[0] === 'EVENT' && data[1] === subId) {
            events.push(data[2]);
          } else if (data[0] === 'EOSE' && data[1] === subId) {
            clearTimeout(timeout);
            resolved = true;
            // EOSE = relay confirmed end of stored events, so an empty result is real.
            resolve({ success: true, events, complete: true });
            closeQuietly();
          } else if (data[0] === 'CLOSED' && data[1] === subId) {
            // NIP-01: the relay ended the subscription instead of fulfilling it,
            // with a machine-readable reason. Without this branch the socket sits
            // until the timeout, so a failure the relay already reported gets
            // called a timeout instead, 5s later than it needed to be.
            clearTimeout(timeout);
            resolved = true;
            const reason = typeof data[2] === 'string' && data[2] ? data[2] : 'no reason given';
            resolve({ success: false, events: events.slice(), error: `Relay closed the subscription: ${reason}` });
            closeQuietly();
          }
        } catch {
          // Ignore parse errors
        }
      });

      ws.addEventListener('error', () => {
        if (!resolved) {
          clearTimeout(timeout);
          resolved = true;
          resolve({ success: false, events: events.slice(), error: 'WebSocket error' });
          closeQuietly();
        }
      });

      ws.addEventListener('close', () => {
        if (!resolved) {
          clearTimeout(timeout);
          resolved = true;
          // Closed before EOSE: absence is unconfirmed, so this is a failure.
          // The only exit that does not closeQuietly() -- the socket is already
          // closing, which is why we are here.
          resolve({ success: false, events: events.slice(), error: `Relay closed before EOSE (${events.length} events received)` });
        }
      });
    } catch (error) {
      resolve({ success: false, error: error instanceof Error ? error.message : 'Unknown error' });
    }
  });
}

/**
 * Cap on best-effort relay enrichment.
 *
 * Originally sized so a slow relay could not push the Zendesk webhook handler
 * toward Zendesk's delivery timeout; report-note enrichment posts without the
 * profile when it fires. Identity capture reuses it despite having no delivery
 * deadline of its own — there, a fired timeout means the lookup did not
 * complete, so no capture is recorded and the case stays eligible for backfill.
 */
export const ENRICHMENT_TIMEOUT_MS = 3000;

export function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), ms);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}

export interface AccountIdentityLookup {
  /**
   * Whether the relay actually answered. False means we never got to look --
   * timeout, socket error, or no relay configured.
   *
   * Callers must not record a capture attempt when this is false. The backfill
   * reads a null `identity_captured_at` as "never looked", so stamping it after
   * a failed lookup excludes the case from recovery permanently -- and the
   * account's profile is about to be hidden by enforcement, which is the one
   * thing that makes the loss unrecoverable.
   */
  completed: boolean;
  /** The profile, or null when the relay answered and the account had none. */
  profile: ReportedProfile | null;
}

/**
 * Best-effort kind-0 lookup for an account, used to capture a human-readable
 * identifier while one is still visible.
 *
 * Ordering matters at every call site: a suspended account's content is hidden
 * from relay queries, so this has to run before any enforcement leg fires. Once
 * an account is suspended the profile is gone and a later lookup returns nothing.
 *
 * Never throws. Enrichment must not be able to fail a case creation.
 */
export async function fetchAccountIdentity(
  pubkey: string,
  relayUrl: string | undefined,
): Promise<AccountIdentityLookup> {
  if (!relayUrl) return { completed: false, profile: null };
  try {
    const res = await withTimeout(
      queryRelay({ authors: [pubkey], kinds: [0], limit: 1 }, relayUrl),
      ENRICHMENT_TIMEOUT_MS,
    );
    // Presence first, absence second. A profile we actually received is a
    // confirmed answer however the read ended: an event in hand cannot be made
    // less true by the socket closing a moment later. Only *absence* needs the
    // read to have finished cleanly before it can be believed.
    //
    // The order matters because of #186 (merged 2026-08-07, one commit ahead of
    // this branch's merge base), which rewrites queryRelay so an early close or
    // a NIP-01 CLOSED is `success: false` -- while still returning the events
    // that did arrive. Testing `success` first would then throw away a kind-0
    // that a relay streamed before closing without EOSE, leave
    // identity_captured_at null, and let enforcement hide the profile before any
    // backfill could run: precisely the permanent loss this capture exists to
    // prevent. Under the current vendored queryRelay the two orders are
    // equivalent -- its `success: false` path carries no events -- so this is
    // cover for the rebase, not a behaviour change here.
    if (res?.events?.length) {
      return {
        completed: true,
        // Raw: this is persisted, and both surfaces that render it
        // (buildAgeReviewIdentityBlock, buildClaimedParentName) sanitize on the
        // way out. Sanitizing here instead would store a mangled handle.
        profile: parseKind0Profile(
          res.events[0] as { content?: string; tags?: string[][] },
          { raw: true },
        ),
      };
    }
    // A timeout resolves to null and an unreachable relay resolves to
    // { success: false }; neither is evidence the account has no profile.
    if (!res?.success) return { completed: false, profile: null };
    // An empty result only means "this account has no profile" when the relay
    // sent EOSE. queryRelay reports complete: false when it timed out or the
    // socket closed first, and that absence is unconfirmed.
    //
    // Falls back to `success` because #186 folds `complete` into `success` and
    // drops the field: under that contract `success` alone means EOSE-confirmed.
    // Reading `res.complete === true` after this branch rebases would be
    // `undefined === true` -- permanently false, so nothing would ever stamp and
    // every case would sit eligible for backfill forever, with `tsc` green
    // because the field is optional.
    return { completed: res.complete ?? res.success, profile: null };
  } catch (err) {
    console.warn('[relay-profile] identity fetch failed (continuing without it):', err);
    return { completed: false, profile: null };
  }
}
