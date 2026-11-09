// ABOUTME: Opens the age-review case an under-16 report asks for, one active case per pubkey.
// ABOUTME: Shared by ReportWatcher (kind-1984 reports) and the private-report intake route.

import {
  AGE_REVIEW_ACTION,
  DEADLINE_DAYS,
  TERMINAL_STATES,
  defaultResolutionForBand,
} from '../../shared/age-review';
import { getUserStatus, type KeycastEnv } from './keycast-client';
import { resolveByPubkey } from './protected-minors';
import { fetchAccountIdentity } from './relay-profile';

export interface ReportedAgeReviewEnv extends KeycastEnv {
  RELAY_URL?: string;
}

/**
 * Where the under-16 report came from. A kind-1984 report is a public event,
 * so the case links its id (`report_id`), which the case pane resolves on the
 * relay. A private report has no event to resolve: its id is moderation-
 * service's idempotency key, so it goes to the decision log only, and the
 * case records the source in `created_via`.
 */
export type ReportedAgeReviewSource =
  | { kind: 'report'; reportEventId: string; reporterPubkey: string }
  | { kind: 'private_report'; reportId: string; reporterPubkey: string };

// SQL literals, never interpolated from input: the kind is a closed union.
const CREATED_VIA_SQL: Record<ReportedAgeReviewSource['kind'], string> = {
  report: "'report'",
  private_report: "'private_report'",
};

export interface ReportedAgeReviewDecision {
  targetType: string;
  targetId: string;
  action: string;
  reason: string;
  reportId: string;
  // Null for a private report; see decisionReporter.
  reporterPubkey: string | null;
}

export type ReportedAgeReviewResult =
  | { outcome: 'opened'; caseId: string }
  | { outcome: 'auto_cleared'; caseId: string }
  // caseId is null when a concurrent start won the insert.
  | { outcome: 'exists'; caseId: string | null };

function caseReportId(source: ReportedAgeReviewSource): string | null {
  return source.kind === 'report' ? source.reportEventId : null;
}

function decisionReportId(source: ReportedAgeReviewSource): string {
  return source.kind === 'report' ? source.reportEventId : source.reportId;
}

// The decision log has no disposal stage. A kind-1984 report's reporter is
// public on the relay anyway, but a private report's reporter-to-account link
// exists nowhere public: it is kept only on the case and the intake row, where
// retention clears it.
function decisionReporter(source: ReportedAgeReviewSource): string | null {
  return source.kind === 'report' ? source.reporterPubkey : null;
}

function reasonLabel(source: ReportedAgeReviewSource): string {
  return source.kind === 'report' ? 'Under-16 report' : 'Under-16 private report';
}

/**
 * An approved minor: an active protected-minor subject (#192; the durable record,
 * and the only one a self-custody account has) or keycast's verified_minor flag.
 * The keycast fallback covers onboarding accounts the registry never recorded, but
 * it also answers yes while a denial's keycast clear is still pending (the account
 * is banned by then, and the cron converges within a tick). The registry is read
 * first because it is local and survives a keycast outage. Returns which source
 * proved it, for the decision log, or null for no approved minor.
 */
async function isApprovedMinor(
  db: D1Database,
  env: ReportedAgeReviewEnv,
  pubkey: string,
  logPrefix: string,
): Promise<'registry' | 'keycast' | null> {
  try {
    if (await resolveByPubkey(db, pubkey)) return 'registry';
  } catch (err) {
    console.warn(`${logPrefix} Protected-minor registry check failed; falling back to keycast:`, err);
  }
  const keycastStatus = await getUserStatus(pubkey, env);
  return keycastStatus.success && keycastStatus.verified_minor === true ? 'keycast' : null;
}

async function attachReportToFamilyApplication(
  db: D1Database,
  source: ReportedAgeReviewSource,
  reportedPubkey: string,
): Promise<void> {
  // Keep the first report visible without overwriting provenance or opening a
  // second case. The predicate also handles a family start winning the insert race.
  // A private report attaches with no report_id, which only it can leave beside a
  // reporter. A public report still attaches over one, as it did before private
  // reports existed, and so takes the place of a private one, never the reverse.
  const unattached = source.kind === 'report'
    ? 'report_id IS NULL'
    : 'report_id IS NULL AND reporter_pubkey IS NULL';
  await db.prepare(`UPDATE age_review_cases
    SET report_id = ?, reporter_pubkey = ?, updated_at = datetime('now'), version = version + 1
    WHERE pubkey = ? AND state NOT IN (${TERMINAL_STATES.map(() => '?').join(',')}) AND created_via = 'greenlight_application'
      AND ${unattached}`)
    .bind(caseReportId(source), source.reporterPubkey, reportedPubkey, ...TERMINAL_STATES).run();
}

/**
 * Open the age-review case an under-16 report asks for, unless the account
 * already has an active one. The caller has ensured the schema. Opening a case
 * enforces nothing: a case starts `open_reported`, which the deadline cron
 * never auto-closes, and only a moderator moves it into a restricted state.
 *
 * Throws when a D1 read or write fails, so the caller decides whether that is
 * retried (the private-report route) or logged (ReportWatcher).
 */
export async function openReportedAgeReviewCase(
  db: D1Database,
  env: ReportedAgeReviewEnv,
  reportedPubkey: string,
  source: ReportedAgeReviewSource,
  logDecision: (decision: ReportedAgeReviewDecision) => Promise<boolean>,
  logPrefix: string,
): Promise<ReportedAgeReviewResult> {
  // Skip if an active case already exists for this pubkey
  const existing = await db.prepare(`
    SELECT id, state FROM age_review_cases
    WHERE pubkey = ? AND state NOT IN (${TERMINAL_STATES.map(() => '?').join(',')})
    LIMIT 1
  `).bind(reportedPubkey, ...TERMINAL_STATES).first<{ id: string; state: string }>();

  if (existing) {
    await attachReportToFamilyApplication(db, source, reportedPubkey);
    console.log(`${logPrefix} Active age review case already exists; skipping duplicate`);
    return { outcome: 'exists', caseId: existing.id };
  }

  // Auto-clear: an approved minor (registry or keycast) is recorded as already cleared
  try {
    const approvedVia = await isApprovedMinor(db, env, reportedPubkey, logPrefix);
    if (approvedVia) {
      const caseId = crypto.randomUUID();
      // Capture here too. This case opens already cleared, so nothing hides the
      // profile today -- but the account may be actioned later, and a cleared
      // case is still one a moderator may need to identify after the fact.
      const lookup = await fetchAccountIdentity(reportedPubkey, env.RELAY_URL)
        .catch(() => ({ completed: false, profile: null }));
      const identity = lookup.profile;
      // Null unless the relay answered -- see the note on the main path.
      const identityCapturedAt = lookup.completed ? new Date().toISOString() : null;

      await db.prepare(`
        INSERT INTO age_review_cases
        (id, pubkey, reporter_pubkey, report_id, suspected_age_band, state, allowed_resolution, resolution_note, created_via,
         account_name, account_nip05, account_vine_username, identity_captured_at, closed_at)
        VALUES (?, ?, ?, ?, 'age_13_15', 'cleared', 'parent_video_or_email', 'Auto-cleared: previously verified minor', ${CREATED_VIA_SQL[source.kind]}, ?, ?, ?, ?, datetime('now'))
      `).bind(
        caseId,
        reportedPubkey,
        source.reporterPubkey,
        caseReportId(source),
        identity?.name ?? null,
        identity?.nip05 ?? null,
        identity?.vineUsername ?? null,
        identityCapturedAt,
      ).run();

      await logDecision({
        targetType: 'pubkey',
        targetId: reportedPubkey,
        action: AGE_REVIEW_ACTION.caseCreated,
        reason: `${reasonLabel(source)} auto-cleared: verified minor via ${approvedVia} (case ${caseId})`,
        reportId: decisionReportId(source),
        reporterPubkey: decisionReporter(source),
      });

      console.log(`${logPrefix} Age review case auto-cleared for verified minor`);
      return { outcome: 'auto_cleared', caseId };
    }
  } catch (err) {
    console.warn(`${logPrefix} Approved-minor check failed; proceeding with normal case:`, err);
  }

  const caseId = crypto.randomUUID();
  const band = 'age_13_15' as const;
  const deadline = new Date(Date.now() + DEADLINE_DAYS * 24 * 60 * 60 * 1000).toISOString();

  // Capture a readable identifier while one is still visible. The invariant
  // is that nothing which hides a *pubkey's* profile may run first:
  // suspendpubkey/banpubkey hide the account's content from relay queries and
  // a later lookup returns nothing. Those run only from the case-update
  // handler and the deadline cron, both of which act on a case that already
  // exists and has already captured.
  //
  // Not the stronger claim that no enforcement at all precedes this.
  // ReportWatcher.handleReportEvent awaits processAutoHide first, which can
  // reach banEvent -- but that targets a single event id and leaves the
  // author's kind-0 queryable, so it does not threaten the capture.
  //
  // Best-effort by contract -- fetchAccountIdentity swallows its own errors,
  // and the extra catch here covers an unexpected throw so enrichment can
  // never be the reason a case fails to open.
  const lookup = await fetchAccountIdentity(reportedPubkey, env.RELAY_URL)
    .catch(() => ({ completed: false, profile: null }));
  const identity = lookup.profile;
  // Only stamp when the relay actually answered. A timeout or an unreachable
  // relay is not evidence the account has no profile, and a stamp would
  // exclude this case from the backfill for good -- right before enforcement
  // hides the profile and makes the loss permanent.
  const identityCapturedAt = lookup.completed ? new Date().toISOString() : null;

  // A family can start Greenlight during the identity lookup above. Check
  // inside the insert too, so the two entry points keep one active case.
  const inserted = await db.prepare(`
    INSERT INTO age_review_cases
    (id, pubkey, reporter_pubkey, report_id, suspected_age_band, state, allowed_resolution, deadline_at,
     account_name, account_nip05, account_vine_username, identity_captured_at, created_via)
    SELECT ?, ?, ?, ?, ?, 'open_reported', ?, ?, ?, ?, ?, ?, ${CREATED_VIA_SQL[source.kind]}
    WHERE NOT EXISTS (SELECT 1 FROM age_review_cases WHERE pubkey = ?
      AND state NOT IN (${TERMINAL_STATES.map(() => '?').join(',')}))
  `).bind(
    caseId,
    reportedPubkey,
    source.reporterPubkey,
    caseReportId(source),
    band,
    defaultResolutionForBand(band),
    deadline,
    identity?.name ?? null,
    identity?.nip05 ?? null,
    identity?.vineUsername ?? null,
    identityCapturedAt,
    reportedPubkey,
    ...TERMINAL_STATES,
  ).run();
  if (inserted.meta?.changes === 0) {
    await attachReportToFamilyApplication(db, source, reportedPubkey);
    // Keep this capture if the family case opened without one.
    if (identityCapturedAt) {
      await db.prepare(`UPDATE age_review_cases
        SET account_name = ?, account_nip05 = ?, account_vine_username = ?, identity_captured_at = ?
        WHERE pubkey = ? AND state NOT IN (${TERMINAL_STATES.map(() => '?').join(',')})
          AND created_via = 'greenlight_application' AND identity_captured_at IS NULL`)
        .bind(identity?.name ?? null, identity?.nip05 ?? null, identity?.vineUsername ?? null, identityCapturedAt,
          reportedPubkey, ...TERMINAL_STATES).run();
    }
    return { outcome: 'exists', caseId: null };
  }

  await logDecision({
    targetType: 'pubkey',
    targetId: reportedPubkey,
    action: AGE_REVIEW_ACTION.caseCreated,
    reason: `${reasonLabel(source)}: age review case ${caseId} created (default band: ${band})`,
    reportId: decisionReportId(source),
    reporterPubkey: decisionReporter(source),
  });

  console.log(`${logPrefix} Age review case created`);
  return { outcome: 'opened', caseId };
}
