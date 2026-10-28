import { getAdminPubkey, banEvent, type Nip86Env } from './nip86';
import { syncZendeskAfterAction, type ZendeskSyncEnv } from './zendesk-sync';
import { isHex64, isLowerHex64 } from './hex';
import {
  listAccountVideos, readBlossomSecret, readBlossomStatus,
  STATUS_READ_TIMEOUT_MS, type AccountVideo, type BlossomBlob, type MediaLevel, type MediaStatus,
} from './media-server';
import { ensureBulkNotesTable, storeBulkNotes } from './bulk-notes';
import {
  VALID_BULK_ACTIONS,
  type BulkAction,
  type AccountBulkAction,
  type BulkModerateResult,
  type BulkJob,
  type BulkJobMessage,
  type BulkJobPhase,
  type BulkEnqueueResponse,
  type BulkKindCounts,
  type BulkNote,
  MAX_NOTES_PER_WRITE,
  bulkJobIdOf,
  bulkJobIdField,
  isVersionedKind,
  ABANDONED_REASON,
  enumerationWarning,
  eventFailure,
  formatOverflowMarker,
  isListingGapWarning,
  jobFailure,
  listFallbackWarning,
  mediaFailure,
  notesNotStoredWarning,
  notesOverflowWarning,
  outOfScopeWarning,
  parseOverflowMarker,
  recheckUnreadableWarning,
  sameSecondGapWarning,
  stillHiddenUnreadableWarning,
  stillUnchangedWarning,
  unpaginatedGapWarning,
} from '../../shared/bulk-moderation';
import { getActiveAgeReviewCase } from './age-review-lookup';
import { deriveFunnelcakeApiUrl } from './funnelcake-proxy';

const BULK_ACTION_CONCURRENCY = 5;
// Page through ALL of an author's events via `until` cursoring instead of
// rejecting accounts with more than one page. The old reject left prolific
// accounts entirely un-enforced (the throw was swallowed upstream).
const RELAY_QUERY_PAGE_SIZE = 500;
const RELAY_QUERY_MAX_PAGES = 100; // safety bound (~50k events); logged if hit, never silent
const RELAY_QUERY_TIMEOUT_MS = 10000; // per-page (reset each page)
const EVENT_CHUNK_SIZE = 200; // relay enumeration page size
const EVENT_BATCH_BUDGET_MS = 4 * 60 * 1000;
// max_concurrency=1 prevents multiple bulk consumers from building a gate
// backlog; bounded batches reduce continuation loss and Queue overhead.
const SERIALIZED_EVENT_BATCH_SIZE = 20;
// Upper bound on delete-kind sweeps. Each sweep after the first exists because
// the previous one deleted something, which for a replaceable or addressable
// kind can reveal an older version. The count is the deepest edit history of
// any one coordinate; hitting the bound is recorded as a failure.
const MAX_KIND_SWEEPS = 20;
// A delete-kind job's sweeps all start from one ceiling, fixed at enqueue as the
// start time plus this margin. Funnelcake accepts created_at up to 60s ahead,
// so the margin takes in posts stamped slightly in the future. Re-reading "now"
// for each sweep let such posts slip past the final, confirming sweep and let
// an account that keeps posting force every sweep non-empty.
const KIND_SWEEP_CEILING_MARGIN_S = 300;

// The ceiling a delete-kind job (or the kind count, which must see the same
// events) takes from now.
function kindSweepCeiling(): number {
  return Math.floor(Date.now() / 1000) + KIND_SWEEP_CEILING_MARGIN_S;
}

export interface BulkModerateEnv extends Nip86Env, ZendeskSyncEnv {
  DB?: D1Database;
  MODERATION_API?: Fetcher;
  MODERATION_ADMIN_URL?: string;
  SERVICE_API_TOKEN?: string | { get(): Promise<string> };
  // Explicit Funnelcake REST API URL; derived from RELAY_URL when unset.
  FUNNELCAKE_API_URL?: string;
  BULK_QUEUE?: Queue<BulkJobMessage>;
  // Current-status reads before each change (see mayChangeMedia).
  MODERATION_SERVICE_URL?: string;
  CDN_DOMAIN?: string;
  BLOSSOM_WEBHOOK_SECRET?: string | { get(): Promise<string> };
}

interface RelayEventSummary {
  id: string;
  kind: number;
  content: string;
  tags: string[][];
}

function json(data: unknown, status: number, corsHeaders: Record<string, string>): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders },
  });
}

// The media action each whole-account bulk action sends. Exhaustive over
// AccountBulkAction so a new action cannot silently fall through to SAFE.
// delete-kind has no row and its type cannot gain one: it never reaches the
// media phase, because funnelcake's per-user video list can't be narrowed to a
// kind and one blob can back events of a kind the moderator chose to keep.
//   age-restrict-all -> QUARANTINE: the age-review withhold. QUARANTINE maps to
//     blossom Restricted (404 to everyone but the owner, reversible).
//     AGE_RESTRICTED would serve the bytes to any signed-in viewer, so it must
//     never be used to hide a minor's content.
//   age-gate-all -> AGE_RESTRICTED: the moderator's "Age Restrict All", the same
//     18+ gate the single-video Age Restrict applies (#290).
//   un-age-restrict-all -> SAFE: restore.
type MediaAction = 'QUARANTINE' | 'AGE_RESTRICTED' | 'SAFE' | 'DELETE';

const BULK_MEDIA_ACTION: Record<AccountBulkAction, MediaAction> = {
  'age-restrict-all': 'QUARANTINE',
  'age-gate-all': 'AGE_RESTRICTED',
  'un-age-restrict-all': 'SAFE',
  'delete-all': 'DELETE',
};

// Which bulk actions loosen an age-review hold. Exhaustive over BulkAction so a
// new action has to choose. Two places act on it:
//   - the /api/bulk-moderate enqueue guard (index.ts) fails CLOSED for these when
//     the case lookup itself fails, and open for the rest;
//   - processBulkJob re-checks before every chunk of these, because the enqueue
//     guard runs once and a case can open while the job is still draining.
//   true: un-age-restrict-all lifts a withhold, and age-gate-all swaps it for an
//     18+ gate that serves a suspected minor's videos to signed-in viewers
//     (#290). Unchecked, either can expose a minor while reporting success. The
//     cost: while the lookup is down, these get a "try again" (503) and a
//     running job stops, but Delete All and Ban (unguarded) still work. With a
//     case open, every bulk action is routed to the case (409) regardless.
//   false: the actions that only add restriction or delete. A refused bulk job
//     is one moderator's click failing, with no automated caller behind it, so
//     refusing these during an outage stops content moderation for a human who
//     has no other route. If bulk ever becomes reachable from automation,
//     revisit these rows: that reasoning is about who is on the other end.
export const LOOSENS_AGE_REVIEW_HOLD: Record<BulkAction, boolean> = {
  'age-restrict-all': false,
  'delete-all': false,
  'delete-kind': false,
  'age-gate-all': true,
  'un-age-restrict-all': true,
};

// A bulk action must never weaken a stronger decision already on a blob: Age
// Restrict All turning a moderator's block into an 18+ gate that any signed-in
// viewer passes, or Delete All destroying a blocked file kept as evidence (#291).
// Nothing downstream refuses that: moderation-service records whatever action
// it is sent and blossom writes the status unconditionally. And the account's
// video list does not exclude blocked files: a media block does not reach
// funnelcake today (its blocked-media sync job is not scheduled). So each blob's
// current status is read before it is changed, and the change is made only when
// it is allowed from that status. Each status source's states map to a
// MediaLevel; blossom's map (BLOSSOM_LEVEL) is with its reads in
// media-server.ts.

// moderation-service's recorded decision, from GET /check-result/{sha256}
// ('unknown' when it has none). Read too because blossom caches status for 5
// minutes per POP and a change only clears the cache in its own POP, so
// blossom's answer can be stale right after a block made through
// moderation-service, which this record reflects at once.
const MODERATION_LEVEL = new Map<string, MediaLevel>([
  ['unknown', 'open'],
  ['safe', 'open'],
  ['review', 'open'],
  ['age_restricted', 'gated'],
  ['quarantine', 'hidden'],
  ['permanent_ban', 'blocked'],
  ['delete', 'deleted'],
]);

// The current states each media action may change. Blocked is in no row: no
// bulk action touches a blocked blob. How the two sources combine is in
// decideMediaChange.
//   AGE_RESTRICTED (Age Restrict All): only from open. Skips hidden, blocked
//     and deleted (that would loosen them) and already-gated (nothing to do).
//   QUARANTINE (age review's hide): from open or gated. Tightening an 18+ blob
//     to hidden is the point of the withhold.
//   SAFE (age review's un-hide on clear): only from hidden, so it never acts
//     on a blob that is currently 18+ or blocked. It does not know what the
//     blob was before the hide: a blob that was 18+ and then hidden by the
//     review comes back fully open, and a blob some other decision hid can
//     be un-hidden too. Restoring only what the review hid, to its previous
//     status, is #295.
//   DELETE (Delete All's media phase): from open, gated or hidden.
//
// Still a check-then-write: a change landing between the read and the write is
// not caught, and a block made in blossom's admin UI in another POP within the
// last 5 minutes can read as open. Closing both needs blossom to make the write
// itself conditional (divinevideo/divine-blossom#306); until then this is the
// strongest guard available from here.
const MAY_CHANGE_FROM: Record<MediaAction, readonly MediaLevel[]> = {
  AGE_RESTRICTED: ['open'],
  QUARANTINE: ['open', 'gated'],
  SAFE: ['hidden'],
  DELETE: ['open', 'gated', 'hidden'],
};

// The state each action leaves a blob in.
const RESULT_LEVEL: Record<MediaAction, MediaLevel> = {
  AGE_RESTRICTED: 'gated',
  QUARANTINE: 'hidden',
  SAFE: 'open',
  DELETE: 'deleted',
};

type MediaDecision = 'change' | 'leave' | 'disagree';

// How strictly a level withholds a blob, for comparing the two sources.
// Blocked and deleted both serve nothing.
const STRICTNESS: Record<MediaLevel, number> = { open: 0, gated: 1, hidden: 2, blocked: 3, deleted: 3 };

// True when viewers are being served the blob more openly than the record
// says: blossom serves it to everyone (open) or to anyone signed in (gated),
// and the record is stricter. Hidden is owner-only, so a hidden blob the record
// calls blocked exposes nothing beyond its owner.
function servedMoreOpenlyThanRecorded(blossom: MediaLevel, moderation: MediaLevel): boolean {
  return (blossom === 'open' || blossom === 'gated') && STRICTNESS[moderation] > STRICTNESS[blossom];
}

// How the two status sources combine. blossom is what viewers are served;
// moderation-service is the recorded decision. They drift: blossom's admin UI
// never reports to moderation-service, moderation-service records an action
// even when its call to blossom fails, and blossom's read can be up to 5
// minutes stale in another POP.
//
//   blossom does not allow the action -> leave it alone (counted). What viewers
//     get is already at least as strict as the action, or for SAFE there is
//     nothing hidden to undo, so the action has nothing to do. The common case
//     is a blob gated or blocked in blossom's admin UI. Except when viewers are
//     served it more openly than the record says: then it is a disagree, so the
//     exposure reaches a moderator whichever action happened to find it.
//   both allow it -> change it.
//   blossom allows it, and the record already shows the action's own result ->
//     change it. The record got ahead of blossom (its blossom call failed);
//     sending the action again cannot weaken anything, since blossom's status
//     already passed. Tightening actions only: for SAFE that record is "open",
//     handled below.
//   SAFE, blossom hidden, record open or gated -> leave it alone (counted). The
//     hide came from somewhere other than a recorded hide (blossom's admin UI),
//     so it is not age review's to undo; restricting un-hide to what age review
//     hid is #295.
//   otherwise -> disagree: the record is stricter than what blossom serves.
//     Either a block just landed and blossom's read is stale, or it was lifted
//     in blossom's admin UI and the record is stale. Acting could undo a fresh
//     block, and leaving it quietly could leave a minor's video public, so it
//     fails and a person looks.
function decideMediaChange(mediaAction: MediaAction, blossom: MediaLevel, moderation: MediaLevel): MediaDecision {
  const allowed = MAY_CHANGE_FROM[mediaAction];
  if (!allowed.includes(blossom)) {
    return servedMoreOpenlyThanRecorded(blossom, moderation) ? 'disagree' : 'leave';
  }
  if (allowed.includes(moderation)) return 'change';
  if (mediaAction !== 'SAFE' && moderation === RESULT_LEVEL[mediaAction]) return 'change';
  if (mediaAction === 'SAFE' && (moderation === 'open' || moderation === 'gated')) return 'leave';
  return 'disagree';
}

async function readModerationStatus(sha256: string, env: BulkModerateEnv): Promise<MediaStatus> {
  // The service binding when bound, like callModerateMedia (its host is
  // ignored). Without one, reads go to MODERATION_SERVICE_URL like
  // handleModerateMedia's check-result read, while callModerateMedia writes to
  // MODERATION_ADMIN_URL. Every config sets the two to the same host; if they
  // ever diverge, this reads one deployment's record and writes another's.
  let response: Response;
  if (env.MODERATION_API) {
    response = await env.MODERATION_API.fetch(`https://moderation-api.divine.video/check-result/${sha256}`, {
      signal: AbortSignal.timeout(STATUS_READ_TIMEOUT_MS),
    });
  } else if (env.MODERATION_SERVICE_URL) {
    response = await fetch(`${env.MODERATION_SERVICE_URL}/check-result/${sha256}`, {
      signal: AbortSignal.timeout(STATUS_READ_TIMEOUT_MS),
    });
  } else {
    throw new Error('no moderation service configured');
  }
  if (!response.ok) throw new Error(`moderation-service returned ${response.status}`);
  const { status } = await response.json() as { status?: unknown };
  const level = typeof status === 'string' ? MODERATION_LEVEL.get(status) : undefined;
  if (!level) throw new Error(`moderation-service returned unrecognised status ${JSON.stringify(status)}`);
  return { raw: status as string, level };
}

// What to do with one blob (see decideMediaChange).
//   change: `resend` when the record already shows the action's result, so the
//     change only repeats one already made (decideMediaChange's "record got
//     ahead of blossom").
//   leave: `atResult` when blossom already serves what the action would leave.
//   not-owned: another account owns it.
type MediaVerdict =
  | { kind: 'change'; resend: boolean }
  | { kind: 'leave'; atResult: boolean }
  | { kind: 'not-owned'; owner: string };

// Throws, leaving the blob unchanged and reported, when its owner or either
// status cannot be read (an unreadable status is never treated as open) or the
// two statuses disagree.
async function mayChangeMedia(
  sha256: string, mediaAction: MediaAction, env: BulkModerateEnv, blossomSecret: string | Error, pubkey: string,
): Promise<MediaVerdict> {
  const unreadable = (error: unknown) => new Error(`could not read current status, left unchanged: ${formatError(error)}`);
  let blossom: BlossomBlob;
  try {
    if (blossomSecret instanceof Error) throw blossomSecret;
    blossom = await readBlossomStatus(sha256, env, blossomSecret);
  } catch (error) {
    throw unreadable(error);
  }
  // Only the account's own files (#299). Both lists can name a file someone
  // else uploaded first: blossom's uploader list includes re-uploads of
  // another account's bytes, and the account's event can point at another
  // account's file. Blossom keeps one copy per hash, so changing it would
  // change it for its owner too (a DELETE removes it for everyone). Decided
  // before the recorded decision is read, so another account's moderation
  // record can never fail this account's run (an unreadable media-server
  // status still fails it, whoever owns the file). Both sides are lowercase
  // hex: readBlossomStatus lowercases the owner, and runBulkModeration and
  // processBulkJob refuse any other pubkey.
  if (blossom.owner !== pubkey) return { kind: 'not-owned', owner: blossom.owner };
  let moderation: MediaStatus;
  try {
    moderation = await readModerationStatus(sha256, env);
  } catch (error) {
    throw unreadable(error);
  }
  const decision = decideMediaChange(mediaAction, blossom.level, moderation.level);
  if (decision === 'disagree') {
    throw new Error(
      `status sources disagree (blossom ${blossom.raw}, moderation-service ${moderation.raw}), left unchanged`,
    );
  }
  const result = RESULT_LEVEL[mediaAction];
  return decision === 'change'
    ? { kind: 'change', resend: moderation.level === result }
    : { kind: 'leave', atResult: blossom.level === result };
}

// Per-item chunk helpers, shared by the synchronous runBulkModeration (age-review)
// and the chunked queue consumer (processBulkJob).

// Which pass over the files this is, for what it counts:
//   walk: the first look at each file. Every file left alone is counted.
//   after-blossom: the queued funnelcake walk after the blossom walk. A file
//     already at the action's result is not counted again: the blossom walk
//     changed it, or counted it. That includes a file it deleted, which has
//     left the uploader list so the funnelcake walk cannot exclude it.
//     Known limit: a file only funnelcake lists, and that was already at the
//     result before the job, was never counted by the blossom walk, so it is
//     not counted at all. The "left as they were" count can be lower than
//     the worker's before #299, which counted it. Counts only; nothing is
//     left unchanged.
//     Two more count limits, both only after a media-server list read failed,
//     which the job already reports as a failure line:
//     - the first blossom chunk's read fails: the job goes straight to the
//       funnelcake walk, without the exclusion, and that walk still counts as
//       after-blossom, so a file already at the action's result before the
//       job is counted by no pass;
//     - a later read fails (a later blossom chunk's, or a funnelcake page's
//       own exclusion read): the funnelcake walk revisits files the blossom
//       walk already saw, so one it left alone that is not at the result
//       (one already blocked, under Delete All) can be counted twice.
//     Counts only here too: each revisited file is read again and left or
//     changed as the blossom walk would have, and nothing is left unchanged.
//   recheck: the end-of-walk check. It counts only files it changed for the
//     first time, never a skip: anything else was counted on the walk, and
//     blossom's cache can show a file this job already changed as unchanged.
type MediaPass = 'walk' | 'after-blossom' | 'recheck';

interface MediaOutcome {
  processed: number;
  skipped: number;
  failures: string[];
  notes: BulkNote[];
}

async function moderateMediaHashes(
  env: BulkModerateEnv, pubkey: string, hashes: string[], mediaAction: MediaAction, reason: string,
  pass: MediaPass = 'walk',
): Promise<MediaOutcome> {
  let processed = 0;
  let skipped = 0;
  const failures: string[] = [];
  const notes: BulkNote[] = [];
  const blossomSecret = await readBlossomSecret(env);
  await runWithConcurrency(hashes, BULK_ACTION_CONCURRENCY, async (sha256) => {
    try {
      const verdict = await mayChangeMedia(sha256, mediaAction, env, blossomSecret, pubkey);
      if (verdict.kind === 'not-owned') {
        // A note, not a failure, and not counted: the count is shown as files
        // left as they were because they were already blocked or deleted,
        // which another account's file is not. The owner is the moderator's
        // lead when an account posts files another key uploaded.
        notes.push({ kind: 'not-owned', sha256, owner: verdict.owner });
        return;
      }
      if (verdict.kind === 'leave') {
        // Left alone on purpose: not a failure, and not processed (processed
        // means changed). Counted so the moderator sees it.
        if (pass === 'walk' || (pass === 'after-blossom' && !verdict.atResult)) skipped++;
        return;
      }
      await callModerateMedia(sha256, mediaAction, reason, env);
      if (pass !== 'recheck' || !verdict.resend) processed++;
    } catch (error) {
      failures.push(mediaFailure(sha256, formatError(error)));
    }
  });
  return { processed, skipped, failures, notes };
}

// The end-of-walk check (#299). Each walk reads the uploader list afresh and
// only moves forward, so a file can be passed over: one uploaded behind the
// walk's position, or one a read left out (blossom drops a row whose record
// read errors and still answers 200). One more read, after every walk, finds
// any owned video whose status the action may still change, and gives it one
// more pass. One that is still unchanged after it has a failure line (a
// change that fails, or statuses that disagree), so the job does not end
// clean. The pass is one chunk at most; past that, the rest are counted in one
// line, never changed unbounded in one invocation.
async function recheckOwnedVideos(
  env: BulkModerateEnv, pubkey: string, mediaAction: MediaAction, reason: string,
): Promise<MediaOutcome> {
  let files: AccountVideo[];
  try {
    files = await listAccountVideos(pubkey, env);
  } catch (error) {
    return {
      processed: 0, skipped: 0, notes: [],
      failures: [recheckUnreadableWarning(pubkey, formatError(error))],
    };
  }
  // A row it cannot describe (no usable owner, or this account's with a status
  // this worker does not know) goes through the pass too: for a file the walk
  // passed over, this read is the only one that lists it. The per-file read
  // fails on the same record and names the file, once (repeats of a line the
  // walk wrote are dropped). Another account's row is not this account's.
  const left = files
    .filter((file) => file.owner === null
      || (file.owner === pubkey && (file.level === null || MAY_CHANGE_FROM[mediaAction].includes(file.level))))
    .map((file) => file.sha256);
  const pass = left.slice(0, MEDIA_CHUNK_SIZE);
  const media = await moderateMediaHashes(env, pubkey, pass, mediaAction, reason, 'recheck');
  if (left.length > pass.length) {
    media.failures.push(stillUnchangedWarning(pubkey, left.length - pass.length));
  }
  return media;
}

// Un-age-restrict All's report (#299). It chooses files from funnelcake's list
// only: SAFE cannot tell a file age review hid from one another decision hid
// (#295), and the uploader list shows both, including the moderation
// pipeline's own quarantines, which funnelcake hides. So the files it cannot
// see are never changed. Each owned video the media server still serves
// hidden is a note instead, for a person to look at and restore by hand.
// Read-only. A list that cannot be read is a failure, not a note: then no one
// can tell what is still hidden.
//
// Known limit: it reads blossom's status, which blossom caches per POP for up
// to 5 minutes. Right after a change it can name a file a restore just made
// active, or miss one the withhold just hid, so a clear can end with no note
// while a file is still hidden. Recording what the withhold hid is #295.
async function reportStillHidden(env: BulkModerateEnv, pubkey: string): Promise<{ notes: BulkNote[]; failures: string[] }> {
  try {
    const files = await listAccountVideos(pubkey, env);
    const notes: BulkNote[] = files
      .filter((file) => file.owner === pubkey && file.level === 'hidden')
      .map((file) => ({ kind: 'still-hidden', sha256: file.sha256 }));
    return { notes, failures: [] };
  } catch (error) {
    return { notes: [], failures: [stillHiddenUnreadableWarning(pubkey, formatError(error))] };
  }
}

// One entry per file and kind of note, in first-seen order. A job meets the
// same file on more than one walk.
function uniqueNotes(notes: BulkNote[]): BulkNote[] {
  const seen = new Set<string>();
  return notes.filter((note) => {
    const key = `${note.kind}:${note.sha256}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// Who the per-event decision rows name. A job that carries neither falls back
// to the worker's signing key and no report.
interface DecisionAttribution {
  moderatorPubkey?: string;
  reportId?: string;
}

async function writeDecisionBatch(
  env: BulkModerateEnv, eventIds: string[], reason: string, moderatorPubkey: string, reportId: string | null,
): Promise<void> {
  if (!env.DB || eventIds.length === 0) return;
  // Non-critical audit write (the relay deletes already happened): log and
  // continue, never abort the run and mislabel a completed destructive run.
  try {
    await env.DB.batch(
      eventIds.map((eventId) => env.DB!.prepare(
        `INSERT INTO moderation_decisions (target_type, target_id, action, reason, moderator_pubkey, report_id, created_at) VALUES (?, ?, ?, ?, ?, ?, datetime('now'))`
      ).bind('event', eventId, 'delete_event', reason, moderatorPubkey, reportId))
    );
  } catch (error) {
    console.error('[bulk-moderate] decision-log batch insert failed (non-critical):', formatError(error));
  }
}

async function deleteEvents(
  env: BulkModerateEnv, events: RelayEventSummary[], reason: string, moderatorPubkey: string,
  attribution: DecisionAttribution = {},
): Promise<{ processed: number; successfulEventIds: string[]; failures: string[] }> {
  let processed = 0;
  const successfulEventIds: string[] = [];
  const failures: string[] = [];
  await runWithConcurrency(events, BULK_ACTION_CONCURRENCY, async (event) => {
    try {
      // Admin deletion is NIP-86 banevent (authoritative). We do NOT publish a NIP-09
      // kind-5 deletion: NIP-09 is author-only, so funnelcake (and any compliant relay)
      // rejects a non-author's kind-5 — an admin kind-5 always fails and propagates
      // nothing. banevent is the real removal.
      const banResult = await banEvent(event.id, reason, env, 'delete_event');
      if (!banResult.success) throw new Error(banResult.error || 'banevent failed');
      processed++;
      successfulEventIds.push(event.id);
    } catch (error) {
      failures.push(eventFailure(event.id, formatError(error)));
    }
  });
  // The decision rows name the requesting moderator when the job carries one;
  // the Zendesk sync below stays on the worker's key, as handleModerate does.
  await writeDecisionBatch(
    env, successfulEventIds, reason,
    attribution.moderatorPubkey ?? moderatorPubkey, attribution.reportId ?? null,
  );
  await runWithConcurrency(successfulEventIds, BULK_ACTION_CONCURRENCY, async (eventId) => {
    await syncZendeskAfterAction(env, 'delete_event', 'event', eventId, moderatorPubkey);
  });
  return { processed, successfulEventIds, failures };
}

// Runs the WHOLE enumerate->action job synchronously, in one invocation. Used by
// the age-review enforcement path, which needs the result inline for the case's
// enforcement-leg status. The moderator-facing UI path uses the chunked queue
// consumer (processBulkJob) instead, which drains any account size.
//
// Scope note: because this runs in one invocation, a very large account can still
// hit the Workers per-invocation subrequest/CPU ceiling and land `failed` here
// (BULK_ACTION_CONCURRENCY changes parallelism, not the total subrequest count).
// Each blob costs three subrequests (two status reads and the write; see
// mayChangeMedia), so at the paid plan's 10,000 per invocation the ceiling is
// roughly 3,300 videos.
// It fails visibly on the case. There is no moderator re-run path for the
// withhold: the Users-page "Age Restrict All" sends age-gate-all (the 18+ gate),
// which would serve a minor's videos to signed-in viewers, so never use it to
// finish a failed age-review restriction (#290).
export async function runBulkModeration(
  env: BulkModerateEnv,
  pubkey: string,
  action: AccountBulkAction,
  reason: string,
): Promise<BulkModerateResult> {
  // A mixed-case or malformed pubkey would match no owner, so every file would
  // be left alone and the run would report success.
  if (!isLowerHex64(pubkey)) throw new Error(`refusing ${JSON.stringify(pubkey)}: not a lowercase hex pubkey`);
  const moderatorPubkey = await getAdminPubkey(env);
  const result: BulkModerateResult = { success: true, eventsProcessed: 0, mediaProcessed: 0, mediaSkipped: 0, failures: [], notes: [] };
  const mediaAction = BULK_MEDIA_ACTION[action];
  // Files come from funnelcake's video list and, except for Un-age-restrict
  // All (see reportStillHidden), blossom's uploader list (see
  // listAccountVideos), all read before any event is banned. An uploader list
  // that cannot be read leaves funnelcake's, and says so.
  const listed = mediaAction === 'SAFE'
    ? Promise.resolve(null)
    : listAccountVideos(pubkey, env).then((files) => ({ files }), (error: unknown) => ({ error }));

  let videoHashes: string[];
  let list: Awaited<typeof listed>;
  if (action === 'delete-all') {
    // Events come from the relay (WebSocket, paginated) for the event IDs.
    let relayEvents: Awaited<ReturnType<typeof queryRelayEvents>>;
    [relayEvents, videoHashes, list] = await Promise.all([
      queryRelayEvents(pubkey, env),
      queryUserMediaHashes(pubkey, env),
      listed,
    ]);
    const { events, complete, outOfScope } = relayEvents;
    if (list && 'error' in list) result.failures.push(listFallbackWarning(pubkey, formatError(list.error), { countMayBeOff: false }));
    if (outOfScope > 0) result.failures.push(outOfScopeWarning(pubkey, outOfScope));
    if (!complete) result.failures.push(unpaginatedGapWarning(pubkey, 'actioned a partial set'));
    const ev = await deleteEvents(env, events, reason, moderatorPubkey);
    result.eventsProcessed = ev.processed;
    result.failures.push(...ev.failures);
    if (ev.successfulEventIds.length > 0) {
      await syncZendeskAfterAction(env, 'delete_event', 'pubkey', pubkey, moderatorPubkey);
    }
  } else {
    // age-restrict-all / age-gate-all / un-age-restrict-all are media-only;
    // see BULK_MEDIA_ACTION for what each sends.
    [videoHashes, list] = await Promise.all([queryUserMediaHashes(pubkey, env), listed]);
    if (list && 'error' in list) result.failures.push(listFallbackWarning(pubkey, formatError(list.error), { countMayBeOff: false }));
    // one video == one event for video kinds, counted from funnelcake's list
    // as before #299
    result.eventsProcessed = videoHashes.length;
  }

  const listedHashes = list && 'files' in list ? list.files.map((file) => file.sha256) : [];
  const mediaHashes = [...new Set([...listedHashes, ...videoHashes])];
  const media = await moderateMediaHashes(env, pubkey, mediaHashes, mediaAction, reason);
  result.mediaProcessed = media.processed;
  result.mediaSkipped = media.skipped;
  result.failures.push(...media.failures);
  result.notes.push(...media.notes);
  if (mediaAction === 'SAFE') {
    const report = await reportStillHidden(env, pubkey);
    result.failures.push(...report.failures);
    result.notes.push(...report.notes);
  } else if (list && 'files' in list) {
    // After a failed read the fallback line already stands, and this read
    // would most likely fail the same way.
    const check = await recheckOwnedVideos(env, pubkey, mediaAction, reason);
    result.mediaProcessed += check.processed;
    result.mediaSkipped += check.skipped;
    result.failures.push(...check.failures);
    result.notes.push(...check.notes);
  }

  // The check can meet a failure or a note the walk already recorded.
  result.failures = [...new Set(result.failures)];
  result.notes = uniqueNotes(result.notes);
  // Notes are for a person and do not make the run a failure (see BulkNote).
  result.success = result.failures.length === 0;
  return result;
}

// On-demand schema, matching the repo's ensureDecisionsTable/ensureZendeskTable
// pattern (no migration runner).
// Memoized per worker isolate (mirrors index.ts ensureSchemaOnce) so the status
// poll — which fires every ~1.5s — doesn't re-issue the CREATE plus the defensive
// ALTER (which throws-and-is-caught once the column exists) on every call.
let bulkSchemaReady = false;
export async function ensureBulkJobsTable(db: D1Database): Promise<void> {
  if (bulkSchemaReady) return;
  await db.prepare(
    `CREATE TABLE IF NOT EXISTS bulk_jobs (
      job_id TEXT PRIMARY KEY,
      pubkey TEXT NOT NULL,
      action TEXT NOT NULL,
      status TEXT NOT NULL,
      events_processed INTEGER NOT NULL DEFAULT 0,
      media_processed INTEGER NOT NULL DEFAULT 0,
      failures TEXT NOT NULL DEFAULT '[]',
      failures_dropped INTEGER NOT NULL DEFAULT 0,
      version INTEGER NOT NULL DEFAULT 0,
      media_skipped INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      kind INTEGER
    )`
  ).run();
  // Defensive add for a bulk_jobs table created before failures_dropped existed
  // (on-demand schema, no migration runner). Ignored once the column is present.
  await db.prepare('ALTER TABLE bulk_jobs ADD COLUMN failures_dropped INTEGER NOT NULL DEFAULT 0')
    .run().catch(() => {});
  await db.prepare('ALTER TABLE bulk_jobs ADD COLUMN version INTEGER NOT NULL DEFAULT 0')
    .run().catch(() => {});
  await db.prepare('ALTER TABLE bulk_jobs ADD COLUMN media_skipped INTEGER NOT NULL DEFAULT 0')
    .run().catch(() => {});
  // NULL for every job that is not kind-scoped, including all existing rows.
  await db.prepare('ALTER TABLE bulk_jobs ADD COLUMN kind INTEGER')
    .run().catch(() => {});
  // A job's notes for a person (#299), in their own table.
  await ensureBulkNotesTable(db);
  bulkSchemaReady = true;
}

interface BulkJobRow {
  job_id: string;
  pubkey: string;
  action: string;
  status: string;
  events_processed: number;
  media_processed: number;
  failures: string;
  failures_dropped: number;
  version: number;
  media_skipped?: number; // absent on rows read before the column was added
  created_at: string;
  updated_at: string;
  kind: number | null;
}

// `failures[]` stores a capped raw list (<= MAX_STORED_FAILURES, no synthetic
// marker); the overflow count lives in its own `failures_dropped` column so it
// survives across chunks. Render the "+N more" marker only for display/the API.
function failuresForDisplay(list: string[], dropped: number): string[] {
  return dropped > 0 ? list.concat(formatOverflowMarker(dropped)) : list;
}

function parseFailuresList(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw) as string[];
    // Defensive: never let a previously-stored synthetic marker re-enter the list.
    return parsed.filter((f) => parseOverflowMarker(f) === null);
  } catch {
    return [];
  }
}

function rowToBulkJob(row: BulkJobRow): BulkJob {
  const dropped = Number(row.failures_dropped) || 0;
  return {
    jobId: row.job_id,
    pubkey: row.pubkey,
    action: row.action as BulkJob['action'],
    ...(row.kind !== null && row.kind !== undefined ? { kind: Number(row.kind) } : {}),
    status: row.status as BulkJob['status'],
    eventsProcessed: Number(row.events_processed) || 0,
    mediaProcessed: Number(row.media_processed) || 0,
    mediaSkipped: Number(row.media_skipped) || 0,
    failures: failuresForDisplay(parseFailuresList(row.failures), dropped),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// The optional per-job fields every event-phase message must carry, so a
// continuation resumes with the same kind and attribution. The media phase uses
// neither (a kind-scoped job never reaches it, and it writes no decision rows).
// Fields that are absent stay absent, which keeps a plain delete-all message
// unchanged.
function jobScope(
  src: Pick<BulkJobMessage, 'kind' | 'moderatorPubkey' | 'reportId' | 'sweepUntil'>,
): Pick<BulkJobMessage, 'kind' | 'moderatorPubkey' | 'reportId' | 'sweepUntil'> {
  return {
    ...(src.kind !== undefined ? { kind: src.kind } : {}),
    ...(src.sweepUntil !== undefined ? { sweepUntil: src.sweepUntil } : {}),
    ...(src.moderatorPubkey !== undefined ? { moderatorPubkey: src.moderatorPubkey } : {}),
    ...(src.reportId !== undefined ? { reportId: src.reportId } : {}),
  };
}

// Producer: validate, persist a pending job, enqueue, and return the jobId
// immediately. The actual O(N/5) work runs in the queue consumer (processBulkJob)
// so a large account can never hang the request.
export async function handleBulkModerateEnqueue(
  request: Request,
  env: BulkModerateEnv,
  corsHeaders: Record<string, string>,
): Promise<Response> {
  type EnqueueBody = {
    pubkey?: string; action?: string; reason?: string;
    kind?: unknown; moderatorPubkey?: unknown; reportId?: unknown;
  };
  let body: EnqueueBody;
  try {
    body = await request.json() as EnqueueBody;
  } catch {
    return json({ error: 'Malformed JSON body' }, 400, corsHeaders);
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return json({ error: 'Request body must be a JSON object' }, 400, corsHeaders);
  }

  if (typeof body.pubkey !== 'string' || !/^[0-9a-f]{64}$/.test(body.pubkey)) {
    return json({ error: 'Valid 64-char hex pubkey required' }, 400, corsHeaders);
  }
  if (!body.action || !VALID_BULK_ACTIONS.includes(body.action as BulkAction)) {
    return json({ error: `Invalid action. Must be one of: ${VALID_BULK_ACTIONS.join(', ')}` }, 400, corsHeaders);
  }
  // A kind-scoped delete is its own action, not delete-all plus a kind, so a
  // worker that predates it refuses the request (unknown action) instead of
  // running a full delete-all. Every other action refuses a kind rather than
  // ignoring it, which would widen the job to the whole account.
  if (body.action === 'delete-kind') {
    // NIP-01 kinds are 0-65535. Above that, funnelcake returns nothing (a clean
    // "done" with 0 deleted), and a relay that truncates to u16 would delete a
    // different kind.
    if (typeof body.kind !== 'number' || !Number.isSafeInteger(body.kind) || body.kind < 0 || body.kind > 65535) {
      return json({ error: 'delete-kind requires kind, an integer from 0 to 65535' }, 400, corsHeaders);
    }
  } else if (body.kind !== undefined) {
    return json({ error: 'kind is only supported for delete-kind' }, 400, corsHeaders);
  }
  if (body.moderatorPubkey !== undefined && (typeof body.moderatorPubkey !== 'string' || !/^[0-9a-f]{64}$/.test(body.moderatorPubkey))) {
    return json({ error: 'moderatorPubkey must be a 64-char hex pubkey' }, 400, corsHeaders);
  }
  if (body.reportId !== undefined && (typeof body.reportId !== 'string' || !/^[0-9a-f]{64}$/.test(body.reportId))) {
    return json({ error: 'reportId must be a 64-char hex event id' }, 400, corsHeaders);
  }
  if (!env.DB) {
    return json({ error: 'bulk_jobs storage (D1) is not bound' }, 500, corsHeaders);
  }
  if (!env.BULK_QUEUE) {
    return json({ error: 'bulk-moderate queue is not bound' }, 500, corsHeaders);
  }

  const action = body.action as BulkAction;
  const reason = body.reason || `Bulk ${action} by moderator`;
  const kind = body.kind as number | undefined;
  const jobId = crypto.randomUUID();
  const now = new Date().toISOString();

  // No job row means no job: nothing is enqueued, and the caller gets a JSON
  // 500 it can show, not an unhandled throw.
  try {
    await ensureBulkJobsTable(env.DB);
    await env.DB.prepare(
      `INSERT INTO bulk_jobs (job_id, pubkey, action, status, events_processed, media_processed, failures, failures_dropped, version, created_at, updated_at, kind)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(jobId, body.pubkey, action, 'pending', 0, 0, '[]', 0, 0, now, now, kind ?? null).run();
  } catch (error) {
    console.error('[bulk-moderate] job insert failed', error);
    return json({ error: 'Failed to record the bulk moderation job' }, 500, corsHeaders);
  }

  try {
    await env.BULK_QUEUE.send({
      ...bulkJobIdField(action, jobId), pubkey: body.pubkey, action, reason, version: 0,
      ...jobScope({
        kind,
        sweepUntil: action === 'delete-kind' ? kindSweepCeiling() : undefined,
        moderatorPubkey: body.moderatorPubkey as string | undefined,
        reportId: body.reportId as string | undefined,
      }),
    });
  } catch (error) {
    // Roll back the orphaned pending row so it can't linger unprocessed.
    await env.DB.prepare('DELETE FROM bulk_jobs WHERE job_id = ?').bind(jobId).run().catch(() => {});
    console.error('[bulk-moderate] enqueue failed for', jobId, error);
    return json({ error: 'Failed to enqueue bulk moderation job' }, 500, corsHeaders);
  }

  return json({ success: true, jobId } satisfies BulkEnqueueResponse, 200, corsHeaders);
}

// A job whose row hasn't advanced past pending/running within this window is
// treated as abandoned (e.g. the worker was evicted mid-consume, and with
// max_retries=0 the message is gone). Generous because a large account can run
// for minutes; the per-invocation subrequest/CPU ceiling caps real runtime well
// under this. The frontend poller should also bound its own wait.
const STALE_JOB_MS = 30 * 60 * 1000;

// Consumer: run one job to completion and write its terminal state. Any error is
// recorded as `failed` and swallowed (not rethrown) so the queue does not retry a
// half-applied DESTRUCTIVE job — re-running is a manual operator action.
//
// Idempotency: Cloudflare Queues is at-least-once. Each message carries the row
// version it expects and atomically increments it before doing work, so only one
// delivery can own a chunk. Terminal writes also require that claimed version.
// Recovering an abandoned job's dropped continuation remains separate work.
// TODO(#319): continuation recovery.
const MAX_STORED_FAILURES = 50;

// Merge new failures into the stored list, tracking the cumulative dropped count
// as its own number so it survives across chunks. Returns the capped raw list
// (<= MAX_STORED_FAILURES, no marker) plus the running dropped total. Re-deriving
// the marker from only the stored set each chunk loses earlier overflow and lets
// a clean final chunk erase the count entirely; a dedicated counter can't be
// erased. On a destructive path `failures[]` is the moderator's only signal of how
// much went un-actioned, so the total must not silently understate.
function mergeFailures(
  existing: string[], existingDropped: number, added: string[],
): { list: string[]; dropped: number } {
  const base = existing.filter((f) => parseOverflowMarker(f) === null);
  // Store each failure once. A by-kind job's sweeps meet the same failing ban
  // (or the same saturated second, or the same out-of-scope events) on every
  // sweep; repeats would overstate the count and crowd distinct failures out of
  // the cap. Only stored entries can be recognised, so a repeat of one already
  // past the cap still adds to `dropped`, which can therefore overcount.
  const stored = new Set(base);
  const merged = base.concat([...new Set(added)].filter((f) => !stored.has(f)));
  if (merged.length <= MAX_STORED_FAILURES) {
    return { list: merged, dropped: existingDropped };
  }
  return {
    list: merged.slice(0, MAX_STORED_FAILURES),
    dropped: existingDropped + (merged.length - MAX_STORED_FAILURES),
  };
}

// Merge in the reason a job stopped. It must be visible even when the list is
// full: it takes the last stored slot, and the entry it displaces stays counted
// in `dropped`, which mergeFailures already raised for the overflow.
function mergeWithReason(
  existing: string[], existingDropped: number, reason: string,
): { list: string[]; dropped: number } {
  const merged = mergeFailures(existing, existingDropped, [reason]);
  if (!merged.list.includes(reason)) merged.list = [...merged.list.slice(0, MAX_STORED_FAILURES - 1), reason];
  return merged;
}

// Consumer: process ONE chunk of a job, persist incremental progress, then
// re-enqueue the next chunk (carrying a continuation cursor) or finalize. One
// chunk per invocation (max_batch_size=1) keeps any account size under the
// per-invocation subrequest ceiling. The whole body is wrapped so any failure
// lands a terminal `failed` state rather than stranding the row.
export async function processBulkJob(msg: BulkJobMessage, env: BulkModerateEnv): Promise<void> {
  if (!env.DB) throw new Error('bulk_jobs storage (D1) is not bound');
  const db = env.DB;
  const msgJobId = bulkJobIdOf(msg);
  let ownedVersion: number | undefined;
  try {
    await ensureBulkJobsTable(db);
    const row = await db.prepare('SELECT * FROM bulk_jobs WHERE job_id = ?').bind(msgJobId).first<BulkJobRow>();
    if (!row) return;                                          // unknown job: nothing to do
    const job = rowToBulkJob(row);
    if (job.status === 'done' || job.status === 'failed') return; // idempotent: already terminal

    const reason = msg.reason || `Bulk ${msg.action} by moderator`;
    const phase: BulkJobPhase = msg.phase ?? (msg.action === 'delete-all' || msg.action === 'delete-kind' ? 'events' : 'media');
    const expectedVersion = msg.version ?? 0;
    const claimedVersion = expectedVersion + 1;

    // Claim this exact chunk version atomically. Concurrent and delayed duplicate
    // deliveries change zero rows and cannot repeat work or fork continuations.
    const claim = await db.prepare(
      `UPDATE bulk_jobs SET status = ?, updated_at = ?, version = version + 1 WHERE version = ? AND job_id = ? AND status IN ('pending','running')`
    ).bind('running', new Date().toISOString(), expectedVersion, msgJobId).run();
    if (!claim.meta?.changes) return;
    ownedVersion = claimedVersion;

    // The claimed row, not the queue message, says what this chunk may touch.
    // A message that disagrees with it on action, author or kind is corrupt or
    // misrouted; fail the job before any relay or ban call.
    const rowKind = row.kind === null || row.kind === undefined ? undefined : Number(row.kind);
    if (msg.action !== row.action || msg.pubkey !== row.pubkey || msg.kind !== rowKind) {
      throw new Error('message does not match its job row (action, pubkey or kind); refusing to act on it');
    }
    // The enqueue accepts only lowercase hex; a row that holds anything else
    // would match no file's owner and report every file as left alone.
    if (!isLowerHex64(msg.pubkey)) {
      throw new Error(`refusing ${JSON.stringify(msg.pubkey)}: not a lowercase hex pubkey`);
    }

    // A loosening job must not run against an account an age review now holds:
    // stop it as `failed` (via the catch below) before this chunk sends anything.
    // A failed lookup stops it the same way, so this fails closed.
    if (LOOSENS_AGE_REVIEW_HOLD[msg.action]) {
      let open: boolean;
      try {
        // anyCase: missing a case stored under an uppercase `p` tag would let
        // this job lift the hold (see getActiveAgeReviewCase).
        open = (await getActiveAgeReviewCase(msg.pubkey, env, { anyCase: true })) !== null;
      } catch (error) {
        throw new Error(`stopped: could not check age-review status for ${msg.pubkey} (${formatError(error)}); no further videos were changed`);
      }
      if (open) {
        throw new Error(`stopped: ${msg.pubkey} is under age review; no further videos were changed`);
      }
    }

    const moderatorPubkey = await getAdminPubkey(env);
    // A delete-kind job's ceiling (see KIND_SWEEP_CEILING_MARGIN_S). A message
    // without one gets one computed now, and it is carried on every continuation
    // like an enqueue-time ceiling, so later sweeps don't re-read "now".
    const ceiling = msg.action === 'delete-kind'
      ? msg.sweepUntil ?? kindSweepCeiling()
      : undefined;
    const scope = jobScope({ ...msg, sweepUntil: ceiling });

    let eventsDelta = 0;
    let mediaDelta = 0;
    let skippedDelta = 0;
    const chunkFailures: string[] = [];
    const chunkNotes: BulkNote[] = [];
    let next: BulkJobMessage | null = null;
    // Set when a delete-kind job's final sweep read from its ceiling, found
    // nothing and recorded nothing: that read disproves earlier gap warnings.
    let disproveListingGaps = false;
    // The job's next message. Every continuation names the job, its author,
    // action and reason; `fields` is what this one carries on from here.
    const continuation = (fields: Omit<BulkJobMessage, 'jobId' | 'kindJobId' | 'pubkey' | 'action' | 'reason'>): BulkJobMessage => ({
      ...bulkJobIdField(msg.action, row.job_id), pubkey: msg.pubkey, action: msg.action, reason, ...fields,
    });

    if (phase === 'events') {
      // Without its kind, a delete-kind page query would list every event.
      if (msg.action === 'delete-kind' && msg.kind === undefined) {
        throw new Error('delete-kind message arrived without a kind; refusing to list every event');
      }
      const isKindJob = msg.action === 'delete-kind';
      const until = msg.cursor ? Number(msg.cursor) : undefined;
      // Every sweep's first page starts from the job's fixed ceiling. Naming
      // `until` explicitly also keeps a kind-0 + authors REQ off funnelcake's
      // profile cache, which can hand back versions this job already banned.
      // delete-all has no ceiling, so its first page names no `until`.
      const askedUntil = until ?? ceiling;
      const page = msg.eventIds
        ? {
          events: msg.eventIds.map(id => ({ id, kind: 0, content: '', tags: [] })),
          nextUntil: until ?? null,
          complete: until === undefined,
          saturated: false,
          outOfScope: 0,
        }
        : await queryRelayEventsPage(msg.pubkey, env, askedUntil, msg.kind);
      // The events phase (a delete-kind sweep, or delete-all's walk) ends only
      // because each page's next `until` is below the one it asked with. A relay
      // that answers above `until` would repeat the page forever, each chunk
      // refreshing updated_at so the stale heal never fires, and the queue's
      // single consumer would stall every later bulk job. Fail the job instead,
      // as the media phase does for a cursor that won't move. (delete-all's first
      // page names no `until`, so the check starts from its second.)
      if (!msg.eventIds && askedUntil !== undefined && page.nextUntil !== null && page.nextUntil >= askedUntil) {
        throw new Error(`relay cursor did not advance for ${msg.pubkey} (asked until ${askedUntil}, got ${page.nextUntil})`);
      }
      // No page follows this one in the listing. For leftover ids, that means
      // the page they came from was the listing's last.
      const pageEnded = page.complete || page.nextUntil === null;
      const startedAt = Date.now();
      const candidates = page.events.slice(0, SERIALIZED_EVENT_BATCH_SIZE);
      const attribution: DecisionAttribution = { moderatorPubkey: msg.moderatorPubkey, reportId: msg.reportId };
      const ev = { processed: 0, successfulEventIds: [] as string[], failures: [] as string[] };
      let attempted = 0;
      while (attempted < candidates.length) {
        if (attempted > 0 && Date.now() - startedAt >= EVENT_BATCH_BUDGET_MS) break;
        const wave = candidates.slice(attempted, attempted + BULK_ACTION_CONCURRENCY);
        const waveResult = await deleteEvents(env, wave, reason, moderatorPubkey, attribution);
        ev.processed += waveResult.processed;
        ev.successfulEventIds.push(...waveResult.successfulEventIds);
        ev.failures.push(...waveResult.failures);
        attempted += wave.length;
      }
      const remainingEventIds = page.events.slice(attempted).map(event => event.id);
      const sweep = msg.sweep ?? 0;
      // These count successful ban calls, not distinct events. A ban the relay
      // is slow to reflect (the event still listed on the next sweep) is banned
      // and counted again then, with another decision row. Accepted: the
      // 20-sweep bound caps the repeats, and a lag that outlasts it is reported.
      const sweepDeleted = (msg.sweepDeleted ?? 0) + ev.processed;
      // Within a sweep, continuations carry its number and running total.
      const sweepFields = isKindJob ? { sweep, sweepDeleted } : {};
      eventsDelta = ev.processed;
      chunkFailures.push(...ev.failures);
      if (page.outOfScope > 0) chunkFailures.push(outOfScopeWarning(msg.pubkey, page.outOfScope));
      if (page.saturated) {
        // More than EVENT_CHUNK_SIZE events share one timestamp; an `until` cursor
        // can't subdivide a second, so some at it may be unprocessed. Surface it.
        chunkFailures.push(sameSecondGapWarning(msg.pubkey, EVENT_CHUNK_SIZE));
      }
      if (!page.complete && page.nextUntil === null) {
        chunkFailures.push(unpaginatedGapWarning(msg.pubkey, 'some events may be unprocessed'));
      }
      if (remainingEventIds.length > 0) {
        next = continuation({
          phase: 'events',
          cursor: page.nextUntil === null ? undefined : String(page.nextUntil),
          eventIds: remainingEventIds,
          ...scope,
          ...sweepFields,
        });
      } else if (pageEnded && isKindJob) {
        // End of a sweep. Funnelcake keeps every version of a replaceable or
        // addressable event and drops banned ids before it picks the newest per
        // coordinate, so banning the newest makes the previous one visible. A
        // sweep that deleted anything is therefore followed by a fresh one from
        // the top; the job ends when a sweep deletes nothing. For a regular
        // kind that costs one empty confirming sweep. A sweep whose bans all
        // failed also ends it: the events stay listed and would only fail again.
        //
        // A kind-scoped job ends with its events: no media phase and no
        // account-level Zendesk sync (each deleted event already synced its own
        // tickets in deleteEvents). It never touches media. Funnelcake's
        // per-user video listing cannot be narrowed to a kind, and a blob is
        // content-addressed, so one file can back events of a kind the
        // moderator chose to keep.
        if (sweepDeleted === 0) {
          next = null;
          // This chunk was the sweep's whole first page and it was empty: nothing
          // of this kind is listed at or below the ceiling, so earlier sweeps'
          // "some may be unprocessed" warnings no longer hold. (An empty page
          // records no failure except an out-of-scope one, which keeps them.)
          // A page that still lists events, whose bans failed, is not that read.
          disproveListingGaps = !msg.cursor && !msg.eventIds && page.events.length === 0
            && page.outOfScope === 0;
        } else if (sweep + 1 >= MAX_KIND_SWEEPS) {
          chunkFailures.push(enumerationWarning(msg.pubkey, `still finding events after ${MAX_KIND_SWEEPS} sweeps; older versions may remain`));
          next = null;
        } else {
          // A new sweep from the top, with its own running total.
          next = continuation({ phase: 'events', ...scope, sweep: sweep + 1, sweepDeleted: 0 });
        }
      } else if (pageEnded) {
        // Events done: one pubkey-level zendesk sync (gated on the job's CUMULATIVE
        // successes, not just this final chunk's -- the last chunk is often an empty
        // short page), then move to the media phase.
        if (job.eventsProcessed + ev.processed > 0) {
          await syncZendeskAfterAction(env, 'delete_event', 'pubkey', msg.pubkey, moderatorPubkey);
        }
        next = continuation({ phase: 'media' });
      } else {
        next = continuation({ phase: 'events', cursor: String(page.nextUntil), ...scope, ...sweepFields });
      }
    } else {
      // The media actions below would DELETE or un-restrict every video on the
      // account. A kind-scoped delete never gets here; fail if a message says so.
      if (msg.action === 'delete-kind') throw new Error('delete-kind has no media phase');

      // Two walks (#299). First blossom's uploader list, by hash: it lists the
      // account's files whatever the relay shows, so it still finds them after
      // this job banned the events, or when the account is banned or
      // suspended. Then funnelcake's video list, for files the uploader list
      // missed. Then the end-of-walk check (recheckOwnedVideos). Only the
      // account's own files are changed (mayChangeMedia). An uploader list
      // that cannot be read sends the walk on to funnelcake's, and says so.
      // The funnelcake walk skips what the uploader list shows, which the
      // blossom walk handled, unless a blossom-walk read failed
      // (`mediaFallback`): then the blossom walk did not handle it, so the
      // funnelcake walk takes every file funnelcake lists.
      //
      // Un-age-restrict All walks funnelcake's list only, as before #299, and
      // ends with reportStillHidden instead of the check.
      //
      // A message without mediaWalk starts the blossom walk from the beginning.
      // That is the first media message, and also a media continuation from a
      // worker that predates this walk, whose funnelcake `cursor` is ignored:
      // the walk restarts, which is idempotent (files already changed read as
      // done and are left alone). Un-age-restrict All keeps that cursor: the
      // older worker walked the same list for it.
      const mediaPage = msg.mediaPage ?? 0;
      const mediaAction = BULK_MEDIA_ACTION[msg.action];
      const relayListOnly = mediaAction === 'SAFE';
      const walk = relayListOnly || msg.mediaWalk === 'funnelcake' ? 'funnelcake' : 'blossom';
      let candidates: string[];
      let pass: MediaPass = 'walk';
      let nextWalk: Pick<BulkJobMessage, 'mediaWalk' | 'mediaAfter' | 'cursor' | 'mediaFallback'> | null;
      if (!relayListOnly && msg.mediaWalk === undefined && msg.cursor !== undefined) {
        console.warn(`[bulk-job] ${msgJobId}: media continuation from an older worker; restarting the file walk from the start`);
      }
      if (walk === 'funnelcake') {
        // Only `true` turns the exclusion off. A message without it comes from
        // a blossom walk that ran to its end; a worker that predates the field
        // sends no funnelcake-walk message at all (it has no mediaWalk), and
        // walks funnelcake's list without any exclusion itself.
        const fallback = msg.mediaFallback === true;
        const [{ hashes, nextCursor }, listed] = await Promise.all([
          queryUserVideosPage(msg.pubkey, env, msg.cursor),
          relayListOnly || fallback
            ? null
            : listAccountVideos(msg.pubkey, env).then((files) => ({ files }), (error: unknown) => ({ error })),
        ]);
        candidates = [...new Set(hashes)];
        if (listed && 'files' in listed) {
          // The blossom walk already handled what the uploader list shows; doing
          // them again here would count each as skipped a second time. Anything
          // listed that it passed over, the end-of-walk check finds.
          const onList = new Set(listed.files.map((file) => file.sha256));
          candidates = candidates.filter((sha256) => !onList.has(sha256));
        } else if (listed) {
          chunkFailures.push(listFallbackWarning(msg.pubkey, formatError(listed.error), { countMayBeOff: true }));
        }
        if (!relayListOnly) pass = 'after-blossom';
        // Parity with the synchronous path: for media-only actions one video ==
        // one event, so the UI's "across N events" stays meaningful (delete-all
        // counts events in its own phase, so leave eventsDelta 0 there).
        if (msg.action !== 'delete-all') eventsDelta = hashes.length;
        nextWalk = nextCursor
          ? { mediaWalk: 'funnelcake', cursor: nextCursor, ...(fallback ? { mediaFallback: true } : {}) }
          : null;
      } else {
        // Re-read every chunk rather than carried in messages: the list is
        // not paged and can be larger than a queue message holds. Walking by
        // hash, not position, is what keeps it exact while each DELETE takes
        // a file off the list. A position this worker could not have written
        // restarts the walk, as an unknown mediaWalk does: compared as a
        // string, it could sort past every hash and skip the walk.
        // TODO(divinevideo/divine-blossom#309): walk by hash with the list's own paging once it pages.
        let after: string | undefined;
        if (msg.mediaWalk === 'blossom' && msg.mediaAfter !== undefined) {
          if (isLowerHex64(msg.mediaAfter)) after = msg.mediaAfter;
          else console.warn(`[bulk-job] ${msgJobId}: media position is not a hash; restarting the file walk from the start`);
        }
        try {
          const remaining = (await listAccountVideos(msg.pubkey, env))
            .map((file) => file.sha256)
            .filter((sha256) => after === undefined || sha256 > after);
          candidates = remaining.slice(0, MEDIA_CHUNK_SIZE);
          nextWalk = remaining.length > MEDIA_CHUNK_SIZE
            ? { mediaWalk: 'blossom', mediaAfter: candidates[candidates.length - 1] }
            : { mediaWalk: 'funnelcake' };
        } catch (error) {
          chunkFailures.push(listFallbackWarning(msg.pubkey, formatError(error), { which: 'the rest', countMayBeOff: true }));
          candidates = [];
          nextWalk = { mediaWalk: 'funnelcake', mediaFallback: true };
        }
      }
      const media = await moderateMediaHashes(env, msg.pubkey, candidates, mediaAction, reason, pass);
      mediaDelta = media.processed;
      skippedDelta = media.skipped;
      chunkFailures.push(...media.failures);
      chunkNotes.push(...media.notes);
      if (!nextWalk) {
        // The last chunk of the walk. Its end runs in the same invocation, so
        // no message shape is added for it.
        if (relayListOnly) {
          const report = await reportStillHidden(env, msg.pubkey);
          chunkFailures.push(...report.failures);
          chunkNotes.push(...report.notes);
        } else {
          const check = await recheckOwnedVideos(env, msg.pubkey, mediaAction, reason);
          mediaDelta += check.processed;
          skippedDelta += check.skipped;
          chunkFailures.push(...check.failures);
          chunkNotes.push(...check.notes);
        }
      }
      if (nextWalk) {
        // Bound the media phase on PAGES FETCHED, not items moderated. mediaProcessed
        // only counts successes, so a cursor that advances forever while the
        // moderation service fails would keep it near zero and never trip a
        // success-based bound -- churning the queue forever (each chunk refreshes
        // updated_at, so the stale-heal can't reclaim it either). Counting pages
        // catches advance-forever and A->B->A cycles regardless of success. The
        // count runs across both walks and is never reset, so a job passed back
        // and forth between this worker and an older one (which restarts its
        // own walk) still ends.
        if (nextWalk.cursor !== undefined && nextWalk.cursor === msg.cursor) {
          throw new Error(`Video cursor did not advance for ${msg.pubkey} (stuck at ${nextWalk.cursor})`);
        }
        if (mediaPage + 1 >= VIDEO_MAX_PAGES) {
          throw new Error(`Video enumeration exceeded ${VIDEO_MAX_PAGES} pages for ${msg.pubkey}; cursor is not terminating`);
        }
        next = continuation({ phase: 'media', ...nextWalk, mediaPage: mediaPage + 1 });
      } else {
        next = null;
      }
    }

    // Notes go to their own table before the row moves on, so a job never
    // reads as finished with its notes still to be written. Storing them is a
    // side effect: if it fails, the job says so and carries on.
    if (chunkNotes.length > 0) {
      const notes = uniqueNotes(chunkNotes);
      const kept = notes.slice(0, MAX_NOTES_PER_WRITE);
      if (notes.length > kept.length) {
        chunkFailures.push(notesOverflowWarning(msg.pubkey, notes.length - kept.length));
      }
      try {
        await storeBulkNotes(db, row.job_id, kept);
      } catch (error) {
        console.error('[bulk-job] could not store notes for', row.job_id, error);
        chunkFailures.push(notesNotStoredWarning(msg.pubkey, kept.length, formatError(error)));
      }
    }

    const status = next ? 'running' : 'done';
    if (next) next.version = claimedVersion;
    const merged = mergeFailures(parseFailuresList(row.failures), Number(row.failures_dropped) || 0, chunkFailures);
    // Only gap warnings go; ban failures and out-of-scope warnings stand. One
    // that had already overflowed the cap stays counted in `dropped`.
    if (disproveListingGaps) merged.list = merged.list.filter((f) => !isListingGapWarning(f));
    // Guard the terminal write on the status we claimed (`running`), and only
    // enqueue the next chunk if this write actually landed. If a concurrent or
    // duplicate chunk already moved the row to a terminal state, changes is 0 and
    // we must NOT send `next` (that would fork the chunk chain).
    const wrote = await db.prepare(
      `UPDATE bulk_jobs SET status = ?, events_processed = ?, media_processed = ?, media_skipped = ?, failures = ?, failures_dropped = ?, updated_at = ? WHERE version = ? AND job_id = ? AND status = 'running'`
    ).bind(
      status,
      job.eventsProcessed + eventsDelta,
      job.mediaProcessed + mediaDelta,
      (job.mediaSkipped ?? 0) + skippedDelta,
      JSON.stringify(merged.list),
      merged.dropped,
      new Date().toISOString(),
      claimedVersion,
      msgJobId,
    ).run();

    if (next && wrote.meta?.changes) await env.BULK_QUEUE!.send(next);
  } catch (error) {
    try {
      // Preserve per-item failures earlier chunks recorded (forensic detail on a
      // destructive path) and append the infra error, rather than clobbering them.
      // Guard on a non-terminal status so this can't resurrect a `done` job.
      const cur = await db.prepare('SELECT failures, failures_dropped FROM bulk_jobs WHERE job_id = ?').bind(msgJobId).first<{ failures: string; failures_dropped: number }>();
      const merged = mergeWithReason(
        cur ? parseFailuresList(cur.failures) : [],
        cur ? Number(cur.failures_dropped) || 0 : 0,
        jobFailure(formatError(error)),
      );
      if (ownedVersion === undefined) {
        console.error('[bulk-job] failed before claiming chunk', msgJobId, error);
        return;
      }
      await db.prepare(`UPDATE bulk_jobs SET status = ?, failures = ?, failures_dropped = ?, updated_at = ? WHERE version = ? AND job_id = ? AND status = 'running'`)
        .bind('failed', JSON.stringify(merged.list), merged.dropped, new Date().toISOString(), ownedVersion, msgJobId).run();
    } catch (writeErr) {
      console.error('[bulk-job] failed to record terminal state for', msgJobId, writeErr);
    }
  }
}

// Status endpoint: the UI polls this until status is terminal (done/failed). If a
// row is stuck in pending/running past STALE_JOB_MS, self-heal it to `failed` so
// the poller never hangs.
//
// Why STALE_JOB_MS rarely fires on a LIVE chunked job: each chunk completes in
// seconds (bounded by the per-invocation subrequest/CPU ceiling) and re-enqueues
// its successor immediately, refreshing updated_at. A ~30-minute gap means the
// continuation was lost, the worker was evicted mid-consume (max_retries=0, so the
// message is gone), or the next message sat undelivered in a queue backlog that
// long -- all treated as abandoned. The status guards make done/failed sticky, so
// this heal only acts on a still-non-terminal row, and if a long-delayed message
// IS later delivered its claim changes zero rows and no-ops -- so healing a
// backlogged job is safe (worst case: the remaining pages are dropped and the
// moderator re-runs; all actions are idempotent). Recovering the dropped
// continuation automatically is separate work: TODO(#319).
export async function handleBulkJobStatus(
  jobId: string,
  env: BulkModerateEnv,
  corsHeaders: Record<string, string>,
): Promise<Response> {
  if (!env.DB) {
    return json({ error: 'bulk_jobs storage (D1) is not bound' }, 500, corsHeaders);
  }
  await ensureBulkJobsTable(env.DB);
  const row = await env.DB.prepare('SELECT * FROM bulk_jobs WHERE job_id = ?').bind(jobId).first<BulkJobRow>();
  if (!row) {
    return json({ error: 'job not found' }, 404, corsHeaders);
  }

  const job = rowToBulkJob(row);
  if ((job.status === 'pending' || job.status === 'running') && Date.parse(job.updatedAt) < Date.now() - STALE_JOB_MS) {
    // Append the abandonment note to the failures the consumer already recorded
    // (don't overwrite them), and preserve the cumulative dropped count.
    const merged = mergeWithReason(
      parseFailuresList(row.failures), Number(row.failures_dropped) || 0,
      jobFailure(ABANDONED_REASON),
    );
    job.status = 'failed';
    job.failures = failuresForDisplay(merged.list, merged.dropped);
    job.updatedAt = new Date().toISOString();
    await env.DB.prepare(`UPDATE bulk_jobs SET status = ?, failures = ?, failures_dropped = ?, updated_at = ? WHERE job_id = ? AND status IN ('pending','running')`)
      .bind(job.status, JSON.stringify(merged.list), merged.dropped, job.updatedAt, jobId).run().catch(() => {});
  }
  // How many notes to read back, once the job has ended (the UI shows them
  // then). Left out if the count fails: the UI then reads the notes route,
  // which reports its own error.
  if (job.status === 'done' || job.status === 'failed') {
    try {
      const counted = await env.DB.prepare('SELECT COUNT(*) AS n FROM bulk_job_notes WHERE job_id = ?').bind(jobId).first<{ n: number }>();
      job.noteCount = Number(counted?.n ?? 0);
    } catch (error) {
      console.error('[bulk-job] could not count notes for', jobId, error);
    }
  }
  return json(job, 200, corsHeaders);
}

type RawRelayEvent = { id: string; pubkey?: string; kind: number; content?: string; tags: string[][]; created_at?: number };

export async function queryRelayEvents(
  pubkey: string,
  env: Pick<BulkModerateEnv, 'RELAY_URL'>,
): Promise<{ events: RelayEventSummary[]; complete: boolean; outOfScope: number }> {
  return collectRelayEvents(pubkey, env, (event) => ({
    id: event.id, kind: event.kind, content: event.content || '', tags: event.tags,
  }));
}

// Time budget for the kind-counts listing. The dialog's request gives up after
// KIND_COUNTS_REQUEST_TIMEOUT_MS, and a large account can need more pages than
// that; stopping here returns a lower bound ("at least N") instead of a timeout
// the dialog can't use.
export const KIND_COUNT_BUDGET_MS = 20_000;

// Per-kind counts for one author, from the same paged listing the synchronous
// bulk path uses; a lower bound when `complete` is false (time budget, page
// bound, or a second too full to page past). Keeps only each event's kind, so
// a prolific account's content and tags are never held in memory.
export async function countRelayEventKinds(
  pubkey: string,
  env: Pick<BulkModerateEnv, 'RELAY_URL'>,
  budgetMs: number = KIND_COUNT_BUDGET_MS,
): Promise<BulkKindCounts> {
  // Listed under the same ceiling a delete-kind job would use, so the count and
  // the delete look at the same events: one never counts what the other
  // can't reach.
  const until = kindSweepCeiling();
  const { events: kinds, complete, outOfScope } = await collectRelayEvents(pubkey, env, (event) => event.kind, { budgetMs, until });
  // Not counted; the response has no failure list, so note it in the log.
  if (outOfScope > 0) console.warn(`[bulk-moderate] kind counts for ${pubkey}: relay returned ${outOfScope} event(s) of another author; not counted`);
  const counts: Record<string, number> = {};
  for (const kind of kinds) counts[kind] = (counts[kind] ?? 0) + 1;
  return { counts, complete };
}

// GET /api/bulk-moderate/kind-counts?pubkey=: the by-kind delete dialog's
// breakdown. A failed listing is a 502, never an empty (zero) count.
export async function handleBulkKindCounts(
  pubkey: string | null,
  env: Pick<BulkModerateEnv, 'RELAY_URL'>,
  corsHeaders: Record<string, string>,
  budgetMs: number = KIND_COUNT_BUDGET_MS,
): Promise<Response> {
  if (!pubkey || !/^[0-9a-f]{64}$/.test(pubkey)) {
    return json({ error: 'Valid 64-char hex pubkey required' }, 400, corsHeaders);
  }
  try {
    return json(await countRelayEventKinds(pubkey, env, budgetMs), 200, corsHeaders);
  } catch (error) {
    console.error('[bulk-moderate] kind counts failed for', pubkey, error);
    // Only the cause: the dialog supplies its own "Could not count..." lead-in.
    return json({ error: formatError(error) }, 502, corsHeaders);
  }
}

// Pages through every event an author has (until cursoring, deduped by id) and
// keeps `project(event)` for each. `complete` is false when the listing was cut
// short (page bound, or a second too full to page past). An event of another
// author is never kept, only counted in `outOfScope`, whatever the relay sends.
//
// `budgetMs`, when given, stops paging once that much time has passed and
// reports the listing as incomplete. `until`, when given, caps the first page.
async function collectRelayEvents<T>(
  pubkey: string,
  env: Pick<BulkModerateEnv, 'RELAY_URL'>,
  project: (event: RawRelayEvent) => T,
  opts: { budgetMs?: number; until?: number } = {},
): Promise<{ events: T[]; complete: boolean; outOfScope: number }> {
  type Result = { events: T[]; complete: boolean; outOfScope: number };
  const startedAt = Date.now();
  return new Promise((resolve, reject) => {
    try {
      const ws = new WebSocket(env.RELAY_URL);
      let resolved = false;
      const byId = new Map<string, T>(); // dedup across pages (until boundary overlaps)
      let page = 0;
      let currentSub = '';
      let pageEvents = 0;        // events seen in the current page
      let pageStartSize = 0;     // byId.size at page start -> detects whether the page added anything new
      let pageOldest = Infinity; // min created_at in the current page -> next `until`
      let incomplete = false;    // true if the relay could not be fully paginated (surfaced to caller)
      let timeout: ReturnType<typeof setTimeout>;

      const finish = (fn: ((v: Result) => void) | ((e: Error) => void), value: Result | Error) => {
        if (resolved) return;
        resolved = true;
        clearTimeout(timeout);
        ws.close();
        (fn as (value: Result | Error) => void)(value);
      };
      let outOfScope = 0;        // events of another author the relay returned; never kept
      const done = () => finish(resolve, { events: Array.from(byId.values()), complete: !incomplete, outOfScope });

      const armTimeout = () => {
        clearTimeout(timeout);
        // Per-page: a prolific account legitimately needs many pages; only a
        // stalled page (no EOSE within the window) is a failure. Under a time
        // budget, a page that stalls after earlier pages completed keeps what
        // they listed and reports the listing as incomplete.
        timeout = setTimeout(() => {
          if (opts.budgetMs !== undefined && page > 1) {
            incomplete = true;
            console.warn(`[bulk-moderate] page ${page} of the listing for ${pubkey} timed out; returning a partial set`);
            done();
            return;
          }
          finish(reject, new Error('Relay query timed out before EOSE'));
        }, RELAY_QUERY_TIMEOUT_MS);
      };

      const sendPage = (until?: number) => {
        // Under a time budget, start a page only if it can finish inside it,
        // allowing for its own timeout. Stopping here returns what is listed.
        if (opts.budgetMs !== undefined && Date.now() - startedAt + RELAY_QUERY_TIMEOUT_MS >= opts.budgetMs) {
          incomplete = true;
          console.warn(`[bulk-moderate] listing for ${pubkey} stopped before page ${page + 1} to stay inside its ${opts.budgetMs}ms budget; returning a partial set`);
          done();
          return;
        }
        page += 1;
        currentSub = `bulk-${Date.now()}-${page}`;
        pageEvents = 0;
        pageOldest = Infinity;
        pageStartSize = byId.size;
        const filter: { authors: string[]; limit: number; until?: number } = { authors: [pubkey], limit: RELAY_QUERY_PAGE_SIZE };
        if (until !== undefined) filter.until = until;
        armTimeout();
        ws.send(JSON.stringify(['REQ', currentSub, filter]));
      };

      // Bound the connect too: until 'open', nothing else would time it out.
      armTimeout();
      ws.addEventListener('open', () => sendPage(opts.until));

      ws.addEventListener('message', (msg) => {
        try {
          const data = JSON.parse(msg.data as string);
          if (data[0] === 'EVENT' && data[1] === currentSub) {
            const event = data[2] as RawRelayEvent;
            pageEvents += 1;
            // Still counts toward the page's size and timestamps (the relay's
            // pagination), but is never kept for a caller to ban or count.
            if (event.pubkey !== pubkey) {
              outOfScope += 1;
            } else if (!byId.has(event.id)) {
              byId.set(event.id, project(event));
            }
            if (typeof event.created_at === 'number' && event.created_at < pageOldest) pageOldest = event.created_at;
          } else if (data[0] === 'CLOSED' && data[1] === currentSub) {
            // The relay refused or failed the query: fail now, with its reason,
            // rather than wait out the page timeout and report a timeout.
            finish(reject, new Error(`Relay closed the query: ${String(data[2] ?? 'no reason given')}`));
          } else if (data[0] === 'EOSE' && data[1] === currentSub) {
            ws.send(JSON.stringify(['CLOSE', currentSub]));
            // Last page reached: a partial page means the relay has no more events.
            if (pageEvents < RELAY_QUERY_PAGE_SIZE) {
              done();
              return;
            }
            if (page >= RELAY_QUERY_MAX_PAGES) {
              // Bound coverage rather than loop forever; surface it (not silent).
              incomplete = true;
              console.warn(`[bulk-moderate] hit RELAY_QUERY_MAX_PAGES (${RELAY_QUERY_MAX_PAGES}, ~${page * RELAY_QUERY_PAGE_SIZE} events) for ${pubkey}; returning a partial set`);
              done();
              return;
            }
            // Progress guard: a full page that added no new ids means the `until`
            // cursor is stuck -- more than one page of events share a single
            // created_at second (an inclusive `until` cannot subdivide a second),
            // or the events carry no created_at. Surface incompleteness, and where
            // we can, step strictly past the saturated second so we still
            // enumerate everything older instead of looping to the page bound.
            if (byId.size === pageStartSize) {
              incomplete = true;
              if (pageOldest === Infinity) {
                console.warn(`[bulk-moderate] relay events lack created_at; cannot paginate further for ${pubkey}; returning a partial set`);
                done();
                return;
              }
              console.warn(`[bulk-moderate] more than one page of events share created_at=${pageOldest} for ${pubkey}; skipping past that second (some events at it may be unprocessed)`);
              sendPage(pageOldest - 1);
              return;
            }
            // Page through older events. `until` is inclusive so the boundary
            // timestamp may repeat; the byId map dedups it.
            sendPage(pageOldest === Infinity ? undefined : pageOldest);
          }
        } catch {
          // Ignore malformed relay frames and continue collecting.
        }
      });

      ws.addEventListener('error', () => {
        finish(reject, new Error('Relay query failed'));
      });

      ws.addEventListener('close', () => {
        finish(reject, new Error('Relay query closed before EOSE'));
      });
    } catch (error) {
      reject(error);
    }
  });
}

// One chunk of a user's events via a single relay REQ bounded by `until`.
//
// Pagination correctness on a destructive path: a relay returns the newest
// EVENT_CHUNK_SIZE events with created_at <= until, in descending time. On a FULL
// page the oldest second is at the cut boundary -- there may be more events at that
// exact second that didn't fit. Stepping strictly past it (oldest - 1) would
// silently drop them. So on a multi-second full page we DEFER the boundary
// (oldest) second entirely: process only events strictly newer than `oldest` and
// set nextUntil = oldest (inclusive) so the next chunk re-fetches that whole
// second fresh. No event is processed twice (the boundary second is excluded here,
// processed next chunk) and none is skipped.
//
// The one unavoidable case: a SINGLE second holding more than EVENT_CHUNK_SIZE
// events (min === max on a full page). An `until` cursor cannot subdivide a
// second, so we process this page, step past (oldest - 1), and set
// `saturated: true` so the consumer SURFACES the gap (never silent). This is the
// same step collectRelayEvents' progress guard takes.
//
// `kind` narrows the REQ to that one event kind (a kind-scoped delete job). For
// a replaceable or addressable kind the relay lists only each coordinate's
// newest version, so a short page is not the end: the page steps strictly below
// its oldest event (`complete: false`) and an empty page ends the walk.
//
// Whatever the relay sends, the page holds each event id once, and an event
// outside the requested author or kind is never returned to be banned; it is
// only counted in `outOfScope`, and still counts toward the page's size and
// timestamps, which are the relay's pagination.
export async function queryRelayEventsPage(
  pubkey: string,
  env: Pick<BulkModerateEnv, 'RELAY_URL'>,
  until?: number,
  kind?: number,
): Promise<{ events: RelayEventSummary[]; nextUntil: number | null; complete: boolean; saturated: boolean; outOfScope: number }> {
  type Page = { events: RelayEventSummary[]; nextUntil: number | null; complete: boolean; saturated: boolean; outOfScope: number };
  return new Promise((resolve, reject) => {
    try {
      const ws = new WebSocket(env.RELAY_URL);
      let resolved = false;
      // `inScope` is false for an event the relay returned outside the requested
      // author or kind. It still counts toward the page's size and timestamps (the
      // relay's pagination), but it is never handed to the caller to ban.
      const collected: Array<{ summary: RelayEventSummary; createdAt: number | null; inScope: boolean }> = [];
      const seenIds = new Set<string>();
      const subId = `bulk-page-${Date.now()}`;
      const timeout = setTimeout(() => finish(reject, new Error('Relay query timed out before EOSE')), RELAY_QUERY_TIMEOUT_MS);
      const finish = (fn: ((v: Page) => void) | ((e: Error) => void), value: Page | Error) => {
        if (resolved) return;
        resolved = true;
        clearTimeout(timeout);
        ws.close();
        (fn as (value: Page | Error) => void)(value);
      };
      ws.addEventListener('open', () => {
        const filter: { authors: string[]; kinds?: number[]; limit: number; until?: number } = { authors: [pubkey], limit: EVENT_CHUNK_SIZE };
        if (kind !== undefined) filter.kinds = [kind];
        if (until !== undefined) filter.until = until;
        ws.send(JSON.stringify(['REQ', subId, filter]));
      });
      ws.addEventListener('message', (msg) => {
        try {
          const data = JSON.parse((msg as MessageEvent).data as string);
          if (data[0] === 'EVENT' && data[1] === subId) {
            const e = data[2] as RawRelayEvent;
            // One entry per event id, as collectRelayEvents keeps with byId: a
            // relay that repeats a frame must not get the event banned and
            // counted twice.
            if (seenIds.has(e.id)) return;
            seenIds.add(e.id);
            collected.push({
              summary: { id: e.id, kind: e.kind, content: e.content || '', tags: e.tags },
              createdAt: typeof e.created_at === 'number' ? e.created_at : null,
              inScope: e.pubkey === pubkey && (kind === undefined || e.kind === kind),
            });
          } else if (data[0] === 'CLOSED' && data[1] === subId) {
            // As in collectRelayEvents: the relay's refusal fails the page now.
            finish(reject, new Error(`Relay closed the query: ${String(data[2] ?? 'no reason given')}`));
          } else if (data[0] === 'EOSE' && data[1] === subId) {
            ws.send(JSON.stringify(['CLOSE', subId]));
            const outOfScope = collected.filter((c) => !c.inScope).length;
            const all = collected.filter((c) => c.inScope).map((c) => c.summary);
            if (collected.length < EVENT_CHUNK_SIZE) {
              // For a replaceable or addressable kind the relay lists only the
              // newest version of each coordinate, so a short page is not the end:
              // older versions sit below it. Step strictly under its oldest event
              // and keep walking; an empty page ends the walk. Versions this skips
              // (two at one second, or another coordinate's between steps) are left
              // for the next sweep.
              const shortTimes = collected.map((c) => c.createdAt).filter((t): t is number => t !== null);
              // Nothing is older than created_at 0, so a step below it ends the walk.
              const below = Math.min(...shortTimes) - 1;
              if (kind !== undefined && isVersionedKind(kind) && shortTimes.length > 0 && below >= 0) {
                finish(resolve, { events: all, nextUntil: below, complete: false, saturated: false, outOfScope });
                return;
              }
              // Partial page: the relay has no more events at or before `until`.
              finish(resolve, { events: all, nextUntil: null, complete: true, saturated: false, outOfScope });
              return;
            }
            const times = collected.map((c) => c.createdAt).filter((t): t is number => t !== null);
            if (times.length === 0) {
              // Full page with no usable created_at: cannot advance the cursor.
              finish(resolve, { events: all, nextUntil: null, complete: false, saturated: false, outOfScope });
              return;
            }
            const oldest = Math.min(...times);
            const newest = Math.max(...times);
            if (oldest === newest) {
              // Entire full page is one second -> more events at it were cut off and
              // an `until` cursor can't subdivide. Process this page, step strictly
              // past, and surface the unavoidable gap.
              finish(resolve, { events: all, nextUntil: oldest - 1, complete: false, saturated: true, outOfScope });
              return;
            }
            // Multi-second full page: defer the boundary (oldest) second to the next
            // chunk so we never process or skip a partial second at the cut.
            const kept = collected
              .filter((c) => c.inScope && (c.createdAt === null || c.createdAt > oldest))
              .map((c) => c.summary);
            finish(resolve, { events: kept, nextUntil: oldest, complete: false, saturated: false, outOfScope });
          }
        } catch { /* ignore malformed frames */ }
      });
      ws.addEventListener('error', () => finish(reject, new Error('Relay query failed')));
      ws.addEventListener('close', () => finish(reject, new Error('Relay query closed before EOSE')));
    } catch (error) {
      reject(error);
    }
  });
}

const MEDIA_CHUNK_SIZE = 100; // funnelcake v2 max page; also the blossom walk's chunk
const VIDEO_QUERY_TIMEOUT_MS = 10000; // per page
export const VIDEO_MAX_PAGES = 100000; // anti-runaway guard for a non-terminating cursor (~10M videos)

// One page of a user's video media hashes via the funnelcake v2 cursor API.
// v2 serializes the { data, pagination } envelope (PaginatedResponse<T> in
// funnelcake's crates/api/src/handlers.rs) -- the cursor is at
// `pagination.next_cursor`, NOT top-level. Reading it from the wrong place makes
// next_cursor always null, silently capping enumeration at the first page (100
// videos) and reporting success -- the exact under-enforcement this path fixes.
// v2's opaque cursor walks an account of any size (v1 offset degrades + can
// skip/repeat). funnelcake's deduped view returns every video it shows (vs the
// WebSocket REQ's ~1/kind, funnelcake#471), which leaves out a banned event's
// and every video of a banned or suspended account (#299; listAccountVideos in
// media-server.ts is the list bulk relies on). deriveFunnelcakeApiUrl honors
// FUNNELCAKE_API_URL when the REST and relay hosts diverge; the timeout stops a
// hung endpoint stalling moderation.
export async function queryUserVideosPage(
  pubkey: string,
  env: Pick<BulkModerateEnv, 'RELAY_URL' | 'FUNNELCAKE_API_URL'>,
  cursor?: string,
): Promise<{ hashes: string[]; nextCursor: string | null }> {
  const baseUrl = deriveFunnelcakeApiUrl(env.RELAY_URL, env.FUNNELCAKE_API_URL);
  const qs = new URLSearchParams({ limit: String(MEDIA_CHUNK_SIZE) });
  if (cursor) qs.set('cursor', cursor);
  const res = await fetch(`${baseUrl}/api/v2/users/${pubkey}/videos?${qs.toString()}`, {
    signal: AbortSignal.timeout(VIDEO_QUERY_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`Video query failed: ${res.status}`);
  const body = await res.json() as {
    data?: Array<{ sha256?: string }>;
    pagination?: { next_cursor?: string | null };
  };
  const data = body.data ?? [];
  if (!Array.isArray(data)) {
    throw new Error(`Video page returned a non-array data field for ${pubkey}; response shape may have changed`);
  }
  const hashes: string[] = [];
  for (const v of data) {
    if (v.sha256 && isHex64(v.sha256)) hashes.push(v.sha256.toLowerCase());
  }
  if (data.length > 0 && hashes.length === 0) {
    // Rows present but none carried a usable sha256: the response shape drifted.
    // Treating zero hashes as a clean page would under-action on a withhold path.
    throw new Error(`Video page returned ${data.length} rows with no valid sha256 for ${pubkey}; response shape may have changed`);
  }
  return { hashes, nextCursor: body.pagination?.next_cursor ?? null };
}

// Fully enumerate a user's video media hashes (loops the v2 cursor, deduped). Used
// by the SYNCHRONOUS age-review path; the async UI path chunks per page instead.
export async function queryUserMediaHashes(
  pubkey: string,
  env: Pick<BulkModerateEnv, 'RELAY_URL' | 'FUNNELCAKE_API_URL'>,
): Promise<string[]> {
  const hashes = new Set<string>();
  let cursor: string | undefined;
  for (let page = 0; page < VIDEO_MAX_PAGES; page++) {
    const { hashes: pageHashes, nextCursor } = await queryUserVideosPage(pubkey, env, cursor);
    pageHashes.forEach((h) => hashes.add(h));
    if (!nextCursor) return Array.from(hashes);
    cursor = nextCursor;
  }
  throw new Error(`Video cursor did not terminate for ${pubkey} after ${VIDEO_MAX_PAGES} pages`);
}

async function runWithConcurrency<T>(
  items: T[],
  concurrency: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  for (let i = 0; i < items.length; i += concurrency) {
    await Promise.all(items.slice(i, i + concurrency).map(worker));
  }
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function callModerateMedia(
  sha256: string,
  action: string,
  reason: string,
  env: BulkModerateEnv,
): Promise<void> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };

  if (env.SERVICE_API_TOKEN) {
    const token = typeof env.SERVICE_API_TOKEN === 'string'
      ? env.SERVICE_API_TOKEN
      : await env.SERVICE_API_TOKEN.get();
    if (token) headers['Authorization'] = `Bearer ${token}`;
  }

  const body = JSON.stringify({ sha256, action, reason, source: 'relay-manager-bulk' });

  if (env.MODERATION_API) {
    const response = await env.MODERATION_API.fetch('https://moderation-api.divine.video/api/v1/moderate', {
      method: 'POST', headers, body,
    });
    if (!response.ok) throw new Error(`Moderation service returned ${response.status}`);
  } else if (env.MODERATION_ADMIN_URL) {
    const response = await fetch(`${env.MODERATION_ADMIN_URL}/api/v1/moderate`, {
      method: 'POST', headers, body,
    });
    if (!response.ok) throw new Error(`Moderation service returned ${response.status}`);
  } else {
    throw new Error('No moderation service configured');
  }
}
