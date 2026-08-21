// ABOUTME: Durable protected-minor subject registry and service-only lifecycle operations.
// ABOUTME: Keeps classification independent from replaceable Keycast account rows.

import { createMinorAccount, type KeycastEnv } from './keycast-client';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const PUBKEY_RE = /^[0-9a-f]{64}$/;

export interface ProtectedMinorEnv extends KeycastEnv {
  DB?: D1Database;
  PROTECTED_MINOR_SERVICE_TOKEN?: string | SecretStoreSecret;
  PROTECTED_MINOR_REPLACEMENT_ENABLED?: string;
}

type SecretStoreSecret = { get(): Promise<string> };

function json(body: unknown, status: number, corsHeaders: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...corsHeaders },
  });
}

async function resolveSecret(secret: string | SecretStoreSecret | undefined): Promise<string | undefined> {
  if (typeof secret === 'string') return secret;
  return secret?.get();
}

function constantTimeEqual(left: string, right: string): boolean {
  const encoder = new TextEncoder();
  const a = encoder.encode(left);
  const b = encoder.encode(right);
  let difference = a.length ^ b.length;
  const length = Math.max(a.length, b.length);
  for (let i = 0; i < length; i += 1) difference |= (a[i % Math.max(a.length, 1)] ?? 0) ^ (b[i % Math.max(b.length, 1)] ?? 0);
  return difference === 0;
}

export async function verifyProtectedMinorService(request: Request, env: ProtectedMinorEnv): Promise<boolean> {
  const authorization = request.headers.get('Authorization');
  if (!authorization?.startsWith('Bearer ')) return false;
  const supplied = authorization.slice('Bearer '.length);
  const expected = await resolveSecret(env.PROTECTED_MINOR_SERVICE_TOKEN);
  return Boolean(expected && supplied && constantTimeEqual(supplied, expected));
}

export async function createSubjectWithBinding(
  db: D1Database,
  sourceCaseId: string,
  pubkey: string,
  classifiedAt = new Date().toISOString(),
): Promise<{ subjectId: string }> {
  const subjectId = crypto.randomUUID();
  await db.batch([
    db.prepare(`INSERT INTO protected_minor_subjects
      (subject_id, source_case_id, classification_state, classified_at)
      VALUES (?, ?, 'active', ?)`)
      .bind(subjectId, sourceCaseId, classifiedAt),
    db.prepare(`INSERT INTO protected_minor_account_bindings
      (id, subject_id, pubkey, bound_at) VALUES (?, ?, ?, ?)`)
      .bind(crypto.randomUUID(), subjectId, pubkey, classifiedAt),
  ]);
  return { subjectId };
}

export async function clearSubject(
  db: D1Database,
  pubkey: string,
  clearedBy: string | undefined,
  reason: string,
): Promise<{ success: boolean; error?: string }> {
  try {
    const now = new Date().toISOString();
    const subject = await db.prepare(`SELECT s.subject_id, s.classification_state
      FROM protected_minor_subjects s JOIN protected_minor_account_bindings b ON b.subject_id = s.subject_id
      WHERE b.pubkey = ? AND b.unbound_at IS NULL LIMIT 1`).bind(pubkey)
      .first<{ subject_id: string; classification_state: string }>();
    if (!subject || subject.classification_state === 'cleared') return { success: true };
    await db.batch([
      db.prepare(`UPDATE protected_minor_subjects
        SET classification_state = 'cleared', cleared_at = ?, cleared_by = ?, clear_reason = ?
        WHERE subject_id = ? AND classification_state = 'active'`)
        .bind(now, clearedBy ?? null, reason, subject.subject_id),
      db.prepare(`INSERT INTO protected_minor_projection_jobs
        (subject_id, pubkey, reason, state, created_at, updated_at)
        VALUES (?, ?, ?, 'pending', ?, ?)
        ON CONFLICT(subject_id) DO NOTHING`)
        .bind(subject.subject_id, pubkey, reason, now, now),
    ]);
    return { success: true };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export async function markProjectionComplete(db: D1Database, pubkey: string): Promise<void> {
  await db.prepare(`UPDATE protected_minor_projection_jobs SET state = 'complete', updated_at = ?
    WHERE pubkey = ? AND state = 'pending'`).bind(new Date().toISOString(), pubkey).run();
}

export async function pendingProjectionJobs(db: D1Database): Promise<Array<{ pubkey: string; reason: string }>> {
  const rows = await db.prepare(`SELECT pubkey, reason FROM protected_minor_projection_jobs
    WHERE state = 'pending' ORDER BY created_at LIMIT 100`).all<{ pubkey: string; reason: string }>();
  return rows.results.filter((row) => typeof row.pubkey === 'string' && typeof row.reason === 'string');
}

export async function resolveByPubkey(db: D1Database, pubkey: string): Promise<{ subjectRef: string } | null> {
  const row = await db.prepare(`SELECT s.subject_id
    FROM protected_minor_subjects s
    JOIN protected_minor_account_bindings b ON b.subject_id = s.subject_id
    WHERE b.pubkey = ? AND b.unbound_at IS NULL AND s.classification_state = 'active'
    LIMIT 1`).bind(pubkey).first<{ subject_id: string }>();
  return row ? { subjectRef: row.subject_id } : null;
}

export async function closeBinding(
  db: D1Database,
  subjectRef: string,
  pubkey: string,
  deletionAttemptId: string,
): Promise<'closed' | 'idempotency_conflict' | 'stale_binding'> {
  const replay = await db.prepare(`SELECT subject_id, pubkey FROM protected_minor_account_bindings
    WHERE deletion_attempt_id = ?`).bind(deletionAttemptId).first<{ subject_id: string; pubkey: string }>();
  if (replay) return replay.subject_id === subjectRef && replay.pubkey === pubkey ? 'closed' : 'idempotency_conflict';

  const current = await db.prepare(`SELECT id FROM protected_minor_account_bindings
    WHERE subject_id = ? AND pubkey = ? AND unbound_at IS NULL`).bind(subjectRef, pubkey).first<{ id: string }>();
  if (!current) return 'stale_binding';

  try {
    const result = await db.prepare(`UPDATE protected_minor_account_bindings
      SET unbound_at = ?, deletion_attempt_id = ?
      WHERE id = ? AND unbound_at IS NULL`).bind(new Date().toISOString(), deletionAttemptId, current.id).run();
    if (result.meta.changes === 1) return 'closed';
    return 'stale_binding';
  } catch {
    const concurrent = await db.prepare(`SELECT subject_id, pubkey FROM protected_minor_account_bindings
      WHERE deletion_attempt_id = ?`).bind(deletionAttemptId).first<{ subject_id: string; pubkey: string }>();
    return concurrent?.subject_id === subjectRef && concurrent.pubkey === pubkey ? 'closed' : 'idempotency_conflict';
  }
}

export async function backfillProtectedMinorSubjects(db: D1Database): Promise<{ created: number; skippedDuplicates: number }> {
  const rows = await db.prepare(`SELECT id, pubkey, created_at FROM age_review_cases
    WHERE created_via = 'minor_onboarding' ORDER BY created_at ASC, id ASC`).all<{
      id: string; pubkey: string; created_at: string;
    }>();
  let created = 0;
  let skippedDuplicates = 0;
  const seenPubkeys = new Set<string>();
  for (const row of rows.results) {
    if (seenPubkeys.has(row.pubkey)) {
      skippedDuplicates += 1;
      continue;
    }
    seenPubkeys.add(row.pubkey);
    const exists = await db.prepare(`SELECT subject_id FROM protected_minor_subjects WHERE source_case_id = ?`)
      .bind(row.id).first();
    if (exists) continue;
    const ending = await db.prepare(`SELECT moderator_pubkey, resolution_note, updated_at
      FROM age_review_cases WHERE pubkey = ? AND state = 'denied_closed'
        AND datetime(updated_at) > datetime(?) ORDER BY datetime(updated_at) DESC, id DESC LIMIT 1`)
      .bind(row.pubkey, row.created_at).first<{ moderator_pubkey: string | null; resolution_note: string | null; updated_at: string }>();
    const subjectId = crypto.randomUUID();
    const bindingId = crypto.randomUUID();
    if (ending) {
      await db.batch([
        db.prepare(`INSERT INTO protected_minor_subjects
          (subject_id, source_case_id, classification_state, classified_at, cleared_at, cleared_by, clear_reason)
          VALUES (?, ?, 'cleared', ?, ?, ?, ?)`)
          .bind(subjectId, row.id, row.created_at, ending.updated_at, ending.moderator_pubkey, ending.resolution_note || 'age_review_denied'),
        db.prepare(`INSERT INTO protected_minor_account_bindings
          (id, subject_id, pubkey, bound_at) VALUES (?, ?, ?, ?)`)
          .bind(bindingId, subjectId, row.pubkey, row.created_at),
      ]);
    } else {
      await db.batch([
        db.prepare(`INSERT INTO protected_minor_subjects
          (subject_id, source_case_id, classification_state, classified_at) VALUES (?, ?, 'active', ?)`)
          .bind(subjectId, row.id, row.created_at),
        db.prepare(`INSERT INTO protected_minor_account_bindings
          (id, subject_id, pubkey, bound_at) VALUES (?, ?, ?, ?)`)
          .bind(bindingId, subjectId, row.pubkey, row.created_at),
      ]);
    }
    created += 1;
  }
  return { created, skippedDuplicates };
}

export async function fingerprintProvisioningRequest(username: string, displayName: string | undefined): Promise<string> {
  const input = JSON.stringify({ username, display_name: displayName ?? null });
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function startOrResumeReplacement(
  env: ProtectedMinorEnv,
  input: { subjectRef: string; provisioningOperationId: string; username: string; displayName?: string },
): Promise<{ outcome: 'complete'; pubkey: string; claimUrl: string | null; expiresAt: string | null; accountState: 'unclaimed' | 'claimed'; replayed: boolean } | { outcome: 'conflict'; code: string } | { outcome: 'failed'; error: string }> {
  if (!env.DB) return { outcome: 'failed', error: 'Database not configured' };
  const fingerprint = await fingerprintProvisioningRequest(input.username, input.displayName);
  const existing = await env.DB.prepare(`SELECT subject_id, request_fingerprint, state, result_pubkey
    FROM protected_minor_provisioning_operations WHERE provisioning_operation_id = ?`)
    .bind(input.provisioningOperationId).first<{ subject_id: string; request_fingerprint: string; state: string; result_pubkey: string | null }>();
  if (existing && (existing.subject_id !== input.subjectRef || existing.request_fingerprint !== fingerprint)) {
    return { outcome: 'conflict', code: 'provisioning_operation_conflict' };
  }
  const subject = await env.DB.prepare(`SELECT classification_state FROM protected_minor_subjects WHERE subject_id = ?`)
    .bind(input.subjectRef).first<{ classification_state: string }>();
  if (!subject || subject.classification_state !== 'active') return { outcome: 'conflict', code: 'classification_cleared' };
  if (!existing) {
    const now = new Date().toISOString();
    await env.DB.prepare(`INSERT INTO protected_minor_provisioning_operations
      (provisioning_operation_id, subject_id, kind, request_fingerprint, state, created_at, updated_at)
      VALUES (?, ?, 'replacement', ?, 'pending', ?, ?)`)
      .bind(input.provisioningOperationId, input.subjectRef, fingerprint, now, now).run();
  }
  const result = await createMinorAccount(input.username, input.displayName, env, input.provisioningOperationId);
  if (!result.success || !result.pubkey || !PUBKEY_RE.test(result.pubkey)) {
    return { outcome: 'failed', error: result.error ?? 'Provisioning failed' };
  }
  if (existing?.result_pubkey && existing.result_pubkey !== result.pubkey) {
    return { outcome: 'conflict', code: 'provisioning_result_conflict' };
  }
  if (existing?.state === 'complete' && existing.result_pubkey === result.pubkey) {
    const binding = await env.DB.prepare(`SELECT id FROM protected_minor_account_bindings
      WHERE subject_id = ? AND pubkey = ? AND unbound_at IS NULL`).bind(input.subjectRef, result.pubkey).first();
    if (!binding) return { outcome: 'failed', error: 'Replacement operation is missing its active binding' };
    return {
      outcome: 'complete', pubkey: result.pubkey, claimUrl: result.claim_url ?? null,
      expiresAt: result.expires_at ?? null, accountState: result.account_state ?? 'unclaimed', replayed: true,
    };
  }
  const now = new Date().toISOString();
  try {
    const batch = await env.DB.batch([
      env.DB.prepare(`INSERT INTO protected_minor_account_bindings (id, subject_id, pubkey, bound_at)
        SELECT ?, subject_id, ?, ? FROM protected_minor_subjects
        WHERE subject_id = ? AND classification_state = 'active'
          AND NOT EXISTS (SELECT 1 FROM protected_minor_account_bindings WHERE subject_id = ? AND unbound_at IS NULL)`)
        .bind(crypto.randomUUID(), result.pubkey, now, input.subjectRef, input.subjectRef),
      env.DB.prepare(`UPDATE protected_minor_provisioning_operations SET state = 'complete', result_pubkey = ?, updated_at = ?
        WHERE provisioning_operation_id = ? AND subject_id IN
          (SELECT subject_id FROM protected_minor_subjects WHERE classification_state = 'active')`)
        .bind(result.pubkey, now, input.provisioningOperationId),
    ]);
    if (batch[1].meta.changes !== 1) return { outcome: 'conflict', code: 'classification_cleared' };
  } catch {
    const current = await env.DB.prepare(`SELECT classification_state FROM protected_minor_subjects WHERE subject_id = ?`)
      .bind(input.subjectRef).first<{ classification_state: string }>();
    if (current?.classification_state !== 'active') return { outcome: 'conflict', code: 'classification_cleared' };
    return { outcome: 'failed', error: 'Replacement persistence failed' };
  }
  return {
    outcome: 'complete', pubkey: result.pubkey, claimUrl: result.claim_url ?? null,
    expiresAt: result.expires_at ?? null, accountState: result.account_state ?? 'unclaimed', replayed: result.replayed === true,
  };
}

export async function handleProtectedMinorServiceRoute(
  request: Request,
  path: string,
  env: ProtectedMinorEnv,
  corsHeaders: Record<string, string>,
): Promise<Response> {
  if (!(await verifyProtectedMinorService(request, env))) return json({ error: 'unauthorized' }, 401, corsHeaders);
  if (!env.DB) return json({ error: 'service_unavailable' }, 503, corsHeaders);
  let body: Record<string, unknown>;
  try { body = await request.json(); } catch { return json({ error: 'invalid_request' }, 400, corsHeaders); }
  try {
    if (path === '/api/internal/protected-minors/resolve' && request.method === 'POST') {
      if (typeof body.pubkey !== 'string' || !PUBKEY_RE.test(body.pubkey)) return json({ error: 'invalid_request' }, 400, corsHeaders);
      const resolved = await resolveByPubkey(env.DB, body.pubkey);
      return resolved
        ? json({ classification: 'active', subject_ref: resolved.subjectRef, binding_state: 'active' }, 200, corsHeaders)
        : json({ classification: 'none' }, 200, corsHeaders);
    }
    if (path === '/api/internal/protected-minors/bindings/close' && request.method === 'POST') {
      if (typeof body.subject_ref !== 'string' || !UUID_RE.test(body.subject_ref)
        || typeof body.pubkey !== 'string' || !PUBKEY_RE.test(body.pubkey)
        || typeof body.deletion_attempt_id !== 'string' || !UUID_RE.test(body.deletion_attempt_id)) {
        return json({ error: 'invalid_request' }, 400, corsHeaders);
      }
      const outcome = await closeBinding(env.DB, body.subject_ref, body.pubkey, body.deletion_attempt_id);
      return outcome === 'closed' ? json({ outcome: 'closed' }, 200, corsHeaders) : json({ code: outcome }, 409, corsHeaders);
    }
    if (path === '/api/internal/protected-minors/replacements' && request.method === 'POST') {
      if (env.PROTECTED_MINOR_REPLACEMENT_ENABLED !== 'true') return json({ error: 'not_enabled' }, 503, corsHeaders);
      if (typeof body.subject_ref !== 'string' || !UUID_RE.test(body.subject_ref)
        || typeof body.provisioning_operation_id !== 'string' || !UUID_RE.test(body.provisioning_operation_id)
        || typeof body.username !== 'string' || !/^[a-z0-9](?:[a-z0-9-]{1,61}[a-z0-9])$/.test(body.username)
        || (body.display_name !== undefined && typeof body.display_name !== 'string')) return json({ error: 'invalid_request' }, 400, corsHeaders);
      const result = await startOrResumeReplacement(env, {
        subjectRef: body.subject_ref, provisioningOperationId: body.provisioning_operation_id,
        username: body.username, displayName: body.display_name as string | undefined,
      });
      if (result.outcome === 'conflict') return json({ code: result.code }, 409, corsHeaders);
      if (result.outcome === 'failed') return json({ error: 'service_unavailable' }, 503, corsHeaders);
      return json({ outcome: 'complete', pubkey: result.pubkey, claim_url: result.claimUrl, expires_at: result.expiresAt, account_state: result.accountState, replayed: result.replayed }, 200, corsHeaders);
    }
    return json({ error: 'not_found' }, 404, corsHeaders);
  } catch {
    return json({ error: 'service_unavailable' }, 503, corsHeaders);
  }
}
