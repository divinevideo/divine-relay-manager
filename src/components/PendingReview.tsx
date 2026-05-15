import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Skeleton } from "@/components/ui/skeleton";
import { useAppContext } from "@/hooks/useAppContext";
import { useToast } from "@/hooks/useToast";
import { nip19 } from "nostr-tools";
import { ClipboardCheck, Check, X, Clock, AlertTriangle } from "lucide-react";

interface PendingVerdict {
  id: number;
  event_id: string | null;
  pubkey: string | null;
  verdict: string;
  category: string | null;
  rule_name: string | null;
  source: string;
  created_at: string;
  status: string;
  resolved_at: string | null;
  resolved_by: string | null;
}

export function PendingReview() {
  const { config } = useAppContext();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [showResolved, setShowResolved] = useState(false);

  const status = showResolved ? "confirmed" : "pending";

  const { data, isLoading, error } = useQuery({
    queryKey: ["pending-review", config.apiUrl, status],
    queryFn: async () => {
      const res = await fetch(
        `${config.apiUrl}/api/pending-review?status=${status}`
      );
      if (!res.ok) throw new Error(`Failed to fetch: ${res.status}`);
      const body = (await res.json()) as {
        success: boolean;
        verdicts: PendingVerdict[];
      };
      return body.verdicts;
    },
    refetchInterval: 15_000,
    placeholderData: (prev) => prev,
    retry: false,
  });

  const resolveMutation = useMutation({
    mutationFn: async ({
      id,
      action,
    }: {
      id: number;
      action: "confirm" | "dismiss";
    }) => {
      const res = await fetch(
        `${config.apiUrl}/api/pending-review/${id}/resolve`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action }),
        }
      );
      const body = (await res.json()) as {
        success: boolean;
        error?: string;
      };
      if (!res.ok || !body.success)
        throw new Error(body.error || `Failed: ${res.status}`);
    },
    onSuccess: (_, vars) => {
      queryClient.invalidateQueries({ queryKey: ["pending-review"] });
      toast({
        title: vars.action === "confirm" ? "Verdict confirmed" : "Verdict dismissed",
      });
    },
    onError: (err: Error) => {
      toast({
        title: "Action failed",
        description: err.message,
        variant: "destructive",
      });
    },
  });

  function formatId(eventId: string | null, pubkey: string | null): string {
    if (eventId) {
      try {
        const encoded = nip19.noteEncode(eventId);
        return encoded.slice(0, 16) + "..." + encoded.slice(-6);
      } catch {
        return eventId.slice(0, 12) + "...";
      }
    }
    if (pubkey) {
      try {
        const encoded = nip19.npubEncode(pubkey);
        return encoded.slice(0, 16) + "..." + encoded.slice(-6);
      } catch {
        return pubkey.slice(0, 12) + "...";
      }
    }
    return "unknown";
  }

  function timeAgo(dateStr: string): string {
    const diff = Date.now() - new Date(dateStr).getTime();
    const mins = Math.floor(diff / 60_000);
    if (mins < 1) return "just now";
    if (mins < 60) return `${mins}m ago`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours}h ago`;
    return `${Math.floor(hours / 24)}d ago`;
  }

  if (isLoading) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <ClipboardCheck className="h-4 w-4" />
            Pending Review
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {[1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-16 w-full" />
          ))}
        </CardContent>
      </Card>
    );
  }

  if (error) {
    return (
      <Alert variant="destructive">
        <AlertTriangle className="h-4 w-4" />
        <AlertDescription>
          Failed to load pending verdicts: {(error as Error).message}
        </AlertDescription>
      </Alert>
    );
  }

  const verdicts = data || [];

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="flex items-center gap-2 text-base">
            <ClipboardCheck className="h-4 w-4" />
            Pending Review
            {!showResolved && verdicts.length > 0 && (
              <Badge variant="secondary">{verdicts.length}</Badge>
            )}
          </CardTitle>
          <div className="flex gap-1">
            <Button
              size="sm"
              variant={!showResolved ? "default" : "outline"}
              onClick={() => setShowResolved(false)}
            >
              Pending
            </Button>
            <Button
              size="sm"
              variant={showResolved ? "default" : "outline"}
              onClick={() => setShowResolved(true)}
            >
              Resolved
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        {verdicts.length === 0 ? (
          <p className="text-sm text-muted-foreground py-8 text-center">
            {showResolved
              ? "No resolved verdicts yet."
              : "No items pending review."}
          </p>
        ) : (
          <div className="space-y-2">
            {verdicts.map((v) => (
              <div
                key={v.id}
                className="flex items-center justify-between rounded-lg border p-3"
              >
                <div className="flex flex-col gap-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <code className="text-xs truncate">
                      {formatId(v.event_id, v.pubkey)}
                    </code>
                    {v.category && (
                      <Badge variant="outline" className="text-xs">
                        {v.category}
                      </Badge>
                    )}
                    {v.source && (
                      <Badge variant="secondary" className="text-xs">
                        {v.source}
                      </Badge>
                    )}
                  </div>
                  <div className="flex items-center gap-2 text-xs text-muted-foreground">
                    {v.rule_name && <span>{v.rule_name}</span>}
                    <span className="flex items-center gap-1">
                      <Clock className="h-3 w-3" />
                      {timeAgo(v.created_at)}
                    </span>
                  </div>
                </div>
                {v.status === "pending" ? (
                  <div className="flex gap-1 ml-2 shrink-0">
                    <Button
                      size="sm"
                      variant="destructive"
                      disabled={resolveMutation.isPending}
                      onClick={() =>
                        resolveMutation.mutate({ id: v.id, action: "confirm" })
                      }
                    >
                      <Check className="h-3 w-3 mr-1" />
                      Ban
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={resolveMutation.isPending}
                      onClick={() =>
                        resolveMutation.mutate({ id: v.id, action: "dismiss" })
                      }
                    >
                      <X className="h-3 w-3 mr-1" />
                      Dismiss
                    </Button>
                  </div>
                ) : (
                  <Badge
                    variant={
                      v.status === "confirmed" ? "destructive" : "secondary"
                    }
                    className="ml-2 shrink-0"
                  >
                    {v.status}
                  </Badge>
                )}
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
