// ABOUTME: Shared relay query helpers and best-effort account identity lookup.
// ABOUTME: Extracted from index.ts so ReportWatcher and age-review can use them without a circular import.

import { parseKind0Profile, type ReportedProfile } from './report-note';

// Query relay for events matching a filter
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

      const timeout = setTimeout(() => {
        if (!resolved) {
          resolved = true;
          ws.close();
          // Timed out without EOSE: results may be truncated, so absence is unconfirmed.
          resolve({ success: true, events, complete: false });
        }
      }, 5000);

      ws.addEventListener('open', () => {
        ws.send(JSON.stringify(['REQ', subId, filter]));
      });

      ws.addEventListener('message', (msg) => {
        try {
          const data = JSON.parse(msg.data as string);
          if (data[0] === 'EVENT' && data[1] === subId) {
            events.push(data[2]);
          } else if (data[0] === 'EOSE' && data[1] === subId) {
            clearTimeout(timeout);
            resolved = true;
            ws.close();
            // EOSE = relay confirmed end of stored events, so an empty result is real.
            resolve({ success: true, events, complete: true });
          }
        } catch {
          // Ignore parse errors
        }
      });

      ws.addEventListener('error', () => {
        if (!resolved) {
          clearTimeout(timeout);
          resolved = true;
          resolve({ success: false, error: 'WebSocket error' });
        }
      });

      ws.addEventListener('close', () => {
        if (!resolved) {
          clearTimeout(timeout);
          resolved = true;
          // Closed before EOSE: absence is unconfirmed.
          resolve({ success: true, events, complete: false });
        }
      });
    } catch (error) {
      resolve({ success: false, error: error instanceof Error ? error.message : 'Unknown error' });
    }
  });
}

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
): Promise<ReportedProfile | null> {
  if (!relayUrl) return null;
  try {
    const res = await withTimeout(
      queryRelay({ authors: [pubkey], kinds: [0], limit: 1 }, relayUrl),
      ENRICHMENT_TIMEOUT_MS,
    );
    if (res?.success && res.events?.length) {
      return parseKind0Profile(res.events[0] as { content?: string; tags?: string[][] });
    }
  } catch (err) {
    console.warn('[relay-profile] identity fetch failed (continuing without it):', err);
  }
  return null;
}
