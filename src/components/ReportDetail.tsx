// ABOUTME: Full detail view for a selected report in the split-pane layout
// ABOUTME: Combines thread context, user profile, AI summary, and action buttons

import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { ScrollArea } from "@/components/ui/scroll-area";
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
import { useReportContext } from "@/hooks/useReportContext";
import { useUserSummary } from "@/hooks/useUserSummary";
import { ThreadContext } from "@/components/ThreadContext";
import { UserProfileCard } from "@/components/UserProfileCard";
import { ReporterInfo } from "@/components/ReporterInfo";
import { AISummary } from "@/components/AISummary";
import { LabelPublisherInline } from "@/components/LabelPublisher";
import { ThreadModal } from "@/components/ThreadModal";
import { banPubkey } from "@/lib/adminApi";
import { UserX, Tag, XCircle, Flag } from "lucide-react";
import type { NostrEvent } from "@nostrify/nostrify";

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

interface ReportDetailProps {
  report: NostrEvent | null;
  onDismiss?: () => void;
}

export function ReportDetail({ report, onDismiss }: ReportDetailProps) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [showThreadModal, setShowThreadModal] = useState(false);
  const [showLabelForm, setShowLabelForm] = useState(false);
  const [confirmBan, setConfirmBan] = useState(false);

  const context = useReportContext(report);

  const summary = useUserSummary(
    context.reportedUser.pubkey || undefined,
    context.userStats?.recentPosts,
    context.userStats?.existingLabels,
    context.userStats?.previousReports
  );

  const banMutation = useMutation({
    mutationFn: async ({ pubkey, reason }: { pubkey: string; reason: string }) => {
      await banPubkey(pubkey, reason);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['banned-users'] });
      queryClient.invalidateQueries({ queryKey: ['banned-pubkeys'] });
      toast({ title: "User banned successfully" });
      setConfirmBan(false);
    },
    onError: (error: Error) => {
      toast({
        title: "Failed to ban user",
        description: error.message,
        variant: "destructive",
      });
    },
  });

  if (!report) {
    return (
      <div className="h-full flex items-center justify-center text-muted-foreground">
        <div className="text-center">
          <Flag className="h-12 w-12 mx-auto mb-4 opacity-50" />
          <p>Select a report to view details</p>
        </div>
      </div>
    );
  }

  const category = getReportCategory(report);
  const categoryLabel = CATEGORY_LABELS[category] || category;

  return (
    <>
      {/* Ban Confirmation Dialog */}
      <AlertDialog open={confirmBan} onOpenChange={setConfirmBan}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Ban User?</AlertDialogTitle>
            <AlertDialogDescription>
              This will permanently ban this user from the relay.
              <br />
              <code className="text-xs bg-muted px-1 py-0.5 rounded mt-2 inline-block">
                {context.reportedUser.pubkey?.slice(0, 24)}...
              </code>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={banMutation.isPending}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (context.reportedUser.pubkey) {
                  banMutation.mutate({
                    pubkey: context.reportedUser.pubkey,
                    reason: `Report: ${categoryLabel}`,
                  });
                }
              }}
              disabled={banMutation.isPending}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {banMutation.isPending ? 'Banning...' : 'Ban User'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Thread Modal */}
      {context.target?.type === 'event' && (
        <ThreadModal
          eventId={context.target.value}
          open={showThreadModal}
          onOpenChange={setShowThreadModal}
        />
      )}

      <ScrollArea className="h-full">
        <div className="p-4 space-y-4">
          {/* Header */}
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Badge variant="outline">{categoryLabel}</Badge>
              <Badge variant="secondary">
                {context.target?.type === 'event' ? 'Event' : 'User'}
              </Badge>
            </div>
            <span className="text-xs text-muted-foreground">
              {new Date(report.created_at * 1000).toLocaleString()}
            </span>
          </div>

          {/* Report Content */}
          {report.content && (
            <Card>
              <CardContent className="p-3">
                <p className="text-sm">{report.content}</p>
              </CardContent>
            </Card>
          )}

          <Separator />

          {/* Thread Context */}
          {context.target?.type === 'event' && (
            <ThreadContext
              ancestors={context.thread?.ancestors || []}
              reportedEvent={context.thread?.event || null}
              onViewFullThread={() => setShowThreadModal(true)}
              isLoading={context.isLoading}
            />
          )}

          <Separator />

          {/* Reported User */}
          <UserProfileCard
            profile={context.reportedUser.profile}
            pubkey={context.reportedUser.pubkey}
            stats={context.userStats}
            isLoading={context.isLoading}
          />

          {/* AI Summary */}
          <AISummary
            summary={summary.data?.summary}
            riskLevel={summary.data?.riskLevel}
            isLoading={summary.isLoading}
            error={summary.error as Error | null}
          />

          <Separator />

          {/* Reporter Info */}
          <ReporterInfo
            profile={context.reporter.profile}
            pubkey={context.reporter.pubkey}
            reportCount={context.reporter.reportCount}
            isLoading={context.isLoading}
          />

          <Separator />

          {/* Inline Label Form */}
          {showLabelForm && context.target && (
            <LabelPublisherInline
              targetType={context.target.type}
              targetValue={context.target.value}
              onSuccess={() => setShowLabelForm(false)}
              onCancel={() => setShowLabelForm(false)}
            />
          )}

          {/* Action Buttons */}
          <div className="flex gap-2 pt-2">
            {context.reportedUser.pubkey && (
              <Button
                variant="destructive"
                onClick={() => setConfirmBan(true)}
                disabled={banMutation.isPending}
              >
                <UserX className="h-4 w-4 mr-1" />
                Ban User
              </Button>
            )}
            {context.target && !showLabelForm && (
              <Button
                variant="outline"
                onClick={() => setShowLabelForm(true)}
              >
                <Tag className="h-4 w-4 mr-1" />
                Create Label
              </Button>
            )}
            {onDismiss && (
              <Button variant="ghost" onClick={onDismiss}>
                <XCircle className="h-4 w-4 mr-1" />
                Dismiss
              </Button>
            )}
          </div>
        </div>
      </ScrollArea>
    </>
  );
}
