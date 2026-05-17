import {
  type AgeReviewCase,
  type AgeReviewState,
  type AgeBand,
  AGE_BANDS,
  AGE_REVIEW_STATES,
  TERMINAL_STATES,
  DEADLINE_DAYS,
  defaultResolutionForBand,
} from '../../shared/age-review';

interface AgeReviewEnv {
  DB?: D1Database;
  SLACK_WEBHOOK_URL?: string;
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

  const updated = await env.DB.prepare('SELECT * FROM age_review_cases WHERE id = ?')
    .bind(caseId).first<AgeReviewCase>();
  return json({ success: true, case: updated }, 200, corsHeaders);
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

  const activeCase = await env.DB.prepare(`
    SELECT * FROM age_review_cases
    WHERE pubkey = ? AND state NOT IN (${TERMINAL_STATES.map(() => '?').join(',')})
    ORDER BY created_at DESC LIMIT 1
  `).bind(userPubkey, ...TERMINAL_STATES).first<AgeReviewCase>();

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

  return json({ success: true }, 200, corsHeaders);
}

// ---------------------------------------------------------------------------
// Cron: deadline checker + Slack alerts
// ---------------------------------------------------------------------------

export async function checkAgeReviewDeadlines(env: AgeReviewEnv): Promise<void> {
  if (!env.DB) return;

  // Alert on cases approaching deadline (within 2 days)
  const approaching = await env.DB.prepare(`
    SELECT * FROM age_review_cases
    WHERE state NOT IN (${TERMINAL_STATES.map(() => '?').join(',')})
      AND clock_paused = 0
      AND deadline_at IS NOT NULL
      AND deadline_at < datetime('now', '+2 days')
      AND deadline_at > datetime('now')
    ORDER BY deadline_at ASC
  `).bind(...TERMINAL_STATES).all<AgeReviewCase>();

  if (approaching.results.length > 0 && env.SLACK_WEBHOOK_URL) {
    await sendSlackAlert(env.SLACK_WEBHOOK_URL, 'approaching', approaching.results);
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
  }

  if (expired.results.length > 0 && env.SLACK_WEBHOOK_URL) {
    await sendSlackAlert(env.SLACK_WEBHOOK_URL, 'expired', expired.results);
  }
}

async function sendSlackAlert(
  webhookUrl: string,
  alertType: 'approaching' | 'expired',
  cases: AgeReviewCase[],
): Promise<void> {
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
    }
  } catch (error) {
    console.error('[age-review] Failed to send Slack alert:', error);
  }
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
