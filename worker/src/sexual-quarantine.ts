import { isLowerHex64 } from './hex';

const PREFIX = 'sexual-case:';
const JOB = 'sexual-job:';
const QUEUE = 'sexual-review:';
const DUE = 'sexual-due:';
const DEADLINE = 'sexual-deadline:';
const RECONCILE = 'sexual-reconcile:';
class Superseded extends Error {}
export class OutsideVideoScope extends Error {}
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
  recordDecision?(item: SexualCase): Promise<void>;
}

export class SexualQuarantine {
  private running = new Map<string, Promise<void>>();

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
    const ids = [...(await this.storage.list<string>({ prefix: QUEUE, limit: 100 })).values()];
    const cases = await Promise.all(ids.map(id => this.storage.get<SexualCase>(PREFIX + id)));
    return cases.filter((c): c is SexualCase => !!c).map(c => {
      const summary = { ...c, firstReport: { ...c.firstReport } };
      delete summary.firstReport.source;
      delete summary.snapshot;
      return summary;
    });
  }

  async history(eventId: string): Promise<unknown[]> {
    const entries = [...(await this.storage.list<Record<string, unknown>>({ prefix: `sexual-audit:${eventId}:`, reverse: true, limit: 100 })).values()];
    return Promise.all(entries.map(async entry => {
      if (typeof entry.sourceRef === 'string') entry.source = await this.evidence<object>(entry.sourceRef);
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
    return `${QUEUE}${String(c.deadlineAt).padStart(16, '0')}:${c.eventId}`;
  }

  private timedKey(prefix: string, time: number, eventId = ''): string {
    return `${prefix}${String(time).padStart(16, '0')}:${eventId}`;
  }

  private open(c: SexualCase): boolean {
    return c.state !== 'out_of_scope' && (!c.actor || c.state === 'pending'
      || (!!this.io.recordDecision && !c.decisionRecordedAt));
  }

  private needsWork(c: SexualCase): boolean {
    return c.state !== 'out_of_scope' && ((!c.snapshot && !c.snapshotRef) || c.state === 'pending' || !c.reviewAcceptedAt
      || (!!c.actor && !c.decisionRecordedAt && !!this.io.recordDecision));
  }

  private async index(store: DurableObjectStorage | DurableObjectTransaction, c: SexualCase, previous = c): Promise<void> {
    await store.delete(this.queueKey(previous));
    await store.delete(this.timedKey(DUE, previous.retryAt, c.eventId));
    await store.delete(this.timedKey(DEADLINE, previous.deadlineAt, c.eventId));
    await store.delete(RECONCILE + c.eventId);
    if (this.open(c)) {
      await store.put(this.queueKey(c), c.eventId);
      if (!c.escalatedAt) await store.put(this.timedKey(DEADLINE, c.deadlineAt, c.eventId), c.eventId);
    }
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
      // The alarm's deadline phase can escalate while this worker awaits IO.
      // Its newer metadata belongs to this revision and must survive the result.
      if (latest.escalatedAt) c.escalatedAt = latest.escalatedAt;
      await this.save(tx, c);
      if (action) await this.audit(tx, c.eventId, action, { revision: c.revision, ...detail });
    });
  }

  async admit(eventId: string, report: QuarantineReport, threshold: number): Promise<SexualCase> {
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
      if (!c || c.revision !== revision) throw new Error('Case revision conflict');
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
      await this.audit(tx, eventId, decision, { actor: reviewer, reason, revision: c.revision });
      await this.save(tx, c);
      return c;
    });
    return this.hydrate(result);
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
      if (c.actor && ['restored', 'restored_restricted', 'removed'].includes(c.state)
        && !c.decisionRecordedAt && this.io.recordDecision) {
        await this.current(c);
        stage = 'decision_record';
        await this.io.recordDecision(c);
        c.decisionRecordedAt = this.now();
        await this.commit(c);
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
  // scan the entire case history. New writes already maintain all three indices.
  private async bootstrap(): Promise<void> {
    if (await this.storage.get('sexual-scheduler-v2-ready')) return;
    await this.storage.transaction(async tx => {
      if (await tx.get('sexual-scheduler-v2-ready')) return;
      const after = await tx.get<string>('sexual-scheduler-v2-cursor') || '';
      const cases = await tx.list<SexualCase>({ prefix: PREFIX, startAfter: after, limit: 100 });
      for (const [key, c] of cases) {
        await this.index(tx, c);
        await tx.put('sexual-scheduler-v2-cursor', key);
      }
      if (cases.size < 100) await tx.put('sexual-scheduler-v2-ready', true);
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
    const after = await this.storage.get<string>('sexual-reconcile-scan') || '';
    let slow = await this.storage.list<string>({ prefix: RECONCILE, startAfter: after, limit: 1 });
    if (slow.size === 0) slow = await this.storage.list<string>({ prefix: RECONCILE, limit: 1 });
    for (const key of slow.keys()) await this.storage.put('sexual-reconcile-scan', key);
    await Promise.all([...new Set([...due.values(), ...slow.values()])].map(eventId => this.advance(eventId)));
  }
}
