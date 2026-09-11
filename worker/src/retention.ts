// ABOUTME: Hold-aware, bounded disposal for protected-minor and age-review D1 records.
// ABOUTME: Compacts retry records before deletion and never mutates active classifications.

import { RETENTION_DAYS } from '../../shared/retention';
import type { SecretStoreSecret } from './nip86';

const BATCH_LIMIT = 100;

export interface RetentionEnv {
  DB?: D1Database;
  PROTECTED_MINOR_TOMBSTONE_KEY?: string | SecretStoreSecret;
  SLACK_WEBHOOK_URL?: string;
}

export interface RetentionResult {
  claimLinksCleared: number;
  casesRedacted: number;
  casesDeleted: number;
  projectionsDeleted: number;
  bindingsDeleted: number;
  operationsCompacted: number;
  subjectsDeleted: number;
  pendingOperationsOverdue: number;
  pendingProjectionsOverdue: number;
  unknownReasonsAlerted: number;
}

function emptyResult(): RetentionResult {
  return {
    claimLinksCleared: 0, casesRedacted: 0, casesDeleted: 0,
    projectionsDeleted: 0, bindingsDeleted: 0, operationsCompacted: 0,
    subjectsDeleted: 0, pendingOperationsOverdue: 0,
    pendingProjectionsOverdue: 0, unknownReasonsAlerted: 0,
  };
}

async function resolveSecret(value: string | SecretStoreSecret | undefined): Promise<string | null> {
  if (!value) return null;
  return typeof value === 'string' ? value : value.get();
}

interface TombstoneKeyring { active_key_id: string; keys: Record<string, string> }

async function readKeyring(value: string | SecretStoreSecret | undefined): Promise<TombstoneKeyring | null> {
  const raw = await resolveSecret(value);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<TombstoneKeyring>;
    if (typeof parsed.active_key_id === 'string' && parsed.keys
      && typeof parsed.keys[parsed.active_key_id] === 'string') return parsed as TombstoneKeyring;
  } catch {
    // A plain secret is the backward-compatible v1 keyring.
  }
  return { active_key_id: 'v1', keys: { v1: raw } };
}

export async function resolveTombstoneKey(
  value: string | SecretStoreSecret | undefined,
  keyId: string,
): Promise<string | null> {
  const keyring = await readKeyring(value);
  return keyring?.keys[keyId] ?? null;
}

async function keyedDigest(key: string, domain: string, value: string): Promise<string> {
  const cryptoKey = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  const signature = await crypto.subtle.sign('HMAC', cryptoKey, new TextEncoder().encode(`${domain}\0${value}`));
  return [...new Uint8Array(signature)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function digestProvisioningFingerprint(key: string, fingerprint: string, binding?: string | null): Promise<string> {
  return keyedDigest(key, 'relay-manager:provisioning-request:v1', `${fingerprint}\0${binding ?? ''}`);
}

async function digestProvisioningResult(key: string, resultPubkey: string): Promise<string> {
  return keyedDigest(key, 'relay-manager:provisioning-result:v1', resultPubkey);
}

export async function findProvisioningTombstone(
  db: D1Database,
  operationId: string,
): Promise<{ kind: string; request_digest: string; terminal_outcome: string; key_id: string } | null> {
  return db.prepare(`SELECT kind, request_digest, terminal_outcome, key_id
    FROM protected_minor_provisioning_tombstones WHERE provisioning_operation_id = ?`)
    .bind(operationId).first<{ kind: string; request_digest: string; terminal_outcome: string; key_id: string }>();
}

async function notify(env: RetentionEnv, message: string): Promise<boolean> {
  if (!env.SLACK_WEBHOOK_URL) return false;
  try {
    const response = await fetch(env.SLACK_WEBHOOK_URL, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: message }),
    });
    if (!response.ok) throw new Error(`retention alert returned ${response.status}`);
    return true;
  } catch (error) {
    // Alert delivery is operationally important, but must never block an
    // otherwise-safe disposal run. Keep this log generic: the alert payload is
    // deliberately aggregate-only and protected identifiers never belong here.
    console.error('[retention] alert delivery failed:', error);
    return false;
  }
}

async function notifyIfDue(env: RetentionEnv, alertType: string, message: string): Promise<void> {
  if (!env.DB || !env.SLACK_WEBHOOK_URL) return;
  const due = await env.DB.prepare(`SELECT 1 AS due FROM retention_alert_state
    WHERE alert_type = ? AND datetime(last_alerted_at) > datetime('now', '-1 day')`)
    .bind(alertType).first();
  if (due) return;
  if (await notify(env, message)) {
    await env.DB.prepare(`INSERT INTO retention_alert_state (alert_type, last_alerted_at)
      VALUES (?, datetime('now')) ON CONFLICT(alert_type) DO UPDATE SET last_alerted_at = excluded.last_alerted_at`)
      .bind(alertType).run();
  }
}

const noHold = (recordType: string, recordKey: string, stage: string) => `NOT EXISTS (
  SELECT 1 FROM retention_legal_holds h
  WHERE h.record_type = '${recordType}'
    AND (h.record_key IS NULL OR h.record_key = ${recordKey})
    AND (h.disposal_stage = 'all' OR h.disposal_stage = '${stage}')
    AND datetime(h.starts_at) <= datetime('now')
    AND h.released_at IS NULL
    AND (h.expires_at IS NULL OR datetime(h.expires_at) > datetime('now'))
)`;

export async function runRetentionDisposal(env: RetentionEnv): Promise<RetentionResult> {
  if (!env.DB) return emptyResult();
  const db = env.DB;
  const result = emptyResult();

  // Each disposal stage is independent and idempotent, and the
  // dependent-before-subject ordering is enforced by every delete's own
  // NOT EXISTS guards, not by this sequence running to completion. So one stage
  // throwing must not starve the stages that follow it: isolate each, log the
  // failure, and let the next scheduled run retry it. Only the stage label is
  // safe to log; no protected identifier belongs in this message.
  const runStage = async (label: string, stage: () => Promise<void>): Promise<void> => {
    try {
      await stage();
    } catch (error) {
      console.error(`[retention] disposal stage ${label} failed:`, error);
    }
  };

  await runStage('unknown-reason-alert', async () => {
    const unknown = await db.prepare(`SELECT COUNT(*) AS count FROM (
      SELECT 1 FROM protected_minor_subjects
      WHERE classification_state = 'cleared' AND clear_reason_class = 'unclassified'
        AND clear_reason_alerted_at IS NULL LIMIT ${BATCH_LIMIT})`).first<{ count: number }>();
    result.unknownReasonsAlerted = Number(unknown?.count ?? 0);
    if (result.unknownReasonsAlerted > 0) {
      const sent = await notify(env, `[retention] ${result.unknownReasonsAlerted} protected-subject clear reason(s) require Trust & Safety classification`);
      if (sent) {
        await db.prepare(`UPDATE protected_minor_subjects SET clear_reason_alerted_at = datetime('now')
          WHERE subject_id IN (SELECT subject_id FROM protected_minor_subjects
            WHERE classification_state = 'cleared' AND clear_reason_class = 'unclassified'
              AND clear_reason_alerted_at IS NULL LIMIT ${BATCH_LIMIT})`).run();
      }
    }
  });

  await runStage('overdue-pending-alert', async () => {
    const overdueOps = await db.prepare(`SELECT COUNT(*) AS count FROM protected_minor_provisioning_operations
      WHERE state = 'pending' AND datetime(created_at) <= datetime('now', '-${RETENTION_DAYS.pendingOperationalDeadline} day')`)
      .first<{ count: number }>();
    result.pendingOperationsOverdue = Number(overdueOps?.count ?? 0);
    const overdueProjections = await db.prepare(`SELECT COUNT(*) AS count FROM protected_minor_projection_jobs
      WHERE state = 'pending' AND datetime(created_at) <= datetime('now', '-${RETENTION_DAYS.pendingOperationalDeadline} day')`)
      .first<{ count: number }>();
    result.pendingProjectionsOverdue = Number(overdueProjections?.count ?? 0);
    if (result.pendingOperationsOverdue || result.pendingProjectionsOverdue) {
      await notifyIfDue(env, 'overdue_pending', `[retention] overdue protected-record work: provisioning=${result.pendingOperationsOverdue}, projection=${result.pendingProjectionsOverdue}`);
    }
  });

  await runStage('claim-link-clear', async () => {
    const claims = await db.prepare(`UPDATE age_review_cases SET claim_link_url = NULL
      WHERE id IN (SELECT id FROM age_review_cases
        WHERE claim_link_url IS NOT NULL
          AND ((claim_link_expires_at IS NOT NULL AND datetime(claim_link_expires_at) <= datetime('now'))
            OR closed_at IS NOT NULL)
          AND ${noHold('age_review_case', 'age_review_cases.id', 'claim_link')}
        LIMIT ${BATCH_LIMIT})`).run();
    result.claimLinksCleared = claims.meta.changes;
  });

  await runStage('age-review-redaction', async () => {
    const redacted = await db.prepare(`UPDATE age_review_cases SET
        parent_contact_email = NULL, claim_link_url = NULL, claim_link_expires_at = NULL,
        account_name = NULL, account_nip05 = NULL, account_vine_username = NULL,
        identity_captured_at = NULL, resolution_note = NULL, reporter_pubkey = NULL,
        moderator_pubkey = NULL, redacted_at = datetime('now')
      WHERE id IN (SELECT id FROM age_review_cases
        WHERE closed_at IS NOT NULL AND redacted_at IS NULL
          AND datetime(closed_at) <= datetime('now', '-${RETENTION_DAYS.ageReviewDetail} days')
          AND ${noHold('age_review_case', 'age_review_cases.id', 'redaction')}
        LIMIT ${BATCH_LIMIT})`).run();
    result.casesRedacted = redacted.meta.changes;
  });

  await runStage('projection-delete', async () => {
    const projections = await db.prepare(`DELETE FROM protected_minor_projection_jobs
      WHERE subject_id IN (SELECT subject_id FROM protected_minor_projection_jobs
        WHERE state = 'complete' AND datetime(updated_at) <= datetime('now', '-${RETENTION_DAYS.projectionComplete} days')
          AND ${noHold('projection_job', 'protected_minor_projection_jobs.subject_id', 'deletion')}
        LIMIT ${BATCH_LIMIT})`).run();
    result.projectionsDeleted = projections.meta.changes;
  });

  await runStage('provisioning-compaction', async () => {
    const tombstoneKeyring = await readKeyring(env.PROTECTED_MINOR_TOMBSTONE_KEY);
    const tombstoneKey = tombstoneKeyring?.keys[tombstoneKeyring.active_key_id];
    if (tombstoneKey && tombstoneKeyring) {
      const operations = await db.prepare(`SELECT provisioning_operation_id, subject_id, kind, request_fingerprint, state,
          result_pubkey, updated_at FROM protected_minor_provisioning_operations
        WHERE state IN ('complete', 'failed')
          AND datetime(updated_at) <= datetime('now', '-${RETENTION_DAYS.provisioningDetail} days')
          AND ${noHold('provisioning_operation', 'protected_minor_provisioning_operations.provisioning_operation_id', 'compaction')}
        ORDER BY datetime(updated_at) LIMIT ${BATCH_LIMIT}`).all<{
          provisioning_operation_id: string; subject_id: string | null; kind: string; request_fingerprint: string;
          state: string; result_pubkey: string | null; updated_at: string;
        }>();
      for (const operation of operations.results) {
        const requestDigest = await digestProvisioningFingerprint(
          tombstoneKey, operation.request_fingerprint, operation.kind === 'replacement' ? operation.subject_id : null,
        );
        const resultDigest = operation.result_pubkey
          ? await digestProvisioningResult(tombstoneKey, operation.result_pubkey) : null;
        const batch = await db.batch([
          db.prepare(`INSERT INTO protected_minor_provisioning_tombstones
            (provisioning_operation_id, kind, terminal_outcome, completed_at, request_digest, result_digest, key_id)
            SELECT provisioning_operation_id, kind, state, updated_at, ?, ?, ?
            FROM protected_minor_provisioning_operations
            WHERE provisioning_operation_id = ? AND state IN ('complete', 'failed')
              AND ${noHold('provisioning_operation', 'provisioning_operation_id', 'compaction')}
            ON CONFLICT(provisioning_operation_id) DO NOTHING`)
            .bind(requestDigest, resultDigest, tombstoneKeyring.active_key_id, operation.provisioning_operation_id),
          db.prepare(`DELETE FROM protected_minor_provisioning_operations
            WHERE provisioning_operation_id = ?
              AND EXISTS (SELECT 1 FROM protected_minor_provisioning_tombstones
                WHERE provisioning_operation_id = ?)
              AND ${noHold('provisioning_operation', 'provisioning_operation_id', 'compaction')}`)
            .bind(operation.provisioning_operation_id, operation.provisioning_operation_id),
        ]);
        result.operationsCompacted += batch[1].meta.changes;
      }
    } else {
      const eligible = await db.prepare(`SELECT COUNT(*) AS count FROM protected_minor_provisioning_operations
        WHERE state IN ('complete', 'failed')
          AND datetime(updated_at) <= datetime('now', '-${RETENTION_DAYS.provisioningDetail} days')`).first<{ count: number }>();
      if (Number(eligible?.count ?? 0) > 0) {
        await notifyIfDue(env, 'missing_tombstone_key', '[retention] provisioning compaction paused: tombstone key unavailable');
      }
    }
  });

  await runStage('binding-delete', async () => {
    const bindings = await db.prepare(`DELETE FROM protected_minor_account_bindings
      WHERE id IN (SELECT b.id FROM protected_minor_account_bindings b
        JOIN protected_minor_subjects s ON s.subject_id = b.subject_id
        WHERE b.unbound_at IS NOT NULL AND s.classification_state = 'cleared'
          AND ((s.clear_reason_class = 'false_positive'
            AND datetime(b.unbound_at) <= datetime('now', '-${RETENTION_DAYS.falsePositive} days')
            AND datetime(s.cleared_at) <= datetime('now', '-${RETENTION_DAYS.falsePositive} days'))
          OR (s.clear_reason_class != 'false_positive'
            AND datetime(b.unbound_at) <= datetime('now', '-${RETENTION_DAYS.validPriorClassification} days')
            AND datetime(s.cleared_at) <= datetime('now', '-${RETENTION_DAYS.validPriorClassification} days')))
          AND ${noHold('account_binding', 'b.id', 'deletion')}
        LIMIT ${BATCH_LIMIT})`).run();
    result.bindingsDeleted = bindings.meta.changes;
  });

  await runStage('subject-delete', async () => {
    const subjects = await db.prepare(`DELETE FROM protected_minor_subjects
      WHERE subject_id IN (SELECT s.subject_id FROM protected_minor_subjects s
        WHERE s.classification_state = 'cleared'
          AND ((s.clear_reason_class = 'false_positive' AND datetime(s.cleared_at) <= datetime('now', '-${RETENTION_DAYS.falsePositive} days'))
            OR (s.clear_reason_class != 'false_positive' AND datetime(s.cleared_at) <= datetime('now', '-${RETENTION_DAYS.validPriorClassification} days')))
          AND NOT EXISTS (SELECT 1 FROM protected_minor_account_bindings b WHERE b.subject_id = s.subject_id)
          AND NOT EXISTS (SELECT 1 FROM protected_minor_projection_jobs p WHERE p.subject_id = s.subject_id)
          AND NOT EXISTS (SELECT 1 FROM protected_minor_provisioning_operations o WHERE o.subject_id = s.subject_id)
          AND ${noHold('protected_subject', 's.subject_id', 'deletion')}
        LIMIT ${BATCH_LIMIT})`).run();
    result.subjectsDeleted = subjects.meta.changes;
  });

  await runStage('case-delete', async () => {
    const cases = await db.prepare(`DELETE FROM age_review_cases
      WHERE id IN (SELECT c.id FROM age_review_cases c
        WHERE c.closed_at IS NOT NULL
          AND datetime(c.closed_at) <= datetime('now', '-${RETENTION_DAYS.ageReviewDecision} days')
          AND NOT EXISTS (SELECT 1 FROM protected_minor_subjects s
            WHERE s.source_case_id = c.id AND s.classification_state = 'active')
          AND ${noHold('age_review_case', 'c.id', 'deletion')}
        LIMIT ${BATCH_LIMIT})`).run();
    result.casesDeleted = cases.meta.changes;
  });

  return result;
}
