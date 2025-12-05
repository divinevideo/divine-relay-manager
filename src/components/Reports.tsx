// ABOUTME: Displays kind 1984 reports (user-submitted content flags)
// ABOUTME: Allows admins to review and take action on reports

import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useNostr } from "@nostrify/react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { useToast } from "@/hooks/useToast";
import { Flag, UserX, Tag, Clock } from "lucide-react";
import { banPubkey } from "@/lib/adminApi";
import { LabelPublisherInline } from "@/components/LabelPublisher";
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

export function Reports({ relayUrl }: ReportsProps) {
  const { nostr } = useNostr();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [selectedReport, setSelectedReport] = useState<string | null>(null);
  const [labelingTarget, setLabelingTarget] = useState<{ type: 'event' | 'pubkey'; value: string } | null>(null);
  const [confirmBan, setConfirmBan] = useState<{ pubkey: string; reason: string } | null>(null);

  // Query for kind 1984 reports
  const { data: reports, isLoading, error } = useQuery({
    queryKey: ['reports', relayUrl],
    queryFn: async ({ signal }) => {
      const events = await nostr.query(
        [{ kinds: [1984], limit: 100 }],
        { signal: AbortSignal.any([signal, AbortSignal.timeout(5000)]) }
      );
      return events.sort((a, b) => b.created_at - a.created_at);
    },
  });

  // Ban mutation with proper loading state and error handling
  const banMutation = useMutation({
    mutationFn: async ({ pubkey, reason }: { pubkey: string; reason: string }) => {
      await banPubkey(pubkey, reason);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['banned-users'] });
      queryClient.invalidateQueries({ queryKey: ['banned-pubkeys'] });
      toast({ title: "User banned successfully" });
      setConfirmBan(null);
    },
    onError: (error: Error) => {
      toast({
        title: "Failed to ban user",
        description: error.message,
        variant: "destructive",
      });
    },
  });

  const handleBanClick = (pubkey: string, category: string) => {
    setConfirmBan({
      pubkey,
      reason: `Reported: ${CATEGORY_LABELS[category] || category}`,
    });
  };

  if (isLoading) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Flag className="h-5 w-5" />
            Reports
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="space-y-3">
            {[...Array(5)].map((_, i) => (
              <Skeleton key={i} className="h-20 w-full" />
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
    <div className="space-y-6">
      {/* Ban Confirmation Dialog */}
      <AlertDialog open={!!confirmBan} onOpenChange={() => setConfirmBan(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Ban User?</AlertDialogTitle>
            <AlertDialogDescription>
              This will permanently ban this user from the relay.
              <br />
              <code className="text-xs bg-muted px-1 py-0.5 rounded mt-2 inline-block">
                {confirmBan?.pubkey.slice(0, 24)}...
              </code>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={banMutation.isPending}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => confirmBan && banMutation.mutate(confirmBan)}
              disabled={banMutation.isPending}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {banMutation.isPending ? 'Banning...' : 'Ban User'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Inline Label Publisher */}
      {labelingTarget && (
        <div className="fixed bottom-4 right-4 z-50 w-80 shadow-xl">
          <LabelPublisherInline
            targetType={labelingTarget.type}
            targetValue={labelingTarget.value}
            onSuccess={() => setLabelingTarget(null)}
            onCancel={() => setLabelingTarget(null)}
          />
        </div>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Flag className="h-5 w-5" />
            User Reports (kind 1984)
          </CardTitle>
          <CardDescription>
            Content flagged by users for review. {reports?.length || 0} reports found.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {!reports || reports.length === 0 ? (
            <div className="text-center py-8 text-muted-foreground">
              <Flag className="h-12 w-12 mx-auto mb-4 opacity-50" />
              <p>No reports found</p>
            </div>
          ) : (
            <div className="space-y-3">
              {reports.map((report) => {
                const category = getReportCategory(report);
                const target = getReportTarget(report);
                const categoryLabel = CATEGORY_LABELS[category] || category;

                return (
                  <div
                    key={report.id}
                    className={`p-4 border rounded-lg space-y-3 ${
                      selectedReport === report.id ? 'ring-2 ring-primary' : ''
                    }`}
                    onClick={() => setSelectedReport(report.id)}
                  >
                    <div className="flex items-start justify-between">
                      <div className="space-y-1">
                        <div className="flex items-center gap-2">
                          <Badge variant="outline">{categoryLabel}</Badge>
                          {target && (
                            <Badge variant="secondary">
                              {target.type === 'event' ? 'Event' : 'User'}
                            </Badge>
                          )}
                        </div>
                        {target && (
                          <p className="text-sm text-muted-foreground font-mono">
                            {target.value.slice(0, 16)}...
                          </p>
                        )}
                      </div>
                      <div className="flex items-center gap-1 text-xs text-muted-foreground">
                        <Clock className="h-3 w-3" />
                        {new Date(report.created_at * 1000).toLocaleDateString()}
                      </div>
                    </div>

                    {report.content && (
                      <p className="text-sm">{report.content.slice(0, 200)}</p>
                    )}

                    <div className="flex gap-2">
                      {target?.type === 'pubkey' && (
                        <Button
                          size="sm"
                          variant="destructive"
                          disabled={banMutation.isPending}
                          onClick={(e) => {
                            e.stopPropagation();
                            handleBanClick(target.value, category);
                          }}
                        >
                          <UserX className="h-4 w-4 mr-1" />
                          Ban User
                        </Button>
                      )}
                      {target && (
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={(e) => {
                            e.stopPropagation();
                            setLabelingTarget({
                              type: target.type,
                              value: target.value,
                            });
                          }}
                        >
                          <Tag className="h-4 w-4 mr-1" />
                          Create Label
                        </Button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
