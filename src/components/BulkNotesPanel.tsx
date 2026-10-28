// ABOUTME: The lasting results of a bulk action (#299): its problems (failures)
// ABOUTME: and the files it left for a person to check, with a per-file Restore.
import { useEffect, useRef, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, CheckCircle, Info, Loader2, Undo2, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { useAdminApi, useApiUrl } from '@/hooks/useAdminApi';
import { useCurrentUser } from '@/hooks/useCurrentUser';
import { useToast } from '@/hooks/useToast';
import { ApiError, type BulkNote } from '@/lib/adminApi';
import { describeBulkFailure, mediaServerShows } from '@/lib/bulkFailures';
import { countIssues } from '../../shared/bulk-moderation';
import type { AgeReviewState } from '../../shared/age-review';

// Hashes and pubkeys stay whole (a shortened one can't be looked up), so let
// them break anywhere on a narrow screen.
const WRAP_IDS = 'break-all';
// Text that holds a whole ID: words wrap as words, and only the ID breaks.
const WRAP_TEXT = '[overflow-wrap:anywhere]';

// The request the per-post Remove Restriction sends (EventActions), so a
// restore here does what one there does: blossom, the moderation record and
// funnelcake's quarantine set all change together. It is guarded twice in the
// worker. `from`: a note can be stale, and SAFE sets a file Active whatever it
// was, so the worker writes only while the file's record is still QUARANTINE
// (how age review's withhold and the moderation pipeline record a hide; a
// block made through moderation-service changes it). The account's pubkey:
// the worker also refuses while that account has an open age review, when the
// media server says another account owns the file, or when it shows the file
// blocked, deleted or behind the 18+ gate.
const RESTORE_REASON = 'Restriction removed by moderator';

// Where the entries came from, for the panel's own words.
export type BulkNotesOrigin =
  | { kind: 'job'; status: 'done' | 'failed' }
  | { kind: 'age-review'; state: AgeReviewState; at?: string };

interface BulkNotesPanelProps {
  // The account the files belong to.
  pubkey: string;
  origin: BulkNotesOrigin;
  failures: string[];
  notes: BulkNote[];
  notesLoading?: boolean;
  notesError?: string | null;
  onRetry?: () => void;
  onDismiss: () => void;
}

function originText(origin: BulkNotesOrigin): string {
  if (origin.kind === 'job') {
    return origin.status === 'failed' ? 'The job stopped before it finished.' : 'The job finished.';
  }
  const step = origin.state === 'cleared'
    ? 'cleared'
    : origin.state === 'denied_closed'
      ? 'denied and closed'
      : origin.state.startsWith('restricted_')
        ? 'restricted'
        : `moved to ${origin.state.replace(/_/g, ' ')}`;
  const when = origin.at && !Number.isNaN(Date.parse(origin.at)) ? ` (${new Date(origin.at).toLocaleString()})` : '';
  return `When this case was ${step}${when}.`;
}

// A fragment from describeBulkFailure as a sentence of its own.
function asSentence(fragment: string): string {
  const text = fragment.charAt(0).toUpperCase() + fragment.slice(1);
  return /[.!?]$/.test(text) ? text : `${text}.`;
}

// A recorded state in plain words (moderation-service's names).
const STATE_WORDS: Record<string, string> = {
  SAFE: 'public',
  QUARANTINE: 'hidden',
  PERMANENT_BAN: 'blocked',
  AGE_RESTRICTED: 'behind the 18+ gate',
  REVIEW: 'waiting for review',
  DELETE: 'deleted',
};
const inWords = (state: string) => STATE_WORDS[state] ?? state.toLowerCase().replace(/_/g, ' ');

// `final`: a permanent refusal (the file is no longer hidden as the note said,
// the media server still hides a file its record calls public, or now blocks,
// deletes or 18+-gates it, another account owns it, or the request was
// invalid), so a retry would be refused the same way and the row offers none.
// A 503, or an open age review, is not final: a retry can work, and the text
// says so.
// `checkByHand`: link the file. With `final`, the link replaces Restore;
// without it, as for a refusal a retry may or may not fix, Restore stays and
// the link sits beside it.
// `caseId`: the open age review a refusal names, linked after the text.
interface RestoreOutcome { tone: 'done' | 'error'; text: string; final?: boolean; checkByHand?: boolean; caseId?: string }

const RETRY_THEN_BY_HAND = 'Try again; if it keeps failing, check it by hand.';

// What to do about an open age review, in the row and the panel alike: the
// case page offers no Restore for the account's files while it is open.
const OPEN_REVIEW_NEXT = "That case handles the account's files; Restore here works once it closes.";

// What a refused or failed restore means, in words for the row.
function restoreOutcome(error: unknown): RestoreOutcome {
  if (error instanceof ApiError) {
    switch (error.code) {
      case 'state_mismatch': {
        const now = error.currentState ?? '';
        if (now === 'SAFE' && error.mediaServerState) {
          return {
            tone: 'error',
            text: `Not restored: the moderation record says public, but the media server ${mediaServerShows(error.mediaServerState, 'this file')}. Check it by hand.`,
            final: true,
            checkByHand: true,
          };
        }
        if (now === 'SAFE') return { tone: 'done', text: 'Already restored.', final: true };
        if (now === 'UNKNOWN') {
          return {
            tone: 'error',
            text: "Not restored: this file has no moderation record now (it may have been hidden in the media server's own admin). Check it by hand.",
            final: true,
            checkByHand: true,
          };
        }
        return {
          tone: 'error',
          text: `Not restored: this file is now ${inWords(now)}. Check it by hand.`,
          final: true,
          checkByHand: true,
        };
      }
      case 'age_review_active':
        return { tone: 'error', text: `Not restored: this account has an open age review. ${OPEN_REVIEW_NEXT}`, caseId: error.caseId };
      // The record still reads hidden, but the media server now blocks,
      // deletes or 18+-gates the file (set in its own admin).
      case 'media_server_state':
        return {
          tone: 'error',
          text: `Not restored: the media server now ${mediaServerShows(error.mediaServerState ?? 'changed', 'this file')}. Check it by hand.`,
          final: true,
          checkByHand: true,
        };
      // Permanent: the worker would refuse a retry the same way.
      case 'owner_mismatch':
        return { tone: 'error', text: 'Not restored: another account owns this file. Check it by hand.', final: true, checkByHand: true };
      case 'invalid_pubkey':
      case 'invalid_sha256':
        return {
          tone: 'error', text: `Not restored: the request was refused as invalid (${error.message}). Check it by hand.`,
          final: true, checkByHand: true,
        };
      // The worker sends these for an outage and for answers a retry never
      // changes alike (no such file, a key not bound), so the row keeps
      // Restore and links the file.
      case 'state_unreadable':
        return {
          tone: 'error',
          text: `Not restored: the moderation service did not return this file's current state. ${RETRY_THEN_BY_HAND}`,
          checkByHand: true,
        };
      // Only the open-review lookup fails this way.
      case 'age_review_check_failed':
        return { tone: 'error', text: 'Not restored: this account could not be checked for an open age review. Try again.' };
      case 'owner_unreadable':
        return { tone: 'error', text: `Not restored: the media server did not say who owns this file. ${RETRY_THEN_BY_HAND}`, checkByHand: true };
    }
  }
  return {
    tone: 'error',
    text: `Not restored: the request failed (${error instanceof Error ? error.message : String(error)}). ${RETRY_THEN_BY_HAND}`,
    checkByHand: true,
  };
}

function StillHiddenRow({ sha256, restoredAt, pubkey, origin, blocked }: {
  sha256: string; restoredAt?: string; pubkey: string; origin: BulkNotesOrigin; blocked: boolean;
}) {
  const api = useAdminApi();
  const apiUrl = useApiUrl();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const { getModeratorPubkey } = useCurrentUser();
  const statusRef = useRef<HTMLDivElement>(null);

  const restore = useMutation({
    mutationFn: async () => {
      const moderator = getModeratorPubkey(); // capture before the authoritative request
      await api.moderateMedia(sha256, 'SAFE', RESTORE_REASON, 'QUARANTINE', pubkey);
      // Non-critical audit write, as EventActions does it: never blocks or
      // fails the restore that already happened.
      void moderator.then((moderatorPubkey) =>
        api.logDecision({
          targetType: 'media',
          targetId: sha256,
          action: 'remove_restriction',
          reason: `${RESTORE_REASON} (left hidden by a bulk un-hide)`,
          moderatorPubkey,
        })
          .then(() => { queryClient.invalidateQueries({ queryKey: ['decisions'] }); })
          .catch((e) => {
            console.warn('[BulkNotesPanel] audit log failed', e);
            toast({ title: 'File restored; audit log not recorded' });
          }));
    },
    // The worker marks the file's notes restored when the restore lands, or
    // finds it already public, so the kept results are read again: a panel
    // shown again later reads the file as restored, not still hidden.
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ['age-review-bulk-notes'] });
      queryClient.invalidateQueries({ queryKey: ['bulk-job-notes'] });
    },
    // A review opened after the panel's own check: read it again, so the panel
    // pauses Restore and names the case, as it would have.
    onError: (error) => {
      if (error instanceof ApiError && error.code === 'age_review_active') {
        queryClient.invalidateQueries({ queryKey: ['age-review-active-case', pubkey] });
      }
    },
  });

  const outcome = restore.isError ? restoreOutcome(restore.error) : null;
  const restored = Boolean(restoredAt) || restore.isSuccess;
  const settled = restored || outcome?.final === true;
  // One status per row. "Already restored" stays when the re-read also marks
  // the file restored (the worker marks it on that refusal); a mark that
  // arrives after a refusal that could be retried replaces it.
  const showRestored = restored && outcome?.tone !== 'done';
  const shownOutcome = outcome && !(restored && outcome.tone !== 'done') ? outcome : null;
  const whereFrom = origin.kind === 'age-review' ? 'This age review, or another decision' : 'The action, or another decision';

  // Once a Restore settles for good, its button is gone, and the dialog hands
  // focus back to nothing. Move it to the row's result instead. After the
  // dialog's own focus return, which it schedules as it closes. A refusal for
  // an open age review does the same: the re-read it starts pauses every
  // Restore, this one included, and a disabled button drops focus to the page.
  const actedOn = restore.isSuccess || restore.isError;
  const paused = restore.error instanceof ApiError && restore.error.code === 'age_review_active';
  useEffect(() => {
    if (!(settled || paused) || !actedOn) return;
    const timer = setTimeout(() => statusRef.current?.focus(), 0);
    return () => clearTimeout(timer);
  }, [settled, paused, actedOn]);

  return (
    <li className="space-y-1 rounded border p-2">
      <div className={`font-mono text-xs ${WRAP_IDS}`}>{sha256}</div>
      <div className="flex flex-wrap items-center gap-2">
        {!settled && (
          <span className="text-muted-foreground">
            {origin.kind === 'age-review' ? 'Still hidden after this step.' : 'Still hidden after the job.'}
          </span>
        )}
        {!settled && (
          <ConfirmDialog
            trigger={
              <Button
                size="sm" variant="outline" className="h-6 px-2 text-xs"
                disabled={restore.isPending || blocked}
                aria-label={`Restore file ${sha256}`}
              >
                <Undo2 className="mr-1 h-3 w-3" />
                {restore.isPending ? 'Restoring...' : 'Restore'}
              </Button>
            }
            title="Restore this file?"
            summary={
              `File ${sha256}. Restoring makes it public again, as Remove Restriction on its post does. `
              + `${whereFrom} (an automatic moderation quarantine, or another moderator) may have hidden it. `
              + 'Check why it was hidden before you restore it.'
            }
            summaryClassName={WRAP_TEXT}
            confirmLabel="Restore file"
            pendingLabel="Restoring..."
            isPending={restore.isPending}
            // The outcome is shown on the row, so the dialog closes either way.
            onConfirm={() => restore.mutateAsync().catch(() => {})}
          />
        )}
      </div>
      <div ref={statusRef} role="status" aria-live="polite" tabIndex={-1} className="outline-none">
        {showRestored && (
          <span className="inline-flex items-center gap-1 text-green-700 dark:text-green-400">
            <CheckCircle className="h-3 w-3" /> Restored
          </span>
        )}
        {shownOutcome && !shownOutcome.caseId && (
          <span className={shownOutcome.tone === 'done' ? 'text-muted-foreground' : 'text-red-600'}>{shownOutcome.text}</span>
        )}
        {shownOutcome?.caseId && (
          <span className="text-red-600">
            Not restored: this account has an open age review (
            <a
              href={`/age-review?case=${encodeURIComponent(shownOutcome.caseId)}`} target="_blank" rel="noopener noreferrer"
              className={`underline ${WRAP_IDS}`}
            >
              case {shownOutcome.caseId}
            </a>
            ). {OPEN_REVIEW_NEXT}
          </span>
        )}
        {shownOutcome?.checkByHand && (
          <>
            {' '}
            <a href={`${apiUrl}/media/${sha256}`} target="_blank" rel="noopener noreferrer" className="whitespace-nowrap underline">
              Open the file
            </a>
          </>
        )}
      </div>
    </li>
  );
}

function NotOwnedRow({ sha256, owner }: { sha256: string; owner: string }) {
  return (
    <li className="space-y-1 rounded border p-2">
      <div className={`font-mono text-xs ${WRAP_IDS}`}>{sha256}</div>
      <div className="text-muted-foreground">
        Left unchanged: another account owns this file. Owner:{' '}
        {/* A new tab, so the list here is not lost. */}
        <a
          href={`/users/${owner}`} target="_blank" rel="noopener noreferrer"
          className={`font-mono text-foreground underline ${WRAP_IDS}`}
        >
          {owner}
        </a>
      </div>
    </li>
  );
}

// One problem: in plain words, with the line as the worker wrote it to hand.
function ProblemRow({ failure }: { failure: string }) {
  return (
    <li className={`rounded border border-red-200 p-2 dark:border-red-900 ${WRAP_TEXT}`}>
      <span>{asSentence(describeBulkFailure(failure))}</span>
      <details className="mt-1 text-muted-foreground">
        <summary className="cursor-pointer select-none">As recorded</summary>
        <code className={`font-mono ${WRAP_IDS}`}>{failure}</code>
      </details>
    </li>
  );
}

export function BulkNotesPanel({
  pubkey, origin, failures, notes, notesLoading = false, notesError = null, onRetry, onDismiss,
}: BulkNotesPanelProps) {
  const api = useAdminApi();
  // Restore is paused while the account has an open age review: that review's
  // withhold reads QUARANTINE too. The worker refuses it anyway; this says so,
  // and names the case, before the moderator tries. A lookup that fails
  // disables it as well.
  const restorable = notes.some((note) => note.kind === 'still-hidden' && !note.restoredAt);
  const activeCase = useQuery({
    queryKey: ['age-review-active-case', pubkey],
    queryFn: () => api.getActiveAgeReviewCase(pubkey),
    enabled: restorable,
    staleTime: 30_000,
  });
  const openCaseId = activeCase.data?.case?.id;
  const blockedReason: ReactNode = !restorable
    ? null
    : activeCase.isError
      ? 'Could not check this account for an open age review, so Restore is unavailable.'
      : activeCase.data === undefined
        ? 'Checking this account for an open age review...'
        : openCaseId
          ? (
            <>
              This account has an open age review (
              <a
                href={`/age-review?case=${encodeURIComponent(openCaseId)}`} target="_blank" rel="noopener noreferrer"
                className={`underline ${WRAP_IDS}`}
              >
                case {openCaseId}
              </a>
              ). {OPEN_REVIEW_NEXT}
            </>
          )
          : null;
  // The count is shown only once the files are read: while loading, or after
  // a failed read, it would say 0.
  const notesKnown = !notesLoading && !notesError;

  return (
    <section aria-label="Results to look at" className="space-y-2 rounded-md border border-amber-300 bg-amber-50 p-3 text-xs dark:border-amber-800 dark:bg-amber-950/30">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <h4 className="flex items-center gap-1.5 font-medium">
          <Info className="h-3.5 w-3.5 shrink-0" />
          Results to look at
        </h4>
        <Button size="sm" variant="ghost" className="h-6 px-2 text-xs" onClick={onDismiss}>
          <X className="mr-1 h-3 w-3" /> Dismiss
        </Button>
      </div>
      <p className="text-muted-foreground">{originText(origin)}</p>

      {failures.length > 0 && (
        <div className="space-y-1">
          <h5 className="flex items-center gap-1 font-medium text-red-700 dark:text-red-400">
            <AlertTriangle className="h-3 w-3 shrink-0" /> Problems ({countIssues(failures)})
          </h5>
          <p className="text-muted-foreground">These did not work, or could not be checked.</p>
          <ul className="max-h-60 space-y-1 overflow-y-auto">
            {failures.map((failure) => <ProblemRow key={failure} failure={failure} />)}
          </ul>
        </div>
      )}

      {(notes.length > 0 || notesLoading || notesError) && (
        <div className="space-y-1">
          <h5 className="font-medium">Files to check{notesKnown ? ` (${notes.length})` : ''}</h5>
          <p className="text-muted-foreground">Not failures: these were left for a person to look at.</p>
          {notesLoading && (
            <div className="flex items-center gap-1.5 text-muted-foreground">
              <Loader2 className="h-3 w-3 animate-spin" /> Loading the files to check...
            </div>
          )}
          {notesError && (
            <div className="flex flex-wrap items-center gap-2 text-red-600">
              <span>The files to check could not be loaded: {notesError}</span>
              {onRetry && (
                <Button size="sm" variant="outline" className="h-6 px-2 text-xs" onClick={onRetry}>Try again</Button>
              )}
            </div>
          )}
          {blockedReason && <p className="text-muted-foreground">{blockedReason}</p>}
          {notes.length > 0 && (
            <ul className="max-h-96 space-y-1.5 overflow-y-auto">
              {notes.map((note) => (note.kind === 'still-hidden'
                ? <StillHiddenRow key={`h:${note.sha256}`} sha256={note.sha256} restoredAt={note.restoredAt} pubkey={pubkey} origin={origin} blocked={blockedReason !== null} />
                : <NotOwnedRow key={`o:${note.sha256}`} sha256={note.sha256} owner={note.owner} />))}
            </ul>
          )}
        </div>
      )}
    </section>
  );
}
