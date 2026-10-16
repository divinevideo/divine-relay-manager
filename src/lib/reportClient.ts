// ABOUTME: Reads which app a report says it was filed from (its NIP-89 `client` tag).
// ABOUTME: Self-declared and optional, so it is shown as what the report says, never as identity.

import type { NostrEvent } from '@nostrify/nostrify';

const NO_APP_NAMED = 'No app named';

/**
 * The app name from the report's first `client` tag, trimmed, or undefined
 * when the report names none.
 *
 * Only the first tag counts because that is the one ReportWatcher's
 * trusted-client gate reads for auto-hide (worker/src/ReportWatcher.ts), so a
 * moderator sees the same value that gate acted on. Any client can write any
 * name here, and NIP-89 tells clients to let users turn the tag off, so its
 * absence says nothing about where the report came from either.
 */
export function getReportClientName(event: NostrEvent): string | undefined {
  const clientTag = event.tags.find(t => t[0] === 'client');
  const name = clientTag?.[1]?.trim();
  return name || undefined;
}

/** One line for one report, or for every report in a queue group. */
export function describeReportClients(events: NostrEvent[]): string {
  const names: string[] = [];
  let unnamed = 0;
  for (const event of events) {
    const name = getReportClientName(event);
    if (!name) unnamed++;
    else if (!names.includes(name)) names.push(name);
  }

  if (names.length === 0) return NO_APP_NAMED;
  const named = `Filed via ${names.join(', ')}`;
  return unnamed > 0 ? `${named} · ${unnamed} with no app named` : named;
}
