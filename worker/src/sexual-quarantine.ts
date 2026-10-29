import { isLowerHex64 } from './hex';

const PREFIX = 'sexual-case:';
const JOB = 'sexual-job:';
const QUEUE = 'sexual-review:';
class Superseded extends Error {}
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
  mediaHold(sha256: string, holdId: string, held: boolean, version: number): Promise<void>;
  verify(snapshot: QuarantineSnapshot, holdId: string, held: boolean): Promise<boolean>;
  restorationStatus(snapshot: QuarantineSnapshot): Promise<'visible' | 'restricted' | 'pending'>;
  review(item: SexualCase): Promise<void>;
}

export class SexualQuarantine {
  private running = new Map<string, Promise<void>>();

  constructor(private storage: DurableObjectStorage, private io: QuarantineIO, private now = Date.now) {}

  get(eventId: string): Promise<SexualCase | undefined> { return this.storage.get(PREFIX + eventId); }

  async list(): Promise<SexualCase[]> {
    const ids = [...(await this.storage.list<string>({ prefix: QUEUE, limit: 100 })).values()];
    const cases = await Promise.all(ids.map(id => this.get(id)));
    return cases.filter((c): c is SexualCase => !!c);
  }

  async history(eventId: string): Promise<unknown[]> {
    return [...(await this.storage.list({ prefix: `sexual-audit:${eventId}:`, reverse: true, limit: 100 })).values()];
  }

  private async audit(store: DurableObjectStorage | DurableObjectTransaction, eventId: string, action: string, detail: object = {}): Promise<void> {
    const at = this.now();
    const sequenceKey = `sexual-audit-sequence:${eventId}`;
    const sequence = (await store.get<number>(sequenceKey) || 0) + 1;
    await store.put(sequenceKey, sequence);
    await store.put(`sexual-audit:${eventId}:${String(sequence).padStart(16, '0')}`, { at, action, ...detail });
  }

  private queueKey(c: SexualCase): string {
    return `${QUEUE}${String(c.deadlineAt).padStart(16, '0')}:${c.eventId}`;
  }

  private async save(store: DurableObjectStorage | DurableObjectTransaction, c: SexualCase): Promise<void> {
    c.updatedAt = this.now();
    await store.put(PREFIX + c.eventId, c);
    if (!c.actor || c.state === 'pending') await store.put(this.queueKey(c), c.eventId);
    else await store.delete(this.queueKey(c));
    if (c.actor && ['restored', 'restored_restricted'].includes(c.state) && c.reviewAcceptedAt) {
      await store.delete(JOB + c.eventId);
    } else await store.put(JOB + c.eventId, true);
  }

  // IO runs outside DO concurrency gates. Every persisted worker result compares
  // the operation revision; service-side versions fence late network requests.
  private async current(c: SexualCase): Promise<void> {
    const latest = await this.get(c.eventId);
    if (!latest || latest.revision !== c.revision) throw new Superseded();
  }

  private async commit(c: SexualCase, action?: string, detail: object = {}): Promise<void> {
    await this.storage.transaction(async tx => {
      const latest = await tx.get<SexualCase>(PREFIX + c.eventId);
      if (!latest || latest.revision !== c.revision) throw new Superseded();
      // Reports may arrive without changing the operation revision.
      c.reporters = latest.reporters;
      await this.save(tx, c);
      if (action) await this.audit(tx, c.eventId, action, { revision: c.revision, ...detail });
    });
  }

  async admit(eventId: string, report: QuarantineReport, threshold: number): Promise<SexualCase> {
    if (!isLowerHex64(eventId) || !isLowerHex64(report.id) || !isLowerHex64(report.pubkey)
      || !adultSexualCategory(report.reason) || !Number.isInteger(threshold) || threshold < 2) {
      throw new Error('Invalid adult sexual report');
    }
    return this.storage.transaction(async tx => {
      let c = await tx.get<SexualCase>(PREFIX + eventId);
      if (c && await tx.get(`sexual-report:${report.id}`)) return c;
      if (!c) c = {
        eventId, revision: 1, goal: 'review', state: 'review', reporters: 0, threshold,
        firstReport: report, createdAt: this.now(), updatedAt: this.now(),
        deadlineAt: this.now() + REVIEW_MS, attempts: 0, retryAt: 0,
      };
      const reporterKey = `sexual-reporter:${eventId}:${report.pubkey}`;
      if (!await tx.get(reporterKey)) {
        c.reporters++;
        await tx.put(reporterKey, true);
      }
      // Human decisions are terminal for the unchanged event; another report does
      // not undo an accepted restore. New child-safety allegations use their owner.
      if (!c.actor && c.reporters >= c.threshold) {
        if (c.goal !== 'hide') { c.hideTriggeredAt = this.now(); c.revision++; c.retryAt = 0; delete c.reviewAcceptedAt; }
        c.goal = 'hide';
        if (c.state !== 'hidden') c.state = 'pending';
      }
      await this.audit(tx, eventId, 'report', { ...report, receivedAt: this.now(), category: 'sexual-content' });
      await tx.put(`sexual-report:${report.id}`, true);
      await this.save(tx, c);
      await tx.put('sexual-jobs-exist', true);
      return c;
    });
  }

  async decide(eventId: string, revision: number, decision: 'restore' | 'remove', actor: string, reason: string): Promise<SexualCase> {
    return this.storage.transaction(async tx => {
      const c = await tx.get<SexualCase>(PREFIX + eventId);
      if (!c || c.revision !== revision) throw new Error('Case revision conflict');
      if (!actor || !reason.trim() || reason.length > 2000) throw new Error('Reviewer and reason are required');
      await tx.delete(this.queueKey(c));
      c.revision++;
      c.deadlineAt = this.now() + REVIEW_MS;
      delete c.escalatedAt;
      c.decisionAt = this.now();
      c.goal = decision;
      c.actor = actor;
      c.reason = reason;
      c.state = 'pending';
      c.attempts = 0;
      c.retryAt = 0;
      delete c.verifiedAt;
      await this.audit(tx, eventId, decision, { actor, reason, revision: c.revision });
      await this.save(tx, c);
      return c;
    });
  }

  async advance(eventId: string): Promise<void> {
    const existing = this.running.get(eventId);
    if (existing) return existing;
    const work = (async () => {
      // An in-flight old request may finish after a human decision. Immediately
      // pick up its newer revision rather than waiting for the next alarm.
      for (let pass = 0; pass < 3; pass++) {
        try { await this.run(eventId); return; }
        catch (error) { if (!(error instanceof Superseded)) throw error; }
      }
    })();
    this.running.set(eventId, work);
    try { await work; } finally { this.running.delete(eventId); }
  }

  private async run(eventId: string): Promise<void> {
    const c = await this.get(eventId);
    if (!c) return;
    if ((!c.actor || c.state === 'pending') && !c.escalatedAt && this.now() >= c.deadlineAt) {
      c.escalatedAt = this.now();
      await this.commit(c, 'overdue');
      console.error(`[ALERT] Sexual quarantine review overdue: ${eventId}`);
    }
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
        for (const sha of c.snapshot.assets) {
          await this.current(c);
          stage = 'media_hold';
          await this.io.mediaHold(sha, hold, held, c.revision);
        }
        await this.current(c);
        stage = 'public_verification';
        if (!await this.io.verify(c.snapshot, hold, held)) throw new Error('Enforcement verification incomplete');
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
      if (!c.reviewAcceptedAt) {
        await this.current(c);
        stage = 'review_delivery';
        await this.io.review(c);
        c.reviewAcceptedAt = this.now();
      }
      delete c.lastError;
      delete c.lastFailureStage;
      c.retryAt = this.now() + 60_000;
    } catch (error) {
      if (error instanceof Superseded) throw error;
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

  // Rotate a bounded batch: an old failing case cannot starve later ones. Jobs
  // remain for hidden/review cases until a human decision, so overdue work alerts.
  async tick(): Promise<void> {
    const after = await this.storage.get<string>('sexual-scan') || '';
    let jobs = await this.storage.list({ prefix: JOB, startAfter: after, limit: 4 });
    if (jobs.size === 0) jobs = await this.storage.list({ prefix: JOB, limit: 4 });
    for (const key of jobs.keys()) {
      await this.storage.put('sexual-scan', key);
    }
    await Promise.all([...jobs.keys()].map(key => this.advance(key.slice(JOB.length))));
  }
}
