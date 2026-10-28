// ABOUTME: Reads which app a report says it was filed from (its NIP-89 `client` tag).
// ABOUTME: Self-declared and optional, so it is shown as what the report says, never as identity.

import type { NostrEvent } from '@nostrify/nostrify';
import { isolate } from '@/lib/bidi';

export const NO_APP_NAMED = 'No app named';

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

/** Each named app once, in the order first seen, and how many reports name none. */
export function summarizeReportClients(events: NostrEvent[]): { names: string[]; unnamed: number } {
  const names: string[] = [];
  let unnamed = 0;
  for (const event of events) {
    const name = getReportClientName(event);
    if (!name) unnamed++;
    else if (!names.includes(name)) names.push(name);
  }
  return { names, unnamed };
}

/** The trailing count for reports that name no app, or '' when every report names one. */
export function unnamedSuffix(unnamed: number): string {
  return unnamed > 0 ? ` · ${unnamed} with no app named` : '';
}

/**
 * One line of plain text for one report, or for every report in a queue group,
 * for uses such as a hover title where a <bdi> element can't go.
 *
 * Each name is wrapped in Unicode first-strong-isolate marks (U+2068 ... U+2069),
 * after pairing the name's own isolate controls, so direction controls inside a
 * self-declared name can't reorder the rest of the line.
 */
export function describeReportClients(events: NostrEvent[]): string {
  const { names, unnamed } = summarizeReportClients(events);
  if (names.length === 0) return NO_APP_NAMED;
  return `Filed via ${names.map(isolate).join(', ')}${unnamedSuffix(unnamed)}`;
}
