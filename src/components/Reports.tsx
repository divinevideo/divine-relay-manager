// ABOUTME: Displays kind 1984 reports with split-pane layout
// ABOUTME: List on left, full context detail view on right

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useNostr } from "@nostrify/react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Flag, RefreshCw, Clock } from "lucide-react";
import { ReportDetail } from "@/components/ReportDetail";
import type { NostrEvent } from "@nostrify/nostrify";

interface ReportsProps {
  relayUrl: string;
}

// DTSP category display names
const CATEGORY_LABELS: Record<string, string> = {
  'sexual_minors': 'CSAM',
  'nonconsensual_sexual_content': 'Non-consensual',
  'credible_threats': 'Threats',
  'doxxing_pii': 'Doxxing/PII',
  'terrorism_extremism': 'Terrorism',
  'malware_scam': 'Malware/Scam',
  'illegal_goods': 'Illegal Goods',
  'hate_harassment': 'Hate/Harassment',
  'self_harm_suicide': 'Self-harm',
  'graphic_violence_gore': 'Violence/Gore',
  'bullying_abuse': 'Bullying',
  'adult_nudity': 'Nudity',
  'explicit_sex': 'Explicit',
  'pornography': 'Pornography',
  'spam': 'Spam',
  'impersonation': 'Impersonation',
  'copyright': 'Copyright',
  'other': 'Other',
};

function getReportCategory(event: NostrEvent): string {
  const reportTag = event.tags.find(t => t[0] === 'report');
  if (reportTag && reportTag[1]) return reportTag[1];
  const lTag = event.tags.find(t => t[0] === 'l');
  if (lTag && lTag[1]) return lTag[1];
  return 'other';
}

function getReportTarget(event: NostrEvent): { type: 'event' | 'pubkey'; value: string } | null {
  const eTag = event.tags.find(t => t[0] === 'e');
  if (eTag) return { type: 'event', value: eTag[1] };
  const pTag = event.tags.find(t => t[0] === 'p');
  if (pTag) return { type: 'pubkey', value: pTag[1] };
  return null;
}

function ReportListItem({
  report,
  isSelected,
  onClick
}: {
  report: NostrEvent;
  isSelected: boolean;
  onClick: () => void;
}) {
  const category = getReportCategory(report);
  const target = getReportTarget(report);
  const categoryLabel = CATEGORY_LABELS[category] || category;

  return (
    <div
      className={`p-3 border rounded-lg cursor-pointer transition-colors ${
        isSelected
          ? 'border-primary bg-primary/5 ring-1 ring-primary'
          : 'hover:bg-muted/50'
      }`}
      onClick={onClick}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="space-y-1 min-w-0">
          <div className="flex items-center gap-1.5 flex-wrap">
            <Badge variant="outline" className="text-xs">{categoryLabel}</Badge>
            {target && (
              <Badge variant="secondary" className="text-xs">
                {target.type === 'event' ? 'Event' : 'User'}
              </Badge>
            )}
          </div>
          {target && (
            <p className="text-xs text-muted-foreground font-mono truncate">
              {target.value.slice(0, 16)}...
            </p>
          )}
        </div>
        <div className="flex items-center gap-1 text-xs text-muted-foreground shrink-0">
          <Clock className="h-3 w-3" />
          {new Date(report.created_at * 1000).toLocaleDateString()}
        </div>
      </div>
    </div>
  );
}

export function Reports({ relayUrl }: ReportsProps) {
  const { nostr } = useNostr();
  const [selectedReport, setSelectedReport] = useState<NostrEvent | null>(null);

  const { data: reports, isLoading, error, refetch, isFetching } = useQuery({
    queryKey: ['reports', relayUrl],
    queryFn: async ({ signal }) => {
      const events = await nostr.query(
        [{ kinds: [1984], limit: 100 }],
        { signal: AbortSignal.any([signal, AbortSignal.timeout(5000)]) }
      );
      return events.sort((a, b) => b.created_at - a.created_at);
    },
  });

  if (isLoading) {
    return (
      <Card className="h-[calc(100vh-200px)]">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Flag className="h-5 w-5" />
            User Reports
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="space-y-3">
            {[...Array(5)].map((_, i) => (
              <Skeleton key={i} className="h-16 w-full" />
            ))}
          </div>
        </CardContent>
      </Card>
    );
  }

  if (error) {
    return (
      <Alert variant="destructive">
        <AlertDescription>
          Failed to load reports: {error instanceof Error ? error.message : "Unknown error"}
        </AlertDescription>
      </Alert>
    );
  }

  return (
    <div className="grid grid-cols-1 lg:grid-cols-5 gap-4 h-[calc(100vh-200px)]">
      {/* Left Pane - Report List */}
      <Card className="lg:col-span-2">
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between">
            <div>
              <CardTitle className="flex items-center gap-2 text-lg">
                <Flag className="h-5 w-5" />
                Reports
              </CardTitle>
              <CardDescription>
                {reports?.length || 0} reports
              </CardDescription>
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={() => refetch()}
              disabled={isFetching}
            >
              <RefreshCw className={`h-4 w-4 ${isFetching ? 'animate-spin' : ''}`} />
            </Button>
          </div>
        </CardHeader>
        <CardContent className="p-0">
          <ScrollArea className="h-[calc(100vh-320px)]">
            <div className="space-y-2 p-4 pt-0">
              {!reports || reports.length === 0 ? (
                <div className="text-center py-8 text-muted-foreground">
                  <Flag className="h-8 w-8 mx-auto mb-2 opacity-50" />
                  <p className="text-sm">No reports found</p>
                </div>
              ) : (
                reports.map((report) => (
                  <ReportListItem
                    key={report.id}
                    report={report}
                    isSelected={selectedReport?.id === report.id}
                    onClick={() => setSelectedReport(report)}
                  />
                ))
              )}
            </div>
          </ScrollArea>
        </CardContent>
      </Card>

      {/* Right Pane - Report Detail */}
      <Card className="lg:col-span-3 overflow-hidden">
        <ReportDetail
          report={selectedReport}
          onDismiss={() => setSelectedReport(null)}
        />
      </Card>
    </div>
  );
}
