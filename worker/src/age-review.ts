import {
  type AgeReviewCase,
  type AgeReviewState,
  type AgeBand,
  AGE_BANDS,
  AGE_REVIEW_STATES,
  TERMINAL_STATES,
  VALID_TRANSITIONS,
  DEADLINE_DAYS,
  defaultResolutionForBand,
} from '../../shared/age-review';
import { handleBulkModerate, type BulkModerateEnv } from './bulk-moderate';
import type { BulkAction, BulkModerateResult } from '../../shared/bulk-moderation';

interface AgeReviewEnv extends BulkModerateEnv {
  SLACK_WEBHOOK_URL?: string;
  ZENDESK_SUBDOMAIN?: string;
  ZENDESK_API_TOKEN?: string;
  ZENDESK_EMAIL?: string;
  ZENDESK_FIELD_CATEGORY?: string;
  ZENDESK_FIELD_ISSUE?: string;
  ZENDESK_FIELD_AGE_REVIEW_DEADLINE?: string;
}

interface ZendeskClientConfig {
  auth: string;
  baseUrl: string;
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

  updates.push("updated_at = datetime('now')");
  binds.push(caseId);

  await env.DB.prepare(
    `UPDATE age_review_cases SET ${updates.join(', ')} WHERE id = ?`
  ).bind(...binds).run();

  let updated = await env.DB.prepare('SELECT * FROM age_review_cases WHERE id = ?')
    .bind(caseId).first<AgeReviewCase>();

  // Non-critical: sync Zendesk ticket when case reaches terminal state
  const newState = (body.state as AgeReviewState) ?? existing.state;
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
    body.state &&
    (body.state as string).startsWith('restricted_') &&
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

  // Non-critical: fire bulk content actions on state transitions
  let bulkActionTriggered: string | undefined;
  if (body.state && typeof body.state === 'string') {
    try {
      if ((body.state as string).startsWith('restricted_')) {
        await triggerBulkModerate(existing.pubkey, 'age-restrict-all', 'Age review restriction', env);
        bulkActionTriggered = 'age-restrict-all';
      } else if (body.state === 'cleared') {
        await triggerBulkModerate(existing.pubkey, 'un-age-restrict-all', 'Age review cleared', env);
        bulkActionTriggered = 'un-age-restrict-all';
      } else if (body.state === 'denied_closed') {
        const config = await getAgeReviewConfig(env.DB!);
        if (config.auto_delete_on_deny) {
          await triggerBulkModerate(existing.pubkey, 'delete-all', 'Age review denied', env);
          bulkActionTriggered = 'delete-all';
        }
      }
    } catch (error) {
      console.error(`[age-review] Bulk action failed for case ${caseId}:`, error);
    }
  }

  return json({ success: true, case: updated, bulkActionTriggered }, 200, corsHeaders);
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

function getZendeskClientConfig(env: AgeReviewEnv): ZendeskClientConfig | null {
  if (!env.ZENDESK_SUBDOMAIN || !env.ZENDESK_API_TOKEN || !env.ZENDESK_EMAIL) {
    return null;
  }

  return {
    auth: btoa(`${env.ZENDESK_EMAIL}/token:${env.ZENDESK_API_TOKEN}`),
    baseUrl: `https://${env.ZENDESK_SUBDOMAIN}.zendesk.com/api/v2`,
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
      { id: parseInt(env.ZENDESK_FIELD_ISSUE, 10), value: 'age_review' },
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
  const zendesk = getZendeskClientConfig(env);
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
  const zendesk = getZendeskClientConfig(env);
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
  const zendesk = getZendeskClientConfig(env);
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

  const zendesk = getZendeskClientConfig(env);
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
      assignee_email: env.ZENDESK_EMAIL,
    },
  };

  // Required fields for solving (same pattern as addZendeskInternalNote in index.ts)
  if (env.ZENDESK_FIELD_CATEGORY && env.ZENDESK_FIELD_ISSUE) {
    (payload.ticket as Record<string, unknown>).custom_fields = [
      { id: parseInt(env.ZENDESK_FIELD_CATEGORY, 10), value: 'trust___safety' },
      { id: parseInt(env.ZENDESK_FIELD_ISSUE, 10), value: 'age_review' },
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

  // Alert on cases approaching deadline (within 2 days), skip if alerted in last 12h
  const approaching = await env.DB.prepare(`
    SELECT * FROM age_review_cases
    WHERE state NOT IN (${TERMINAL_STATES.map(() => '?').join(',')})
      AND clock_paused = 0
      AND deadline_at IS NOT NULL
      AND deadline_at < datetime('now', '+2 days')
      AND deadline_at > datetime('now')
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

  // Auto-close expired cases.
  // NOTE: This only updates the case state. Actual account enforcement (ban,
  // Keycast restriction) is deferred to the Keycast integration (Track C).
  const expired = await env.DB.prepare(`
    SELECT * FROM age_review_cases
    WHERE state NOT IN (${TERMINAL_STATES.map(() => '?').join(',')})
      AND clock_paused = 0
      AND deadline_at IS NOT NULL
      AND deadline_at < datetime('now')
  `).bind(...TERMINAL_STATES).all<AgeReviewCase>();

  for (const row of expired.results) {
    await env.DB.prepare(`
      UPDATE age_review_cases
      SET state = 'denied_closed', resolution_note = 'Auto-closed: deadline expired with no response', updated_at = datetime('now')
      WHERE id = ?
    `).bind(row.id).run();
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
  }

  if (expired.results.length > 0 && env.SLACK_WEBHOOK_URL) {
    await sendSlackAlert(env.SLACK_WEBHOOK_URL, 'expired', expired.results);
  }
}

async function sendSlackAlert(
  webhookUrl: string,
  alertType: 'approaching' | 'expired',
  cases: AgeReviewCase[],
): Promise<boolean> {
  const emoji = alertType === 'expired' ? ':rotating_light:' : ':warning:';
  const header = alertType === 'expired'
    ? `${emoji} ${cases.length} age review case(s) expired`
    : `${emoji} ${cases.length} age review case(s) approaching deadline`;

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
