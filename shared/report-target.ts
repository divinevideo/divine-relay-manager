// ABOUTME: Which target a kind-1984 report is about, for the worker and the client.
// ABOUTME: One definition, so the worker filters on the same key the queue groups by.

import { canonicalHex64 } from './hex-id';

export interface ReportTarget {
  type: 'event' | 'pubkey';
  value: string;
}

// The first `e` tag wins, else the first `p` tag, else null. Which tag wins is
// preserved exactly from the three client copies it replaced (Reports.tsx, ReportDetail.tsx,
// useReportContext.ts), which now import it, as the worker does. Includes
// that a valueless ["e"] still yields an event target: those copies are
// presence-based so a malformed report stays visible rather than vanishing
// from the queue. TODO(#160) decides whether that should change; this module
// must not change it on its own, or the worker would filter on a different
// target than the client groups by.
//
// The tags guard is new and behaviour-neutral for the client, whose relay
// payloads are sanitized to always carry a tags array. The worker reads raw
// relay payloads.
//
// A 64-character hex value is lowercased (#315, #313): decisions, labels and
// bans are now written lowercase, so a report spelling its target in
// uppercase would otherwise never read as handled. Any other value is kept as
// written.
export function getReportTarget(event: { tags?: unknown }): ReportTarget | null {
  const written = getWrittenReportTarget(event);
  if (!written) return null;
  return { type: written.type, value: canonicalHex64(written.value) ?? written.value };
}

// The same target with its value exactly as the report's tag spells it. Only
// for asking what a relay read could have returned: relay tag filters match
// exactly, so a read never fetches a spelling it did not ask for (see
// hexTagFilterValues; a mixed-case tag is never asked for).
export function getWrittenReportTarget(event: { tags?: unknown }): ReportTarget | null {
  const tags = Array.isArray(event.tags) ? (event.tags as string[][]) : [];
  const eTag = tags.find(t => Array.isArray(t) && t[0] === 'e');
  if (eTag) return { type: 'event', value: eTag[1] };
  const pTag = tags.find(t => Array.isArray(t) && t[0] === 'p');
  if (pTag) return { type: 'pubkey', value: pTag[1] };
  return null;
}

// No case normalization: the client's keys are built the same way, and the two
// halves must agree about which key a target has. getReportTarget has already
// lowercased a report's hex id. A stored record (a decision, label, ban or
// auto-hide row) is keyed as stored, because the pane's history and Reopen
// read it exactly: one in another spelling leaves its report in front of a
// person rather than hiding it where Reopen can't reach.
export function reportTargetKey(target: ReportTarget): string {
  return `${target.type}:${target.value}`;
}
