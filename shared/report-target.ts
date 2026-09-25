// ABOUTME: Which target a kind-1984 report is about, for the worker and the client.
// ABOUTME: One definition, so the worker filters on the same key the queue groups by.

export interface ReportTarget {
  type: 'event' | 'pubkey';
  value: string;
}

// The first `e` tag wins, else the first `p` tag, else null. Preserved exactly
// from the three client copies this replaces (Reports.tsx, ReportDetail.tsx,
// useReportContext.ts), including that a valueless ["e"] still yields an event
// target: those copies are presence-based so a malformed report stays visible
// rather than vanishing from the queue. TODO(#160) decides whether that should
// change; this module must not change it on its own, or the worker would
// filter on a different target than the client groups by.
//
// The tags guard is new and behaviour-neutral for the client, whose relay
// payloads are sanitized to always carry a tags array. The worker reads raw
// relay payloads.
export function getReportTarget(event: { tags?: unknown }): ReportTarget | null {
  const tags = Array.isArray(event.tags) ? (event.tags as string[][]) : [];
  const eTag = tags.find(t => Array.isArray(t) && t[0] === 'e');
  if (eTag) return { type: 'event', value: eTag[1] };
  const pTag = tags.find(t => Array.isArray(t) && t[0] === 'p');
  if (pTag) return { type: 'pubkey', value: pTag[1] };
  return null;
}

// No case normalization: the client's keys are built the same way, and the two
// halves must agree about which key a target has.
export function reportTargetKey(target: ReportTarget): string {
  return `${target.type}:${target.value}`;
}
