// ABOUTME: One line naming the app a report says it was filed from ("Filed via X").
// ABOUTME: The name is self-declared by the reporting app, so it is never styled as identity.

import { Fragment } from 'react';
import type { NostrEvent } from '@nostrify/nostrify';
import { cn } from '@/lib/utils';
import { displaySafe } from '@/lib/bidi';
import { NO_APP_NAMED, describeReportClients, summarizeReportClients, unnamedSuffix } from '@/lib/reportClient';

const SELF_DECLARED = 'The reporting app writes this name itself; it is not verified.';

/** `reports` is one report, or every report in a queue group. */
export function ReportClientText({ reports }: { reports: NostrEvent[] }) {
  const { names, unnamed } = summarizeReportClients(reports);
  const anyNamed = names.length > 0;
  const titleLabel = describeReportClients(reports);
  return (
    <span
      className={cn('text-xs text-muted-foreground min-w-0 max-w-full', anyNamed ? 'flex' : 'block truncate')}
      // The hover text also carries the full name when a long one is truncated.
      title={anyNamed ? `${titleLabel}. ${SELF_DECLARED}` : titleLabel}
    >
      {anyNamed ? (
        <>
          <span className="truncate min-w-0">
            Filed via{' '}
            {/* Each name is self-declared and may carry direction controls; <bdi>
                keeps it from reordering "Filed via" or the count beside it, and
                displaySafe stops a stray terminator or paragraph break in the
                name ending it early. */}
            {names.map((name, i) => (
              <Fragment key={name}>
                {i > 0 && ', '}
                <bdi>{displaySafe(name)}</bdi>
              </Fragment>
            ))}
          </span>
          {/* The count is ours, not a reporter's, so it sits outside the
              truncation where a long self-declared name can't push it out of view. */}
          {unnamed > 0 && <span className="shrink-0 whitespace-pre">{unnamedSuffix(unnamed)}</span>}
        </>
      ) : (
        NO_APP_NAMED
      )}
    </span>
  );
}
