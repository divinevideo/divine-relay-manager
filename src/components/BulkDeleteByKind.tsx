// ABOUTME: Bulk delete all events of a specific kind from a user
// ABOUTME: Runs as the worker's async bulk-moderate job; counts come from a full relay listing

import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useAdminApi } from "@/hooks/useAdminApi";
import { isTerminal, useBulkModerateJob } from "@/hooks/useBulkModerateJob";
import { useAgeReviewGuardRedirect } from "@/hooks/useAgeReviewGuardRedirect";
import { useToast } from "@/hooks/useToast";
import { getKindName } from "@/lib/kindNames";
import { ApiError, type BulkJob } from "@/lib/adminApi";
import { isVersionedKind, parseFailure, parseOverflowMarker } from "../../shared/bulk-moderation";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Input } from "@/components/ui/input";
import { Trash2, Loader2 } from "lucide-react";

// Video kinds per NIP-71
const VIDEO_KINDS = [
  { value: "34235", label: "Video - Addressable (34235)", priority: true },
  { value: "34236", label: "Short Video - Addressable (34236)", priority: true },
  { value: "21", label: "Video (21)", priority: true },
  { value: "22", label: "Short Video (22)", priority: true },
];

const OTHER_KINDS = [
  { value: "0", label: "Profile Metadata (0)" },
  { value: "1", label: "Text Notes (1)" },
  { value: "6", label: "Reposts (6)" },
  { value: "7", label: "Reactions (7)" },
  { value: "1063", label: "File Metadata (1063)" },
  { value: "30023", label: "Long-form Articles (30023)" },
];

const HIDDEN_ACCOUNT = "The relay doesn't list a banned or suspended account's content, so it can't be counted or deleted here.";
const RERUN_SAFE = "Running it again is safe; it only picks up what's left.";
// Differs from UserActions' approved lost-track copy on purpose: this one names the dialog.
const LOST_TRACK_TITLE = "Lost track of the bulk delete";
const LOST_TRACK_BODY = "It may still be running on the server. Wait a minute and reopen this dialog to check before running it again.";
// A failure detail can carry a full 64-hex event id, which has no break
// opportunity. Let it wrap anywhere so it stays whole on a narrow screen.
const WRAP_IDS = "[overflow-wrap:anywhere]";

interface BulkDeleteByKindProps {
  pubkey: string;
  onComplete?: () => void;
  /** Report the delete is taken from, recorded on each decision row */
  reportId?: string;
  /** Snapshot the acting moderator's pubkey, resolved once at job start so a
   *  logout/switch mid-delete can't retarget the attribution (#178). */
  getModeratorPubkey?: () => Promise<string | undefined>;
  /** Account status where the caller already has it: true, false, or
   *  null/undefined when unknown. The relay hides a banned or suspended
   *  account's events from every listing, so its counts read as zero. */
  isBanned?: boolean | null;
  isSuspended?: boolean | null;
}

// What the moderator confirmed when the job started: the count and the kind.
// The kind is kept here because a worker from before delete-kind reports a
// finished job without one.
interface ExpectedCount {
  count: number;
  complete: boolean;
  kind: number;
}

// Each stored failure is one problem, except the "+N more" overflow marker,
// which stands for N of them.
function countIssues(failures: string[]): number {
  return failures.reduce((n, failure) => n + (parseOverflowMarker(failure) ?? 1), 0);
}

// The worker's failure strings in words a moderator can act on. Event ids stay
// whole: a shortened id can't be looked up.
function describeFailure(failure: string): string {
  const parsed = parseFailure(failure);
  switch (parsed.type) {
    case "job":
      // An abandoned job in words; any other reason the job stopped, as given.
      return parsed.abandoned ? "the server stopped reporting progress" : parsed.reason;
    case "enumeration":
      // The account is already the dialog's subject, so drop its pubkey.
      return parsed.warning;
    case "event":
      return `event ${parsed.id} failed: ${parsed.error}`;
    default:
      return failure;
  }
}

// " of Y" (or " of at least Y") after a deleted count, or nothing where it would
// read as nonsense: past the count ("20 of 1", a sweep also deletes older
// versions and later posts), or against an incomplete zero ("of at least 0").
function ofTotal(expected: ExpectedCount | undefined, deleted: number): string {
  if (!expected || deleted > expected.count || (!expected.complete && expected.count === 0)) return "";
  return ` of ${expected.complete ? "" : "at least "}${expected.count}`;
}

// What a finished job tells the moderator. Only a job that ran to completion
// with no failures reads as done. A job with failures, or one that stopped
// early, says how far it got and that a re-run picks up the rest, unless the
// account is now hidden, where a re-run would find nothing.
function describeOutcome(job: BulkJob, expected: ExpectedCount | undefined, contentHidden: boolean) {
  const kind = job.kind ?? expected?.kind;
  const kindName = kind !== undefined ? `${getKindName(kind)} ` : "";
  const deleted = job.eventsProcessed;
  const clean = job.status === "done" && job.failures.length === 0;
  if (clean) {
    const title = "Bulk delete complete";
    if (expected?.complete && deleted < expected.count) {
      return {
        clean, title,
        description: `Deleted ${deleted} of ${expected.count} ${kindName}events. ${expected.count - deleted} were no longer listed: already deleted, or hidden because the account is now banned or suspended.`,
      };
    }
    // The count lists the newest version of each edited event; the delete also
    // removes the older versions behind it. Only replaceable and addressable
    // kinds have versions; for others the extra were posted after the count.
    if (expected?.complete && deleted > expected.count && kind !== undefined && isVersionedKind(kind)) {
      return { clean, title, description: `Deleted ${deleted} ${kindName}events, including older versions of edited events.` };
    }
    return { clean, title, description: `Deleted ${deleted} ${kindName}events` };
  }
  const head = `Deleted ${deleted}${ofTotal(expected, deleted)} ${kindName}events. ${contentHidden ? HIDDEN_ACCOUNT : RERUN_SAFE}`;
  const detail = job.failures.slice(0, 2).map(describeFailure).join("; ");
  if (job.status === "failed") {
    // Why it stopped is its `job:` entry, which follows any per-event failures
    // (the last stored slot in a full list).
    const stop = job.failures.find((failure) => parseFailure(failure).type === "job");
    return { clean, title: "Bulk delete stopped early", description: `${head} Reason: ${stop ? describeFailure(stop) : detail}` };
  }
  return {
    clean,
    title: "Bulk delete finished with issues",
    description: `${head} ${countIssues(job.failures)} failed or could not be listed: ${detail}`,
  };
}

export function BulkDeleteByKind({ pubkey, onComplete, reportId, getModeratorPubkey, isBanned, isSuspended }: BulkDeleteByKindProps) {
  const api = useAdminApi();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const redirectIfGuarded = useAgeReviewGuardRedirect();

  const [selectedKind, setSelectedKind] = useState<string>("34235"); // Default to Addressable Video
  const [dialogOpen, setDialogOpen] = useState(false);
  const [reason, setReason] = useState("");
  // True while the moderator's identity resolves, before the enqueue is pending,
  // so a second click in that gap cannot start a second job.
  const [starting, setStarting] = useState(false);
  // What the moderator confirmed for the job the hook holds. It is set only
  // once that job's enqueue succeeds, so a later attempt that never became a
  // job leaves it alone, and an outcome never mixes one job with another
  // attempt's count.
  const [expected, setExpected] = useState<ExpectedCount>();
  // Funnelcake drops banned and suspended authors from every REQ, and the
  // worker lists anonymously, so for those accounts there is nothing to count or
  // delete here. Only a known-active account's zero is a real absence.
  const contentHidden = isBanned === true || isSuspended === true;
  const statusKnownActive = isBanned === false && isSuspended === false;

  // Per-kind counts from the worker's paged listing of the account; a lower
  // bound when `complete` is false.
  // No retry: each attempt is a full listing, and reopening the dialog retries.
  const countsQuery = useQuery({
    queryKey: ["bulk-kind-counts", pubkey],
    queryFn: () => api.getBulkKindCounts(pubkey),
    enabled: !!pubkey && dialogOpen && !contentHidden,
    staleTime: 30_000,
    retry: false,
  });

  const bulkJob = useBulkModerateJob({
    pubkey,
    onComplete: (job) => {
      const outcome = describeOutcome(job, expected, contentHidden);
      toast(outcome.clean
        ? { title: outcome.title, description: outcome.description }
        : { title: outcome.title, description: outcome.description, variant: "destructive", className: WRAP_IDS });
      queryClient.invalidateQueries({ queryKey: ["bulk-kind-counts", pubkey] });
      queryClient.invalidateQueries({ queryKey: ["user-stats"] });
      queryClient.invalidateQueries({ queryKey: ["relay-events"] });
      if (outcome.clean) {
        setReason("");
        setDialogOpen(false);
      }
      onComplete?.();
    },
    onError: (error) => {
      // Like Delete All Content, the worker refuses a bulk job on an account
      // with an open age-review case; send the moderator to the case.
      if (redirectIfGuarded(error, pubkey)) return;
      toast({ title: "Bulk delete failed", description: error.message, variant: "destructive" });
    },
    onTrackingLost: () => {
      toast({ title: LOST_TRACK_TITLE, description: LOST_TRACK_BODY });
    },
  });

  const counts = countsQuery.data;
  const selectedCount = counts ? counts.counts[selectedKind] ?? 0 : undefined;
  const isRunning = bulkJob.isRunning || starting;
  // A cut-short listing may have missed events of this kind, so it does not
  // rule a delete out even at zero. A lost status poll keeps Delete off: the
  // job may still be running. So does a failed count refetch, whose earlier
  // counts are still cached under the error the dialog shows.
  const canDelete = !!counts && !countsQuery.isError && (selectedCount! > 0 || !counts.complete) && !isRunning
    && !contentHidden && !bulkJob.trackingLost;
  const kindName = getKindName(parseInt(selectedKind) || 0);
  const job = bulkJob.job;
  const outcome = job && isTerminal(job.status) && (job.kind !== undefined || expected?.kind !== undefined)
    ? describeOutcome(job, expected, contentHidden)
    : null;

  const handleDelete = async () => {
    if (!counts) return;
    const kind = Number(selectedKind);
    setStarting(true);
    try {
      const confirmed = { count: selectedCount ?? 0, complete: counts.complete, kind };
      let moderatorPubkey: string | undefined;
      try {
        moderatorPubkey = await getModeratorPubkey?.();
      } catch (error) {
        // Attribution is non-critical: the job's rows fall back to the worker's key.
        console.warn("[BulkDeleteByKind] could not resolve the moderator pubkey", error);
      }
      try {
        await bulkJob.startAsync("delete-kind", {
          kind,
          reason: reason.trim() || `Bulk delete: kind ${kind}`,
          moderatorPubkey,
          reportId,
        });
        setExpected(confirmed);
      } catch {
        // The hook's onError has reported it; the previous job's outcome stands.
      }
    } finally {
      setStarting(false);
    }
  };

  const processed = job && !isTerminal(job.status) ? job.eventsProcessed : 0;
  const progressValue = expected && expected.count > 0 ? Math.min(100, (processed / expected.count) * 100) : 0;
  const deleteLabel = !counts
    ? "Delete events"
    : counts.complete
      ? `Delete ${selectedCount} ${kindName} events`
      : `Delete all ${kindName} events`;
  const countError = countsQuery.error instanceof ApiError && countsQuery.error.code === "timeout"
    ? "Counting this account's events took too long. Close and reopen this dialog to try again. Delete is unavailable until the count loads."
    : `Could not count this account's events${countsQuery.error instanceof Error ? `: ${countsQuery.error.message}` : ""}. Delete is unavailable until the count loads.`;

  return (
    <AlertDialog open={dialogOpen} onOpenChange={setDialogOpen}>
      <AlertDialogTrigger asChild>
        <Button variant="outline" size="sm">
          {isRunning ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Trash2 className="h-4 w-4 mr-2" />}
          Bulk Delete by Kind
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Bulk Delete Events by Kind</AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="space-y-4">
              <p>Deletes every event of the chosen kind from this user on the relay. This cannot be undone. Media files are retained on the media server.</p>

              <div>
                <Label htmlFor="kind-select-dialog" className="text-sm">Event Kind</Label>
                <Select value={selectedKind} onValueChange={setSelectedKind} disabled={isRunning}>
                  <SelectTrigger id="kind-select-dialog" className="mt-1">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <div className="px-2 py-1 text-xs font-medium text-muted-foreground">Video Events</div>
                    {VIDEO_KINDS.map(kind => (
                      <SelectItem key={kind.value} value={kind.value}>
                        {kind.label}
                      </SelectItem>
                    ))}
                    <div className="px-2 py-1 text-xs font-medium text-muted-foreground border-t mt-1 pt-1">Other</div>
                    {OTHER_KINDS.map(kind => (
                      <SelectItem key={kind.value} value={kind.value}>
                        {kind.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="p-3 bg-muted rounded-lg space-y-1">
                {contentHidden ? (
                  <p className="text-sm">{HIDDEN_ACCOUNT}</p>
                ) : countsQuery.isError ? (
                  <p className="text-sm text-destructive">{countError}</p>
                ) : !counts ? (
                  <div className="flex items-center gap-2 text-sm">
                    <Loader2 className="h-4 w-4 animate-spin" />
                    Counting events...
                  </div>
                ) : (
                  <>
                    {selectedCount === 0 && counts.complete ? (
                      <p className="text-sm">
                        No {kindName} events found.
                        {!statusKnownActive && " If this account is banned or suspended, its content isn't listed."}
                      </p>
                    ) : selectedCount === 0 ? (
                      <p className="text-sm">
                        None found in the part of this account that could be listed. The delete searches this kind directly and may find more.
                      </p>
                    ) : (
                      <p className="text-sm">
                        Found <strong>{counts.complete ? selectedCount : `at least ${selectedCount}`}</strong> {kindName} events to delete
                      </p>
                    )}
                    {!counts.complete && (
                      <p className="text-xs text-muted-foreground">
                        This account's events could not be listed in full, so these counts are a lower bound.
                      </p>
                    )}
                  </>
                )}
              </div>

              {/* Show kind breakdown */}
              {counts && Object.keys(counts.counts).length > 0 && (
                <div className="p-3 bg-blue-50 dark:bg-blue-950/30 rounded-lg border border-blue-200 dark:border-blue-800">
                  <p className="text-xs font-medium text-blue-800 dark:text-blue-200 mb-2">
                    This user has events of these kinds:
                  </p>
                  <div className="flex flex-wrap gap-1">
                    {Object.entries(counts.counts)
                      .sort((a, b) => b[1] - a[1])
                      .map(([kind, count]) => (
                        <button
                          key={kind}
                          onClick={() => setSelectedKind(kind)}
                          disabled={isRunning}
                          aria-pressed={selectedKind === kind}
                          className={`text-xs px-2 py-1 rounded-full transition-colors ${
                            selectedKind === kind
                              ? 'bg-blue-600 text-white'
                              : 'bg-blue-100 dark:bg-blue-900 text-blue-800 dark:text-blue-200 hover:bg-blue-200 dark:hover:bg-blue-800'
                          }`}
                        >
                          {getKindName(Number(kind))} ({count}{counts.complete ? "" : "+"})
                        </button>
                      ))}
                  </div>
                </div>
              )}

              <div>
                <Label htmlFor="bulk-delete-reason" className="text-sm">Reason</Label>
                <Input
                  id="bulk-delete-reason"
                  placeholder="e.g. Spam content, policy violation..."
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  disabled={isRunning}
                  className="mt-1"
                />
              </div>

              {isRunning && (
                <div className="space-y-2">
                  <Progress value={progressValue} aria-label="Bulk delete progress" />
                  <p role="status" className="text-sm text-center text-muted-foreground">
                    {/* While a start is in flight, `expected` still belongs to the previous job. */}
                    Deleted {processed}{ofTotal(starting ? undefined : expected, processed)} events...
                  </p>
                  <p className="text-xs text-center text-muted-foreground">
                    The delete runs on the server; closing this dialog does not stop it.
                  </p>
                </div>
              )}

              {bulkJob.trackingLost && (
                <div className="p-3 rounded-lg border text-sm space-y-2">
                  <p className="font-medium">{LOST_TRACK_TITLE}</p>
                  <p className="text-muted-foreground">{LOST_TRACK_BODY}</p>
                  <Button variant="outline" size="sm" onClick={bulkJob.checkAgain}>Check again</Button>
                </div>
              )}

              {!isRunning && !bulkJob.trackingLost && outcome && !outcome.clean && (
                <div className="p-3 rounded-lg border border-destructive/50 text-sm space-y-1">
                  <p className="font-medium text-destructive">{outcome.title}</p>
                  <p className={`text-muted-foreground ${WRAP_IDS}`}>{outcome.description}</p>
                </div>
              )}
            </div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{isRunning ? "Close" : "Cancel"}</AlertDialogCancel>
          <AlertDialogAction
            onClick={(e) => {
              // Keep the dialog open so it can show the job's progress.
              e.preventDefault();
              void handleDelete();
            }}
            disabled={!canDelete}
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
          >
            {isRunning ? (
              <>
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                Deleting...
              </>
            ) : (
              deleteLabel
            )}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
