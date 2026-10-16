// ABOUTME: One line naming the app a report says it was filed from ("Filed via X").
// ABOUTME: The name is self-declared by the reporting app, so it is never styled as identity.

import type { NostrEvent } from '@nostrify/nostrify';
import { describeReportClients, getReportClientName } from '@/lib/reportClient';

const SELF_DECLARED = 'The reporting app writes this name itself; it is not verified.';

/** `reports` is one report, or every report in a queue group. */
export function ReportClientText({ reports }: { reports: NostrEvent[] }) {
  const label = describeReportClients(reports);
  const anyNamed = reports.some(r => getReportClientName(r));
  return (
    <span
      className="block text-xs text-muted-foreground truncate min-w-0 max-w-full"
      // The hover text also carries the full name when a long one is truncated.
      title={anyNamed ? `${label}. ${SELF_DECLARED}` : label}
    >
      {label}
    </span>
  );
}
