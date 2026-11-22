// ABOUTME: User management interface for banning, suspending, and allowing users on the relay
// ABOUTME: Includes verification to confirm NIP-86 actions succeeded and D1 audit logging

import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Skeleton } from "@/components/ui/skeleton";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { useToast } from "@/hooks/useToast";
import { UserX, UserCheck, Plus, Users, Trash2, User, X, Pause, Play, CalendarClock } from "lucide-react";
import { BannedUserCard } from "@/components/BannedUserCard";
import { nip19 } from "nostr-tools";
import { useAdminApi } from "@/hooks/useAdminApi";
import { useAgeReviewGuardRedirect } from "@/hooks/useAgeReviewGuardRedirect";
import { UserActions } from "@/components/UserActions";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { UserDisplayName } from "@/components/UserIdentifier";
import { CopyableId } from "@/components/CopyableId";
import { banFailureToast, banSuccessNote, refreshAfterUnconfirmedBan } from "@/lib/banFeedback";
import { markRestored, resetAccountContentReads, runHidingAction, useRestoreEnvironment } from "@/lib/userStatsCache";
import { ApiError, isSuspensionChanged, type BannedPubkeyEntry } from "@/lib/adminApi";
import { unbanAuditFailedToast, unbanOutcomeToast } from "@/lib/unbanOutcomeToast";
import { TIMED_SUSPENSIONS_KEY, useTimedSuspension, useTimedSuspensions } from "@/hooks/useTimedSuspensions";
import { useChangeSuspensionEnd } from "@/hooks/useChangeSuspensionEnd";
import { SuspensionEndLine } from "@/components/SuspensionEndLine";
import { SuspensionDurationDialog } from "@/components/SuspensionDurationDialog";
import { UnbanSuspensionDialog } from "@/components/UnbanSuspensionDialog";
import { canonicalHex64 } from "../../shared/hex-id";
import type { UnbanSuspensionChoice } from "../../shared/suspension";

interface UserManagementProps {
  selectedPubkey?: string;
}

interface BannedUser {
  pubkey: string;
  reason?: string;
}

interface AllowedUser {
  pubkey: string;
  reason?: string;
}

export function UserManagement({ selectedPubkey }: UserManagementProps) {
  const { toast } = useToast();
  const redirectIfGuarded = useAgeReviewGuardRedirect();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const api = useAdminApi();
  const { callRelayRpc, verifyPubkeyBanned, verifyPubkeyUnbanned } = api;
  const { getModeratorToken } = useCurrentUser();
  const restoreEnvironment = useRestoreEnvironment();
  const [newPubkey, setNewPubkey] = useState("");
  const [newReason, setNewReason] = useState("");
  const [isAddDialogOpen, setIsAddDialogOpen] = useState(false);
  const [actionType, setActionType] = useState<'ban' | 'allow'>('ban');

  // Clear selected pubkey from URL
  const clearSelectedPubkey = () => {
    navigate('/users', { replace: true });
  };

  // Helper to invalidate all user-related query caches
  const invalidateUserQueries = () => {
    queryClient.invalidateQueries({ queryKey: ['banned-users'] });
    queryClient.invalidateQueries({ queryKey: ['banned-pubkeys'] });
    queryClient.invalidateQueries({ queryKey: ['allowed-users'] });
    queryClient.invalidateQueries({ queryKey: ['suspended-users'] });
    queryClient.invalidateQueries({ queryKey: ['suspended-pubkeys'] });
    // Reset, not invalidate: after an action the timers on screen may be out of
    // date, and if the re-read fails the old end must not stay as if current;
    // the end line then says the end is unavailable.
    void queryClient.resetQueries({ queryKey: TIMED_SUSPENSIONS_KEY });
  };

  // After an account action, the acted-on account's authored-content reads
  // describe the other state: the relay hides a banned or suspended account's
  // content (lib/userStatsCache). Each mutation below handles that inside its
  // mutationFn, right after the relay call, so a failed audit write (awaited
  // after it) cannot skip it. A ban resets whatever the call did: one whose
  // confirmation failed may still have landed, and a reset after a failed call
  // only costs a re-read. A ban that landed also ends a restore window an
  // earlier unsuspend left open (markHidden). Unsuspend opens the restore
  // window only once the call succeeded: after a failed one the account is
  // still hidden, and "just restored" would be wrong. Unban and allow only reset
  // the reads: a ban usually purged the posts, so "posts can take a few minutes
  // to reappear" would mislead. The selected user's UserActions does the same
  // for its own actions.

  // Query for banned users
  const { data: bannedUsers, isLoading: loadingBanned, error: bannedError } = useQuery({
    queryKey: ['banned-users'],
    queryFn: () => callRelayRpc<BannedPubkeyEntry[]>('listbannedpubkeys'),
  });

  // Query for allowed users
  const { data: allowedUsers, isLoading: loadingAllowed, error: allowedError } = useQuery({
    queryKey: ['allowed-users'],
    queryFn: () => callRelayRpc<BannedPubkeyEntry[]>('listallowedpubkeys'),
  });

  // Query for suspended users
  const { data: suspendedUsers, isLoading: loadingSuspended, error: suspendedError } = useQuery({
    queryKey: ['suspended-users'],
    queryFn: () => callRelayRpc<BannedPubkeyEntry[]>('listsuspendedpubkeys'),
  });

  // Mutation for banning users
  const banUserMutation = useMutation({
    mutationFn: async ({ pubkey, reason }: { pubkey: string; reason?: string }) => {
      const act = api.asModerator(getModeratorToken()); // take the login at the click
      const env = restoreEnvironment; // the environment the action ran in
      const outcome = await runHidingAction(queryClient, pubkey, env, () => act.banPubkey(pubkey, reason || 'Account banned by moderator'));
      // Log to D1 for audit trail. The ban has already landed, so a failed write
      // must not fail the mutation: that would read as "Failed to ban user" and
      // invite a retry of an applied ban.
      let auditRecorded = true;
      try {
        await act.logDecision({
          targetType: 'pubkey',
          targetId: pubkey,
          action: 'ban_user',
          reason: reason || 'Banned via User Management',
        });
      } catch (e) {
        console.warn('[UserManagement] audit log failed', e);
        auditRecorded = false;
      }
      return { pubkey, outcome, auditRecorded };
    },
    onSuccess: async ({ pubkey, outcome, auditRecorded }) => {
      invalidateUserQueries();
      toast({
        title: auditRecorded ? "User banned successfully" : "User banned; audit log not recorded",
        description: banSuccessNote(outcome),
      });
      setIsAddDialogOpen(false);
      setNewPubkey("");
      setNewReason("");

      // Background verification for debugging - don't show warnings to user
      // RPC success means relay accepted the command
      verifyPubkeyBanned(pubkey).then(verified => {
        if (!verified) {
          console.warn('[UserManagement] Ban verification failed for', pubkey, '- relay may have async processing');
        }
      });
    },
    onError: (error: Error) => {
      refreshAfterUnconfirmedBan(error, queryClient);
      toast(banFailureToast(error));
    },
  });

  // Mutation for allowing users
  const allowUserMutation = useMutation({
    mutationFn: async ({ pubkey, reason }: { pubkey: string; reason?: string }) => {
      const act = api.asModerator(getModeratorToken()); // take the login at the click
      await act.callRelayRpc('unbanpubkey', [pubkey, reason]);
      // A ban usually purged the posts, so no restore window: reset only.
      void resetAccountContentReads(queryClient, pubkey);
      // Log to D1 for audit trail
      await act.logDecision({
        targetType: 'pubkey',
        targetId: pubkey,
        action: 'allow_user',
        reason: reason || 'Allowed via User Management',
      });
      return pubkey;
    },
    onSuccess: () => {
      invalidateUserQueries();
      toast({ title: "User allowed successfully" });
      setIsAddDialogOpen(false);
      setNewPubkey("");
      setNewReason("");
    },
    onError: (error: Error, variables: { pubkey: string; reason?: string }) => {
      // allow_user calls unbanpubkey, so it hits the same guard as unban below.
      if (redirectIfGuarded(error, variables.pubkey)) return;
      toast({
        title: "Failed to allow user",
        description: error.message,
        variant: "destructive"
      });
    },
  });

  const handleAddUser = () => {
    const raw = newPubkey.trim();
    if (!raw) {
      toast({
        title: "Invalid input",
        description: "Please enter a valid pubkey or npub",
        variant: "destructive"
      });
      return;
    }

    // Convert npub to hex if needed
    let hexPubkey = raw;
    if (raw.startsWith('npub1')) {
      try {
        const decoded = nip19.decode(raw);
        if (decoded.type !== 'npub') {
          toast({ title: "Invalid npub", description: "Could not decode npub", variant: "destructive" });
          return;
        }
        hexPubkey = decoded.data;
      } catch {
        toast({ title: "Invalid npub", description: "Could not decode npub — check the value and try again", variant: "destructive" });
        return;
      }
    } else if (!/^[0-9a-f]{64}$/i.test(raw)) {
      toast({ title: "Invalid pubkey", description: "Enter a 64-character hex pubkey or an npub", variant: "destructive" });
      return;
    } else {
      // Accepted case-insensitively above (people paste from anywhere), but
      // canonicalised here: every consumer matches these bytes exactly. The
      // relay's ban/suspend lists are case-sensitive, so an uppercase value
      // bans nobody while reporting success, and the age-review guard's lookup
      // would miss a real open case for the same reason.
      hexPubkey = raw.toLowerCase();
    }

    if (actionType === 'ban') {
      banUserMutation.mutate({ pubkey: hexPubkey, reason: newReason.trim() || undefined });
    } else {
      allowUserMutation.mutate({ pubkey: hexPubkey, reason: newReason.trim() || undefined });
    }
  };

  // The unban prompt's opening on screen, or null (kept in step below). A refusal is left
  // to the prompt only while the opening that sent it still shows: a closed prompt is
  // unmounted, and the Banned tab can open another account's prompt while an unban is
  // pending, so neither can say why nothing happened.
  const unbanOpenings = useRef(0);
  const unbanPromptShown = useRef<number | null>(null);
  // Mutation for unbanning users. `choice` is what happens to a timed
  // suspension; with none the body carries no choice and the worker keeps its
  // default (resume). `version` is the timer version the prompt showed, so the
  // worker can refuse a choice made against an older read (null: no timer
  // shown; undefined: nothing to compare). `opening` is the prompt that sent it.
  const unbanUserMutation = useMutation({
    mutationFn: async ({ pubkey, choice, version }: { pubkey: string; choice?: UnbanSuspensionChoice; version?: number | null; opening?: number }) => {
      const act = api.asModerator(getModeratorToken()); // take the login at the click
      const outcome = choice === undefined ? await act.unbanPubkey(pubkey)
        : version === undefined ? await act.unbanPubkey(pubkey, choice)
          : await act.unbanPubkey(pubkey, choice, version);
      // A ban usually purged the posts, so no restore window: reset only.
      void resetAccountContentReads(queryClient, pubkey);
      // The unban has landed, so a failed audit write must not fail the
      // mutation: that would read as "Failed to unban user" and hide what
      // became of the suspension (an end_failed most of all).
      let auditRecorded = true;
      try {
        await act.logDecision({
          targetType: 'pubkey',
          targetId: pubkey,
          action: 'unban_user',
          reason: 'Unbanned via User Management',
        });
      } catch (e) {
        console.warn('[UserManagement] audit log failed', e);
        auditRecorded = false;
      }
      return { pubkey, outcome, auditRecorded };
    },
    onSuccess: async ({ pubkey, outcome, auditRecorded }) => {
      invalidateUserQueries();
      // One toast (the app shows one at a time): a missing audit row carries
      // the outcome, so neither is lost, and a failure keeps its title and
      // severity (G4).
      // The switch from the cached timers list; false when unknown.
      const opts = { autoLift: unbanTimer.autoLift };
      toast(auditRecorded ? unbanOutcomeToast(outcome, opts) : unbanAuditFailedToast(outcome, opts));

      // Background verification
      verifyPubkeyUnbanned(pubkey).then(verified => {
        if (!verified) {
          console.warn('[UserManagement] Unban verification failed for', pubkey, '- relay may have async processing');
        }
      });
    },
    onError: async (error: Error, variables: { pubkey: string; choice?: UnbanSuspensionChoice; version?: number | null; opening?: number }) => {
      if (redirectIfGuarded(error, variables.pubkey)) return;
      // The timer moved since the prompt read it and nothing was done: read it again, and
      // the prompt, if still open, says why and asks against the current end.
      // Awaited: the mutation stays pending (Confirm disabled) until the re-read settles. A
      // failed re-read shows the end as unavailable, and the next confirm sends no version.
      // A prompt closed before then can say nothing, so the toast below does (still banned).
      if (isSuspensionChanged(error)) {
        await queryClient.invalidateQueries({ queryKey: TIMED_SUSPENSIONS_KEY });
        if (variables.opening !== undefined && unbanPromptShown.current === variables.opening) return;
      }
      toast({
        title: "Failed to unban user",
        description: error.message,
        variant: "destructive"
      });
    },
  });

  const unsuspendUserMutation = useMutation({
    mutationFn: async ({ pubkey }: { pubkey: string }) => {
      const act = api.asModerator(getModeratorToken()); // take the login at the click
      const env = restoreEnvironment; // captured before the call
      await act.unsuspendPubkey(pubkey);
      void markRestored(queryClient, pubkey, env);
      await act.logDecision({
        targetType: 'pubkey',
        targetId: pubkey,
        action: 'unsuspend_user',
        reason: 'Unsuspended via User Management',
      });
      return pubkey;
    },
    onSuccess: () => {
      invalidateUserQueries();
      toast({ title: "User unsuspended successfully" });
    },
    onError: (error: Error, variables: { pubkey: string }) => {
      if (redirectIfGuarded(error, variables.pubkey)) return;
      toast({
        title: "Failed to unsuspend user",
        description: error.message,
        variant: "destructive"
      });
    },
  });

  // F14: the relay's lists may spell a pubkey in either case.
  const listHas = (list: BannedPubkeyEntry[] | undefined, pubkey: string) => {
    const target = pubkey.toLowerCase();
    return !!list?.some((u) => typeof u?.pubkey === 'string' && u.pubkey.toLowerCase() === target);
  };

  // The Banned tab's unban asks what happens to a suspension unless the
  // suspended list has answered without this account (F6). While the list is
  // loading, or after it failed (even over an older copy), nobody knows, so it
  // asks: failing toward asking, as UserActions does with isSuspended !== false.
  // The target outlives the close, so the prompt's options don't change while
  // it animates out; `open` is separate.
  const [unbanDialog, setUnbanDialog] = useState<{ pubkey: string; open: boolean; opening: number } | null>(null);
  useEffect(() => {
    unbanPromptShown.current = unbanDialog?.open ? unbanDialog.opening : null;
    return () => { unbanPromptShown.current = null; };
  }, [unbanDialog]);
  const unbanTimer = useTimedSuspension(unbanDialog?.pubkey);
  // An answer is a list that loaded and whose latest read did not fail: a
  // failed refresh keeps an older copy that may predate a suspend.
  const suspendedListAnswered = suspendedUsers !== undefined && !suspendedError;
  const bannedListAnswered = bannedUsers !== undefined && !bannedError;
  const suspendedListAnsweredWithout = (pubkey: string) =>
    suspendedListAnswered && !listHas(suspendedUsers, pubkey);
  // Read the timers ahead whenever a banned account may be suspended, so the
  // prompt can usually name the end when it opens rather than start unknown.
  useTimedSuspensions({ enabled: !!bannedUsers?.some((u: BannedUser) => !suspendedListAnsweredWithout(u.pubkey)) });

  // Suspended-tab Change end date, for one account at a time. Like the prompt,
  // the target outlives the close so its Currently line stays while it animates out.
  const changeEnd = useChangeSuspensionEnd();
  const [changeEndDialog, setChangeEndDialog] = useState<{ pubkey: string; open: boolean } | null>(null);
  const changeEndTimer = useTimedSuspension(changeEndDialog?.pubkey);

  const handleRemoveUser = async (pubkey: string, type: 'ban' | 'allow' | 'suspend') => {
    if (type === 'ban') {
      if (suspendedListAnsweredWithout(pubkey)) unbanUserMutation.mutate({ pubkey });
      else setUnbanDialog({ pubkey, open: true, opening: ++unbanOpenings.current });
    } else if (type === 'suspend') {
      unsuspendUserMutation.mutate({ pubkey });
    } else {
      toast({
        title: "Not yet supported",
        description: "Removing from allow list requires an RPC method which is not defined in NIP-86",
        variant: "destructive"
      });
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold">User Management</h2>
          <p className="text-muted-foreground">Manage banned, suspended, and allowed users on your relay</p>
        </div>
        <Dialog open={isAddDialogOpen} onOpenChange={setIsAddDialogOpen}>
          <DialogTrigger asChild>
            <Button>
              <Plus className="h-4 w-4 mr-2" />
              Add User
            </Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Add User</DialogTitle>
              <DialogDescription>
                Add a user to the ban list or allow list
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-4">
              <div>
                <Label>Action</Label>
                <div className="flex space-x-2 mt-1">
                  <Button
                    variant={actionType === 'ban' ? 'default' : 'outline'}
                    size="sm"
                    onClick={() => setActionType('ban')}
                  >
                    <UserX className="h-4 w-4 mr-1" />
                    Ban
                  </Button>
                  <Button
                    variant={actionType === 'allow' ? 'default' : 'outline'}
                    size="sm"
                    onClick={() => setActionType('allow')}
                  >
                    <UserCheck className="h-4 w-4 mr-1" />
                    Allow
                  </Button>
                </div>
              </div>
              <div>
                <Label htmlFor="pubkey">Public Key</Label>
                <Input
                  id="pubkey"
                  value={newPubkey}
                  onChange={(e) => setNewPubkey(e.target.value)}
                  placeholder="hex pubkey or npub1..."
                  className="mt-1"
                />
              </div>
              <div>
                <Label htmlFor="reason">Reason (optional)</Label>
                <Textarea
                  id="reason"
                  value={newReason}
                  onChange={(e) => setNewReason(e.target.value)}
                  placeholder="Enter reason for this action"
                  className="mt-1"
                />
              </div>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setIsAddDialogOpen(false)}>
                Cancel
              </Button>
              <Button 
                onClick={handleAddUser}
                disabled={banUserMutation.isPending || allowUserMutation.isPending}
              >
                {actionType === 'ban' ? 'Ban User' : 'Allow User'}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>

      {/* Selected User from Deep Link */}
      {selectedPubkey && (
        <Card className="border-primary/50 bg-primary/5">
          <CardHeader className="pb-3">
            <div className="flex items-center justify-between">
              <CardTitle className="flex items-center gap-2 text-lg">
                <User className="h-5 w-5" />
                Selected User
              </CardTitle>
              <Button variant="ghost" size="sm" onClick={clearSelectedPubkey} className="h-8 w-8 p-0">
                <X className="h-4 w-4" />
              </Button>
            </div>
          </CardHeader>
          <CardContent className="space-y-3">
            <div>
              <div className="font-medium"><UserDisplayName pubkey={selectedPubkey} fallbackLength={16} linkToProfile /></div>
              <CopyableId value={selectedPubkey} type="npub" truncateStart={12} truncateEnd={8} size="xs" />
            </div>
            <div className="flex items-center gap-2 text-sm">
              {bannedUsers?.some((u: BannedUser) => u.pubkey === selectedPubkey) ? (
                <span className="flex items-center gap-1 text-red-600"><UserX className="h-4 w-4" />Banned</span>
              ) : suspendedUsers?.some((u: BannedPubkeyEntry) => u.pubkey === selectedPubkey) ? (
                <span className="flex items-center gap-1 text-amber-600"><Pause className="h-4 w-4" />Suspended</span>
              ) : allowedUsers?.some((u: AllowedUser) => u.pubkey === selectedPubkey) ? (
                <span className="flex items-center gap-1 text-green-600"><UserCheck className="h-4 w-4" />Allowed</span>
              ) : (
                <span className="text-muted-foreground">No restrictions</span>
              )}
            </div>
            {!allowedUsers?.some((u: AllowedUser) => u.pubkey === selectedPubkey) && (
              <Button variant="outline" size="sm" onClick={() => allowUserMutation.mutate({ pubkey: selectedPubkey })} disabled={allowUserMutation.isPending}>
                <UserCheck className="h-4 w-4 mr-1" />Allow
              </Button>
            )}
            <UserActions
              pubkey={selectedPubkey}
              context="users"
              // Each is null while its list has not answered (loading, failed,
              // or a failed refresh over an older copy), never a guessed false:
              // UserActions then says so, and its unban asks (F6).
              isBanned={bannedListAnswered ? listHas(bannedUsers, selectedPubkey) : null}
              isSuspended={suspendedListAnswered ? listHas(suspendedUsers, selectedPubkey) : null}
              statusPending={loadingSuspended || loadingBanned}
              onActionComplete={invalidateUserQueries}
            />
          </CardContent>
        </Card>
      )}

      <Tabs defaultValue="banned" className="space-y-4">
        <TabsList>
          <TabsTrigger value="banned" className="flex items-center space-x-2">
            <UserX className="h-4 w-4" />
            <span>Banned Users</span>
          </TabsTrigger>
          <TabsTrigger value="suspended" className="flex items-center space-x-2">
            <Pause className="h-4 w-4" />
            <span>Suspended Users</span>
          </TabsTrigger>
          <TabsTrigger value="allowed" className="flex items-center space-x-2">
            <UserCheck className="h-4 w-4" />
            <span>Allowed Users</span>
          </TabsTrigger>
        </TabsList>

        <TabsContent value="banned">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center space-x-2">
                <UserX className="h-5 w-5" />
                <span>Banned Users</span>
              </CardTitle>
              <CardDescription>
                Users who are banned from posting to this relay
              </CardDescription>
            </CardHeader>
            <CardContent>
              {loadingBanned ? (
                <div className="space-y-3">
                  {[...Array(3)].map((_, i) => (
                    <div key={i} className="flex items-center justify-between p-3 border rounded-lg">
                      <div className="space-y-2">
                        <Skeleton className="h-4 w-64" />
                        <Skeleton className="h-3 w-48" />
                      </div>
                      <Skeleton className="h-8 w-20" />
                    </div>
                  ))}
                </div>
              ) : bannedError ? (
                <Alert>
                  <AlertDescription>
                    Failed to load banned users: {bannedError.message}
                  </AlertDescription>
                </Alert>
              ) : !bannedUsers || bannedUsers.length === 0 ? (
                <div className="text-center py-8 text-muted-foreground">
                  <Users className="h-12 w-12 mx-auto mb-4 opacity-50" />
                  <p>No banned users</p>
                </div>
              ) : (
                <div className="space-y-3">
                  {bannedUsers.map((user: BannedUser, index: number) => (
                    <BannedUserCard
                      key={index}
                      pubkey={user.pubkey}
                      reason={user.reason}
                      onUnban={() => handleRemoveUser(user.pubkey, 'ban')}
                    />
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="suspended">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center space-x-2">
                <Pause className="h-5 w-5" />
                <span>Suspended Users</span>
              </CardTitle>
              <CardDescription>
                Users whose content is hidden but not deleted. Suspension can be reversed.
              </CardDescription>
            </CardHeader>
            <CardContent>
              {loadingSuspended ? (
                <div className="space-y-3">
                  {[...Array(3)].map((_, i) => (
                    <div key={i} className="flex items-center justify-between p-3 border rounded-lg">
                      <div className="space-y-2">
                        <Skeleton className="h-4 w-64" />
                        <Skeleton className="h-3 w-48" />
                      </div>
                      <Skeleton className="h-8 w-20" />
                    </div>
                  ))}
                </div>
              ) : suspendedError ? (
                <Alert>
                  <AlertDescription>
                    Failed to load suspended users: {suspendedError.message}
                  </AlertDescription>
                </Alert>
              ) : !suspendedUsers || suspendedUsers.length === 0 ? (
                <div className="text-center py-8 text-muted-foreground">
                  <Users className="h-12 w-12 mx-auto mb-4 opacity-50" />
                  <p>No suspended users</p>
                </div>
              ) : (
                <div className="space-y-3">
                  {suspendedUsers.map((user: BannedPubkeyEntry, index: number) => {
                    // The relay keeps legacy rows by their exact spelling. Those rows can
                    // still be removed using Unsuspend. Only the canonical row has a timer.
                    const canHaveTimer = canonicalHex64(user.pubkey) === user.pubkey;
                    return (
                      <BannedUserCard
                        key={index}
                        pubkey={user.pubkey}
                        reason={user.reason}
                        suspended
                        statusLine={canHaveTimer && (
                          <SuspensionEndLine pubkey={user.pubkey} banned={listHas(bannedUsers, user.pubkey)} />
                        )}
                        actionButton={
                          <>
                            <Button
                              variant="outline"
                              size="sm"
                              className="border-green-500 text-green-600 hover:bg-green-50"
                              onClick={() => handleRemoveUser(user.pubkey, 'suspend')}
                            >
                              <Play className="h-4 w-4 mr-1" />
                              Unsuspend
                            </Button>
                            {canHaveTimer && (
                              <Button
                                variant="outline"
                                size="sm"
                                onClick={() => setChangeEndDialog({ pubkey: user.pubkey, open: true })}
                                disabled={changeEnd.isPending}
                              >
                                <CalendarClock className="h-4 w-4 mr-1" />
                                Change end date
                              </Button>
                            )}
                          </>
                        }
                      />
                    );
                  })}
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="allowed">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center space-x-2">
                <UserCheck className="h-5 w-5" />
                <span>Allowed Users</span>
              </CardTitle>
              <CardDescription>
                Users who are explicitly allowed to post to this relay
              </CardDescription>
            </CardHeader>
            <CardContent>
              {loadingAllowed ? (
                <div className="space-y-3">
                  {[...Array(3)].map((_, i) => (
                    <div key={i} className="flex items-center justify-between p-3 border rounded-lg">
                      <div className="space-y-2">
                        <Skeleton className="h-4 w-64" />
                        <Skeleton className="h-3 w-48" />
                      </div>
                      <Skeleton className="h-8 w-20" />
                    </div>
                  ))}
                </div>
              ) : allowedError ? (
                <Alert>
                  <AlertDescription>
                    Failed to load allowed users: {allowedError.message}
                  </AlertDescription>
                </Alert>
              ) : !allowedUsers || allowedUsers.length === 0 ? (
                <div className="text-center py-8 text-muted-foreground">
                  <Users className="h-12 w-12 mx-auto mb-4 opacity-50" />
                  <p>No explicitly allowed users</p>
                </div>
              ) : (
                <div className="space-y-3">
                  {allowedUsers.map((user: AllowedUser, index: number) => (
                    <div key={index} className="flex items-center justify-between p-3 border rounded-lg">
                      <div>
                        <p className="font-mono text-sm">{user.pubkey}</p>
                        {user.reason && (
                          <p className="text-sm text-muted-foreground mt-1">{user.reason}</p>
                        )}
                      </div>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => handleRemoveUser(user.pubkey, 'allow')}
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      <UnbanSuspensionDialog
        key={unbanDialog?.opening}
        open={!!unbanDialog?.open}
        onOpenChange={(open) => {
          if (!open) {
            // The request can finish after the moderator has opened another prompt.
            setUnbanDialog((d) => d && d.opening === unbanDialog?.opening ? { ...d, open: false } : d);
          }
        }}
        // A failed refresh over an older copy is unknown here: that copy may
        // predate a suspend, and its "no timer" would default to no end date.
        record={unbanTimer.refreshFailed ? undefined : unbanTimer.record}
        // The prompt opens only when the list has not answered without the
        // account, so it is either listed (confirmed) or not yet known.
        suspensionConfirmed={!!unbanDialog && suspendedListAnswered && listHas(suspendedUsers, unbanDialog.pubkey)}
        isPending={unbanUserMutation.isPending}
        timersLoading={unbanTimer.isLoading}
        autoLift={unbanTimer.autoLift}
        onConfirm={async (choice, version) => {
          if (!unbanDialog) return;
          await unbanUserMutation.mutateAsync({ pubkey: unbanDialog.pubkey, choice, version, opening: unbanDialog.opening });
        }}
      />

      <SuspensionDurationDialog
        open={!!changeEndDialog?.open}
        onOpenChange={(open) => { if (!open) setChangeEndDialog((d) => d && { ...d, open: false }); }}
        mode="change"
        // undefined while the timer is unknown, so the dialog states no end it doesn't have.
        currentEndsAt={changeEndTimer.record === undefined ? undefined : changeEndTimer.record?.endsAt ?? null}
        isPending={changeEnd.isPending}
        onConfirm={async (duration) => {
          if (!changeEndDialog || duration === null) return; // change mode has no "No end date"
          await changeEnd.mutateAsync({ pubkey: changeEndDialog.pubkey, duration }).catch((error: unknown) => {
            // The worker found the account banned or no longer suspended, so
            // the lists on screen are out of date. UserActions asks its host to
            // re-read; on this tab the page is the host, so it re-reads here.
            if (error instanceof ApiError && (error.code === 'not_suspended' || error.code === 'account_banned')) {
              invalidateUserQueries();
            }
            throw error;
          });
        }}
      />
    </div>
  );
}
