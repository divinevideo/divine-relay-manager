import {
  type AgeReviewCase,
  type AgeReviewState,
  type AgeBand,
  AGE_BANDS,
  AGE_REVIEW_STATES,
  TERMINAL_STATES,
  ACCOUNT_RESTRICTED_AGE_REVIEW_STATES,
  VALID_TRANSITIONS,
  isAccountRestrictedAgeReviewState,
  DEADLINE_DAYS,
  defaultResolutionForBand,
  type EnforcementLegStatus,
  type AgeReviewEnforcement,
  type AgeReviewCaseResponse,
} from '../../shared/age-review';
import { handleBulkModerate, type BulkModerateEnv } from './bulk-moderate';
import { resolveZendeskCreds } from './zendesk-sync';
import type { BulkAction, BulkModerateResult } from '../../shared/bulk-moderation';
import { suspendUser, unsuspendUser, banUser, createMinorAccount, type KeycastEnv } from './keycast-client';
import { suspendPubkey, unsuspendPubkey, banPubkey, type SecretStoreSecret } from './nip86';

export interface AgeReviewEnv extends BulkModerateEnv, KeycastEnv {
  SLACK_WEBHOOK_URL?: string;
  ZENDESK_SUBDOMAIN?: string | SecretStoreSecret;
  ZENDESK_API_TOKEN?: string | SecretStoreSecret;
  ZENDESK_EMAIL?: string | SecretStoreSecret;
  ZENDESK_FIELD_CATEGORY?: string;
  ZENDESK_FIELD_ISSUE?: string;
  ZENDESK_FIELD_AGE_REVIEW_DEADLINE?: string;
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
  const enforcement: AgeReviewEnforcement = { relay, relayError, bulk, bulkError, keycast, keycastError };
  const enforcementComplete = relay !== 'failed' && bulk !== 'failed' && keycast !== 'failed';
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

  let body: { username?: string; display_name?: string; zendesk_ticket_id?: number };
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

  if (body.zendesk_ticket_id !== undefined && body.zendesk_ticket_id !== null) {
    if (typeof body.zendesk_ticket_id !== 'number' || !Number.isInteger(body.zendesk_ticket_id) || body.zendesk_ticket_id <= 0) {
      return json({ success: false, error: 'zendesk_ticket_id must be a positive integer' }, 400, corsHeaders);
    }
  }

  const result = await createMinorAccount(username, displayName, env);
  if (!result.success || !result.pubkey || !result.claim_url) {
    const is409 = result.error?.startsWith('409:');
    const is4xx = result.error?.match(/^4\d{2}:/);
    const status = is409 ? 409 : is4xx ? 400 : 502;
    return json({ success: false, error: result.error ?? 'Keycast account creation failed' }, status, corsHeaders);
  }

  const caseId = crypto.randomUUID();
  try {
    await env.DB.prepare(`
      INSERT INTO age_review_cases
      (id, pubkey, suspected_age_band, state, allowed_resolution, resolution_note, created_via, claim_link_url, claim_link_expires_at, zendesk_ticket_id)
      VALUES (?, ?, 'age_13_15', 'cleared', 'parent_video_or_email', 'Approved via parental consent (minor onboarding)', 'minor_onboarding', ?, ?, ?)
    `).bind(caseId, result.pubkey, result.claim_url, result.expires_at ?? null, body.zendesk_ticket_id ?? null).run();
  } catch (err) {
    console.error(`[age-review] D1 audit record failed for minor account: pubkey=${result.pubkey}, case=${caseId}`, err);
    return json({
      success: false,
      error: 'Account created in Keycast but audit record failed. Contact engineering to reconcile.',
      pubkey: result.pubkey,
      case_id: caseId,
    }, 500, corsHeaders);
  }

  console.log(`[age-review] Minor account created: pubkey=${result.pubkey}, case=${caseId}, username=${username}`);

  return json({
    success: true,
    pubkey: result.pubkey,
    claim_url: result.claim_url,
    expires_at: result.expires_at,
    case_id: caseId,
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
    console.warn('[age-review] DB not available — returning fail-open active status for', userPubkey);
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
    restriction: { status: 'restrictedMinorReview' },
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
      );
    } catch (error) {
      console.error('[age-review] Failed to update Zendesk ticket with parent contact:', error);
    }
  } else {
    try {
      await createAgeReviewTicket(caseId, body.email, activeCase.suspected_age_band as AgeBand, activeCase.deadline_at, env);
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

function buildParentOutreachBody(ageBand: AgeBand): string {
  return [
    'Hello,',
    '',
    'We received a report that an account on Divine may belong to a minor in the ' +
      `${BAND_DISPLAY[ageBand]} age range. As part of our safety process, we need a ` +
      'parent or guardian to verify they are aware of and approve this account.',
    '',
    'Please reply to this email to confirm you are the parent or legal guardian of the account holder.',
    '',
    'If you have questions, you can reply directly to this email or contact us at contact@divine.video.',
    '',
    'Thank you,',
    'Divine Trust & Safety',
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

async function createAgeReviewTicket(
  caseId: string,
  parentEmail: string,
  ageBand: AgeBand,
  deadlineAt: string | null,
  env: AgeReviewEnv,
): Promise<void> {
  const zendesk = await getZendeskClientConfig(env);
  if (!zendesk) {
    console.warn('[age-review] Missing Zendesk credentials, skipping ticket creation');
    return;
  }
  if (!env.DB) return;

  const subject = `Age review: parental verification needed [${caseId}]`;
  const outreachBody = buildParentOutreachBody(ageBand);
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
        comment: { body: outreachBody, public: true },
        requester: { email: parentEmail, name: 'Parent/Guardian' },
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

  const data = await res.json() as { ticket?: { id: number } };
  if (data.ticket?.id) {
    await env.DB.prepare(
      'UPDATE age_review_cases SET zendesk_ticket_id = ? WHERE id = ?'
    ).bind(data.ticket.id, caseId).run();
    console.log(`[age-review] Created Zendesk ticket #${data.ticket.id} for case ${caseId}`);
  }
}

async function updateTicketWithParentContact(
  ticketId: number,
  parentEmail: string,
  ageBand: AgeBand,
  env: AgeReviewEnv,
): Promise<void> {
  const zendesk = await getZendeskClientConfig(env);
  if (!zendesk) return;

  const outreachBody = buildParentOutreachBody(ageBand);

  const res = await fetch(`${zendesk.baseUrl}/tickets/${ticketId}`, {
    method: 'PUT',
    headers: {
      'Authorization': `Basic ${zendesk.auth}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      ticket: {
        requester: { email: parentEmail, name: 'Parent/Guardian' },
        comment: { body: outreachBody, public: true },
      },
    }),
  });

  if (!res.ok) {
    const errorText = await res.text();
    throw new Error(`Zendesk ticket update failed: ${res.status} - ${errorText}`);
  }
  console.log(`[age-review] Updated Zendesk ticket #${ticketId} with parent contact ${parentEmail}`);
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
): Promise<number | null> {
  const zendesk = await getZendeskClientConfig(env);
  if (!zendesk) {
    console.warn('[age-review] Missing Zendesk credentials, skipping internal ticket creation');
    return null;
  }
  if (!env.DB) return null;

  const subject = `Age review: ${BAND_DISPLAY[ageBand]} account restricted [${caseId}]`;
  const note = [
    `Account \`${pubkey}\` restricted for age review.`,
    `Suspected age band: ${BAND_DISPLAY[ageBand]}`,
    deadlineAt ? `Deadline: ${deadlineAt.split('T')[0]}` : 'No deadline set',
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
      assignee_email: zendesk.email,
    },
  };

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

  const allowed = VALID_TRANSITIONS[activeCase.state as AgeReviewState];
  if (!allowed?.includes('submitted_for_review')) {
    return json({ success: true, message: 'Case not in a state that can advance to submitted_for_review' }, 200, corsHeaders);
  }

  const now = new Date();
  const deadline = activeCase.deadline_at ? new Date(activeCase.deadline_at) : null;
  const remainingDays = activeCase.clock_paused
    ? activeCase.remaining_days_when_paused
    : deadline ? (deadline.getTime() - now.getTime()) / (24 * 60 * 60 * 1000) : DEADLINE_DAYS;

  // This path advances an already-restricted case to moderator review, so it
  // intentionally leaves Keycast state unchanged.
  await env.DB.prepare(`
    UPDATE age_review_cases
    SET state = 'submitted_for_review',
        clock_paused = 1,
        clock_paused_at = ?,
        remaining_days_when_paused = ?,
        updated_at = datetime('now')
    WHERE id = ?
  `).bind(now.toISOString(), remainingDays, activeCase.id).run();

  console.log(`[age-review] Parent replied on ticket #${ticketId}, case ${activeCase.id} → submitted_for_review (clock paused)`);

  return json({ success: true, case_id: activeCase.id, new_state: 'submitted_for_review' }, 200, corsHeaders);
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

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// Bulk action trigger (internal call to handleBulkModerate)
// ---------------------------------------------------------------------------

async function triggerBulkModerate(
  pubkey: string,
  action: BulkAction,
  reason: string,
  env: AgeReviewEnv,
): Promise<void> {
  const request = new Request('https://internal/api/bulk-moderate', {
    method: 'POST',
    body: JSON.stringify({ pubkey, action, reason }),
  });
  const response = await handleBulkModerate(request, env, {});
  const body = await response.json() as BulkModerateResult & { error?: string };
  if (!response.ok || !body.success) {
    const summary = body.failures?.slice(0, 3).join('; ');
    throw new Error(summary || body.error || `Bulk moderate returned ${response.status}`);
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
// Helpers
// ---------------------------------------------------------------------------

function json(data: unknown, status: number, headers: Record<string, string>): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}
