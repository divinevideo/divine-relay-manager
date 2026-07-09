// ABOUTME: Degraded-mode UI for a report whose detail pane crashed during render
// ABOUTME: (hostile event data): full target identifiers + retry/dismiss (#158)

import { AlertTriangle, RotateCcw, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { getReportTargetIds, isHex64 } from '@/lib/constants';
import type { NostrEvent } from '@nostrify/nostrify';

interface ReportDetailErrorFallbackProps {
  /** The selected report event — it rendered in the list, so showing its
   * fields is useful; IdentifierRow still guards every value individually. */
  report: NostrEvent | null;
  onRetry: () => void;
  onDismiss: () => void;
}

// Target ids arrive pre-validated by getReportTargetIds; report.id is
// whatever the worker returned (normally relay-verified, but this is the
// degraded path — trust nothing). Valid hex lowercases to NIP-01 canonical
// form; anything else renders VERBATIM, because a case-folded copy of a
// non-canonical id would silently fail relay/D1/log lookups. Non-strings
// are dropped — the crash fallback must never crash itself.
function IdentifierRow({ label, value }: { label: string; value: string | undefined }) {
  if (typeof value !== 'string') return null;
  return (
    <p className="text-xs font-mono break-all text-left">
      <span className="text-muted-foreground select-none">{label}: </span>
      {isHex64(value) ? value.toLowerCase() : value}
    </p>
  );
}

export function ReportDetailErrorFallback({ report, onRetry, onDismiss }: ReportDetailErrorFallbackProps) {
  const targetIds = report ? getReportTargetIds(report) : null;
  return (
    <div className="flex h-full flex-col items-center justify-center space-y-3 p-8 text-center">
      <AlertTriangle className="h-6 w-6 text-destructive" />
      <p className="font-medium">This report failed to render</p>
      <p className="text-sm text-muted-foreground">
        It may contain malformed event data. The identifiers below are from the
        report event itself; the crash details are in the browser console.
      </p>
      {report && (
        <div className="w-full max-w-xl space-y-1 rounded border bg-muted/30 p-3">
          <IdentifierRow label="report id" value={report.id} />
          <IdentifierRow label="target event" value={targetIds?.eventId} />
          <IdentifierRow label="target pubkey" value={targetIds?.pubkey} />
        </div>
      )}
      <div className="flex items-center gap-2">
        <Button variant="outline" size="sm" onClick={onRetry}>
          <RotateCcw className="mr-1 h-3 w-3" />
          Try again
        </Button>
        {report && (
          <Button variant="ghost" size="sm" onClick={onDismiss}>
            <X className="mr-1 h-3 w-3" />
            Dismiss
          </Button>
        )}
      </div>
    </div>
  );
}
