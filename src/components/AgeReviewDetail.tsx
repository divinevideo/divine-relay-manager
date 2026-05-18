import { useState, useEffect } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useAdminApi } from "@/hooks/useAdminApi";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Separator } from "@/components/ui/separator";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Clock,
  Play,
  Pause,
  CheckCircle,
  XCircle,
  AlertTriangle,
  Loader2,
  Copy,
  Check,
  ExternalLink,
} from "lucide-react";
import { nip19 } from "nostr-tools";
import {
  AGE_BANDS,
  TERMINAL_STATES,
  getDaysRemaining,
  type AgeReviewCase,
  type AgeReviewState,
  type AgeBand,
} from "../../shared/age-review";

const STATE_LABELS: Record<AgeReviewState, string> = {
  open_reported: "Open — Reported",
  under_moderator_review: "Under Moderator Review",
  restricted_pending_user_response: "Restricted — Pending User Response",
  restricted_pending_parental_consent: "Restricted — Pending Parental Consent",
  restricted_pending_support_email: "Restricted — Pending Support Email",
  submitted_for_review: "Submitted for Review",
  needs_follow_up: "Needs Follow-up",
  cleared: "Cleared",
  denied_closed: "Denied — Closed",
};

const BAND_LABELS: Record<AgeBand, string> = {
  under_13: "Under 13",
  age_13_15: "Age 13–15",
  age_16_plus_claimed: "16+ (Claimed)",
};

function getRestrictionStateForBand(band: AgeBand): AgeReviewState {
  switch (band) {
    case 'under_13':
    case 'age_16_plus_claimed':
      return 'restricted_pending_support_email';
    case 'age_13_15':
      return 'restricted_pending_user_response';
  }
}

function stateColor(state: AgeReviewState): string {
  if (state === 'cleared') return 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400';
  if (state === 'denied_closed') return 'bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-400';
  if (state.startsWith('restricted_')) return 'bg-orange-100 text-orange-800 dark:bg-orange-900/30 dark:text-orange-400';
  if (state === 'needs_follow_up') return 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900/30 dark:text-yellow-400';
  return 'bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-400';
}

function bandColor(band: AgeBand): string {
  if (band === 'under_13') return 'bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-400';
  if (band === 'age_13_15') return 'bg-orange-100 text-orange-800 dark:bg-orange-900/30 dark:text-orange-400';
  return 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900/30 dark:text-yellow-400';
}

interface Props {
  caseData: AgeReviewCase;
}

export function AgeReviewDetail({ caseData: c }: Props) {
  const api = useAdminApi();
  const queryClient = useQueryClient();
  const [resolutionNote, setResolutionNote] = useState(c.resolution_note ?? "");
  const [copiedField, setCopiedField] = useState<string | null>(null);

  useEffect(() => {
    setResolutionNote(c.resolution_note ?? "");
  }, [c.id, c.resolution_note]);

  const isTerminal = TERMINAL_STATES.includes(c.state);
  const daysRemaining = getDaysRemaining(c);

  const updateCase = useMutation({
    mutationFn: (updates: Record<string, unknown>) =>
      api.updateAgeReviewCase(c.id, updates),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['age-review-cases'] });
    },
  });

  const copyToClipboard = (text: string, field: string) => {
    navigator.clipboard.writeText(text);
    setCopiedField(field);
    setTimeout(() => setCopiedField(null), 2000);
  };

  const npub = nip19.npubEncode(c.pubkey);

  return (
    <ScrollArea className="h-full">
      <div className="space-y-4 p-4">
        {/* Header */}
        <div className="space-y-2">
          <div className="flex items-center gap-2 flex-wrap">
            <Badge className={stateColor(c.state)}>{STATE_LABELS[c.state]}</Badge>
            <Badge className={bandColor(c.suspected_age_band)}>{BAND_LABELS[c.suspected_age_band]}</Badge>
            {c.clock_paused ? (
              <Badge variant="outline" className="gap-1">
                <Pause className="h-3 w-3" /> Clock Paused
              </Badge>
            ) : null}
          </div>

          {/* Deadline */}
          {!isTerminal && daysRemaining != null && (
            <div className={`flex items-center gap-1.5 text-sm ${
              daysRemaining <= 2 ? 'text-red-600 font-medium' : 'text-muted-foreground'
            }`}>
              <Clock className="h-3.5 w-3.5" />
              {daysRemaining <= 0
                ? "Deadline expired"
                : `${Math.ceil(daysRemaining)} day${Math.ceil(daysRemaining) !== 1 ? 's' : ''} remaining`}
            </div>
          )}
        </div>

        <Separator />

        {/* Identity */}
        <div className="space-y-1.5">
          <h4 className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Flagged User</h4>
          <div className="flex items-center gap-1.5">
            <code className="text-xs bg-muted px-1.5 py-0.5 rounded font-mono break-all">{npub}</code>
            <button
              onClick={() => copyToClipboard(c.pubkey, 'pubkey')}
              className="text-muted-foreground hover:text-foreground"
              title="Copy hex pubkey"
            >
              {copiedField === 'pubkey' ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
            </button>
            <a
              href={`/users/${c.pubkey}`}
              className="text-muted-foreground hover:text-foreground"
              title="View in Users tab"
            >
              <ExternalLink className="h-3 w-3" />
            </a>
          </div>
          {c.reporter_pubkey && (
            <div className="text-xs text-muted-foreground">
              Reported by: <code className="bg-muted px-1 py-0.5 rounded font-mono break-all">{c.reporter_pubkey}</code>
            </div>
          )}
          {c.parent_contact_email && (
            <div className="text-xs text-muted-foreground">
              Parent email: <span className="font-medium">{c.parent_contact_email}</span>
            </div>
          )}
        </div>

        <Separator />

        {/* Timestamps */}
        <div className="grid grid-cols-2 gap-2 text-xs">
          <div>
            <span className="text-muted-foreground">Created:</span>{" "}
            {new Date(c.created_at).toLocaleDateString()}
          </div>
          <div>
            <span className="text-muted-foreground">Updated:</span>{" "}
            {new Date(c.updated_at).toLocaleDateString()}
          </div>
          {c.deadline_at && (
            <div>
              <span className="text-muted-foreground">Deadline:</span>{" "}
              {new Date(c.deadline_at).toLocaleDateString()}
            </div>
          )}
          {c.report_id && (
            <div>
              <span className="text-muted-foreground">Report:</span>{" "}
              <code className="bg-muted px-1 rounded font-mono break-all">{c.report_id}</code>
            </div>
          )}
        </div>

        {!isTerminal && (
          <>
            <Separator />

            {/* Moderator Actions */}
            <div className="space-y-3">
              <h4 className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Actions</h4>

              {/* State transitions */}
              <div className="flex flex-wrap gap-2">
                {c.state === 'open_reported' && (
                  <Button
                    size="sm"
                    className="h-7 text-xs"
                    disabled={updateCase.isPending}
                    onClick={() => updateCase.mutate({ state: 'under_moderator_review' })}
                  >
                    <Play className="h-3 w-3 mr-1" />
                    Begin Review
                  </Button>
                )}
                {c.state === 'under_moderator_review' && (
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-7 text-xs"
                    disabled={updateCase.isPending}
                    onClick={() => updateCase.mutate({
                      state: getRestrictionStateForBand(c.suspected_age_band),
                    })}
                  >
                    <AlertTriangle className="h-3 w-3 mr-1" />
                    Restrict Account
                  </Button>
                )}
                {c.state === 'submitted_for_review' && (
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-7 text-xs"
                    disabled={updateCase.isPending}
                    onClick={() => updateCase.mutate({ state: 'under_moderator_review' })}
                  >
                    Re-review
                  </Button>
                )}

                {/* Clock controls */}
                {!c.clock_paused ? (
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-7 text-xs"
                    disabled={updateCase.isPending}
                    onClick={() => updateCase.mutate({ clock_paused: true })}
                  >
                    <Pause className="h-3 w-3 mr-1" />
                    Pause Clock
                  </Button>
                ) : (
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-7 text-xs"
                    disabled={updateCase.isPending}
                    onClick={() => updateCase.mutate({ clock_paused: false })}
                  >
                    <Play className="h-3 w-3 mr-1" />
                    Resume Clock
                  </Button>
                )}
              </div>

              {/* Age band change */}
              <div className="flex items-center gap-2">
                <span className="text-xs text-muted-foreground">Age band:</span>
                <Select
                  value={c.suspected_age_band}
                  onValueChange={(val) => updateCase.mutate({ suspected_age_band: val })}
                  disabled={updateCase.isPending}
                >
                  <SelectTrigger className="h-7 w-40 text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {AGE_BANDS.map((band) => (
                      <SelectItem key={band} value={band} className="text-xs">
                        {BAND_LABELS[band]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              {/* Resolution note */}
              <div className="space-y-1.5">
                <Textarea
                  placeholder="Resolution note..."
                  value={resolutionNote}
                  onChange={(e) => setResolutionNote(e.target.value)}
                  rows={2}
                  className="text-xs"
                />
              </div>

              {/* Terminal actions */}
              <div className="flex gap-2 pt-1">
                <Button
                  size="sm"
                  variant="default"
                  className="h-7 text-xs bg-green-600 hover:bg-green-700"
                  disabled={updateCase.isPending}
                  onClick={() => updateCase.mutate({
                    state: 'cleared',
                    resolution_note: resolutionNote || undefined,
                  })}
                >
                  <CheckCircle className="h-3 w-3 mr-1" />
                  Clear
                </Button>
                <Button
                  size="sm"
                  variant="destructive"
                  className="h-7 text-xs"
                  disabled={updateCase.isPending}
                  onClick={() => updateCase.mutate({
                    state: 'denied_closed',
                    resolution_note: resolutionNote || undefined,
                  })}
                >
                  <XCircle className="h-3 w-3 mr-1" />
                  Deny &amp; Close
                </Button>
              </div>

              {updateCase.isPending && (
                <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  <Loader2 className="h-3 w-3 animate-spin" />
                  Updating...
                </div>
              )}
              {updateCase.isError && (
                <div className="text-xs text-red-600">
                  Failed to update: {(updateCase.error as Error).message}
                </div>
              )}
            </div>
          </>
        )}

        {isTerminal && c.resolution_note && (
          <>
            <Separator />
            <div className="space-y-1">
              <h4 className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Resolution</h4>
              <p className="text-sm">{c.resolution_note}</p>
            </div>
          </>
        )}

      </div>
    </ScrollArea>
  );
}
