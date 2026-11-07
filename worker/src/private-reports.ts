// ABOUTME: POST /api/internal/private-reports: moderation-service hands over a private DM report,
// ABOUTME: which becomes a Coop review item, or an age-review case for an under-16 report.

import { TERMINAL_STATES } from '../../shared/age-review';
import { AUTOMATED_MODERATOR } from '../../shared/automated-decision';
import { coopHeaders, type CoopEnv } from './coop';
import { errorNameOnly } from './error-name';
import { isHex64 } from './hex';
import {
  openReportedAgeReviewCase,
  type ReportedAgeReviewDecision,
  type ReportedAgeReviewEnv,
} from './reported-age-review';

export interface PrivateReportEnv extends CoopEnv, ReportedAgeReviewEnv {
  DB?: D1Database;
  // Coop's id for the nostr_user item type (Osprey's DIVINE_COOP_USER_TYPE_ID).
  COOP_USER_TYPE_ID?: string;
}

type PrivateReportOutcome = 'queued_in_coop' | 'age_review_opened' | 'age_review_exists';

interface PrivateReport {
  reportId: string;
  reportedPubkey: string;
  reporterPubkey: string;
  reportType: string;
  reportedAt: string;
  hasExcerpt: boolean;
  giftWrapId: string;
}

interface IntakeRow {
  reported_pubkey: string;
  report_type: string;
  outcome: PrivateReportOutcome | null;
  completed_at: string | null;
}

type AttemptResult =
  | { ok: true; outcome: PrivateReportOutcome; caseId: string | null }
  | { ok: false; code: string };

const UNDERAGE_REPORT_TYPE = 'underage_user';

// moderation-service's report type -> Coop's report_reason routing token. Coop
// routes these five to their own queues, CSAM and Child Safety first, and the
// rest of its tokens, `other` included, to General Review.
const COOP_REPORT_REASON = new Map<string, string>([
  ['csam', 'csam'],
  ['child_safety', 'child_safety'],
  ['sexual_content', 'nudity'],
  ['violence', 'violence'],
  ['harassment', 'harassment'],
  ['spam', 'spam'],
  ['ai_generated', 'ai_generated'],
]);

// Long enough that a second delivery of the same report does not run beside
// one still in flight: a Coop attempt is bounded by COOP_TIMEOUT_MS, and the
// age-review identity lookup by its own 3s timeout. The age-review keycast read
// has no timeout, so a slow keycast can outlast the lease and let a second
// attempt start. The two still open one case: the case insert keeps one
// active case per account, and whichever loses it answers age_review_exists.
// An attempt that died mid-way is retried once its lease lapses.
const ATTEMPT_LEASE_MS = 120_000;
const COOP_TIMEOUT_MS = 10_000;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const REPORT_TYPE_RE = /^[a-z_]{1,64}$/;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}T/;

function json(body: unknown, status: number, corsHeaders: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

function parseReport(raw: unknown): { report: PrivateReport } | { error: string } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { error: 'body must be a JSON object' };
  const body = raw as Record<string, unknown>;
  const { reportId, reportedPubkey, reporterPubkey, reportType, reportedAt, hasExcerpt, giftWrapId } = body;
  if (typeof reportId !== 'string' || !(UUID_RE.test(reportId) || isHex64(reportId))) {
    return { error: 'reportId must be a UUID or 64 hex characters' };
  }
  if (!isHex64(reportedPubkey)) return { error: 'reportedPubkey must be 64 hex characters' };
  if (!isHex64(reporterPubkey)) return { error: 'reporterPubkey must be 64 hex characters' };
  if (!isHex64(giftWrapId)) return { error: 'giftWrapId must be 64 hex characters' };
  if (typeof reportType !== 'string' || !REPORT_TYPE_RE.test(reportType)) {
    return { error: 'reportType must be a lowercase report type' };
  }
  if (typeof reportedAt !== 'string' || reportedAt.length > 64 || !ISO_DATE_RE.test(reportedAt)
    || !Number.isFinite(Date.parse(reportedAt))) {
    return { error: 'reportedAt must be an ISO-8601 timestamp' };
  }
  if (typeof hasExcerpt !== 'boolean') return { error: 'hasExcerpt must be a boolean' };
  return {
    report: {
      reportId: reportId.toLowerCase(),
      reportedPubkey: (reportedPubkey as string).toLowerCase(),
      reporterPubkey: (reporterPubkey as string).toLowerCase(),
      reportType,
      reportedAt: new Date(reportedAt).toISOString(),
      hasExcerpt,
      giftWrapId: (giftWrapId as string).toLowerCase(),
    },
  };
}

// UUIDs are application lookup keys. A hex fallback is a gift-wrap event id;
// retain only a domain-separated digest so the lookup key is not a relay pointer.
async function reportLookupKey(reportId: string): Promise<string> {
  if (!isHex64(reportId)) return reportId;
  const digest = await crypto.subtle.digest('SHA-256',
    new TextEncoder().encode(`private-report-id:v1:${reportId}`));
  return `sha256:${Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')}`;
}

async function readRow(db: D1Database, report: PrivateReport): Promise<IntakeRow | null> {
  return db.prepare(`SELECT reported_pubkey, report_type, outcome, completed_at
    FROM private_report_intake WHERE reporter_pubkey = ? AND report_id = ?`)
    .bind(report.reporterPubkey, report.reportId).first<IntakeRow>();
}

// A row retention redacted no longer names its reporter, so it answers a late
// resend of the same reportId, account and type from whoever sends it.
async function readRedactedOutcome(db: D1Database, report: PrivateReport): Promise<{ outcome: PrivateReportOutcome | null } | null> {
  const row = await db.prepare(`SELECT outcome FROM private_report_intake
    WHERE report_id = ? AND reporter_pubkey IS NULL AND reported_pubkey = ? AND report_type = ?
    LIMIT 1`)
    .bind(report.reportId, report.reportedPubkey, report.reportType).first<{ outcome: PrivateReportOutcome | null }>();
  return row;
}

async function logDecision(db: D1Database, decision: ReportedAgeReviewDecision): Promise<boolean> {
  try {
    await db.prepare(`
      INSERT INTO moderation_decisions
      (target_type, target_id, action, reason, moderator_pubkey, report_id, reporter_pubkey, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
    `).bind(
      decision.targetType,
      decision.targetId,
      decision.action,
      decision.reason,
      AUTOMATED_MODERATOR,
      decision.reportId,
      decision.reporterPubkey,
    ).run();
    return true;
  } catch (error) {
    console.error('[private-reports] Failed to log decision:', errorNameOnly(error));
    return false;
  }
}

async function openAgeReview(db: D1Database, env: PrivateReportEnv, report: PrivateReport): Promise<AttemptResult> {
  try {
    const result = await openReportedAgeReviewCase(
      db,
      env,
      report.reportedPubkey,
      { kind: 'private_report', reportId: report.reportId, reporterPubkey: report.reporterPubkey },
      (decision) => logDecision(db, decision),
      '[private-reports]',
    );
    // An approved minor's case opens already cleared; it is still a new case.
    if (result.outcome !== 'exists') return { ok: true, outcome: 'age_review_opened', caseId: result.caseId };
    // A family start that won the insert race leaves no id; record the case
    // this report joined, since retention clears the reporter link with it.
    const caseId = result.caseId ?? (await db.prepare(`SELECT id FROM age_review_cases
      WHERE pubkey = ? AND state NOT IN (${TERMINAL_STATES.map(() => '?').join(',')}) LIMIT 1`)
      .bind(report.reportedPubkey, ...TERMINAL_STATES).first<{ id: string }>())?.id;
    // Gone again already (closed in between). A row with no case would never be
    // redacted, so fail the attempt; the retry sees the account as it is then.
    if (!caseId) {
      console.error(`[private-reports] ${report.reportId}: joined an age review case that is no longer active`);
      return { ok: false, code: 'age_review_failed' };
    }
    return { ok: true, outcome: 'age_review_exists', caseId };
  } catch (error) {
    console.error('[private-reports] Age review case not opened:', errorNameOnly(error));
    return { ok: false, code: 'age_review_failed' };
  }
}

// The item names an account and a reason such as csam, and the request carries
// the ingestion key, so neither may cross the network in clear. Loopback is the
// local stack. The quarantine handoff applies its own rule and is not changed.
function isPrivateSafeCoopUrl(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol === 'https:') return true;
  return url.protocol === 'http:'
    && (url.hostname === 'localhost' || url.hostname === '[::1]' || /^127(\.\d{1,3}){3}$/.test(url.hostname));
}

// Coop's nostr_user item: only fields its schema declares, and nothing from the
// report beyond the account and the reason.
async function queueInCoop(env: PrivateReportEnv, report: PrivateReport): Promise<AttemptResult> {
  if (!env.COOP_URL || !env.COOP_API_KEY || !env.COOP_USER_TYPE_ID) {
    const unset = [!env.COOP_URL && 'COOP_URL', !env.COOP_API_KEY && 'COOP_API_KEY',
      !env.COOP_USER_TYPE_ID && 'COOP_USER_TYPE_ID'].filter(Boolean);
    console.error(`[private-reports] Coop handoff not configured: ${unset.join(', ')} unset`);
    return { ok: false, code: 'coop_not_configured' };
  }
  if (!isPrivateSafeCoopUrl(env.COOP_URL)) {
    console.error('[private-reports] Coop handoff not configured: COOP_URL must be https (or loopback)');
    return { ok: false, code: 'coop_not_configured' };
  }
  let headers: Record<string, string>;
  try {
    headers = await coopHeaders(env.COOP_URL, env.COOP_API_KEY, env);
  } catch (error) {
    console.error('[private-reports] Coop credentials unusable (key, Access pair or HTTPS):', errorNameOnly(error));
    return { ok: false, code: 'coop_not_configured' };
  }
  let response: Response;
  try {
    response = await fetch(`${env.COOP_URL.replace(/\/$/, '')}/api/v1/items/async/`, {
      method: 'POST',
      headers,
      redirect: 'manual',
      signal: AbortSignal.timeout(COOP_TIMEOUT_MS),
      body: JSON.stringify({
        items: [{
          id: report.reportedPubkey,
          typeId: env.COOP_USER_TYPE_ID,
          data: { pubkey: report.reportedPubkey, report_reason: COOP_REPORT_REASON.get(report.reportType) ?? 'other' },
        }],
      }),
    });
  } catch (error) {
    console.error('[private-reports] Coop unreachable:', errorNameOnly(error));
    return { ok: false, code: 'coop_unreachable' };
  }
  await response.body?.cancel();
  // Coop answers 202 with no body; any 2xx is an accepted item.
  if (!response.ok) {
    console.error(`[private-reports] Coop refused the item: ${response.status}`);
    return { ok: false, code: `coop_status_${response.status}` };
  }
  return { ok: true, outcome: 'queued_in_coop', caseId: null };
}

async function intake(
  db: D1Database,
  env: PrivateReportEnv,
  report: PrivateReport,
  corsHeaders: Record<string, string>,
): Promise<Response> {
  const done = (outcome: PrivateReportOutcome | null, duplicate: boolean) =>
    json({ success: true, outcome, duplicate }, 200, corsHeaders);
  const unavailable = (code: string) =>
    json({ success: false, error: 'The report could not be handed over now; retry later', code }, 503, corsHeaders);

  let stored = await readRow(db, report);
  if (!stored) {
    // Answered before the insert, so a resend never writes the link back.
    const redacted = await readRedactedOutcome(db, report);
    if (redacted) {
      if (redacted.outcome) return done(redacted.outcome, true);
      return json({ success: false, error: 'The undelivered report has expired', code: 'report_expired' }, 400, corsHeaders);
    }
    await db.prepare(`INSERT INTO private_report_intake
      (report_id, reported_pubkey, reporter_pubkey, report_type, gift_wrap_id, has_excerpt, reported_at, first_received_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(reporter_pubkey, report_id) DO NOTHING`)
      .bind(report.reportId, report.reportedPubkey, report.reporterPubkey, report.reportType, report.giftWrapId,
        report.hasExcerpt ? 1 : 0, report.reportedAt, new Date().toISOString())
      .run();
    stored = await readRow(db, report);
    if (!stored) throw new Error('intake row missing after insert');
  }
  // A resend carries a new gift wrap and possibly a new timestamp, but never a
  // different account or reason. One that does is a caller bug, and answering
  // `duplicate` would drop it unseen.
  if (stored.reported_pubkey !== report.reportedPubkey || stored.report_type !== report.reportType) {
    console.error(`[private-reports] reportId ${report.reportId} already names a different report from this reporter; refused`);
    return json({ success: false, error: 'This reporter already used reportId for a different report', code: 'report_id_conflict' }, 400, corsHeaders);
  }
  if (stored.completed_at) return done(stored.outcome, true);

  const startedAt = Date.now();
  const claim = await db.prepare(`UPDATE private_report_intake
    SET attempts = attempts + 1, last_attempt_at = ?, lease_until = ?
    WHERE reporter_pubkey = ? AND report_id = ? AND completed_at IS NULL AND lease_until <= ?
    RETURNING id, attempts`)
    .bind(new Date(startedAt).toISOString(), startedAt + ATTEMPT_LEASE_MS, report.reporterPubkey, report.reportId,
      startedAt)
    .first<{ id: number; attempts: number }>();
  if (!claim) {
    const current = await readRow(db, report);
    if (current?.completed_at) return done(current.outcome, true);
    return unavailable('attempt_in_progress');
  }
  // This attempt's number. A newer attempt claims the row once this one's
  // lease lapses, so both finishing writes below change the row only while it
  // is still this attempt's: a late one must not clear the newer attempt's
  // lease or replace what it recorded. They find the row by id, because
  // retention can expire an unfinished row mid-attempt and clear its reporter.
  const { id: rowId, attempts: attempt } = claim;

  const result = report.reportType === UNDERAGE_REPORT_TYPE
    ? await openAgeReview(db, env, report)
    : await queueInCoop(env, report);

  if (!result.ok) {
    await db.prepare(`UPDATE private_report_intake SET last_error = ?, lease_until = 0
      WHERE id = ? AND completed_at IS NULL AND attempts = ?`)
      .bind(result.code, rowId, attempt).run();
    return unavailable(result.code);
  }
  // If this write fails after Coop accepted the item, the retry submits it again.
  const recorded = await db.prepare(`UPDATE private_report_intake
    SET outcome = ?, case_id = ?, completed_at = ?, last_error = NULL, lease_until = 0
    WHERE id = ? AND completed_at IS NULL AND attempts = ?`)
    .bind(result.outcome, result.caseId, new Date().toISOString(), rowId, attempt)
    .run();
  if (recorded.meta.changes !== 1) {
    // The report was still handed over; the row is the newer attempt's to record.
    console.warn(`[private-reports] ${report.reportId}: attempt ${attempt} finished after a newer attempt took the row`);
  }
  console.log(`[private-reports] ${report.reportId}: ${result.outcome} (${report.reportType})`);
  return done(result.outcome, false);
}

/**
 * Take a private report moderation-service received by encrypted DM and put the
 * reported account in front of a moderator: an age-review case for an under-16
 * report, otherwise a Coop `nostr_user` item routed by reason. It only creates
 * review items. Nothing is published to a relay, no Zendesk ticket is filed,
 * and nothing is hidden, restricted or banned.
 *
 * The caller authorizes the request first (index.ts opens this route to
 * moderation-service's MOD_RELAY_ADMIN_KEY).
 *
 * Answers 200 with the outcome, `duplicate: true` when this reporter's
 * reportId already completed; 400 for a body that will never succeed; 503
 * when the handoff cannot complete now, which moderation-service retries.
 */
export async function handlePrivateReport(
  request: Request,
  env: PrivateReportEnv,
  corsHeaders: Record<string, string>,
  prepareDb: (db: D1Database) => Promise<void>,
): Promise<Response> {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    raw = undefined;
  }
  const parsed = parseReport(raw);
  if ('error' in parsed) {
    return json({ success: false, error: parsed.error, code: 'invalid_body' }, 400, corsHeaders);
  }

  const unavailable = () => json({
    success: false, error: 'The report could not be handed over now; retry later', code: 'db_unavailable',
  }, 503, corsHeaders);
  if (!env.DB) return unavailable();
  try {
    parsed.report.reportId = await reportLookupKey(parsed.report.reportId);
    await prepareDb(env.DB);
    return await intake(env.DB, env, parsed.report, corsHeaders);
  } catch (error) {
    console.error('[private-reports] Intake failed:', errorNameOnly(error));
    return unavailable();
  }
}
