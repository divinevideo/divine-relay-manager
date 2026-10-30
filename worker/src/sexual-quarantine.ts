import { isLowerHex64 } from './hex';

const PREFIX = 'sexual-case:';
const JOB = 'sexual-job:';
const QUEUE = 'sexual-review-v3:';
const DUE = 'sexual-due-v3:';
const DELIVERY = 'sexual-delivery-v3:';
const DEADLINE = 'sexual-deadline-v3:';
const RECONCILE = 'sexual-reconcile-v3:';
class Superseded extends Error {}
export class OutsideVideoScope extends Error {}
export class ConfirmedAbsentTarget extends Error {}
export class TargetEvidenceLimit extends Error {}
export class QuarantineConflict extends Error {}
const REVIEW_MS = 15 * 60_000;
const ADULT_ALIASES = new Set([
  'ns-sexualcontent', 'ns-sexual-content', 'sexualcontent', 'sexual-content',
  'sexual_content', 'sexual', 'explicit', 'porn', 'pornography', 'nudity', 'ns-nudity',
]);

export function adultSexualCategory(reason: string): 'sexual-content' | null {
  return ADULT_ALIASES.has(reason.trim().toLowerCase()) ? 'sexual-content' : null;
}

export type { QuarantineReport, QuarantineSnapshot, QuarantineGoal, SexualCase } from '../../shared/sexual-quarantine';
import type { QuarantineReport, QuarantineSnapshot, SexualCase } from '../../shared/sexual-quarantine';

// All effects must be idempotent named holds. Never implement eventHold(false)
// with allowevent: that RPC clears unrelated bans too.
export interface QuarantineIO {
  snapshot(eventId: string): Promise<QuarantineSnapshot>;
  eventHold(eventId: string, held: boolean, version: number): Promise<void>;
  resolveAssets?(snapshot: QuarantineSnapshot): Promise<{ assets: string[]; incomplete: boolean }>;
  mediaHold(sha256: string, holdId: string, held: boolean, version: number): Promise<void>;
  verify(snapshot: QuarantineSnapshot, holdId: string, held: boolean): Promise<boolean>;
  restorationStatus(snapshot: QuarantineSnapshot): Promise<'visible' | 'restricted' | 'pending'>;
  review(item: SexualCase): Promise<void>;
  recordDecision?(item: SexualCase): Promise<void>;
}

export class SexualQuarantine {
  private running = new Map<string, Promise<void>>();
  private delivering = new Map<string, Promise<void>>();

  constructor(private storage: DurableObjectStorage, private io: QuarantineIO, private now = Date.now) {}

  async get(eventId: string): Promise<SexualCase | undefined> {
    const c = await this.storage.get<SexualCase>(PREFIX + eventId);
    return c ? this.hydrate(c) : undefined;
  }

  private async archive(store: DurableObjectStorage | DurableObjectTransaction, ref: string, value: object): Promise<string> {
    if (await store.get(`${ref}:manifest`)) return ref;
    const json = JSON.stringify(value);
    const encoder = new TextEncoder();
    let parts = 0;
    for (let start = 0; start < json.length;) {
      let end = Math.min(start + 16000, json.length);
      // Escaped controls and split surrogate pairs can cost more than UTF-8
      // source text. Bound the serialized part as well as its code-unit count.
      while (encoder.encode(JSON.stringify(json.slice(start, end))).byteLength > 64 * 1024) {
        end = start + Math.ceil((end - start) / 2);
      }
      await store.put(`${ref}:part:${parts++}`, json.slice(start, end));
      start = end;
    }
    await store.put(`${ref}:manifest`, { parts });
    return ref;
  }

  private async evidence<T>(ref: string): Promise<T> {
    const manifest = await this.storage.get<{ parts: number }>(`${ref}:manifest`);
    if (!manifest || !Number.isSafeInteger(manifest.parts) || manifest.parts < 1) throw new Error('Evidence manifest unavailable');
    const parts = await Promise.all(Array.from({ length: manifest.parts }, (_, part) => this.storage.get<string>(`${ref}:part:${part}`)));
    if (parts.some(part => typeof part !== 'string')) throw new Error('Evidence part unavailable');
    return JSON.parse(parts.join('')) as T;
  }

  private async hydrate(c: SexualCase): Promise<SexualCase> {
    if (c.firstReport.sourceRef && !c.firstReport.source) c.firstReport.source = await this.evidence<object>(c.firstReport.sourceRef);
    if (c.snapshotRef && !c.snapshot) c.snapshot = await this.evidence<QuarantineSnapshot>(c.snapshotRef);
    return c;
  }

  async list(): Promise<SexualCase[]> {
    return (await this.listPage()).cases;
  }

  async listPage(cursor?: string): Promise<{ cases: SexualCase[]; nextCursor?: string }> {
    if (cursor !== undefined && !new RegExp(`^${QUEUE}[01]:[0-9]{16}:[0-9a-f]{64}$`).test(cursor)) {
      throw new Error('Invalid review queue cursor');
    }
    // Finish the one-time index upgrade before issuing a cursor. Otherwise a
    // later batch can insert an old case before an already-issued page boundary.
    while (!await this.storage.get('sexual-scheduler-v3-ready')) await this.bootstrap();
    const entries = [...(await this.storage.list<string>({ prefix: QUEUE, startAfter: cursor, limit: 101 })).entries()];
    const page = entries.slice(0, 100);
    const cases = await Promise.all(page.map(([, id]) => this.storage.get<SexualCase>(PREFIX + id)));
    return {
      cases: cases.filter((c): c is SexualCase => !!c).map(c => {
        const summary = { ...c, firstReport: { ...c.firstReport } };
        delete summary.firstReport.source;
        delete summary.snapshot;
        return summary;
      }),
      ...(entries.length > 100 ? { nextCursor: page[page.length - 1][0] } : {}),
    };
  }

  async history(eventId: string): Promise<unknown[]> {
    const entries = [...(await this.storage.list<Record<string, unknown>>({ prefix: `sexual-audit:${eventId}:`, reverse: true, limit: 100 })).values()];
    return Promise.all(entries.map(async entry => {
      if (typeof entry.sourceRef === 'string') entry.source = await this.evidence<object>(entry.sourceRef);
      if (typeof entry.failureRef === 'string') {
        const summary = await this.storage.get<Record<string, unknown>>(entry.failureRef);
        if (summary) Object.assign(entry, summary);
      }
      return entry;
    }));
  }

  private async audit(store: DurableObjectStorage | DurableObjectTransaction, eventId: string, action: string, detail: object = {}): Promise<void> {
    const at = this.now();
    const sequenceKey = `sexual-audit-sequence:${eventId}`;
    const sequence = (await store.get<number>(sequenceKey) || 0) + 1;
    await store.put(sequenceKey, sequence);
    const entry: Record<string, unknown> = { at, action, ...detail };
    if (action === 'report' && entry.source) {
      entry.sourceRef = await this.archive(store, `sexual-evidence:report:${String(entry.id)}`, entry.source as object);
      delete entry.source;
    }
    await store.put(`sexual-audit:${eventId}:${String(sequence).padStart(16, '0')}`, entry);
  }

  private queueKey(c: SexualCase): string {
    const priority = c.state === 'review' ? 1 : 0;
    return `${QUEUE}${priority}:${String(c.deadlineAt).padStart(16, '0')}:${c.eventId}`;
  }

  private timedKey(prefix: string, time: number, eventId = ''): string {
    return `${prefix}${String(time).padStart(16, '0')}:${eventId}`;
  }

  private open(c: SexualCase): boolean {
    return c.state !== 'out_of_scope' && (!c.actor || c.state === 'pending'
      || (!!this.io.recordDecision && !c.decisionRecordedAt));
  }

  private needsWork(c: SexualCase): boolean {
    return c.state !== 'out_of_scope' && ((!c.snapshot && !c.snapshotRef) || c.state === 'pending');
  }

  private needsDelivery(c: SexualCase): boolean {
    return c.state !== 'out_of_scope' && !!(c.snapshot || c.snapshotRef) && (!c.reviewAcceptedAt
      || (!!c.actor && !!c.holdsAppliedAt && !c.decisionRecordedAt && !!this.io.recordDecision));
  }

  private async index(store: DurableObjectStorage | DurableObjectTransaction, c: SexualCase, previous = c): Promise<void> {
    await store.delete(this.queueKey(previous));
    await store.delete(this.timedKey(DUE, previous.retryAt, c.eventId));
    await store.delete(this.timedKey(DELIVERY, previous.deliveryRetryAt || 0, c.eventId));
    await store.delete(this.timedKey(DEADLINE, previous.deadlineAt, c.eventId));
    await store.delete(RECONCILE + c.eventId);
    if (this.open(c)) {
      await store.put(this.queueKey(c), c.eventId);
      if (!c.escalatedAt) await store.put(this.timedKey(DEADLINE, c.deadlineAt, c.eventId), c.eventId);
    }
    if (this.needsDelivery(c)) await store.put(this.timedKey(DELIVERY, c.deliveryRetryAt || 0, c.eventId), c.eventId);
    if (this.needsWork(c)) await store.put(this.timedKey(DUE, c.retryAt, c.eventId), c.eventId);
    else if (c.state === 'hidden' || c.state === 'removed') await store.put(RECONCILE + c.eventId, c.eventId);
    if (c.state === 'out_of_scope' || (c.actor && ['restored', 'restored_restricted'].includes(c.state)
      && c.reviewAcceptedAt && (c.decisionRecordedAt || !this.io.recordDecision))) {
      await store.delete(JOB + c.eventId);
    } else await store.put(JOB + c.eventId, true);
  }

  private async save(store: DurableObjectStorage | DurableObjectTransaction, c: SexualCase): Promise<void> {
    const previous = await store.get<SexualCase>(PREFIX + c.eventId);
    c.updatedAt = this.now();
    const stored = { ...c, firstReport: { ...c.firstReport } };
    if (stored.firstReport.source) {
      stored.firstReport.sourceRef = await this.archive(store, `sexual-evidence:report:${stored.firstReport.id}`, stored.firstReport.source);
      delete stored.firstReport.source;
    }
    if (stored.snapshot) {
      stored.snapshotRef = await this.archive(store, `sexual-evidence:snapshot:${c.eventId}`, stored.snapshot);
      delete stored.snapshot;
    }
    await store.put(PREFIX + c.eventId, stored);
    await this.index(store, stored, previous);
  }

  // IO runs outside DO concurrency gates. Every persisted worker result compares
  // the operation revision; service-side versions fence late network requests.
  private async current(c: SexualCase): Promise<void> {
    const latest = await this.storage.get<SexualCase>(PREFIX + c.eventId);
    if (!latest || latest.revision !== c.revision) throw new Superseded();
  }

  private async commit(c: SexualCase, action?: string, detail: object = {}): Promise<void> {
    await this.storage.transaction(async tx => {
      const latest = await tx.get<SexualCase>(PREFIX + c.eventId);
      if (!latest || latest.revision !== c.revision) throw new Superseded();
      // Reports may arrive without changing the operation revision.
      c.reporters = latest.reporters;
      c.mediaHoldAssets = latest.mediaHoldAssets;
      // Delivery is a separate worker. Its current-revision acknowledgments and
      // backoff must survive an enforcement result that began before them.
      c.reviewAcceptedAt = latest.reviewAcceptedAt;
      c.decisionRecordedAt = latest.decisionRecordedAt;
      c.deliveryAttempts = latest.deliveryAttempts;
      c.deliveryRetryAt = latest.deliveryRetryAt;
      if (['review_delivery', 'decision_record'].includes(latest.lastFailureStage || '')
        && (!c.lastFailureStage || ['review_delivery', 'decision_record'].includes(c.lastFailureStage))) {
        c.lastError = latest.lastError;
        c.lastFailureStage = latest.lastFailureStage;
      } else if (['review_delivery', 'decision_record'].includes(c.lastFailureStage || '') && !latest.lastFailureStage) {
        delete c.lastError; delete c.lastFailureStage;
      }
      // The alarm's deadline phase can escalate while this worker awaits IO.
      // Its newer metadata belongs to this revision and must survive the result.
      if (latest.escalatedAt) c.escalatedAt = latest.escalatedAt;
      await this.save(tx, c);
      if (action === 'retry') await this.failureAudit(tx, c, String((detail as { stage?: string }).stage), detail);
      else if (action) await this.audit(tx, c.eventId, action, { revision: c.revision, ...detail });
    });
  }

  private async mediaIntent(c: SexualCase, sha256: string): Promise<void> {
    await this.storage.transaction(async tx => {
      const latest = await tx.get<SexualCase>(PREFIX + c.eventId);
      if (!latest || latest.revision !== c.revision) throw new Superseded();
      // An absent journal predates this fence. Conservatively retain every signed
      // candidate that an older worker might already have attempted.
      latest.mediaHoldAssets = [...new Set([...(latest.mediaHoldAssets ?? c.snapshot!.assets), sha256])];
      const intentKey = `sexual-media-intent:${c.eventId}:${sha256}`;
      if (!await tx.get(intentKey)) {
        await this.audit(tx, c.eventId, 'media_hold_intent', { revision: c.revision, sha256 });
        await tx.put(intentKey, true);
      }
      await this.save(tx, latest);
      c.mediaHoldAssets = latest.mediaHoldAssets;
    });
  }

  async admit(eventId: string, report: QuarantineReport, threshold: number, verifiedSnapshot?: QuarantineSnapshot): Promise<SexualCase> {
    if (!isLowerHex64(eventId) || !isLowerHex64(report.id) || !isLowerHex64(report.pubkey)
      || !adultSexualCategory(report.reason) || !Number.isInteger(threshold) || threshold < 2) {
      throw new Error('Invalid adult sexual report');
    }
    const result = await this.storage.transaction(async tx => {
      let c = await tx.get<SexualCase>(PREFIX + eventId);
      const reportKey = `sexual-report:${eventId}:${report.id}`;
      if (c?.state === 'out_of_scope' || (c && await tx.get(reportKey))) return c;
      if (!c) c = {
        eventId, revision: 1, goal: 'review', state: 'review', reporters: 0, threshold,
        firstReport: report, createdAt: this.now(), updatedAt: this.now(),
        deadlineAt: this.now() + REVIEW_MS, attempts: 0, retryAt: 0, mediaHoldAssets: [],
        ...(verifiedSnapshot ? { snapshot: verifiedSnapshot } : {}),
      };
      const reporterKey = `sexual-reporter:${eventId}:${report.pubkey}`;
      if (!await tx.get(reporterKey)) {
        c.reporters++;
        await tx.put(reporterKey, true);
      }
      // Human decisions are terminal for the unchanged event; another report does
      // not undo an accepted restore. New child-safety allegations use their owner.
      if (!c.actor && c.reporters >= c.threshold) {
        if (c.goal !== 'hide') {
          c.hideTriggeredAt = this.now(); c.deadlineAt = this.now() + REVIEW_MS;
          c.revision++; c.retryAt = 0; c.deliveryRetryAt = 0; c.deliveryAttempts = 0;
          delete c.escalatedAt; delete c.holdsAppliedAt; delete c.reviewAcceptedAt;
        }
        c.goal = 'hide';
        if (c.state !== 'hidden') c.state = 'pending';
      }
      await this.audit(tx, eventId, 'report', { ...report, receivedAt: this.now(), category: 'sexual-content' });
      await tx.put(reportKey, true);
      await this.save(tx, c);
      await tx.put('sexual-jobs-exist', true);
      return c;
    });
    return this.hydrate(result);
  }

  async decide(eventId: string, revision: number, decision: 'restore' | 'remove', actor: string, reason: string): Promise<SexualCase> {
    const result = await this.storage.transaction(async tx => {
      const c = await tx.get<SexualCase>(PREFIX + eventId);
      if (!c || c.revision !== revision) throw new QuarantineConflict('Case revision conflict');
      if (c.state === 'out_of_scope') throw new Error('Target outside video scope');
      const reviewer = actor.trim();
      if (!reviewer || reviewer === 'auto' || !reason.trim() || reason.length > 2000) throw new Error('Reviewer and reason are required');
      c.revision++;
      c.deadlineAt = this.now() + REVIEW_MS;
      delete c.escalatedAt;
      c.decisionAt = this.now();
      c.goal = decision;
      c.actor = reviewer;
      c.reason = reason;
      c.state = 'pending';
      c.attempts = 0;
      c.retryAt = 0;
      delete c.verifiedAt;
      delete c.decisionRecordedAt;
      delete c.holdsAppliedAt;
      c.deliveryRetryAt = 0; c.deliveryAttempts = 0;
      await this.audit(tx, eventId, decision, { actor: reviewer, reason, revision: c.revision });
      await this.save(tx, c);
      return c;
    });
    return this.hydrate(result);
  }

  async advance(eventId: string, deliver = true): Promise<void> {
    let work = this.running.get(eventId);
    if (!work) {
      work = (async () => {
        // Network results from a superseded operation immediately pick up the
        // new revision. Neither enforcement nor delivery runs under a DO gate.
        for (let pass = 0; pass < 3; pass++) {
          try { await this.run(eventId); return; }
          catch (error) { if (!(error instanceof Superseded)) throw error; }
        }
      })();
      this.running.set(eventId, work);
    }
    try { await work; } finally { if (this.running.get(eventId) === work) this.running.delete(eventId); }
    if (deliver) await this.deliver(eventId);
  }

  private async run(eventId: string): Promise<void> {
    await this.escalate([eventId]);
    const c = await this.get(eventId);
    if (!c || c.state === 'out_of_scope') return;
    if (c.retryAt > this.now()) return;
    c.attempts++;
    await this.commit(c);
    let stage = 'snapshot';
    try {
      if (!c.snapshot) {
        c.snapshot = await this.io.snapshot(eventId);
        await this.commit(c);
      }
      const hold = `sexual:${eventId}`;
      if (c.state === 'hidden' || c.state === 'removed') {
        stage = 'public_verification';
        if (!await this.io.verify(c.snapshot, hold, true)) {
          c.state = 'pending';
          delete c.verifiedAt;
          await this.commit(c, 'enforcement_drift');
        }
        c.lastCheckedAt = this.now();
      }
      if (c.state === 'pending') {
        const held = c.goal !== 'restore';
        await this.current(c);
        stage = 'event_hold';
        await this.io.eventHold(eventId, held, c.revision);
        let verificationSnapshot = held ? c.snapshot
          : { ...c.snapshot, assets: c.mediaHoldAssets ?? c.snapshot.assets };
        if (held && this.io.resolveAssets) {
          await this.current(c);
          stage = 'media_resolution';
          const resolved = await this.io.resolveAssets(c.snapshot);
          // Signed candidates remain immutable evidence. Retry eligibility reads
          // independently, and require complete coverage before claiming hidden.
          verificationSnapshot = { ...c.snapshot, assets: resolved.assets,
            mappingIncomplete: !!c.snapshot.mappingIncomplete || resolved.incomplete };
        }
        for (const sha of verificationSnapshot.assets) {
          await this.current(c);
          stage = 'media_hold';
          if (held) { await this.mediaIntent(c, sha); await this.current(c); }
          await this.io.mediaHold(sha, hold, held, c.revision);
        }
        await this.current(c);
        c.holdsAppliedAt = this.now();
        await this.commit(c);
        // A human decision becomes durable once every own-hold RPC accepted it.
        // Public mapping and visibility checks remain an independent requirement.
        await this.recordDecision(c);
        stage = 'public_verification';
        if (!await this.io.verify(verificationSnapshot, hold, held)) throw new Error('Enforcement verification incomplete');
        if (held) c.state = c.goal === 'remove' ? 'removed' : 'hidden';
        else {
          stage = 'restore_visibility';
          const status = await this.io.restorationStatus(c.snapshot);
          if (status === 'pending') throw new Error('Restoration visibility has not converged');
          c.state = status === 'visible' ? 'restored' : 'restored_restricted';
        }
        if (held && !c.firstHiddenAt) c.firstHiddenAt = this.now();
        c.verifiedAt = this.now();
        c.lastCheckedAt = this.now();
        await this.commit(c, c.state);
        console.log('[sexual-quarantine-metric]', JSON.stringify({ outcome: c.state,
          elapsedMs: this.now() - (c.decisionAt ?? c.hideTriggeredAt ?? c.createdAt),
          sinceFirstReportMs: this.now() - c.createdAt, attempts: c.attempts }));
      }
      if (!c.lastFailureStage || !['review_delivery', 'decision_record'].includes(c.lastFailureStage)) {
        delete c.lastError;
        delete c.lastFailureStage;
      }
      c.retryAt = this.now() + 60_000;
    } catch (error) {
      if (error instanceof Superseded) throw error;
      if (stage === 'snapshot' && !c.snapshot && error instanceof OutsideVideoScope) {
        c.goal = 'review';
        c.state = 'out_of_scope';
        c.lastError = 'Target is outside the video quarantine scope';
        await this.commit(c, 'out_of_scope');
        return;
      }
      // Do not retain service errors: they may contain credentials/private URLs.
      if (stage === 'public_verification' && ['hidden', 'removed'].includes(c.state)) {
        c.state = 'pending';
        delete c.verifiedAt;
      }
      c.lastError = 'Quarantine processing incomplete; retry scheduled';
      c.lastFailureStage = stage;
      c.retryAt = this.now() + Math.min(60_000, 1000 * 2 ** Math.min(c.attempts, 6));
      await this.commit(c, 'retry', { attempt: c.attempts, stage });
    }
    await this.commit(c);
  }

  private async failureAudit(store: DurableObjectStorage | DurableObjectTransaction, c: SexualCase, stage: string, detail: object = {}): Promise<void> {
    const marker = `sexual-failure:${c.eventId}:${c.revision}:${stage}`;
    const existing = await store.get<{ occurrences: number }>(marker);
    const summary = { ...detail, lastAt: this.now(), occurrences: (existing?.occurrences || 0) + 1 };
    // The first failure is an append-only audit event. Repeated attempts update
    // a separate summary, so an outage cannot evict the original report history.
    if (!existing) await this.audit(store, c.eventId, 'retry', { revision: c.revision, stage, failureRef: marker, ...summary });
    await store.put(marker, summary);
  }

  private async deliveryResult(c: SexualCase, stage: 'review_delivery' | 'decision_record', success: boolean): Promise<void> {
    await this.storage.transaction(async tx => {
      const latest = await tx.get<SexualCase>(PREFIX + c.eventId);
      if (!latest || latest.revision !== c.revision) throw new Superseded();
      if (success) {
        if (stage === 'review_delivery') latest.reviewAcceptedAt = this.now();
        else latest.decisionRecordedAt = this.now();
        if (latest.lastFailureStage === stage) {
          delete latest.lastError; delete latest.lastFailureStage;
        }
        if (!this.needsDelivery(latest)) { latest.deliveryAttempts = 0; latest.deliveryRetryAt = 0; }
      } else {
        latest.deliveryAttempts = (latest.deliveryAttempts || 0) + 1;
        latest.deliveryRetryAt = this.now() + Math.min(5 * 60_000, 30_000 * 2 ** Math.min(latest.deliveryAttempts - 1, 4));
        latest.lastError = 'Quarantine delivery incomplete; retry scheduled';
        latest.lastFailureStage = stage;
        await this.failureAudit(tx, latest, stage, { attempt: latest.deliveryAttempts });
      }
      await this.save(tx, latest);
      c.reviewAcceptedAt = latest.reviewAcceptedAt;
      c.decisionRecordedAt = latest.decisionRecordedAt;
      c.deliveryAttempts = latest.deliveryAttempts;
      c.deliveryRetryAt = latest.deliveryRetryAt;
      if (!c.lastFailureStage || ['review_delivery', 'decision_record'].includes(c.lastFailureStage)) {
        c.lastError = latest.lastError; c.lastFailureStage = latest.lastFailureStage;
      }
    });
  }

  private async recordDecision(c: SexualCase): Promise<void> {
    if (!c.actor || !c.holdsAppliedAt || c.decisionRecordedAt || !this.io.recordDecision
      || (c.deliveryRetryAt || 0) > this.now()) return;
    await this.current(c);
    try {
      await this.io.recordDecision(c);
      await this.deliveryResult(c, 'decision_record', true);
    } catch (error) {
      if (error instanceof Superseded) throw error;
      await this.deliveryResult(c, 'decision_record', false);
    }
  }

  private async deliver(eventId: string): Promise<void> {
    const existing = this.delivering.get(eventId);
    if (existing) return existing;
    const work = (async () => {
      for (let pass = 0; pass < 3; pass++) {
        try {
          const c = await this.get(eventId);
          if (!c || c.state === 'out_of_scope' || !c.snapshot || (c.deliveryRetryAt || 0) > this.now()) return;
          await this.recordDecision(c);
          if (!c.reviewAcceptedAt) {
            await this.current(c);
            try {
              await this.io.review(c);
              await this.deliveryResult(c, 'review_delivery', true);
            } catch (error) {
              if (error instanceof Superseded) throw error;
              await this.deliveryResult(c, 'review_delivery', false);
            }
          }
          return;
        } catch (error) { if (!(error instanceof Superseded)) throw error; }
      }
    })();
    this.delivering.set(eventId, work);
    try { await work; } finally { this.delivering.delete(eventId); }
  }

  private async escalate(eventIds: string[]): Promise<void> {
    const overdue = await this.storage.transaction(async tx => {
      const ids: string[] = [];
      for (const eventId of eventIds) {
        const c = await tx.get<SexualCase>(PREFIX + eventId);
        if (!c || !this.open(c) || c.escalatedAt || c.deadlineAt > this.now()) continue;
        c.escalatedAt = this.now();
        await this.save(tx, c);
        await this.audit(tx, eventId, 'overdue', { revision: c.revision });
        ids.push(eventId);
      }
      return ids;
    });
    for (const eventId of overdue) console.error(`[ALERT] Sexual quarantine review overdue: ${eventId}`);
  }

  // Upgrade older persisted cases incrementally without making the first alarm
  // scan the entire case history. New writes already maintain the current indices.
  // TODO(#350): remove the compatibility reindex only after every environment's
  // stored-case inventory proves the older index generations are retired.
  private async bootstrap(): Promise<void> {
    if (await this.storage.get('sexual-scheduler-v3-ready')) return;
    await this.storage.transaction(async tx => {
      if (await tx.get('sexual-scheduler-v3-ready')) return;
      const after = await tx.get<string>('sexual-scheduler-v3-cursor') || '';
      const cases = await tx.list<SexualCase>({ prefix: PREFIX, startAfter: after, limit: 100 });
      for (const [key, c] of cases) {
        // Previous verified terminal states already required every hold ACK.
        if (c.actor && c.verifiedAt && ['removed', 'restored', 'restored_restricted'].includes(c.state) && !c.holdsAppliedAt) {
          c.holdsAppliedAt = c.verifiedAt;
          await tx.put(key, c);
        }
        await this.index(tx, c);
        await tx.put('sexual-scheduler-v3-cursor', key);
      }
      if (cases.size < 100) await tx.put('sexual-scheduler-v3-ready', true);
    });
  }

  // Urgent retries and deadlines have independent ordered indices. Stable holds
  // use a separate slow rotation, so a large retained history cannot delay them.
  async tick(): Promise<void> {
    await this.bootstrap();
    const deadlines = await this.storage.list<string>({
      prefix: DEADLINE, end: this.timedKey(DEADLINE, this.now() + 1), limit: 100,
    });
    await this.escalate([...deadlines.values()]);
    const due = await this.storage.list<string>({
      prefix: DUE, end: this.timedKey(DUE, this.now() + 1), limit: 3,
    });
    const after = await this.storage.get<string>('sexual-reconcile-v3-scan') || '';
    let slow = await this.storage.list<string>({ prefix: RECONCILE, startAfter: after, limit: 1 });
    if (slow.size === 0) slow = await this.storage.list<string>({ prefix: RECONCILE, limit: 1 });
    for (const key of slow.keys()) await this.storage.put('sexual-reconcile-v3-scan', key);
    // One failing case must not leave the others running unawaited.
    const results = await Promise.allSettled([...new Set([...due.values(), ...slow.values()])].map(eventId => this.advance(eventId, false)));
    // Select after enforcement, so a newly archived snapshot can be handed off
    // immediately. Unavailable snapshots never occupy the delivery lane.
    const delivery = await this.storage.list<string>({
      prefix: DELIVERY, end: this.timedKey(DELIVERY, this.now() + 1), limit: 1,
    });
    // COOP and decision-log retries have their own single slow lane. They never
    // consume one of the three enforcement slots, including after an outage.
    const deliveryResults = await Promise.allSettled([...delivery.values()].map(eventId => this.deliver(eventId)));
    const failed = [...results, ...deliveryResults].find((r): r is PromiseRejectedResult => r.status === 'rejected');
    if (failed) throw failed.reason;
  }
}
