import { useState, useEffect, useRef } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useAdminApi, useApiUrl } from "@/hooks/useAdminApi";
import { ApiError } from "@/lib/adminApi";
import { useToast } from "@/hooks/useToast";
import { DeleteConfirmDialog } from "@/components/DeleteConfirmDialog";
import { UserActions } from "@/components/UserActions";
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
  ExternalLink,
  ShieldCheck,
  EyeOff,
  MessageSquareLock,
} from "lucide-react";
import { CopyableId } from "@/components/CopyableId";
import { UserIdentifier } from "@/components/UserIdentifier";
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

const ENFORCEMENT_STATES: AgeReviewState[] = [
  'restricted_pending_user_response',
  'restricted_pending_parental_consent',
  'restricted_pending_support_email',
  'cleared',
  'denied_closed',
];

export function AgeReviewDetail({ caseData: c }: Props) {
  const api = useAdminApi();
  const apiUrl = useApiUrl();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [resolutionNote, setResolutionNote] = useState(c.resolution_note ?? "");
  const pendingStateRef = useRef<string | undefined>();

  useEffect(() => {
    setResolutionNote(c.resolution_note ?? "");
  }, [c.id, c.resolution_note]);

  const isTerminal = TERMINAL_STATES.includes(c.state);
  const daysRemaining = getDaysRemaining(c);
  const claimLinkExpired = c.claim_link_expires_at != null && new Date(c.claim_link_expires_at).getTime() < Date.now();

  const updateCase = useMutation({
    mutationFn: (updates: Record<string, unknown>) => {
      pendingStateRef.current = updates.state as string | undefined;
      return api.updateAgeReviewCase(c.id, { ...updates, expected_version: c.version });
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ['age-review-cases'] });
      // Keep the per-case entry in step: the hand-off seeds
      // ['age-review-case', id] (30s staleTime), and a terminal action drops
      // the case from the active list, so the detail falls back to that
      // entry — left stale, it shows actionable controls with the old
      // expected_version (review). The PATCH returns the updated row; write
      // it through, or invalidate if a response ever omits it.
      if (data.case) {
        queryClient.setQueryData(['age-review-case', c.id], { success: true, case: data.case });
        // ...and the hand-off's lookup key: left stale, re-entering the
        // ?pubkey= hand-off within its cache lifetime re-seeds the per-case
        // entry with the pre-action ACTIVE row, resurrecting the exact hole
        // above. Terminal states have no active case; write that truth.
        queryClient.setQueryData(
          ['age-review-active-case', c.pubkey],
          { success: true, case: TERMINAL_STATES.includes(data.case.state) ? null : data.case },
        );
      } else {
        queryClient.invalidateQueries({ queryKey: ['age-review-case', c.id] });
        queryClient.removeQueries({ queryKey: ['age-review-active-case', c.pubkey] });
      }
      const requestedState = pendingStateRef.current as AgeReviewState | undefined;
      if (requestedState && ENFORCEMENT_STATES.includes(requestedState) && data.enforcementComplete === false) {
        // Surface only actual failed enforcement legs. `not_attempted` is valid
        // for transitions where a leg does not apply.
        const enforcement = data.enforcement;
        const failed: string[] = [];
        if (enforcement?.relay === 'failed') failed.push('relay (existing posts and feed)');
        if (enforcement?.bulk === 'failed') failed.push('media and content');
        if (enforcement?.keycast === 'failed') failed.push('account sign-in');
        toast({
          title: 'Enforcement incomplete',
          description: `Case updated, but these did not apply: ${failed.join(', ') || 'one or more enforcement steps'}. The user's content or account may still be reachable. Retry the action or escalate.`,
          variant: 'destructive',
        });
      }
    },
    onError: (error) => {
      // A concurrent writer (another moderator, or the deadline cron) changed
      // the case between our read and this write. Reload the current state so
      // the moderator can review it before re-applying; we deliberately do not
      // blindly replay a possibly-stale transition.
      if (error instanceof ApiError && error.code === 'version_conflict') {
        queryClient.invalidateQueries({ queryKey: ['age-review-cases'] });
        // The reload must also reach the per-case fallback the hand-off seeds
        queryClient.invalidateQueries({ queryKey: ['age-review-case', c.id] });
        // Remove (not invalidate) the lookup entry: the hand-off effect seeds
        // synchronously from cached data before any refetch could land
        queryClient.removeQueries({ queryKey: ['age-review-active-case', c.pubkey] });
        toast({
          title: 'Case changed since you opened it',
          description: 'Another moderator or an automated deadline action modified this case. Reloaded the latest state; review it and re-apply if still needed.',
          variant: 'destructive',
        });
      }
      // Other errors surface inline via updateCase.isError below.
    },
  });

  const { data: ageReviewConfig } = useQuery({
    queryKey: ['age-review-config'],
    queryFn: () => api.getAgeReviewConfig(),
  });

  // Keycast-backed protected-minor status (verified_minor). Best-effort: a
  // keycast blip resolves to success:false, so we show status unavailable.
  const { data: accountStatus, isError: accountStatusFailed } = useQuery({
    queryKey: ['account-status', apiUrl, c.pubkey],
    queryFn: () => api.getAccountStatus(c.pubkey),
    enabled: !!apiUrl && !!c.pubkey,
    staleTime: 60_000, // verified_minor is durable; avoid refetching per case reopen
  });
  const verifiedMinorAtDate = accountStatus?.verified_minor_at
    ? new Date(accountStatus.verified_minor_at)
    : null;
  const verifiedMinorAtLabel =
    verifiedMinorAtDate && !Number.isNaN(verifiedMinorAtDate.getTime())
      ? // UTC so every moderator sees the same approval date regardless of their
        // local timezone (a near-midnight-UTC timestamp would otherwise shift a day).
        verifiedMinorAtDate.toLocaleDateString(undefined, { timeZone: 'UTC' })
      : null;

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
            {accountStatus?.verified_minor ? (
              <>
                <Badge className="bg-emerald-600 text-white hover:bg-emerald-600">
                  Approved protected minor (13-15)
                </Badge>
                {verifiedMinorAtLabel ? (
                  <span className="text-xs text-muted-foreground">
                    approved {verifiedMinorAtLabel}
                  </span>
                ) : null}
              </>
            ) : accountStatusFailed || accountStatus?.success === false ? (
              // Couldn't determine (keycast down/misconfig) — don't let a blip
              // read the same as a confirmed non-minor; keep the safety signal.
              <span className="text-xs text-muted-foreground">
                protected-minor status unavailable
              </span>
            ) : null}
          </div>

          {/* Protections that apply to an approved protected minor (#143).
              POLICY-DERIVED from verified_minor: these are client-enforced
              (the relay can't attribute NIP-17 DMs, and the content lock is
              in-app), so there is no per-device signal to observe. We state
              what policy applies and who enforces it — never "confirmed on
              their device", which would be false assurance. */}
          {accountStatus?.verified_minor ? (
            <div className="rounded-md border p-2.5 space-y-2 text-xs">
              {/* Shipped protections only. A row under this heading is read as
                  protecting the teen TODAY, so nothing rollout-only may live
                  here regardless of caveats — the heading's claim wins. */}
              <div className="space-y-1.5">
                <h4 className="flex items-center gap-1.5 font-medium">
                  <ShieldCheck className="h-3.5 w-3.5 text-emerald-600" />
                  Protections that apply to this account
                </h4>
                <div className="flex items-start gap-1.5 text-muted-foreground">
                  <EyeOff className="h-3.5 w-3.5 mt-0.5 shrink-0" />
                  <span>
                    Adult content lock: adult content is hidden and the 18+ visibility toggle is disabled, so they cannot re-enable it.
                  </span>
                </div>
                <div className="text-muted-foreground/80">
                  Derived from the approved protected-minor status above; enforced client-side by the Divine apps on supported versions. Not confirmed per device.
                </div>
              </div>
              {/* TODO(divinevideo/support-trust-safety#176): move the DM
                  restriction into the applied section above (and remove this
                  one) once released mobile + web builds enforce it. Until
                  then it lives under an explicit not-yet heading so a
                  moderator can never mistake it for a live protection. */}
              <div className="space-y-1.5 border-t pt-2">
                <h4 className="flex items-center gap-1.5 font-medium text-muted-foreground">
                  <Clock className="h-3.5 w-3.5" />
                  Rolling out (not yet enforced by released apps)
                </h4>
                <div className="flex items-start gap-1.5 text-muted-foreground">
                  <MessageSquareLock className="h-3.5 w-3.5 mt-0.5 shrink-0" />
                  <span>
                    DM restriction: DMs limited to the pinned official accounts, Divine HQ (_@divinehq.divine.video) and Divine Moderation (moderation@divine.video); everything else is blocked on send and hidden on receive.
                  </span>
                </div>
              </div>
            </div>
          ) : null}

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
          <UserIdentifier
            pubkey={c.pubkey}
            variant="block"
            showAvatar={true}
            avatarSize="md"
            showCopyButton={false}
            showNip05={true}
            linkToProfile={true}
          />
          <div className="flex flex-wrap items-center gap-2">
            <CopyableId
              value={c.pubkey}
              type="hex"
              size="xs"
              label="Hex pubkey:"
              truncateStart={16}
              truncateEnd={8}
            />
            <a
              href={`/users/${c.pubkey}`}
              className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
            >
              <ExternalLink className="h-3 w-3" />
              View in Users tab
            </a>
          </div>
          {c.reporter_pubkey && (
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <span>Reported by:</span>
              <UserIdentifier
                pubkey={c.reporter_pubkey}
                variant="compact"
                showAvatar={false}
                linkToProfile={false}
                copyOnClick={false}
              />
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
                {ageReviewConfig?.auto_delete_on_deny ? (
                  <DeleteConfirmDialog
                    trigger={
                      <Button size="sm" variant="destructive" className="h-7 text-xs" disabled={updateCase.isPending}>
                        <XCircle className="h-3 w-3 mr-1" />
                        Deny &amp; Delete
                      </Button>
                    }
                    title="Deny & Delete Content"
                    summary="Denying this case will permanently delete all events and media for this user. This cannot be undone."
                    onConfirm={async () => {
                      await updateCase.mutateAsync({
                        state: 'denied_closed',
                        resolution_note: resolutionNote || undefined,
                      });
                    }}
                    isPending={updateCase.isPending}
                  />
                ) : (
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
                )}
              </div>

              {updateCase.isPending && (
                <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  <Loader2 className="h-3 w-3 animate-spin" />
                  Updating...
                </div>
              )}
              {updateCase.isError && !(updateCase.error instanceof ApiError && updateCase.error.code === 'version_conflict') && (
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
              {c.created_via === 'minor_onboarding' && (
                <Badge className="bg-emerald-100 text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-400 text-[10px]">
                  Minor Onboarding
                </Badge>
              )}
              {c.created_via === 'minor_onboarding' && c.claim_link_url && (
                <div className="space-y-1.5 pt-1">
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-medium text-muted-foreground">Claim Link</span>
                    {claimLinkExpired && (
                      <Badge className="bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-400 text-[10px] gap-1">
                        <AlertTriangle className="h-3 w-3" />
                        Expired
                      </Badge>
                    )}
                  </div>
                  <CopyableId value={c.claim_link_url} type="url" size="xs" truncateStart={32} truncateEnd={12} />
                  <div className="text-xs text-muted-foreground">
                    Expires: {c.claim_link_expires_at ? new Date(c.claim_link_expires_at).toLocaleDateString() : 'N/A'}
                  </div>
                </div>
              )}
              {c.resolution_note.startsWith('Auto-cleared:') && (
                <Badge className="bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-400 text-[10px]">
                  Auto-cleared
                </Badge>
              )}
              <p className="text-sm">{c.resolution_note}</p>
            </div>
          </>
        )}

        {isTerminal && c.state === 'denied_closed' && !ageReviewConfig?.auto_delete_on_deny && (
          <div className="border-t pt-4 mt-4">
            <p className="text-xs text-muted-foreground mb-2">Auto-delete is disabled. You can manually delete content:</p>
            <UserActions
              pubkey={c.pubkey}
              context="age-review"
              onActionComplete={() => queryClient.invalidateQueries({ queryKey: ['age-review-cases'] })}
            />
          </div>
        )}

      </div>
    </ScrollArea>
  );
}
