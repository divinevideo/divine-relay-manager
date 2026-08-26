import {
  type AgeReviewCase,
  type AgeReviewState,
  type AgeBand,
  AGE_BANDS,
  AGE_REVIEW_STATES,
  TERMINAL_STATES,
  ACCOUNT_RESTRICTED_AGE_REVIEW_STATES,
  foldByState,
  VALID_TRANSITIONS,
  isAccountRestrictedAgeReviewState,
  DEADLINE_DAYS,
  defaultResolutionForBand,
  type EnforcementLegStatus,
  type AgeReviewEnforcement,
  type AgeReviewCaseResponse,
  type FunnelModerationCounts,
  type AgeReviewFunnelResponse,
  FUNNEL_ZENDESK_QUERIES,
} from '../../shared/age-review';
import { runBulkModeration, type BulkModerateEnv } from './bulk-moderate';
import { resolveZendeskCreds } from './zendesk-sync';
import type { BulkAction } from '../../shared/bulk-moderation';
import { suspendUser, unsuspendUser, banUser, clearVerifiedMinor, createMinorAccount, type KeycastEnv } from './keycast-client';
import { suspendPubkey, unsuspendPubkey, banPubkey, type SecretStoreSecret } from './nip86';
import { buildAgeReviewIdentityBlock, buildClaimedParentName, toNpub } from './report-note';
import {
  clearSubject,
  fingerprintProvisioningRequest,
  markProjectionAttempt,
  markProjectionComplete,
  pendingProjectionJobs,
  pendingSubjectClears,
  UUID_RE,
} from './protected-minors';

/**
 * The identity a case captured at creation, as stored on `age_review_cases`.
 * Every field is optional: capture is best-effort, and an account that had no
 * profile -- or whose profile was already hidden by enforcement -- yields none.
 */
type AgeReviewCaseIdentity = Pick<
  Partial<AgeReviewCase>,
  'account_name' | 'account_nip05' | 'account_vine_username'
>;

export interface AgeReviewEnv extends BulkModerateEnv, KeycastEnv {
  SLACK_WEBHOOK_URL?: string;
  ZENDESK_SUBDOMAIN?: string | SecretStoreSecret;
  ZENDESK_API_TOKEN?: string | SecretStoreSecret;
  ZENDESK_EMAIL?: string | SecretStoreSecret;
  ZENDESK_FIELD_CATEGORY?: string;
  ZENDESK_FIELD_ISSUE?: string;
  ZENDESK_FIELD_AGE_REVIEW_DEADLINE?: string;
  // Group to route resolved tickets to (the Trust & Safety queue), instead of
  // assigning the API credential's owner. Numeric Zendesk group id as a string.
  ZENDESK_GROUP_ID?: string;
  // Identity domain used to derive an account's NIP-05 from its username on the
  // operator-created path. Environment-specific: staging accounts do not live
  // under the production domain.
  NIP05_DOMAIN?: string;
}

interface ZendeskClientConfig {
  auth: string;
  baseUrl: string;
  email: string;
}

// ---------------------------------------------------------------------------
// Admin API handlers (behind verifyAdminAccess)
// ---------------------------------------------------------------------------

export async function handleGetAgeReviewCases(
  request: Request,
  env: AgeReviewEnv,
  corsHeaders: Record<string, string>,
): Promise<Response> {
  if (!env.DB) return json({ success: false, error: 'Database not configured' }, 500, corsHeaders);

  const url = new URL(request.url);
  const stateFilter = url.searchParams.get('state');
  const bandFilter = url.searchParams.get('age_band');

  let query = 'SELECT * FROM age_review_cases';
  const conditions: string[] = [];
  const binds: string[] = [];

  if (stateFilter === 'active') {
    conditions.push(`state NOT IN (${TERMINAL_STATES.map(() => '?').join(',')})`);
    binds.push(...TERMINAL_STATES);
  } else if (stateFilter === 'closed') {
    conditions.push(`state IN (${TERMINAL_STATES.map(() => '?').join(',')})`);
    binds.push(...TERMINAL_STATES);
  } else if (stateFilter && AGE_REVIEW_STATES.includes(stateFilter as AgeReviewState)) {
    conditions.push('state = ?');
    binds.push(stateFilter);
  }

  if (bandFilter && AGE_BANDS.includes(bandFilter as AgeBand)) {
    conditions.push('suspected_age_band = ?');
    binds.push(bandFilter);
  }

  if (conditions.length > 0) {
    query += ' WHERE ' + conditions.join(' AND ');
  }
  query += ' ORDER BY deadline_at ASC LIMIT 500';

  const result = await env.DB.prepare(query).bind(...binds).all<AgeReviewCase>();
  return json({ success: true, cases: result.results }, 200, corsHeaders);
}

/**
 * Per-state case counts for the moderator queue — one `GROUP BY state` over the
 * whole table (age-band scoped to match the list). Returned as `by_state` so the
 * queue's tab totals and drill-down chip counts are exact regardless of the
 * list query's LIMIT 500, which a client-side tally over the list could not be.
 */
export async function handleGetAgeReviewCaseCounts(
  request: Request,
  env: AgeReviewEnv,
  corsHeaders: Record<string, string>,
): Promise<Response> {
  if (!env.DB) return json({ success: false, error: 'Database not configured' }, 500, corsHeaders);

  const bandFilter = new URL(request.url).searchParams.get('age_band');
  let query = 'SELECT state, COUNT(*) AS n FROM age_review_cases';
  const binds: string[] = [];
  if (bandFilter && AGE_BANDS.includes(bandFilter as AgeBand)) {
    query += ' WHERE suspected_age_band = ?';
    binds.push(bandFilter);
  }
  query += ' GROUP BY state';

  const result = await env.DB.prepare(query).bind(...binds).all<{ state: string; n: number }>();
  return json({ success: true, by_state: foldByState(result.results ?? []) }, 200, corsHeaders);
}

export async function handleGetAgeReviewCase(
  caseId: string,
  env: AgeReviewEnv,
  corsHeaders: Record<string, string>,
): Promise<Response> {
  if (!env.DB) return json({ success: false, error: 'Database not configured' }, 500, corsHeaders);

  const row = await env.DB.prepare('SELECT * FROM age_review_cases WHERE id = ?')
    .bind(caseId).first<AgeReviewCase>();

  if (!row) return json({ success: false, error: 'Case not found' }, 404, corsHeaders);
  return json({ success: true, case: row }, 200, corsHeaders);
}

/**
 * Returns the single active (non-terminal) age-review case for a pubkey, or
 * null. ReportWatcher guarantees at most one active case per pubkey, so this is
 * unambiguous. Shared by the by-pubkey lookup endpoint and the relay-RPC guard.
 */
export async function getActiveAgeReviewCase(
  pubkey: string,
  env: AgeReviewEnv,
): Promise<AgeReviewCase | null> {
  if (!env.DB) return null;
  const row = await env.DB.prepare(`
    SELECT * FROM age_review_cases
    WHERE pubkey = ? AND state NOT IN (${TERMINAL_STATES.map(() => '?').join(',')})
    LIMIT 1
  `).bind(pubkey, ...TERMINAL_STATES).first<AgeReviewCase>();
  return row ?? null;
}

/**
 * Refuse-and-route guard shared by the interactive enforcement endpoints
 * (relay-rpc suspend/unsuspend/unban, bulk-moderate enqueue): if the pubkey has
 * an open (non-terminal) age-review case, returns a structured 409
 * (`age_review_active` + caseId/state) that the frontend turns into a redirect
 * to the case; returns null when nothing blocks the action.
 *
 * Fails open by default: the guard is a safety net (the report hand-off is the
 * primary path), so a transient D1 error must not block core moderation — log
 * and proceed. Age-review's own enforcement calls the nip86 helpers /
 * runBulkModeration directly, so it never hits the guarded endpoints.
 *
 * `failClosed` inverts that for the REVERSAL direction, where the default is
 * the wrong trade. Failing open on a suspend over-enforces: visible, and
 * undone by the moderator who did it. Failing open on an unsuspend or unban
 * silently LIFTS a minor-safety hold while reporting success, so nobody learns
 * the check never ran — and those calls now arrive from automation rather than
 * a human who might notice. The cost is that a real outage blocks reversals
 * entirely, which is accepted: an outage long enough to matter is not tenable
 * and has to be fixed rather than papered over. `banpubkey` is unguarded, so
 * severe enforcement still works throughout.
 *
 * Under `failClosed` there are two ways the check "cannot happen", and both
 * refuse identically: no DB binding, and a thrown lookup. A non-canonical pubkey
 * is NOT one of them: no case can be keyed to a value the lookup could never
 * match, so there is nothing to refuse on its behalf.
 *
 * `failClosed` is opt-in PER CALL SITE, not a property of the guard. Only
 * relay-rpc's reversals pass it today; bulk-moderate deliberately does not, for
 * reasons recorded at its call site in index.ts.
 */
export async function ageReviewActiveGuard(
  pubkey: string,
  env: AgeReviewEnv,
  corsHeaders: Record<string, string>,
  error: string,
  opts: { failClosed?: boolean } = {},
): Promise<Response | null> {
  // 503, not 409: "could not check" is a different answer from "there is a
  // case", and 5xx is the retryable class. No caseId/state, since neither is
  // known.
  const cannotCheck = () => json({
    success: false,
    error: 'Could not check age-review status. Try again.',
    code: 'age_review_check_failed',
  }, 503, corsHeaders);

  // A non-canonical pubkey proceeds in both modes, and that is not the same
  // omission the earlier version made. It skipped on the stated grounds that the
  // caller validates, which no caller did. The reason now is that there is nothing
  // here to protect: a case is keyed to a real lowercase pubkey, so a value that
  // cannot match one cannot be hiding an open case either. Refusing would only
  // block the reverse direction, which deliberately carries such values so a row
  // banned with one stays removable (see handleRelayRpc).
  //
  // The enforce direction does not reach this: handleRelayRpc answers those with a
  // 400 first, since a ban on a value the relay cannot match enforces on nobody.
  if (!/^[0-9a-f]{64}$/.test(pubkey)) return null;

  // A missing binding is the check not happening, so it refuses under
  // failClosed exactly as a thrown lookup does. Handling only the throw would
  // leave the PERSISTENT failure lifting holds while the transient one refused,
  // which is the wrong way round. Every deployment binds DB (wrangler prod,
  // staging and local), so this costs real traffic nothing.
  if (!env.DB) {
    if (opts.failClosed) {
      console.error('[ageReviewActiveGuard] no DB binding; refusing (fail-closed)');
      return cannotCheck();
    }
    return null;
  }

  let activeCase: AgeReviewCase | null = null;
  try {
    activeCase = await getActiveAgeReviewCase(pubkey, env);
  } catch (err) {
    if (opts.failClosed) {
      console.error('[ageReviewActiveGuard] lookup failed; refusing (fail-closed):', err);
      return cannotCheck();
    }
    console.error('[ageReviewActiveGuard] lookup failed; proceeding:', err);
  }
  if (!activeCase) return null;
  return json({
    success: false,
    error,
    code: 'age_review_active',
    caseId: activeCase.id,
    state: activeCase.state,
  }, 409, corsHeaders);
}

/**
 * GET /api/age-review/active-case?pubkey=<hex>
 *
 * Returns the active (non-terminal) age-review case for a pubkey, or null.
 * Read-only. Powers the report hand-off deep-link, the Ban warning, and the
 * relay-RPC guard-response rendering.
 */
export async function handleGetActiveAgeReviewCase(
  pubkey: string,
  env: AgeReviewEnv,
  corsHeaders: Record<string, string>,
): Promise<Response> {
  // Pubkeys are canonical lowercase hex and the stored column is case-sensitive,
  // so validate case-sensitively (a mixed-case value would pass a case-
  // insensitive check but miss the lowercased row). Validate before the DB
  // check so a malformed pubkey is a 400, not a 500.
  if (!/^[0-9a-f]{64}$/.test(pubkey)) {
    return json({ success: false, error: 'Invalid pubkey' }, 400, corsHeaders);
  }
  if (!env.DB) return json({ success: false, error: 'Database not configured' }, 500, corsHeaders);
  const row = await getActiveAgeReviewCase(pubkey, env);
  return json({ success: true, case: row }, 200, corsHeaders);
}

export async function handleUpdateAgeReviewCase(
  request: Request,
  caseId: string,
  env: AgeReviewEnv,
  corsHeaders: Record<string, string>,
): Promise<Response> {
  if (!env.DB) return json({ success: false, error: 'Database not configured' }, 500, corsHeaders);

  const existing = await env.DB.prepare('SELECT * FROM age_review_cases WHERE id = ?')
    .bind(caseId).first<AgeReviewCase>();
  if (!existing) return json({ success: false, error: 'Case not found' }, 404, corsHeaders);

  if (TERMINAL_STATES.includes(existing.state as AgeReviewState)) {
    return json({ success: false, error: 'Cannot modify a closed case' }, 400, corsHeaders);
  }

  const body = await request.json() as Record<string, unknown>;
  const updates: string[] = [];
  const binds: unknown[] = [];

  // State transition
  if (body.state && typeof body.state === 'string') {
    if (!AGE_REVIEW_STATES.includes(body.state as AgeReviewState)) {
      return json({ success: false, error: `Invalid state: ${body.state}` }, 400, corsHeaders);
    }
    const allowed = VALID_TRANSITIONS[existing.state as AgeReviewState];
    if (!allowed?.includes(body.state as AgeReviewState)) {
      return json({
        success: false,
        error: `Cannot transition from '${existing.state}' to '${body.state}'`,
      }, 400, corsHeaders);
    }
    updates.push('state = ?');
    binds.push(body.state);
  }

  // Age band change
  if (body.suspected_age_band && typeof body.suspected_age_band === 'string') {
    if (!AGE_BANDS.includes(body.suspected_age_band as AgeBand)) {
      return json({ success: false, error: `Invalid age band: ${body.suspected_age_band}` }, 400, corsHeaders);
    }
    updates.push('suspected_age_band = ?');
    binds.push(body.suspected_age_band);
    updates.push('allowed_resolution = ?');
    binds.push(defaultResolutionForBand(body.suspected_age_band as AgeBand));
  }

  // Clock pause/resume
  if (body.clock_paused === true && !existing.clock_paused) {
    const now = new Date();
    const deadline = existing.deadline_at ? new Date(existing.deadline_at) : null;
    const remainingDays = deadline ? (deadline.getTime() - now.getTime()) / (24 * 60 * 60 * 1000) : null;
    updates.push('clock_paused = 1', 'clock_paused_at = ?', 'remaining_days_when_paused = ?');
    binds.push(now.toISOString(), remainingDays);
  } else if (body.clock_paused === false && existing.clock_paused) {
    const remaining = existing.remaining_days_when_paused ?? DEADLINE_DAYS;
    const newDeadline = new Date(Date.now() + remaining * 24 * 60 * 60 * 1000).toISOString();
    updates.push('clock_paused = 0', 'clock_paused_at = NULL', 'remaining_days_when_paused = NULL', 'deadline_at = ?');
    binds.push(newDeadline);
  }

  // Moderator assignment
  if (body.moderator_pubkey !== undefined) {
    if (body.moderator_pubkey !== null && typeof body.moderator_pubkey !== 'string') {
      return json({ success: false, error: 'moderator_pubkey must be a string or null' }, 400, corsHeaders);
    }
    updates.push('moderator_pubkey = ?');
    binds.push(body.moderator_pubkey as string | null);
  }

  // Resolution note
  if (body.resolution_note !== undefined) {
    if (body.resolution_note !== null && typeof body.resolution_note !== 'string') {
      return json({ success: false, error: 'resolution_note must be a string or null' }, 400, corsHeaders);
    }
    updates.push('resolution_note = ?');
    binds.push(body.resolution_note as string | null);
  }

  // Parent contact email
  if (body.parent_contact_email !== undefined) {
    const email = body.parent_contact_email as string | null;
    if (email !== null && (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) || email.length > 254)) {
      return json({ success: false, error: 'Invalid email format' }, 400, corsHeaders);
    }
    updates.push('parent_contact_email = ?');
    binds.push(email);
  }

  if (updates.length === 0) {
    return json({ success: false, error: 'No valid fields to update' }, 400, corsHeaders);
  }

  // optimistic locking. Validate expected_version's type like every other
  // field (a bad type is a 400, not a conflict), then reject a stale client
  // write up front; the server-read CAS below is the real guard.
  const versionConflict = (currentVersion: number = existing.version) => json({
    success: false,
    error: 'Case was modified by another request',
    code: 'version_conflict',
    current_version: currentVersion,
  }, 409, corsHeaders);

  if (body.expected_version !== undefined && typeof body.expected_version !== 'number') {
    return json({ success: false, error: 'expected_version must be a number' }, 400, corsHeaders);
  }
  if (body.expected_version !== undefined && body.expected_version !== existing.version) {
    return versionConflict();
  }

  updates.push("updated_at = datetime('now')");
  updates.push('version = version + 1');

  // ... and compare-and-swap on the version we read. If a concurrent
  // writer (another moderator, or the deadline cron) committed between our
  // read and this write, changes === 0 and we abort BEFORE running any
  // enforcement -- the loser must not apply side effects for a state it no
  // longer owns.
  const updateResult = await env.DB.prepare(
    `UPDATE age_review_cases SET ${updates.join(', ')} WHERE id = ? AND version = ?`
  ).bind(...binds, caseId, existing.version).run();

  if (updateResult.meta?.changes !== 1) {
    // A concurrent writer bumped the version between our read and this write, so
    // existing.version is now stale. Re-read the row to report the TRUE current
    // version. (The up-front check above can safely return existing.version
    // because no write has happened yet; on a CAS miss one has.)
    const fresh = await env.DB.prepare('SELECT version FROM age_review_cases WHERE id = ?')
      .bind(caseId).first<{ version: number }>();
    return versionConflict(fresh?.version ?? existing.version);
  }

  let updated = await env.DB.prepare('SELECT * FROM age_review_cases WHERE id = ?')
    .bind(caseId).first<AgeReviewCase>();

  const requestedState = typeof body.state === 'string'
    ? body.state as AgeReviewState
    : undefined;
  const enteredRestrictedState = requestedState !== undefined
    && isAccountRestrictedAgeReviewState(requestedState)
    && !isAccountRestrictedAgeReviewState(existing.state);
  const clearedCase = requestedState === 'cleared';
  const deniedCase = requestedState === 'denied_closed';

  // Non-critical: sync Zendesk ticket when case reaches terminal state
  const newState = requestedState ?? existing.state;
  if (TERMINAL_STATES.includes(newState)) {
    try {
      const note = (body.resolution_note as string | undefined) ?? existing.resolution_note;
      await syncAgeReviewTicketResolution(caseId, newState, note ?? null, env);
    } catch (error) {
      console.error('[age-review] Failed to sync Zendesk ticket resolution:', error);
    }
  }

  // Non-critical: create internal Zendesk ticket when moderator restricts an account
  // (parent-contact flow creates its own ticket with requester email; this covers
  // moderator-initiated restriction where no parent email exists yet)
  if (
    enteredRestrictedState &&
    !existing.zendesk_ticket_id &&
    !updated?.zendesk_ticket_id
  ) {
    try {
      const zendeskTicketId = await createAgeReviewInternalTicket(
        caseId,
        existing.pubkey,
        (updated?.suspected_age_band ?? existing.suspected_age_band) as AgeBand,
        updated?.deadline_at ?? existing.deadline_at,
        env,
        updated ?? existing,
      );
      if (updated && zendeskTicketId) {
        updated = { ...updated, zendesk_ticket_id: zendeskTicketId };
      }
    } catch (error) {
      console.error('[age-review] Failed to create internal Zendesk ticket:', error);
    }
  }

  // Enforcement legs are safety-critical: track each leg's real outcome and
  // surface failure -- the API must not report success when a minor's content
  // was not actually restricted or their account not suspended. (Zendesk above
  // stays non-critical and swallowed.)
  let bulk: EnforcementLegStatus = 'not_attempted';
  let bulkError: string | undefined;
  let bulkActionTriggered: string | undefined;
  let relay: EnforcementLegStatus = 'not_attempted';
  let relayError: string | undefined;
  let keycast: EnforcementLegStatus = 'not_attempted';
  let keycastError: string | undefined;
  let keycastMinorClear: EnforcementLegStatus = 'not_attempted';
  let keycastMinorClearError: string | undefined;
  let subjectClear: EnforcementLegStatus = 'not_attempted';
  let subjectClearError: string | undefined;
  let minorProjectionPubkey = existing.pubkey;

  // Shared wrapper for the relay and Keycast legs (both resolve to
  // { success, error }). Returns not_attempted when no call applies.
  const runStatusLeg = async (
    label: string,
    call: () => Promise<{ success: boolean; error?: string }> | undefined,
  ): Promise<{ status: EnforcementLegStatus; error?: string }> => {
    try {
      const result = await call();
      if (!result) return { status: 'not_attempted' };
      if (result.success) return { status: 'ok' };
      console.error(`[age-review] ${label} ${requestedState} failed for case ${caseId}: ${result.error}`);
      return { status: 'failed', error: result.error };
    } catch (error) {
      console.error(`[age-review] ${label} action failed for case ${caseId}:`, error);
      return { status: 'failed', error: error instanceof Error ? error.message : String(error) };
    }
  };

  if (requestedState !== undefined) {
    // Relay-level pubkey enforcement: suspendpubkey (reversible) hides the user's
    // existing events AND blocks new writes regardless of key custody (Keycast
    // suspend does not stop a self-custody / local-key signer); unsuspendpubkey
    // reverses it on clear (existing content reappears on the ~5-min MV refresh);
    // banpubkey purges (one-way) on deny/expiry.
    const relayLeg = await runStatusLeg('Relay', () =>
      enteredRestrictedState ? suspendPubkey(existing.pubkey, 'age_review', env)
      : clearedCase ? unsuspendPubkey(existing.pubkey, env)
      : deniedCase ? banPubkey(existing.pubkey, 'age_review_denied', env)
      : undefined);
    relay = relayLeg.status;
    relayError = relayLeg.error;

    // Relay/media bulk content action (own shape: throws on failure, and deny
    // only deletes when auto_delete_on_deny is set).
    try {
      if (enteredRestrictedState) {
        await triggerBulkModerate(existing.pubkey, 'age-restrict-all', 'Age review restriction', env);
        bulk = 'ok';
        bulkActionTriggered = 'age-restrict-all';
      } else if (clearedCase) {
        await triggerBulkModerate(existing.pubkey, 'un-age-restrict-all', 'Age review cleared', env);
        bulk = 'ok';
        bulkActionTriggered = 'un-age-restrict-all';
      } else if (deniedCase) {
        const config = await getAgeReviewConfig(env.DB!);
        if (config.auto_delete_on_deny) {
          await triggerBulkModerate(existing.pubkey, 'delete-all', 'Age review denied', env);
          bulk = 'ok';
          bulkActionTriggered = 'delete-all';
        }
      }
    } catch (error) {
      bulk = 'failed';
      bulkError = error instanceof Error ? error.message : String(error);
      console.error(`[age-review] Bulk action failed for case ${caseId}:`, error);
    }

    // Keycast account status.
    const keycastLeg = await runStatusLeg('Keycast', () =>
      enteredRestrictedState ? suspendUser(existing.pubkey, 'age_review', env)
      : clearedCase ? unsuspendUser(existing.pubkey, env)
      : deniedCase ? banUser(existing.pubkey, 'age_review_denied', env)
      : undefined);
    keycast = keycastLeg.status;
    keycastError = keycastLeg.error;

    // Clear verified_minor on the DENY/revoke transition ONLY (issue #147:
    // "Revoking an approved minor... clears verified_minor"). Compose, don't
    // couple: the status outcome above stays this side's decision; this leg
    // only lifts the protected-minor flag so protections release across
    // clients (#174).
    //
    // Deliberately NOT on `cleared`: `cleared` is the favorable outcome and
    // is overloaded. For a 13-15 consent-verified case it "restores the
    // account" (age-review-process.md, 13-15 band) — a *confirmed protected
    // minor* who must KEEP verified_minor. Clearing there would strip
    // protection from a minor, the worst failure direction on this path. The
    // 16+ mistaken-flag case also uses `cleared`, where the flag is a no-op;
    // we cannot distinguish the two from the transition alone, so we leave the
    // flag untouched on `cleared` (an over-protected mistaken adult is the safe
    // side). Only deny/revoke removes it. keycast's clear is an idempotent
    // no-op for never-minor accounts, so no pre-read is needed.
    //
    // actor = the case's assigned moderator (best-effort: relay-manager auths
    // with a shared admin pubkey, so there's no per-actor signal, and
    // moderator_pubkey is unvalidated on write). A malformed/absent actor is
    // dropped server-side in clearVerifiedMinor → keycast logs-only.
    const minorClearActor = (updated?.moderator_pubkey ?? existing.moderator_pubkey) ?? undefined;
    if (deniedCase && env.DB) {
      try {
        const result = await clearSubject(env.DB, existing.pubkey, minorClearActor, 'age_review_denied');
        subjectClear = result.success ? 'ok' : 'failed';
        subjectClearError = result.error;
        minorProjectionPubkey = result.projectionPubkey ?? existing.pubkey;
        if (!result.success) {
          console.error(`[age-review] Protected subject clear ${requestedState} failed for case ${caseId}: ${result.error}`);
        }
      } catch (error) {
        subjectClear = 'failed';
        subjectClearError = error instanceof Error ? error.message : String(error);
        console.error(`[age-review] Protected subject clear action failed for case ${caseId}:`, error);
      }
    }
    const minorClearLeg = await runStatusLeg('Keycast verified_minor clear', () =>
      deniedCase && subjectClear !== 'failed'
        ? clearVerifiedMinor(minorProjectionPubkey, minorClearActor, 'age_review_denied', env)
        : undefined);
    keycastMinorClear = minorClearLeg.status;
    keycastMinorClearError = minorClearLeg.error;
    if (deniedCase && keycastMinorClear === 'ok' && env.DB) {
      try {
        await markProjectionComplete(env.DB, minorProjectionPubkey);
      } catch (error) {
        // The pending job remains a safe retry boundary after the projection
        // itself succeeded, so do not turn an applied denial into a 500.
        console.error(`[age-review] Failed to mark protected-minor projection complete for case ${caseId}:`, error);
      }
    }
  }

  // A failed critical leg is reported (success:false, HTTP 207) so the
  // moderator/UI sees enforcement is incomplete. The DB state change persists;
  // remediation must re-run the failed downstream enforcement outside this
  // state-transition handler.
  // `updated` is the row re-read after the CAS succeeded, so it must exist;
  // guard for the type system and surface the impossible case rather than
  // emitting case:null.
  if (!updated) {
    return json({ success: false, error: 'Case not found after update' }, 500, corsHeaders);
  }
  const enforcement: AgeReviewEnforcement = {
    relay, relayError, bulk, bulkError, keycast, keycastError,
    keycastMinorClear, keycastMinorClearError, subjectClear, subjectClearError,
  };
  const enforcementComplete = relay !== 'failed' && bulk !== 'failed' && keycast !== 'failed'
    && keycastMinorClear !== 'failed' && subjectClear !== 'failed';
  const response: AgeReviewCaseResponse = {
    success: enforcementComplete,
    case: updated,
    bulkActionTriggered,
    keycastUpdated: keycast === 'ok',
    enforcementComplete,
    enforcement,
  };
  return json(response, enforcementComplete ? 200 : 207, corsHeaders);
}

// ---------------------------------------------------------------------------
// Minor onboarding (behind admin auth)
// ---------------------------------------------------------------------------

export async function handleCreateMinorAccount(
  request: Request,
  env: AgeReviewEnv,
  corsHeaders: Record<string, string>,
): Promise<Response> {
  if (!env.DB) return json({ success: false, error: 'Database not configured' }, 500, corsHeaders);

  let body: { username?: string; display_name?: string; zendesk_ticket_id?: number; provisioning_operation_id?: string };
  try {
    body = await request.json();
  } catch {
    return json({ success: false, error: 'Invalid JSON body' }, 400, corsHeaders);
  }

  const username = body.username?.trim().toLowerCase();
  if (!username) {
    return json({ success: false, error: 'username is required' }, 400, corsHeaders);
  }
  // Matches divine-mobile's DivineUsernamePolicy (3-63 chars, [a-z0-9-], no leading/trailing hyphens)
  if (username.length < 3 || username.length > 63 || !/^[a-z0-9-]+$/.test(username) || username.startsWith('-') || username.endsWith('-')) {
    return json({ success: false, error: 'username must be 3-63 characters, lowercase alphanumeric or hyphens, cannot start or end with a hyphen' }, 400, corsHeaders);
  }

  if (body.display_name !== undefined && typeof body.display_name !== 'string') {
    return json({ success: false, error: 'display_name must be a string' }, 400, corsHeaders);
  }
  const displayName = body.display_name?.trim() || undefined;
  const provisioningOperationId = body.provisioning_operation_id ?? crypto.randomUUID();
  if (!UUID_RE.test(provisioningOperationId)) {
    return json({ success: false, error: 'provisioning_operation_id must be a lowercase UUID' }, 400, corsHeaders);
  }

  if (body.zendesk_ticket_id !== undefined && body.zendesk_ticket_id !== null) {
    if (typeof body.zendesk_ticket_id !== 'number' || !Number.isInteger(body.zendesk_ticket_id) || body.zendesk_ticket_id <= 0) {
      return json({ success: false, error: 'zendesk_ticket_id must be a positive integer' }, 400, corsHeaders);
    }
  }

  const requestFingerprint = await fingerprintProvisioningRequest({
    kind: 'onboarding', username, displayName, zendeskTicketId: body.zendesk_ticket_id,
  });
  let existingOperation = await env.DB.prepare(`SELECT kind, request_fingerprint, state, subject_id, result_pubkey
    FROM protected_minor_provisioning_operations WHERE provisioning_operation_id = ?`).bind(provisioningOperationId)
    .first<{ kind: string; request_fingerprint: string; state: string; subject_id: string | null; result_pubkey: string | null }>();
  if (existingOperation && (existingOperation.kind !== 'onboarding' || existingOperation.request_fingerprint !== requestFingerprint)) {
    return json({ success: false, code: 'provisioning_operation_conflict', error: 'Provisioning operation conflicts with its original request' }, 409, corsHeaders);
  }
  if (!existingOperation) {
    const now = new Date().toISOString();
    try {
      await env.DB.prepare(`INSERT INTO protected_minor_provisioning_operations
        (provisioning_operation_id, subject_id, kind, request_fingerprint, state, created_at, updated_at)
        VALUES (?, NULL, 'onboarding', ?, 'pending', ?, ?)`)
        .bind(provisioningOperationId, requestFingerprint, now, now).run();
    } catch {
      return json({ success: false, error: 'Could not persist provisioning operation; no account was created.' }, 500, corsHeaders);
    }
  }

  const result = await createMinorAccount(username, displayName, env, provisioningOperationId);
  if (!result.success || !result.pubkey || (result.account_state !== 'claimed' && !result.claim_url)) {
    const is409 = result.error?.startsWith('409:');
    const is4xx = result.error?.match(/^4\d{2}:/);
    const status = is409 ? 409 : is4xx ? 400 : 502;
    return json({ success: false, error: result.error ?? 'Keycast account creation failed', provisioning_operation_id: provisioningOperationId }, status, corsHeaders);
  }

  if (existingOperation?.result_pubkey && existingOperation.result_pubkey !== result.pubkey) {
    return json({ success: false, code: 'provisioning_result_conflict', error: 'Provisioning replay returned a conflicting result' }, 409, corsHeaders);
  }
  if (existingOperation?.state !== 'complete') {
    const observedAt = new Date().toISOString();
    const observed = await env.DB.prepare(`UPDATE protected_minor_provisioning_operations
      SET result_pubkey = ?, updated_at = ?
      WHERE provisioning_operation_id = ? AND kind = 'onboarding' AND state = 'pending'
        AND (result_pubkey IS NULL OR result_pubkey = ?)`)
      .bind(result.pubkey, observedAt, provisioningOperationId, result.pubkey).run();
    if (observed.meta.changes !== 1) {
      const current = await env.DB.prepare(`SELECT kind, request_fingerprint, state, subject_id, result_pubkey
        FROM protected_minor_provisioning_operations WHERE provisioning_operation_id = ?`).bind(provisioningOperationId)
        .first<{ kind: string; request_fingerprint: string; state: string; subject_id: string | null; result_pubkey: string | null }>();
      if (current?.result_pubkey && current.result_pubkey !== result.pubkey) {
        return json({ success: false, code: 'provisioning_result_conflict', error: 'Provisioning replay returned a conflicting result' }, 409, corsHeaders);
      }
      if (!current || current.kind !== 'onboarding') {
        return json({ success: false, error: 'Could not persist provisioning result. Retry with the same operation ID.', provisioning_operation_id: provisioningOperationId }, 500, corsHeaders);
      }
      existingOperation = current;
    } else if (existingOperation) {
      existingOperation = { ...existingOperation, result_pubkey: result.pubkey };
    }
  }

  if (existingOperation?.state === 'complete') {
    if (existingOperation.result_pubkey !== result.pubkey || !existingOperation.subject_id) {
      return json({ success: false, code: 'provisioning_result_conflict', error: 'Provisioning replay returned a conflicting result' }, 409, corsHeaders);
    }
    const prior = await env.DB.prepare(`SELECT source_case_id FROM protected_minor_subjects WHERE subject_id = ?`)
      .bind(existingOperation.subject_id).first<{ source_case_id: string }>();
    return json({ success: true, pubkey: result.pubkey, claim_url: result.claim_url, expires_at: result.expires_at,
      account_state: result.account_state, case_id: prior?.source_case_id,
      provisioning_operation_id: provisioningOperationId, replayed: true }, 200, corsHeaders);
  }

  const caseId = crypto.randomUUID();
  const subjectId = crypto.randomUUID();
  try {
    // Identity is known up front on this path -- the operator supplied it -- so
    // there is nothing to look up. Storing it keeps this case as identifiable as
    // a report-created one, where the name has to be fetched before enforcement
    // hides the profile.
    //
    // account_name prefers display_name, so the username would be dropped
    // entirely whenever one is supplied. It is stored twice over, because the
    // two places it can go fail in different environments:
    //
    //  - account_nip05 records the address the account is expected to claim.
    //    Divine's NIP-05 is the subdomain form `_@<username>.<domain>`, so the
    //    username is recoverable from it. Derived from what the operator gave
    //    us, not read back from Keycast -- the create-minor-account response
    //    carries no nip05. No fallback domain on purpose: staging accounts do
    //    not live under the production identity domain, and guessing one would
    //    write a wrong address into a record agents read to decide who a case
    //    is about. Unconfigured stores nothing rather than something false.
    //
    //  - account_vine_username holds the username itself, unconditionally.
    //    Without this, an unconfigured NIP05_DOMAIN means a case created with a
    //    display_name keeps no trace of the username at all -- and because this
    //    path stamps identity_captured_at, the backfill's `IS NULL` keying never
    //    revisits the row, so the loss is permanent. That is the exact defect
    //    the nip05 derivation was added to close; it just has to survive in the
    //    environment shipped without the config too. The column is unused on
    //    this path and resolveHandle already falls back to it, so it costs
    //    nothing and reads correctly wherever the block is rendered.
    const nip05 = env.NIP05_DOMAIN ? `_@${username}.${env.NIP05_DOMAIN}` : null;
    const now = new Date().toISOString();
    await env.DB.batch([env.DB.prepare(`
      INSERT INTO age_review_cases
      (id, pubkey, suspected_age_band, state, allowed_resolution, resolution_note, created_via, claim_link_url, claim_link_expires_at, zendesk_ticket_id,
       account_name, account_nip05, account_vine_username, identity_captured_at)
      VALUES (?, ?, 'age_13_15', 'cleared', 'parent_video_or_email', 'Approved via parental consent (minor onboarding)', 'minor_onboarding', ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      caseId,
      result.pubkey,
      result.claim_url,
      result.expires_at ?? null,
      body.zendesk_ticket_id ?? null,
      displayName ?? username,
      nip05,
      username,
      now,
    ), env.DB.prepare(`INSERT INTO protected_minor_subjects
      (subject_id, source_case_id, classification_state, classified_at) VALUES (?, ?, 'active', ?)`)
      .bind(subjectId, caseId, now),
    env.DB.prepare(`INSERT INTO protected_minor_account_bindings
      (id, subject_id, pubkey, bound_at) VALUES (?, ?, ?, ?)`)
      .bind(crypto.randomUUID(), subjectId, result.pubkey, now),
    env.DB.prepare(`UPDATE protected_minor_provisioning_operations
      SET subject_id = ?, state = 'complete', result_pubkey = ?, updated_at = ?
      WHERE provisioning_operation_id = ? AND state = 'pending'`)
      .bind(subjectId, result.pubkey, now, provisioningOperationId)]);
  } catch (err) {
    console.error(`[age-review] D1 audit record failed for minor account: pubkey=${result.pubkey}, case=${caseId}`, err);
    return json({
      success: false,
      error: `Account created in Keycast but registry persistence failed. Retry with provisioning operation ${provisioningOperationId}.`,
      pubkey: result.pubkey,
      case_id: caseId,
      provisioning_operation_id: provisioningOperationId,
    }, 500, corsHeaders);
  }

  console.log(`[age-review] Minor account created: pubkey=${result.pubkey}, case=${caseId}, username=${username}`);

  return json({
    success: true,
    pubkey: result.pubkey,
    claim_url: result.claim_url,
    expires_at: result.expires_at,
    account_state: result.account_state,
    case_id: caseId,
    provisioning_operation_id: provisioningOperationId,
  }, 200, corsHeaders);
}

// ---------------------------------------------------------------------------
// Mobile-facing endpoints (behind NIP-98 user auth)
// ---------------------------------------------------------------------------

export async function handleGetModerationStatus(
  userPubkey: string,
  env: AgeReviewEnv,
  corsHeaders: Record<string, string>,
): Promise<Response> {
  if (!env.DB) {
    // Distinct, greppable marker so this fail-open path is alertable via log
    // monitoring (#197) -- the minor-review gate failing open during a DB
    // outage should never be silent, even though we deliberately keep it
    // fail-open here (see the proactive cron alert in index.ts scheduled()).
    // MODERATION_STATUS_DB_UNAVAILABLE is intentionally a separate marker from
    // index.ts's "D1 UNAVAILABLE" -- this one fires per live request that just
    // failed open; that one fires from the cron proactively detecting the DB
    // binding is absent. Not a typo -- two distinct signals.
    console.error('[age-review] MODERATION_STATUS_DB_UNAVAILABLE — DB binding absent, returning fail-open active status for', userPubkey);
    return json({ restriction: { status: 'active' } }, 200, corsHeaders);
  }

  // Only surface restriction for states where a moderator has reviewed.
  // open_reported is pre-review — a single unsolicited report should not
  // restrict the user before a human confirms.
  const RESTRICTED_STATES: readonly AgeReviewState[] = [
    'under_moderator_review',
    'restricted_pending_user_response',
    'restricted_pending_parental_consent',
    'restricted_pending_support_email',
    'submitted_for_review',
    'needs_follow_up',
  ];
  const activeCase = await env.DB.prepare(`
    SELECT * FROM age_review_cases
    WHERE pubkey = ? AND state IN (${RESTRICTED_STATES.map(() => '?').join(',')})
    ORDER BY created_at DESC LIMIT 1
  `).bind(userPubkey, ...RESTRICTED_STATES).first<AgeReviewCase>();

  if (!activeCase) {
    return json({ restriction: { status: 'active' } }, 200, corsHeaders);
  }

  return json({
    restriction: { status: 'restricted_minor_review' },
    minorReviewCase: {
      id: activeCase.id,
      state: activeCase.state,
      suspectedAgeBand: activeCase.suspected_age_band,
      allowedResolution: activeCase.allowed_resolution,
      instructions: null,
      supportEmail: 'contact@divine.video',
      moderationConversationPubkey: null,
      moderationConversationId: null,
    },
  }, 200, corsHeaders);
}

export async function handleParentContact(
  request: Request,
  caseId: string,
  userPubkey: string,
  env: AgeReviewEnv,
  corsHeaders: Record<string, string>,
): Promise<Response> {
  if (!env.DB) return json({ success: false, error: 'Database not configured' }, 500, corsHeaders);

  const activeCase = await env.DB.prepare(
    'SELECT * FROM age_review_cases WHERE id = ? AND pubkey = ?'
  ).bind(caseId, userPubkey).first<AgeReviewCase>();

  if (!activeCase) {
    return json({ success: false, error: 'Case not found' }, 404, corsHeaders);
  }

  if (TERMINAL_STATES.includes(activeCase.state as AgeReviewState)) {
    return json({ success: false, error: 'Case is already closed' }, 400, corsHeaders);
  }

  if (activeCase.suspected_age_band === 'under_13') {
    return json({ success: false, error: 'Under-13 cases require support review only' }, 400, corsHeaders);
  }

  const body = await request.json() as { email?: string };
  if (!body.email) {
    return json({ success: false, error: 'email is required' }, 400, corsHeaders);
  }
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(body.email) || body.email.length > 254) {
    return json({ success: false, error: 'Invalid email format' }, 400, corsHeaders);
  }

  // Validate state transition before modifying the case
  const targetState: AgeReviewState = activeCase.suspected_age_band === 'age_13_15'
    ? 'restricted_pending_parental_consent'
    : 'restricted_pending_support_email';
  const allowed = VALID_TRANSITIONS[activeCase.state as AgeReviewState];
  if (!allowed?.includes(targetState)) {
    return json({
      success: false,
      error: `Cannot submit parent contact from state '${activeCase.state}'`,
    }, 400, corsHeaders);
  }

  // Save parent email, pause the clock (if not already paused), and transition state
  // This path stays within the restricted workflow, so it intentionally does not
  // resync Keycast. Account suspension is handled when the case first enters a
  // restricted state via handleUpdateAgeReviewCase.
  if (activeCase.clock_paused) {
    // Clock already paused — update email and state only, preserve existing remaining time
    await env.DB.prepare(`
      UPDATE age_review_cases
      SET parent_contact_email = ?,
          state = CASE
            WHEN suspected_age_band = 'age_13_15' THEN 'restricted_pending_parental_consent'
            WHEN suspected_age_band = 'age_16_plus_claimed' THEN 'restricted_pending_support_email'
            ELSE state
          END,
          updated_at = datetime('now')
      WHERE id = ?
    `).bind(body.email, caseId).run();
  } else {
    const now = new Date();
    const deadline = activeCase.deadline_at ? new Date(activeCase.deadline_at) : null;
    const remainingDays = deadline ? (deadline.getTime() - now.getTime()) / (24 * 60 * 60 * 1000) : DEADLINE_DAYS;

    await env.DB.prepare(`
      UPDATE age_review_cases
      SET parent_contact_email = ?,
          clock_paused = 1,
          clock_paused_at = ?,
          remaining_days_when_paused = ?,
          state = CASE
            WHEN suspected_age_band = 'age_13_15' THEN 'restricted_pending_parental_consent'
            WHEN suspected_age_band = 'age_16_plus_claimed' THEN 'restricted_pending_support_email'
            ELSE state
          END,
          updated_at = datetime('now')
      WHERE id = ?
    `).bind(body.email, now.toISOString(), remainingDays, caseId).run();
  }

  // Non-critical: Zendesk ticket handling
  // If an internal ticket already exists (from moderator restriction), update it
  // to add the parent as requester and send them the outreach email.
  // Otherwise create a new ticket from scratch.
  if (activeCase.zendesk_ticket_id) {
    try {
      await updateTicketWithParentContact(
        activeCase.zendesk_ticket_id,
        body.email,
        activeCase.suspected_age_band as AgeBand,
        env,
        activeCase,
      );
    } catch (error) {
      console.error('[age-review] Failed to update Zendesk ticket with parent contact:', error);
    }
  } else {
    try {
      await createAgeReviewTicket(caseId, body.email, activeCase.suspected_age_band as AgeBand, activeCase.deadline_at, env, activeCase);
    } catch (error) {
      console.error('[age-review] Failed to create Zendesk ticket:', error);
    }
  }

  return json({ success: true }, 200, corsHeaders);
}

// ---------------------------------------------------------------------------
// Zendesk integration
// ---------------------------------------------------------------------------

const BAND_DISPLAY: Record<AgeBand, string> = {
  under_13: 'Under 13',
  age_13_15: '13-15',
  age_16_plus_claimed: '16+ (claimed)',
};

async function getZendeskClientConfig(env: AgeReviewEnv): Promise<ZendeskClientConfig | null> {
  const creds = await resolveZendeskCreds(env);
  if (!creds) return null;
  return {
    auth: btoa(`${creds.email}/token:${creds.apiToken}`),
    baseUrl: `https://${creds.subdomain}.zendesk.com/api/v2`,
    email: creds.email,
  };
}

/**
 * Escape text for interpolation into the HTML outreach body. The display name
 * and NIP-05 come from the account's own kind-0 and are stored raw, so every
 * render surface has to neutralize them itself.
 */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** The same 80 characters `sanitizeInline` allows a rendered handle. */
const IDENTITY_MAX_LEN = 80;

/**
 * Strip what has no business in a rendered identity and truncate to the cap.
 *
 * Control characters and zero-width joiners are removed rather than escaped:
 * they cannot help a parent recognise an account, and a zero-width character
 * inside a hostname is a way to hide one from `looksLinkish` while a mail
 * client's own parser still sees the link.
 *
 * Truncation is by code point, not code unit -- emoji in display names are
 * ordinary, and slicing one in half emits a lone surrogate into the mail body.
 * The ellipsis matches `sanitizeInline`, so a cut name is not presented to a
 * parent as if it were whole.
 */
function cleanIdentityText(value: string): string {
  // Control characters, invisible/format characters, and unpaired surrogates,
  // tested by Unicode property rather than an enumerated list: the set that can
  // hide a hostname from `looksLinkish` while a mail client still parses one is
  // far wider than the well-known zero-width characters, and includes the bidi
  // controls. Property escapes do not trip no-control-regex, so noInlineConfig
  // is not a constraint here.
  const stripped = Array.from(value)
    .filter((ch) => !/[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Zl}\p{Zp}\p{Default_Ignorable_Code_Point}]/u.test(ch))
    .join('')
    .trim();
  const points = Array.from(stripped);
  return points.length > IDENTITY_MAX_LEN
    ? `${points.slice(0, IDENTITY_MAX_LEN).join('')}…`
    : stripped;
}

/**
 * True when a display name is trying to look like a link.
 *
 * Escaping stops markup, not linkification: mail clients auto-link bare URLs in
 * text, and `report-note.ts` wraps these same values in a code span for exactly
 * this reason. That defence does not carry over here, because this render goes
 * out as mail rather than into an agent-facing note.
 *
 * The threat is specific. The account under review picks its own kind-0 display
 * name AND supplies the address this mail is sent to, so a name of
 * "verify at http://not-divine.example/claim" would have Divine Trust & Safety
 * deliver an attacker's link, under Divine's branding, to an address the
 * attacker chose. Dropping the row is the safe failure: the parent still gets
 * the username and the ID.
 *
 * Compared on a normalized copy, because a linkifier resolves hostnames under
 * UTS-46: U+3002, U+FF0E and U+FF61 all map to `.`, so `evil。example` is a
 * hostname to the client and was not to an ASCII-only check. NFKC alone does
 * not cover it -- it folds U+FF0E and leaves the other two -- so they are
 * replaced outright.
 *
 * Deliberately blunt. A dotted token with a letter suffix is enough to trip it,
 * so a legitimate name like "Anna.Marie" is dropped too. Losing a display name
 * costs recognisability; shipping a live link costs more.
 */
function looksLinkish(value: string): boolean {
  const normalized = value.normalize('NFKC').replace(/[。．｡]/g, '.');
  return (
    /:\/\/|\bwww\./iu.test(normalized) ||
    /[\p{L}\p{N}-]+\.[\p{L}]{2,}/u.test(normalized) ||
    // A bare IPv4 host has no letters after the final dot, so the rule above
    // does not see it. Narrower than widening that suffix class, which would
    // also drop ordinary names containing a decimal.
    /\b\d{1,3}(\.\d{1,3}){3}\b/.test(normalized)
  );
}

/**
 * The display form of a NIP-05, or undefined when we will not vouch for it.
 *
 * Two gates. Shape first: anything carrying a scheme, a path, whitespace or a
 * second `@` is not a NIP-05.
 *
 * Then the issuing domain, which is the gate that matters. A NIP-05 is a bare
 * hostname by construction, so `looksLinkish` cannot be applied to it -- it
 * would reject every legitimate value. That leaves the same hole this row was
 * supposed to be exempt from: `account_nip05` is unverified kind-0 the account
 * chose, so `_@claim-your-teen-account.example` would render as a clean, highly
 * linkifiable hostname, mailed under Divine branding to an address the same
 * account supplied. We can only vouch for domains we issue, so anything else is
 * dropped.
 *
 * Unset `NIP05_DOMAIN` therefore renders no username at all. That is the same
 * call #222 made for the capture side: staging accounts come from a different
 * Keycast instance, and no username beats a wrong or unvouched one.
 *
 * NIP-05 calls `_@domain` the "root" identifier and says to display it as the
 * bare domain (nips/05.md, "Showing just the domain as an identifier"). Divine
 * issues `_@<username>.<NIP05_DOMAIN>`, so the prefix is noise to a parent. Any
 * other local part is left intact unless it is itself hostname-shaped: the host
 * gate does not see the local part, so a `looksLinkish` one is dropped below.
 */
function displayNip05(nip05: string, issuingDomain?: string): string | undefined {
  if (!issuingDomain) return undefined;
  if (!/^[a-z0-9._-]+@[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(nip05)) return undefined;

  const host = nip05.split('@').pop() ?? '';
  const domain = issuingDomain.toLowerCase();
  const lowerHost = host.toLowerCase();
  if (lowerHost !== domain && !lowerHost.endsWith(`.${domain}`)) return undefined;

  // The gate above constrains only the host. The local part is attacker-chosen
  // kind-0 and NIP-05 permits `.` there, so it can be hostname-shaped
  // (`www.evil.example@divine.video`) even when the host is ours. Drop it for the
  // same reason looksLinkish drops a display name: a mail client may parse a link
  // out of text delivered under Divine branding. The root form `_@…` and a plain
  // local part like `alice` survive; only a dotted, hostname-shaped one is refused.
  if (looksLinkish(nip05.split('@')[0] ?? '')) return undefined;

  const display = nip05.startsWith('_@') ? nip05.slice(2) : nip05;
  return display.length > 0 && display.length <= IDENTITY_MAX_LEN ? display : undefined;
}

/**
 * Tells the parent which account this is about.
 *
 * A narrower set than agents get: the contact-notes block also carries the case
 * deeplink, the band, and the claimed-and-unverified qualifier. A parent needs
 * only enough to recognise their child's account.
 *
 * `account_vine_username` is captured and is the agent block's third fallback,
 * but is deliberately not shown here. It may have informed what became the
 * Divine username, but by the time a case exists the original Vine name that
 * happened to be carried over is not what a parent would recognise.
 *
 * Every row is conditional except the npub. Capture is best effort -- an account
 * whose profile was already hidden by enforcement yields no name and no NIP-05
 * -- but the pubkey is on the case row and always resolves.
 */
function buildAccountIdentityHtml(
  identity: AgeReviewCaseIdentity & { pubkey?: string },
  issuingDomain?: string,
): string {
  const rows: string[] = [];

  // Cleaned and capped before the link check, never after: the check has to run
  // on exactly the string that gets rendered, or truncation could cut a URL out
  // of view of the check while leaving one in the mail.
  const name = identity.account_name ? cleanIdentityText(identity.account_name) : undefined;
  const nip05 = identity.account_nip05
    ? displayNip05(identity.account_nip05.trim(), issuingDomain)
    : undefined;

  if (name && !looksLinkish(name)) rows.push(`Display name: ${escapeHtml(name)}`);
  // The escape here cannot fire: displayNip05's charset already excludes every
  // HTML-special character, so a markup-bearing value is dropped before it
  // arrives. Kept so the row does not become the one that forgot, if that
  // validation is ever loosened. Deliberately not covered by a test -- there is
  // no input that would reach it.
  if (nip05) rows.push(`Username: ${escapeHtml(nip05)}`);
  if (identity.pubkey) rows.push(`ID: ${escapeHtml(toNpub(identity.pubkey))}`);
  if (rows.length === 0) return '';

  return `<p>The account under review:<br>\n${rows.join('<br>\n')}</p>`;
}

/**
 * The first message a parent or guardian receives. It leads with what we need
 * from them rather than asking them to confirm who they are: a reply that only
 * says "yes" tells us nothing, and anyone who is not the parent cannot produce
 * the video regardless.
 *
 * One template covers both bands this path can reach. It carries no age-band
 * label because the same message is sent to a 13-15 case and to someone
 * claiming to be 16 or older, and "possibly under 16" is true of both.
 *
 * It names the account. That is a deliberate reversal of the position #222 took
 * for this message, taken by the T&S lead: a parent cannot act on a review
 * without knowing which account it concerns. The risk #222 named is real and
 * unchanged -- the address is supplied by the account under review and is
 * unverified until someone replies from it -- so the requester name stays
 * address-only and this is the only surface where the handle reaches an
 * unverified recipient.
 *
 * Sent as HTML: Zendesk renders `html_body` through the account's mail template
 * and derives the plain-text alternative itself.
 */
export function buildParentOutreachBody(
  identity: AgeReviewCaseIdentity & { pubkey?: string } = {},
  issuingDomain?: string,
): string {
  const identityHtml = buildAccountIdentityHtml(identity, issuingDomain);

  return [
    '<p>Hello,</p>',
    '',
    '<p>An account on Divine was flagged as possibly belonging to someone under 16. ' +
      'Where permitted by law, teens aged 13 to 15 can use Divine through Divine Greenlight, ' +
      'with a parent or guardian who is aware and involved.</p>',
    ...(identityHtml ? ['', identityHtml] : []),
    '',
    '<p>To keep the account open, reply to this email with a short private video that shows:</p>',
    '',
    '<ul>',
    '  <li>the teen</li>',
    '  <li>a parent or guardian speaking on camera</li>',
    '  <li>that the teen is between 13 and 15</li>',
    '  <li>that the teen has permission to use Divine</li>',
    '  <li>that the parent or guardian knows about the account and will supervise its use</li>',
    '  <li>the country or countries where you live</li>',
    '</ul>',
    '',
    '<p>You can attach the video or include a private link to it.</p>',
    '',
    '<p><strong>Please do NOT send government IDs, payment details, school or medical records, ' +
      'or passwords.</strong> We only need the short video.</p>',
    '',
    '<p>Please reply within 15 days. If we do not hear from you, your child&#39;s account will be deleted.</p>',
    '',
    '<p>If you are the account holder and you are 16 or older, reply and tell us that. ' +
      'No video needed, and we will take another look.</p>',
    '',
    '<p>If you have questions about this request, or want tips on supporting your family&#39;s ' +
      'healthy use of social media, visit our <a href="https://divine.video/family">For Families page</a>. ' +
      'Read <a href="https://divine.video/kids">how accounts work for kids on Divine</a>.</p>',
    '',
    '<p>You can also reply directly to this email with any questions.</p>',
    '',
    '<p>Thank you,<br>',
    'Divine Trust &amp; Safety</p>',
  ].join('\n');
}

function buildAgeReviewCustomFields(
  env: AgeReviewEnv,
  deadlineAt: string | null,
): { id: number; value: string }[] {
  const customFields: { id: number; value: string }[] = [];

  if (env.ZENDESK_FIELD_CATEGORY && env.ZENDESK_FIELD_ISSUE) {
    customFields.push(
      { id: parseInt(env.ZENDESK_FIELD_CATEGORY, 10), value: 'trust___safety' },
      { id: parseInt(env.ZENDESK_FIELD_ISSUE, 10), value: 'content_report_under_16' },
    );
  }

  const deadlineField = buildDeadlineCustomField(deadlineAt, env);
  if (deadlineField) customFields.push(deadlineField);

  return customFields;
}

// Bracketed on purpose: sanitizeInline strips [ and ], so no account-chosen
// name can reproduce these markers and forge a block boundary in the notes.
const CONTACT_NOTES_START = '--- [Divine age review] ---';
const CONTACT_NOTES_END = '--- [end Divine age review] ---';

/**
 * Resolve a ticket requester to a contact it is safe to write case data onto.
 *
 * The parent address is supplied by the teen under review and is validated
 * only as email-shaped. Zendesk resolves `requester: {email}` to an *existing*
 * user when one matches, and permits agents to be requesters -- so naming a
 * Divine staff address makes that staff member the requester of the case
 * ticket. A Zendesk display name is global, so renaming them would put a
 * minor's handle in the header of every mail they later send, on any ticket.
 *
 * A non-null `parent_contact_email` on the case does not establish this: that
 * column is written before the Zendesk call, and the call's failure is
 * swallowed, so the row can claim a parent while the requester is still the
 * admin who opened the internal ticket.
 *
 * Returns null when the contact is anyone other than the end user at exactly
 * the address we were given. Callers must not write on null.
 */
async function resolveVerifiedParentContact(
  requesterId: number,
  expectedEmail: string,
  zendesk: ZendeskClientConfig,
): Promise<{ notes: string } | null> {
  const res = await fetch(`${zendesk.baseUrl}/users/${requesterId}`, {
    headers: { 'Authorization': `Basic ${zendesk.auth}`, 'Content-Type': 'application/json' },
  });
  if (!res.ok) throw new Error(`Zendesk contact read failed: ${res.status}`);

  const user = (await res.json() as {
    user?: { role?: string; email?: string; notes?: string | null };
  }).user;
  if (!user) return null;

  if (user.role !== 'end-user') {
    console.warn(`[age-review] Refusing to write case data to a non-end-user contact (role=${user.role})`);
    return null;
  }
  if ((user.email ?? '').toLowerCase() !== expectedEmail.toLowerCase()) {
    console.warn('[age-review] Refusing to write case data: requester is not the parent address on the case');
    return null;
  }
  return { notes: user.notes ?? '' };
}

/**
 * Splice our block into a contact's existing `notes`, replacing only a block we
 * wrote before.
 *
 * `notes` is a single free-text field a human writes in too, and the bottom of
 * it is exactly where an agent adds a line. So both sides are preserved: text
 * before our block and text after it. Only the region between our own markers
 * is replaced, which keeps repeated attaches -- a re-submitted parent address,
 * or two cases sharing one address -- from stacking copies up.
 */
export function composeContactNotes(current: string, block: string): string {
  const start = current.indexOf(CONTACT_NOTES_START);
  const head = (start === -1 ? current : current.slice(0, start)).trimEnd();

  let tail = '';
  if (start !== -1) {
    const endIdx = current.indexOf(CONTACT_NOTES_END, start);
    tail = endIdx === -1
      // No end marker, so we cannot tell where our block stopped and an agent's
      // text began. Keep the remainder: this field belongs to the agent, and a
      // visible duplicate is something they can fix, whereas a silent deletion
      // is not something they can even notice.
      ? current.slice(start + CONTACT_NOTES_START.length).trimStart()
      : current.slice(endIdx + CONTACT_NOTES_END.length).trimStart();
  }

  return [head, CONTACT_NOTES_START, block, CONTACT_NOTES_END, tail]
    .filter((part) => part !== '')
    .join('\n');
}

/**
 * Append the identity block to a Zendesk contact's `notes`, which is where an
 * agent sees who a requester is without opening the case.
 *
 * Writes nothing unless the requester verifies as the end user at the parent
 * address on the case -- see resolveVerifiedParentContact for why the case row
 * alone is not evidence of that.
 *
 * Best-effort by contract: the caller's outreach must not fail because
 * enrichment did.
 */
async function writeParentContactNotes(
  requesterId: number,
  parentEmail: string,
  block: string,
  zendesk: ZendeskClientConfig,
): Promise<void> {
  const contact = await resolveVerifiedParentContact(requesterId, parentEmail, zendesk);
  if (!contact) return;

  const res = await fetch(`${zendesk.baseUrl}/users/${requesterId}`, {
    method: 'PUT',
    headers: { 'Authorization': `Basic ${zendesk.auth}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ user: { notes: composeContactNotes(contact.notes, block) } }),
  });
  if (!res.ok) {
    throw new Error(`Zendesk contact write failed: ${res.status}`);
  }
}

async function createAgeReviewTicket(
  caseId: string,
  parentEmail: string,
  ageBand: AgeBand,
  deadlineAt: string | null,
  env: AgeReviewEnv,
  identity: AgeReviewCaseIdentity & { pubkey?: string } = {},
): Promise<void> {
  const zendesk = await getZendeskClientConfig(env);
  if (!zendesk) {
    console.warn('[age-review] Missing Zendesk credentials, skipping ticket creation');
    return;
  }
  if (!env.DB) return;

  const subject = `Age review: parental verification needed [${caseId}]`;
  const outreachBody = buildParentOutreachBody(identity, env.NIP05_DOMAIN);
  const customFields = buildAgeReviewCustomFields(env, deadlineAt);

  const res = await fetch(`${zendesk.baseUrl}/tickets`, {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${zendesk.auth}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      ticket: {
        subject,
        comment: { html_body: outreachBody, public: true },
        // The address alone. Zendesk renders this into the To: header of every
        // outbound mail, and this ticket's first message goes to an address the
        // teen supplied that nobody has verified -- so it must not carry the
        // account's handle. It gains one only once the parent replies.
        requester: { email: parentEmail, name: parentEmail },
        tags: ['age-review', `age-band-${ageBand}`],
        priority: 'high',
        custom_fields: customFields.length > 0 ? customFields : undefined,
      },
    }),
  });

  if (!res.ok) {
    const errorText = await res.text();
    throw new Error(`Zendesk ticket creation failed: ${res.status} - ${errorText}`);
  }

  const data = await res.json() as { ticket?: { id: number; requester_id?: number } };
  if (data.ticket?.id) {
    await env.DB.prepare(
      'UPDATE age_review_cases SET zendesk_ticket_id = ? WHERE id = ?'
    ).bind(data.ticket.id, caseId).run();
    console.log(`[age-review] Created Zendesk ticket #${data.ticket.id} for case ${caseId}`);
  }

  await attachIdentityToParentContact({
    requesterId: data.ticket?.requester_id,
    parentEmail,
    caseId,
    ageBand,
    deadlineAt,
    originTicketId: data.ticket?.id ?? null,
    identity,
    zendesk,
  });
}

/**
 * Put the case identity on the parent's contact record. Agent-only surface.
 *
 * Named arguments rather than positional: this takes several strings, numbers
 * and nullables of the same shape (case id, ticket id, requester id, email),
 * and a silent swap between them would write one case's data onto another
 * case's contact.
 *
 * Wrapped whole and swallowed: the parent's outreach is the critical path and
 * must survive a Zendesk contact API failure.
 */
async function attachIdentityToParentContact(args: {
  requesterId: number | undefined;
  parentEmail: string;
  caseId: string;
  ageBand: AgeBand;
  deadlineAt: string | null;
  originTicketId: number | null;
  identity: AgeReviewCaseIdentity & { pubkey?: string };
  zendesk: ZendeskClientConfig;
}): Promise<void> {
  const { requesterId, parentEmail, caseId, ageBand, deadlineAt, originTicketId, identity, zendesk } = args;

  // Without a requester id there is no contact to write to; without a pubkey or
  // case id the block would render a broken deeplink and identify nothing.
  //
  // The requester-id and pubkey clauses are reachable and tested. The caseId and
  // parentEmail clauses are defence-in-depth against a future caller and are
  // unreachable today: both call sites take caseId from a validated route param
  // or the case row's own id, and parentEmail is rejected as empty by
  // handleParentContact before either path runs. Kept because this function
  // writes a minor's identity to an external system, and cheap; deliberately
  // left untested rather than reached through a contorted fixture.
  if (!requesterId || !identity.pubkey || !caseId || !parentEmail) return;
  try {
    await writeParentContactNotes(
      requesterId,
      parentEmail,
      buildAgeReviewIdentityBlock({
        caseId,
        pubkey: identity.pubkey,
        ageBand: BAND_DISPLAY[ageBand],
        accountName: identity.account_name,
        accountNip05: identity.account_nip05,
        accountVineUsername: identity.account_vine_username,
        originTicketId,
        deadlineAt: deadlineAt ? deadlineAt.split('T')[0] : null,
      }),
      zendesk,
    );
  } catch (error) {
    console.error('[age-review] Failed to write parent contact notes:', error);
  }
}

async function updateTicketWithParentContact(
  ticketId: number,
  parentEmail: string,
  ageBand: AgeBand,
  env: AgeReviewEnv,
  identity: AgeReviewCaseIdentity & { pubkey?: string; id?: string; deadline_at?: string | null } = {},
): Promise<void> {
  const zendesk = await getZendeskClientConfig(env);
  if (!zendesk) return;

  const outreachBody = buildParentOutreachBody(identity, env.NIP05_DOMAIN);

  const res = await fetch(`${zendesk.baseUrl}/tickets/${ticketId}`, {
    method: 'PUT',
    headers: {
      'Authorization': `Basic ${zendesk.auth}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      ticket: {
        // Address only -- see the note on the creation path. This one is
        // riskier still: it reassigns the requester on a ticket that already
        // exists, so the name lands on a contact an agent may already see.
        requester: { email: parentEmail, name: parentEmail },
        comment: { html_body: outreachBody, public: true },
      },
    }),
  });

  if (!res.ok) {
    const errorText = await res.text();
    throw new Error(`Zendesk ticket update failed: ${res.status} - ${errorText}`);
  }
  // The ticket id is the useful identifier here. The address itself is a
  // parent's personal data and does not belong in worker logs.
  console.log(`[age-review] Updated Zendesk ticket #${ticketId} with parent contact`);

  const data = await res.json().catch(() => null) as { ticket?: { requester_id?: number } } | null;
  await attachIdentityToParentContact({
    requesterId: data?.ticket?.requester_id,
    parentEmail,
    caseId: identity.id ?? '',
    ageBand,
    deadlineAt: identity.deadline_at ?? null,
    originTicketId: ticketId,
    identity,
    zendesk,
  });
}

function buildDeadlineCustomField(
  deadlineAt: string | null,
  env: AgeReviewEnv,
): { id: number; value: string } | null {
  if (!env.ZENDESK_FIELD_AGE_REVIEW_DEADLINE || !deadlineAt) return null;
  return {
    id: parseInt(env.ZENDESK_FIELD_AGE_REVIEW_DEADLINE, 10),
    value: deadlineAt.split('T')[0],
  };
}

async function createAgeReviewInternalTicket(
  caseId: string,
  pubkey: string,
  ageBand: AgeBand,
  deadlineAt: string | null,
  env: AgeReviewEnv,
  identity: AgeReviewCaseIdentity = {},
): Promise<number | null> {
  const zendesk = await getZendeskClientConfig(env);
  if (!zendesk) {
    console.warn('[age-review] Missing Zendesk credentials, skipping internal ticket creation');
    return null;
  }
  if (!env.DB) return null;

  const subject = `Age review: ${BAND_DISPLAY[ageBand]} account restricted [${caseId}]`;
  // Agent-only. The identity block leads so the first thing a moderator sees is
  // which account this is and a link that opens the case; the pubkey alone told
  // them neither.
  const note = [
    buildAgeReviewIdentityBlock({
      caseId,
      pubkey,
      ageBand: BAND_DISPLAY[ageBand],
      accountName: identity.account_name,
      accountNip05: identity.account_nip05,
      accountVineUsername: identity.account_vine_username,
      deadlineAt: deadlineAt ? deadlineAt.split('T')[0] : null,
    }),
    '',
    'This ticket was created automatically when a moderator restricted the account.',
    'It will be updated if a parent/guardian email is provided or the case is resolved.',
  ].join('\n');

  const customFields = buildAgeReviewCustomFields(env, deadlineAt);

  const res = await fetch(`${zendesk.baseUrl}/tickets`, {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${zendesk.auth}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      ticket: {
        subject,
        comment: { body: note, public: false },
        tags: ['age-review', `age-band-${ageBand}`, 'internal'],
        priority: 'high',
        custom_fields: customFields.length > 0 ? customFields : undefined,
      },
    }),
  });

  if (!res.ok) {
    const errorText = await res.text();
    throw new Error(`Zendesk internal ticket creation failed: ${res.status} - ${errorText}`);
  }

  const data = await res.json() as { ticket?: { id: number } };
  if (data.ticket?.id) {
    await env.DB.prepare(
      'UPDATE age_review_cases SET zendesk_ticket_id = ? WHERE id = ?'
    ).bind(data.ticket.id, caseId).run();
    console.log(`[age-review] Created internal Zendesk ticket #${data.ticket.id} for case ${caseId}`);
    return data.ticket.id;
  }

  return null;
}

export async function syncAgeReviewTicketResolution(
  caseId: string,
  state: AgeReviewState,
  resolutionNote: string | null,
  env: AgeReviewEnv,
): Promise<void> {
  if (!env.DB) return;

  const zendesk = await getZendeskClientConfig(env);
  if (!zendesk) return;

  const row = await env.DB.prepare(
    'SELECT zendesk_ticket_id FROM age_review_cases WHERE id = ?'
  ).bind(caseId).first<{ zendesk_ticket_id: number | null }>();

  if (!row?.zendesk_ticket_id) return;

  const ticketId = row.zendesk_ticket_id;

  const noteLines = [
    `Age review case ${caseId} resolved: **${state}**`,
  ];
  if (resolutionNote) noteLines.push(`Note: ${resolutionNote}`);

  const payload: Record<string, unknown> = {
    ticket: {
      comment: { body: noteLines.join('\n'), public: false },
      status: 'solved',
    },
  };

  // Route to a group (Trust & Safety) rather than assigning the credential owner.
  if (env.ZENDESK_GROUP_ID) {
    (payload.ticket as Record<string, unknown>).group_id = Number(env.ZENDESK_GROUP_ID);
  }

  // Required fields for solving (same pattern as addZendeskInternalNote in index.ts)
  if (env.ZENDESK_FIELD_CATEGORY && env.ZENDESK_FIELD_ISSUE) {
    (payload.ticket as Record<string, unknown>).custom_fields = [
      { id: parseInt(env.ZENDESK_FIELD_CATEGORY, 10), value: 'trust___safety' },
      { id: parseInt(env.ZENDESK_FIELD_ISSUE, 10), value: 'content_report_under_16' },
    ];
  }

  // Catches Zendesk API/network errors here; callers also wrap in try/catch for unexpected errors (e.g. D1 failure on the SELECT above)
  try {
    const res = await fetch(`${zendesk.baseUrl}/tickets/${ticketId}`, {
      method: 'PUT',
      headers: {
        'Authorization': `Basic ${zendesk.auth}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const errorText = await res.text();
      console.error(`[age-review] Failed to resolve Zendesk ticket #${ticketId}: ${res.status} - ${errorText}`);
    }
  } catch (error) {
    console.error('[age-review] Error resolving Zendesk ticket:', error);
  }
}

// Caller (index.ts) must verify HMAC signature before dispatching here.
/**
 * Rename the parent's Zendesk contact to carry the account handle, once they
 * have replied.
 *
 * Staged deliberately. Zendesk renders the stored contact name into the To:
 * header of outbound mail, and the address is supplied unverified by the teen
 * under review, so naming the contact after the account any earlier would
 * disclose a real handle to whoever holds a mistyped address. A reply proves
 * the address is live and held by someone engaging with the review.
 *
 * The contact is verified before the write, not merely assumed from the case
 * row -- see resolveVerifiedParentContact. A Zendesk display name is global,
 * so renaming the wrong user would put a minor's handle in the header of every
 * mail they subsequently send.
 *
 * Best-effort by contract -- the caller has already advanced the case, and a
 * Zendesk failure must not change what the webhook reports.
 */
async function upgradeParentContactName(
  ticketId: number,
  caseRow: AgeReviewCase,
  env: AgeReviewEnv,
): Promise<void> {
  if (!caseRow.parent_contact_email) return;

  const name = buildClaimedParentName({
    accountName: caseRow.account_name,
    accountNip05: caseRow.account_nip05,
    accountVineUsername: caseRow.account_vine_username,
  });
  if (!name) return;

  try {
    // Credential resolution is inside the try on purpose: a Secrets Store
    // binding can throw on .get(), and that must degrade like any other
    // enrichment failure rather than escaping this function.
    const zendesk = await getZendeskClientConfig(env);
    if (!zendesk) return;

    const headers = {
      'Authorization': `Basic ${zendesk.auth}`,
      'Content-Type': 'application/json',
    };

    const ticketRes = await fetch(`${zendesk.baseUrl}/tickets/${ticketId}`, { headers });
    if (!ticketRes.ok) throw new Error(`Zendesk ticket read failed: ${ticketRes.status}`);
    const requesterId = (await ticketRes.json() as { ticket?: { requester_id?: number } }).ticket?.requester_id;
    if (!requesterId) return;

    if (!await resolveVerifiedParentContact(requesterId, caseRow.parent_contact_email, zendesk)) return;

    const res = await fetch(`${zendesk.baseUrl}/users/${requesterId}`, {
      method: 'PUT',
      headers,
      body: JSON.stringify({ user: { name } }),
    });
    if (!res.ok) throw new Error(`Zendesk contact rename failed: ${res.status}`);
    console.log(`[age-review] Renamed parent contact for ticket #${ticketId}`);
  } catch (error) {
    console.error('[age-review] Failed to rename parent contact:', error);
  }
}

export async function handleAgeReviewReplyWebhook(
  request: Request,
  env: AgeReviewEnv,
  corsHeaders: Record<string, string>,
): Promise<Response> {
  if (!env.DB) return json({ success: false, error: 'Database not configured' }, 500, corsHeaders);

  const body = await request.json() as { ticket_id?: number | string };
  const rawTicketId = body.ticket_id;
  const ticketId = typeof rawTicketId === 'string' ? parseInt(rawTicketId, 10) : rawTicketId;
  if (!ticketId || Number.isNaN(ticketId)) {
    return json({ success: false, error: 'ticket_id is required' }, 400, corsHeaders);
  }

  const activeCase = await env.DB.prepare(
    `SELECT * FROM age_review_cases WHERE zendesk_ticket_id = ? AND state NOT IN (${TERMINAL_STATES.map(() => '?').join(',')})`
  ).bind(ticketId, ...TERMINAL_STATES).first<AgeReviewCase>();

  if (!activeCase) {
    return json({ success: false, error: 'No active case linked to this ticket' }, 404, corsHeaders);
  }

  // Advance the case with optimistic concurrency: CAS on the version we read so
  // a concurrent moderator action isn't clobbered, AND bump version so a
  // moderator holding the pre-reply version is forced to refetch -- their stale
  // expected_version now returns 409 on the case-update PATCH rather than
  // silently overwriting the fact that the parent replied. On a CAS miss we
  // re-read once and re-apply if the case is still advanceable, so a real parent
  // reply is never dropped just because an unrelated write bumped the row.
  //
  // The rename is deliberately NOT tied to this delivery winning the CAS. Its
  // only real precondition is "the parent has replied", which is what reaching
  // this handler means at all -- the Zendesk trigger gates on an end-user public
  // comment on an age-review ticket. Tying it to `changes === 1` made it
  // one-shot: upgradeParentContactName swallows its errors and the handler
  // answers 200 regardless, so Zendesk never redelivers, and the next reply
  // returns early because the case has already advanced. A single transient
  // Zendesk blip therefore left the Requester column showing a bare email
  // permanently, with no path back -- and that column is the readable-queue
  // payoff the staging exists to unlock. Renaming on every delivery is
  // idempotent, still gated on resolveVerifiedParentContact, and self-heals.
  let advanced: AgeReviewCase | null = null;
  let notAdvanceable = false;
  let target: AgeReviewCase | null = activeCase;
  for (let attempt = 0; attempt < 2 && target; attempt++) {
    const allowed = VALID_TRANSITIONS[target.state as AgeReviewState];
    if (!allowed?.includes('submitted_for_review')) {
      notAdvanceable = true;
      break;
    }

    const now = new Date();
    const deadline = target.deadline_at ? new Date(target.deadline_at) : null;
    const remainingDays = target.clock_paused
      ? target.remaining_days_when_paused
      : deadline ? (deadline.getTime() - now.getTime()) / (24 * 60 * 60 * 1000) : DEADLINE_DAYS;

    // This path advances an already-restricted case to moderator review, so it
    // intentionally leaves Keycast state unchanged.
    const result = await env.DB.prepare(`
      UPDATE age_review_cases
      SET state = 'submitted_for_review',
          clock_paused = 1,
          clock_paused_at = ?,
          remaining_days_when_paused = ?,
          updated_at = datetime('now'),
          version = version + 1
      WHERE id = ? AND version = ?
    `).bind(now.toISOString(), remainingDays, target.id, target.version).run();

    if (result.meta?.changes === 1) {
      console.log(`[age-review] Parent replied on ticket #${ticketId}, case ${target.id} → submitted_for_review (clock paused)`);
      advanced = target;
      break;
    }

    // CAS miss: the row changed between our read and this write. Re-read and retry.
    target = await env.DB.prepare('SELECT * FROM age_review_cases WHERE id = ?')
      .bind(activeCase.id).first<AgeReviewCase>();
  }

  // Every exit below goes through this. The identity fields it reads are written
  // at case creation and never change, so activeCase is as good a source as the
  // re-read row. Still best-effort: it must not change what the webhook reports.
  await upgradeParentContactName(ticketId, activeCase, env);

  if (advanced) {
    return json({ success: true, case_id: advanced.id, new_state: 'submitted_for_review' }, 200, corsHeaders);
  }
  if (notAdvanceable) {
    return json({ success: true, message: 'Case not in a state that can advance to submitted_for_review' }, 200, corsHeaders);
  }

  console.log(`[age-review] Parent reply on ticket #${ticketId}, case ${activeCase.id} not advanced (changed concurrently)`);
  return json({ success: true, case_id: activeCase.id, message: 'Case changed concurrently; not advanced' }, 200, corsHeaders);
}

// ---------------------------------------------------------------------------
// Cron: deadline checker + Slack alerts
// ---------------------------------------------------------------------------

export async function checkAgeReviewDeadlines(env: AgeReviewEnv): Promise<void> {
  if (!env.DB) return;

  // Alert on cases approaching deadline (within 2 days), skip if alerted in last 12h.
  // Note the deliberate asymmetry: this alert window covers ALL non-terminal cases,
  // whereas auto-close (below) only fires for the restricted set. An expired case in
  // a non-restricted state would therefore be neither auto-closed nor in this window
  // (its deadline is in the past) -- the expired-needs-action alert further down closes
  // that blind spot so such cases still reach a moderator.
  const approaching = await env.DB.prepare(`
    SELECT * FROM age_review_cases
    WHERE state NOT IN (${TERMINAL_STATES.map(() => '?').join(',')})
      AND clock_paused = 0
      AND deadline_at IS NOT NULL
      AND datetime(deadline_at) < datetime('now', '+2 days')
      AND datetime(deadline_at) > datetime('now')
      AND (last_alerted_at IS NULL OR last_alerted_at < datetime('now', '-12 hours'))
    ORDER BY deadline_at ASC
  `).bind(...TERMINAL_STATES).all<AgeReviewCase>();

  if (approaching.results.length > 0 && env.SLACK_WEBHOOK_URL) {
    const sent = await sendSlackAlert(env.SLACK_WEBHOOK_URL, 'approaching', approaching.results);
    if (sent) {
      for (const row of approaching.results) {
        await env.DB.prepare(
          `UPDATE age_review_cases SET last_alerted_at = datetime('now') WHERE id = ?`
        ).bind(row.id).run();
      }
    }
  }

  // Auto-close expired cases and ban via Keycast.
  // only auto-close cases the moderator actually RESTRICTED and that are
  // still awaiting a user/parent response. This deliberately excludes
  // open_reported / under_moderator_review (never restricted -- a single
  // unsolicited report must not auto-ban an account no human confirmed) and
  // submitted_for_review / needs_follow_up (the user already responded -- a
  // moderator must act, the clock must not auto-deny them).
  // compare via datetime() so the ISO-8601 (`...T...Z`) deadline_at is
  // parsed rather than lexically compared against datetime('now') (space form),
  // which otherwise delays expiry until the next UTC midnight.
  const expired = await env.DB.prepare(`
    SELECT * FROM age_review_cases
    WHERE state IN (${ACCOUNT_RESTRICTED_AGE_REVIEW_STATES.map(() => '?').join(',')})
      AND clock_paused = 0
      AND deadline_at IS NOT NULL
      AND datetime(deadline_at) < datetime('now')
  `).bind(...ACCOUNT_RESTRICTED_AGE_REVIEW_STATES).all<AgeReviewCase>();

  for (const row of expired.results) {
    // CAS on the version we read so the cron doesn't auto-close (and then
    // ban/delete) a case a moderator is concurrently acting on. If the row
    // changed since the SELECT above, skip it -- the moderator's action wins and
    // the next tick re-evaluates. This prevents the cron from clobbering a
    // just-cleared case or double-firing enforcement.
    const closeResult = await env.DB.prepare(`
      UPDATE age_review_cases
      SET state = 'denied_closed', resolution_note = 'Auto-closed: deadline expired with no response', updated_at = datetime('now'), version = version + 1
      WHERE id = ? AND version = ?
    `).bind(row.id, row.version).run();
    if (closeResult.meta?.changes !== 1) {
      console.log(`[age-review] Skipped expired case ${row.id} (modified concurrently)`);
      continue;
    }
    console.log(`[age-review] Auto-closed expired case ${row.id} for ${row.pubkey}`);
    try {
      await syncAgeReviewTicketResolution(row.id, 'denied_closed', 'Auto-closed: deadline expired with no response', env);
    } catch (error) {
      console.error(`[age-review] Failed to sync Zendesk for auto-closed case ${row.id}:`, error);
    }

    try {
      const config = await getAgeReviewConfig(env.DB!);
      if (config.auto_delete_on_deny) {
        await triggerBulkModerate(row.pubkey, 'delete-all', 'Age review expired -- auto-deleted', env);
        console.log(`[age-review] Auto-deleted content for expired case ${row.id}`);
      }
    } catch (error) {
      console.error(`[age-review] Auto-delete failed for expired case ${row.id}:`, error);
    }

    try {
      const banResult = await banUser(row.pubkey, 'age_review_expired', env);
      if (banResult.success) {
        console.log(`[age-review] Keycast ban sent for expired case ${row.id}`);
      } else {
        console.error(`[age-review] Keycast ban failed for expired case ${row.id}: ${banResult.error}`);
      }
    } catch (error) {
      console.error(`[age-review] Keycast ban failed for expired case ${row.id}:`, error);
    }

    // Commit the durable classification clear first. That creates a projection
    // job which this tick (or a later tick after an outage) converges in Keycast.
    const durableClear = await clearSubject(env.DB, row.pubkey, undefined, 'age_review_expired');
    if (!durableClear.success) {
      console.error(`[age-review] Protected subject clear failed for expired case ${row.id}: ${durableClear.error}`);
    } else {
      try {
        const projectionPubkey = durableClear.projectionPubkey ?? row.pubkey;
        const clearResult = await clearVerifiedMinor(projectionPubkey, undefined, 'age_review_expired', env);
        if (clearResult.success) await markProjectionComplete(env.DB, projectionPubkey);
        else console.error(`[age-review] Keycast verified_minor clear failed for expired case ${row.id}: ${clearResult.error}`);
      } catch (error) {
        console.error(`[age-review] Keycast verified_minor clear failed for expired case ${row.id}:`, error);
      }
    }

    // purge the user's events at the relay (one-way) -- the case is closed
    // by deadline, matching the deny outcome. Best-effort; logged on failure.
    try {
      const relayBan = await banPubkey(row.pubkey, 'age_review_expired', env);
      if (relayBan.success) {
        console.log(`[age-review] Relay banpubkey sent for expired case ${row.id}`);
      } else {
        console.error(`[age-review] Relay banpubkey failed for expired case ${row.id}: ${relayBan.error}`);
      }
    } catch (error) {
      console.error(`[age-review] Relay banpubkey failed for expired case ${row.id}:`, error);
    }
  }

  // A terminal denial is itself the durable retry source if the subject update
  // failed before it could create a projection job.
  let subjectClearRetries: Awaited<ReturnType<typeof pendingSubjectClears>> = [];
  try {
    subjectClearRetries = await pendingSubjectClears(env.DB);
  } catch (error) {
    console.error('[age-review] Failed to load protected-subject clear retries:', error);
  }
  for (const retry of subjectClearRetries) {
    const result = await clearSubject(
      env.DB, retry.pubkey, retry.clearedBy, retry.reason, retry.subjectId,
    );
    if (!result.success) {
      console.error(`[age-review] Protected-subject clear retry failed for ${retry.pubkey}: ${result.error}`);
    }
  }

  // Durable retry boundary for Keycast projection failures after the subject
  // clear commits.
  let projectionJobs: Array<{ pubkey: string; reason: string }> = [];
  try {
    projectionJobs = await pendingProjectionJobs(env.DB);
  } catch (error) {
    console.error('[age-review] Failed to load protected-minor projection retries:', error);
  }
  for (const job of projectionJobs) {
    try {
      const result = await clearVerifiedMinor(job.pubkey, undefined, job.reason as 'age_review_denied' | 'age_review_expired', env);
      if (result.success) await markProjectionComplete(env.DB, job.pubkey);
      else {
        await markProjectionAttempt(env.DB, job.pubkey);
        console.error(`[age-review] Keycast protected-minor projection retry failed for ${job.pubkey}: ${result.error}`);
      }
    } catch (error) {
      try {
        await markProjectionAttempt(env.DB, job.pubkey);
      } catch (markError) {
        console.error(`[age-review] Failed to rotate protected-minor projection retry ${job.pubkey}:`, markError);
      }
      console.error(`[age-review] Keycast protected-minor projection retry failed for ${job.pubkey}:`, error);
    }
  }

  if (expired.results.length > 0 && env.SLACK_WEBHOOK_URL) {
    await sendSlackAlert(env.SLACK_WEBHOOK_URL, 'expired', expired.results);
  }

  // Expired but NOT auto-closable: non-terminal cases the cron deliberately does
  // not auto-close (never restricted, e.g. open_reported / under_moderator_review,
  // or the user already responded, e.g. submitted_for_review / needs_follow_up).
  // Without this they would silently sit past deadline -- out of the approaching
  // window and out of the auto-close set -- so alert (throttled to 12h) to keep a
  // human in the loop.
  const expiredNeedsAction = await env.DB.prepare(`
    SELECT * FROM age_review_cases
    WHERE state NOT IN (${TERMINAL_STATES.map(() => '?').join(',')})
      AND state NOT IN (${ACCOUNT_RESTRICTED_AGE_REVIEW_STATES.map(() => '?').join(',')})
      AND clock_paused = 0
      AND deadline_at IS NOT NULL
      AND datetime(deadline_at) < datetime('now')
      AND (last_alerted_at IS NULL OR last_alerted_at < datetime('now', '-12 hours'))
    ORDER BY deadline_at ASC
  `).bind(...TERMINAL_STATES, ...ACCOUNT_RESTRICTED_AGE_REVIEW_STATES).all<AgeReviewCase>();

  if (expiredNeedsAction.results.length > 0 && env.SLACK_WEBHOOK_URL) {
    const sent = await sendSlackAlert(env.SLACK_WEBHOOK_URL, 'expired_needs_action', expiredNeedsAction.results);
    if (sent) {
      for (const row of expiredNeedsAction.results) {
        await env.DB.prepare(
          `UPDATE age_review_cases SET last_alerted_at = datetime('now') WHERE id = ?`
        ).bind(row.id).run();
      }
    }
  }
}

async function sendSlackAlert(
  webhookUrl: string,
  alertType: 'approaching' | 'expired' | 'expired_needs_action',
  cases: AgeReviewCase[],
): Promise<boolean> {
  const emoji = alertType === 'approaching' ? ':warning:' : ':rotating_light:';
  const header = alertType === 'approaching'
    ? `${emoji} ${cases.length} age review case(s) approaching deadline`
    : alertType === 'expired'
      ? `${emoji} ${cases.length} age review case(s) expired`
      : `${emoji} ${cases.length} age review case(s) past deadline awaiting moderator action`;

  const lines = cases.map(c => {
    const deadline = c.deadline_at ? new Date(c.deadline_at).toISOString().split('T')[0] : 'no deadline';
    return `• \`${c.pubkey}\` — ${c.suspected_age_band} — deadline: ${deadline} — state: ${c.state}`;
  });

  try {
    const res = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: `${header}\n${lines.join('\n')}` }),
    });
    if (!res.ok) {
      console.error(`[age-review] Slack alert returned ${res.status}`);
      return false;
    }
    return true;
  } catch (error) {
    console.error('[age-review] Failed to send Slack alert:', error);
    return false;
  }
}

// Proactive alert for the moderation-status DB-unavailable fail-open (#197).
// Called from index.ts scheduled() once per cron tick when env.DB is absent,
// so the outage isn't silent even though the request path keeps failing open.
export async function sendDbUnavailableAlert(webhookUrl: string, environment: string): Promise<boolean> {
  try {
    const res = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text: `:rotating_light: [${environment}] D1 unavailable — age-review moderation-status is failing open (returning unrestricted \`active\`). Investigate the moderation-decisions D1 binding.`,
      }),
    });
    if (!res.ok) {
      console.error(`[age-review] DB-unavailable Slack alert returned ${res.status}`);
      return false;
    }
    return true;
  } catch (error) {
    console.error('[age-review] Failed to send DB-unavailable Slack alert:', error);
    return false;
  }
}

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// Bulk action trigger (internal, SYNCHRONOUS)
// ---------------------------------------------------------------------------
// Age-review enforcement runs the bulk action inline and needs the result to set
// the case's enforcement leg status, so it calls runBulkModeration directly
// rather than the async HTTP enqueue path the moderator UI uses. This runs in a
// webhook/cron context (no UI modal to hang), so synchronous is correct here.

async function triggerBulkModerate(
  pubkey: string,
  action: BulkAction,
  reason: string,
  env: AgeReviewEnv,
): Promise<void> {
  const result = await runBulkModeration(env, pubkey, action, reason);
  if (!result.success) {
    const summary = result.failures.slice(0, 3).join('; ');
    throw new Error(summary || 'Bulk moderate failed');
  }
}

// ---------------------------------------------------------------------------
// Age review configuration (D1)
// ---------------------------------------------------------------------------

interface AgeReviewConfig {
  auto_delete_on_deny: boolean;
}

const DEFAULT_CONFIG: AgeReviewConfig = { auto_delete_on_deny: true };

export async function getAgeReviewConfig(db: D1Database): Promise<AgeReviewConfig> {
  const row = await db.prepare(
    "SELECT value FROM age_review_config WHERE key = 'auto_delete_on_deny'"
  ).first<{ value: string }>();
  return {
    auto_delete_on_deny: row ? row.value === 'true' : DEFAULT_CONFIG.auto_delete_on_deny,
  };
}

export async function updateAgeReviewConfig(
  db: D1Database,
  config: Partial<AgeReviewConfig>,
): Promise<AgeReviewConfig> {
  if (config.auto_delete_on_deny !== undefined) {
    await db.prepare(
      "INSERT INTO age_review_config (key, value) VALUES ('auto_delete_on_deny', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
    ).bind(String(config.auto_delete_on_deny)).run();
  }
  return getAgeReviewConfig(db);
}

// ---------------------------------------------------------------------------
// Greenlight consent funnel
// ---------------------------------------------------------------------------

// One row of the funnel's D1 group-by (state x created_via, with a count).
export interface FunnelRow {
  state: string;
  created_via: string | null;
  c: number;
}

// Pure bucketing of the D1 group-by rows into funnel stages. `cleared` is
// approved (split into new_minor vs restored by created_via); `denied_closed` is
// denied/expired; every other state (the seven non-terminal states, and by
// design any unknown/future state) rolls up to in_progress as "still open".
export function bucketModerationCounts(rows: FunnelRow[]): FunnelModerationCounts {
  const terminal = new Set<string>(TERMINAL_STATES);
  let in_progress = 0;
  let approvedTotal = 0;
  let approvedNewMinor = 0;
  let denied_expired = 0;

  for (const row of rows) {
    const count = row.c ?? 0;
    if (row.state === 'cleared') {
      approvedTotal += count;
      if (row.created_via === 'minor_onboarding') approvedNewMinor += count;
    } else if (row.state === 'denied_closed') {
      denied_expired += count;
    } else if (!terminal.has(row.state)) {
      in_progress += count;
    }
  }

  return {
    in_progress,
    approved: {
      total: approvedTotal,
      restored: approvedTotal - approvedNewMinor,
      new_minor: approvedNewMinor,
    },
    denied_expired,
  };
}

// Count tickets matching a Zendesk Search query via /search/count.json. Takes a
// resolved client config (auth + baseUrl from getZendeskClientConfig) so it does
// not duplicate auth/URL construction. Returns null on any failure so a Zendesk
// hiccup degrades gracefully rather than blocking the moderation half.
export async function fetchZendeskTagCount(
  config: { auth: string; baseUrl: string },
  query: string,
): Promise<number | null> {
  try {
    const url = `${config.baseUrl}/search/count.json?query=${encodeURIComponent(query)}`;
    const response = await fetch(url, { headers: { Authorization: `Basic ${config.auth}` } });
    if (!response.ok) return null;
    const data = await response.json() as { count?: number };
    return typeof data.count === 'number' ? data.count : null;
  } catch {
    return null;
  }
}

// GET /api/age-review/funnel: one D1 group-by for band-accurate moderation
// outcomes, plus Zendesk tag counts for the helpdesk intake stages. The Zendesk
// half is best-effort and nulls out on failure; the D1 half always returns.
export async function handleGetAgeReviewFunnel(
  request: Request,
  env: AgeReviewEnv,
  corsHeaders: Record<string, string>,
): Promise<Response> {
  if (!env.DB) return json({ success: false, error: 'Database not configured' }, 500, corsHeaders);

  const url = new URL(request.url);
  const bandParam = url.searchParams.get('age_band');
  const ageBand: AgeBand = bandParam && AGE_BANDS.includes(bandParam as AgeBand)
    ? (bandParam as AgeBand)
    : 'age_13_15';

  const rows = await env.DB.prepare(
    'SELECT state, created_via, COUNT(*) AS c FROM age_review_cases WHERE suspected_age_band = ? GROUP BY state, created_via',
  ).bind(ageBand).all<FunnelRow>();
  const moderation = bucketModerationCounts(rows.results ?? []);

  let reports_in: number | null = null;
  let requests_in: number | null = null;
  let video_received: number | null = null;

  try {
    const zendesk = await getZendeskClientConfig(env);
    if (zendesk) {
      [requests_in, video_received, reports_in] = await Promise.all([
        fetchZendeskTagCount(zendesk, FUNNEL_ZENDESK_QUERIES.requests_in),
        fetchZendeskTagCount(zendesk, FUNNEL_ZENDESK_QUERIES.video_received),
        fetchZendeskTagCount(zendesk, FUNNEL_ZENDESK_QUERIES.reports_in),
      ]);
    }
  } catch (error) {
    console.warn('[age-review] Zendesk funnel counts unavailable:', error);
  }

  const payload: AgeReviewFunnelResponse = {
    success: true,
    age_band: ageBand,
    helpdesk: { source: 'zendesk', band_scope: 'all_bands', reports_in, requests_in, video_received },
    moderation: { source: 'd1', band_scope: ageBand, ...moderation },
    generated_at: new Date().toISOString(),
  };
  return json(payload, 200, corsHeaders);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function json(data: unknown, status: number, headers: Record<string, string>): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}
