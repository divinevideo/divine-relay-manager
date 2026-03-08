// ABOUTME: Bulk delete all events of a specific kind from a user
// ABOUTME: Queries events by kind+author then deletes them with progress tracking

import { useState, useMemo } from "react";
import { useNostr } from "@nostrify/react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useAdminApi } from "@/hooks/useAdminApi";
import { useToast } from "@/hooks/useToast";
import { getKindName } from "@/lib/kindNames";
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
import { Trash2, Loader2, AlertTriangle } from "lucide-react";
import type { NostrEvent } from "@nostrify/nostrify";

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

interface BulkDeleteByKindProps {
  pubkey: string;
  onComplete?: () => void;
  variant?: "button" | "inline";
}

export function BulkDeleteByKind({ pubkey, onComplete, variant = "button" }: BulkDeleteByKindProps) {
  const { nostr } = useNostr();
  const { deleteEvent } = useAdminApi();
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const [selectedKind, setSelectedKind] = useState<string>("34235"); // Default to Addressable Video
  const [dialogOpen, setDialogOpen] = useState(false);
  const [deleteProgress, setDeleteProgress] = useState(0);
  const [deletedCount, setDeletedCount] = useState(0);

  // Query ALL events from this user to show kind breakdown
  const { data: allUserEvents } = useQuery({
    queryKey: ['user-all-events', pubkey],
    queryFn: async ({ signal }) => {
      const timeout = AbortSignal.timeout(10000);
      const combinedSignal = AbortSignal.any([signal, timeout]);
      const events = await nostr.query(
        [{ authors: [pubkey], limit: 500 }],
        { signal: combinedSignal }
      );
      return events;
    },
    enabled: !!pubkey && dialogOpen,
  });

  // Group events by kind for the summary
  const kindCounts = useMemo(() => {
    if (!allUserEvents) return new Map<number, number>();
    const counts = new Map<number, number>();
    for (const event of allUserEvents) {
      counts.set(event.kind, (counts.get(event.kind) || 0) + 1);
    }
    return counts;
  }, [allUserEvents]);

  // Query events of selected kind from this user
  const { data: events, isLoading: loadingEvents, error: queryError } = useQuery({
    queryKey: ['bulk-delete-events', pubkey, selectedKind],
    queryFn: async ({ signal }) => {
      const kind = parseInt(selectedKind);
      if (isNaN(kind)) return [];

      const timeout = AbortSignal.timeout(10000);
      const combinedSignal = AbortSignal.any([signal, timeout]);

      const events = await nostr.query(
        [{ kinds: [kind], authors: [pubkey], limit: 500 }],
        { signal: combinedSignal }
      );

      return events;
    },
    enabled: !!pubkey && !!selectedKind,
  });

  // Debug: log query errors
  if (queryError) {
    console.error('[BulkDeleteByKind] Query error:', queryError);
  }

  // Bulk delete mutation
  const bulkDeleteMutation = useMutation({
    mutationFn: async (eventsToDelete: NostrEvent[]) => {
      const total = eventsToDelete.length;
      let deleted = 0;
      const errors: string[] = [];

      for (const event of eventsToDelete) {
        try {
          await deleteEvent(event.id, `Bulk delete: kind ${selectedKind}`);
          deleted++;
          setDeletedCount(deleted);
          setDeleteProgress((deleted / total) * 100);
        } catch (error) {
          errors.push(event.id);
          console.error(`Failed to delete event ${event.id}:`, error);
        }
      }

      return { deleted, errors, total };
    },
    onSuccess: (result) => {
      const kindName = getKindName(parseInt(selectedKind));

      if (result.errors.length === 0) {
        toast({
          title: "Bulk delete complete",
          description: `Deleted ${result.deleted} ${kindName} events`,
        });
      } else {
        toast({
          title: "Bulk delete completed with errors",
          description: `Deleted ${result.deleted}/${result.total} events. ${result.errors.length} failed.`,
          variant: "destructive",
        });
      }

      // Reset state
      setDeleteProgress(0);
      setDeletedCount(0);
      setDialogOpen(false);

      // Invalidate queries
      queryClient.invalidateQueries({ queryKey: ['bulk-delete-events'] });
      queryClient.invalidateQueries({ queryKey: ['user-stats'] });
      queryClient.invalidateQueries({ queryKey: ['relay-events'] });

      onComplete?.();
    },
    onError: (error) => {
      toast({
        title: "Bulk delete failed",
        description: error instanceof Error ? error.message : "Unknown error",
        variant: "destructive",
      });
      setDeleteProgress(0);
      setDeletedCount(0);
    },
  });

  const handleDelete = () => {
    if (events && events.length > 0) {
      bulkDeleteMutation.mutate(events);
    }
  };

  const eventCount = events?.length || 0;
  const kindName = getKindName(parseInt(selectedKind) || 0);
  const isDeleting = bulkDeleteMutation.isPending;

  if (variant === "inline") {
    return (
      <div className="space-y-3">
        <div className="flex items-end gap-2">
          <div className="flex-1">
            <Label htmlFor="kind-select" className="text-xs text-muted-foreground">
              Delete all events of kind
            </Label>
            <Select value={selectedKind} onValueChange={setSelectedKind} disabled={isDeleting}>
              <SelectTrigger id="kind-select" className="mt-1">
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

          <AlertDialog open={dialogOpen} onOpenChange={setDialogOpen}>
            <AlertDialogTrigger asChild>
              <Button
                variant="destructive"
                size="sm"
                disabled={loadingEvents || eventCount === 0 || isDeleting}
              >
                {loadingEvents ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <>
                    <Trash2 className="h-4 w-4 mr-1" />
                    Delete {eventCount}
                  </>
                )}
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle className="flex items-center gap-2">
                  <AlertTriangle className="h-5 w-5 text-destructive" />
                  Delete {eventCount} Events?
                </AlertDialogTitle>
                <AlertDialogDescription asChild>
                  <div className="space-y-3">
                    <p>
                      This will permanently delete <strong>{eventCount} {kindName}</strong> events
                      from this user on the relay.
                    </p>
                    {isDeleting && (
                      <div className="space-y-2">
                        <Progress value={deleteProgress} />
                        <p className="text-sm text-center">
                          Deleted {deletedCount} of {eventCount} events...
                        </p>
                      </div>
                    )}
                  </div>
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel disabled={isDeleting}>Cancel</AlertDialogCancel>
                <AlertDialogAction
                  onClick={handleDelete}
                  disabled={isDeleting}
                  className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                >
                  {isDeleting ? (
                    <>
                      <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                      Deleting...
                    </>
                  ) : (
                    `Delete ${eventCount} Events`
                  )}
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </div>

        {eventCount === 0 && !loadingEvents && (
          <p className="text-xs text-muted-foreground">
            No {kindName} events found for this user
          </p>
        )}
      </div>
    );
  }

  // Button variant (can be placed anywhere)
  return (
    <AlertDialog open={dialogOpen} onOpenChange={setDialogOpen}>
      <AlertDialogTrigger asChild>
        <Button variant="outline" size="sm">
          <Trash2 className="h-4 w-4 mr-2" />
          Bulk Delete by Kind
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Bulk Delete Events by Kind</AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="space-y-4">
              <p>Select an event kind to delete all matching events from this user.</p>

              <div>
                <Label htmlFor="kind-select-dialog" className="text-sm">Event Kind</Label>
                <Select value={selectedKind} onValueChange={setSelectedKind} disabled={isDeleting}>
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

              <div className="p-3 bg-muted rounded-lg">
                {loadingEvents ? (
                  <div className="flex items-center gap-2 text-sm">
                    <Loader2 className="h-4 w-4 animate-spin" />
                    Counting events...
                  </div>
                ) : (
                  <p className="text-sm">
                    Found <strong>{eventCount}</strong> {kindName} events to delete
                  </p>
                )}
              </div>

              {/* Show kind breakdown */}
              {kindCounts.size > 0 && (
                <div className="p-3 bg-blue-50 dark:bg-blue-950/30 rounded-lg border border-blue-200 dark:border-blue-800">
                  <p className="text-xs font-medium text-blue-800 dark:text-blue-200 mb-2">
                    This user has events of these kinds:
                  </p>
                  <div className="flex flex-wrap gap-1">
                    {Array.from(kindCounts.entries())
                      .sort((a, b) => b[1] - a[1])
                      .map(([kind, count]) => (
                        <button
                          key={kind}
                          onClick={() => setSelectedKind(kind.toString())}
                          className={`text-xs px-2 py-1 rounded-full transition-colors ${
                            selectedKind === kind.toString()
                              ? 'bg-blue-600 text-white'
                              : 'bg-blue-100 dark:bg-blue-900 text-blue-800 dark:text-blue-200 hover:bg-blue-200 dark:hover:bg-blue-800'
                          }`}
                        >
                          {getKindName(kind)} ({count})
                        </button>
                      ))}
                  </div>
                </div>
              )}

              {isDeleting && (
                <div className="space-y-2">
                  <Progress value={deleteProgress} />
                  <p className="text-sm text-center text-muted-foreground">
                    Deleted {deletedCount} of {eventCount} events...
                  </p>
                </div>
              )}
            </div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={isDeleting}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            onClick={handleDelete}
            disabled={isDeleting || eventCount === 0 || loadingEvents}
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
          >
            {isDeleting ? (
              <>
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                Deleting...
              </>
            ) : (
              `Delete ${eventCount} Events`
            )}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
