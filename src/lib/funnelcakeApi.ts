// ABOUTME: REST client for Funnelcake API proxy endpoints
// ABOUTME: Used by useThread and useAuthor for fast ClickHouse-backed reads

import type { NostrEvent } from '@nostrify/nostrify';
import { getApiHeaders } from './adminApi';

/**
 * Fetch a Nostr event by ID via the Funnelcake REST API proxy.
 * Returns null on any error (caller falls back to WebSocket).
 */
export async function fetchFunnelcakeEvent(
  apiUrl: string,
  eventId: string,
): Promise<NostrEvent | null> {
  try {
    const response = await fetch(`${apiUrl}/api/funnelcake/event/${eventId}`, {
      headers: getApiHeaders(''),
    });
    if (!response.ok) return null;
    return await response.json() as NostrEvent;
  } catch {
    return null;
  }
}

/**
 * Fetch user profile data via the Funnelcake REST API proxy.
 * Returns flattened metadata matching the shape useAuthor consumers expect.
 * Returns null on any error (caller falls back to WebSocket).
 */
export async function fetchFunnelcakeUser(
  apiUrl: string,
  pubkey: string,
): Promise<{ metadata: Record<string, string | undefined> } | null> {
  try {
    const response = await fetch(`${apiUrl}/api/funnelcake/users/${pubkey}`, {
      headers: getApiHeaders(''),
    });
    if (!response.ok) return null;
    const data = await response.json() as {
      profile?: Record<string, string | undefined>;
    };
    if (!data.profile) return null;
    return { metadata: data.profile };
  } catch {
    return null;
  }
}
