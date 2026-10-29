import { describe, expect, it, vi } from 'vitest';
import { finalizeEvent } from 'nostr-tools';
import { SexualQuarantine, OutsideVideoScope, adultSexualCategory, type QuarantineIO, type SexualCase } from './sexual-quarantine';

const EVENT = '1'.repeat(64);
const HASH = 'a'.repeat(64);
const report = (n: number, reason = 'NS-sexualContent') => ({
  id: n.toString(16).padStart(64, '0'), pubkey: (n + 20).toString(16).padStart(64, '0'), reason,
});

function fixture() {
  let time = 1000;
  const data = new Map<string, unknown>();
  const store = {
    get: async (key: string) => structuredClone(data.get(key)),
    put: async (key: string, value: unknown) => {
      if (new TextEncoder().encode(JSON.stringify(value)).byteLength > 128 * 1024) throw new Error('Durable value exceeds 128 KiB');
      data.set(key, structuredClone(value));
    },
    delete: async (key: string) => data.delete(key),
    list: async ({ prefix, limit = 1000, startAfter = '', end, reverse = false }: { prefix: string; limit?: number; startAfter?: string; end?: string; reverse?: boolean }) =>
      new Map([...data].filter(([k]) => k.startsWith(prefix) && k > startAfter && (!end || k < end)).sort(([a], [b]) => reverse ? b.localeCompare(a) : a.localeCompare(b)).slice(0, limit)),
  };
  const storage = { ...store, transaction: async (fn: (tx: unknown) => unknown) => fn(store) } as unknown as DurableObjectStorage;
  const eventHolds = new Set<string>();
  const mediaHolds = new Set<string>();
  const io: QuarantineIO = {
    snapshot: vi.fn(async () => ({ event: { id: EVENT }, assets: [HASH] })),
    eventHold: vi.fn(async (event, held) => { if (held) eventHolds.add(event); else eventHolds.delete(event); }),
    mediaHold: vi.fn(async (_hash, hold, held) => { if (held) mediaHolds.add(hold); else mediaHolds.delete(hold); }),
    verify: vi.fn(async (_snapshot, hold, held) => held
      ? eventHolds.has(EVENT) && mediaHolds.has(hold)
      : !eventHolds.has(EVENT) && !mediaHolds.has(hold)),
    restorationStatus: vi.fn(async () => !eventHolds.has(EVENT) && mediaHolds.size === 0 ? 'visible' as const : 'pending' as const),
    review: vi.fn(async () => {}),
  };
  return { data, storage, io, now: () => time, later: () => { time += 60_000; },
    engine: () => new SexualQuarantine(storage, io, () => time) };
}

// Persisted cases from the previous scheduler have only the legacy job marker.
function removedBacklog(f: ReturnType<typeof fixture>, count: number) {
  for (let n = 1; n <= count; n++) {
    const eventId = n.toString(16).padStart(64, '0');
    const c: SexualCase = {
      eventId, revision: 3, goal: 'remove', state: 'removed', reporters: 2, threshold: 2,
      firstReport: report(n + 1000), createdAt: 1000, updatedAt: 1000, deadlineAt: 901000,
      attempts: 1, retryAt: 0, snapshot: { event: { id: eventId }, assets: [HASH] },
      actor: 'reviewer', reason: 'explicit activity', reviewAcceptedAt: 1000, verifiedAt: 1000,
    };
    f.data.set(`sexual-case:${eventId}`, c);
    f.data.set(`sexual-job:${eventId}`, true);
  }
}

describe('adult sexual report quarantine', () => {
  it('preserves complete large Unicode evidence across storage and eviction', async () => {
    const f = fixture(); const q = f.engine();
    const video = structuredClone(finalizeEvent({ kind: 21, created_at: 1, tags: [], content: '€'.repeat(45000) }, new Uint8Array(32).fill(1)));
    const source = structuredClone(finalizeEvent({ kind: 1984, created_at: 2,
      tags: [['e', video.id, 'NS-sexualContent']], content: '€'.repeat(45000) }, new Uint8Array(32).fill(2)));
    const originalReport = { id: source.id, pubkey: source.pubkey, reason: 'NS-sexualContent', source };
    const snapshot = { event: video, assets: [HASH] };
    expect(JSON.stringify(source).length).toBeLessThan(60000);
    expect(JSON.stringify(video).length).toBeLessThan(60000);
    expect(new TextEncoder().encode(JSON.stringify(source)).byteLength).toBeGreaterThan(128 * 1024);
    vi.mocked(f.io.snapshot).mockResolvedValue(snapshot);
    vi.mocked(f.io.verify).mockResolvedValue(true);
    await q.admit(video.id, originalReport, 2); await q.admit(video.id, report(2), 2);
    await q.advance(video.id);
    const stored = f.data.get(`sexual-case:${video.id}`) as SexualCase;
    expect(stored.firstReport.source).toBeUndefined();
    expect(stored.snapshot).toBeUndefined();
    expect(stored.firstReport.sourceRef).toBeDefined();
    expect(stored.snapshotRef).toBeDefined();
    const summary = (await q.list())[0];
    expect(summary.firstReport.source).toBeUndefined();
    expect(summary.snapshot).toBeUndefined();
    expect(summary.firstReport.sourceRef).toBe(stored.firstReport.sourceRef);
    expect(summary.snapshotRef).toBe(stored.snapshotRef);
    const evicted = f.engine();
    expect((await evicted.get(video.id))?.firstReport.source).toEqual(source);
    expect((await evicted.get(video.id))?.snapshot).toEqual(snapshot);
    expect((await evicted.history(video.id)).find(entry => (entry as { id?: string }).id === source.id)).toMatchObject({ source });
    await evicted.admit(video.id, originalReport, 2);
    expect((await evicted.get(video.id))?.reporters).toBe(2);
    expect((await evicted.history(video.id)).filter(entry => (entry as { action: string }).action === 'report')).toHaveLength(2);
    f.later(); await evicted.tick();
    expect((await evicted.get(video.id))?.state).toBe('hidden');
    expect(f.io.snapshot).toHaveBeenCalledTimes(1);
    for (const [key, value] of f.data) {
      if (key.includes(':part:')) expect(new TextEncoder().encode(JSON.stringify(value)).byteLength).toBeLessThanOrEqual(64 * 1024);
    }
  });

  it('counts a report for each named target while deduplicating each target replay', async () => {
    const f = fixture(); const q = f.engine();
    const second = 'b'.repeat(64);
    await q.admit(second, report(1), 2);
    const shared = report(2);
    await q.admit(EVENT, shared, 2);
    await q.admit(second, shared, 2);
    expect((await q.get(second))?.reporters).toBe(2);
    expect((await q.get(second))?.goal).toBe('hide');
    await q.admit(second, shared, 2);
    expect((await q.get(second))?.reporters).toBe(2);
    expect((await q.history(second)).filter(entry => (entry as { action: string }).action === 'report')).toHaveLength(2);
  });

  it('rejects the reserved automation identity for human decisions', async () => {
    const f = fixture(); const q = f.engine();
    const c = await q.admit(EVENT, report(1), 2);
    for (const actor of ['auto', ' auto ', ' ']) {
      await expect(q.decide(EVENT, c.revision, 'remove', actor, 'reviewed')).rejects.toThrow('Reviewer');
    }
    expect((await q.get(EVENT))?.revision).toBe(c.revision);
    expect((await q.get(EVENT))?.goal).toBe('review');
  });

  it('processes an urgent retry before a thousand removed reconciliation jobs', async () => {
    const f = fixture(); const q = f.engine();
    removedBacklog(f, 1000);
    await q.admit(EVENT, report(1), 2); await q.admit(EVENT, report(2), 2);
    vi.mocked(f.io.mediaHold).mockRejectedValueOnce(new Error('timeout'));
    await q.advance(EVENT);
    expect((await q.get(EVENT))?.state).toBe('pending');
    vi.mocked(f.io.verify).mockResolvedValue(true);
    f.later(); await q.tick();
    expect((await q.get(EVENT))?.state).toBe('hidden');
    expect(f.io.verify).toHaveBeenCalledTimes(2);
  });

  it('reserves reconciliation capacity while processing three urgent cases', async () => {
    const f = fixture(); const q = f.engine();
    removedBacklog(f, 1000);
    const targets = ['d'.repeat(64), 'e'.repeat(64), 'f'.repeat(64), EVENT].sort();
    for (const [n, eventId] of targets.entries()) {
      await q.admit(eventId, report(n * 2 + 1), 2); await q.admit(eventId, report(n * 2 + 2), 2);
    }
    vi.mocked(f.io.verify).mockResolvedValue(true);
    await q.tick();
    for (const eventId of targets.slice(0, 3)) expect((await q.get(eventId))?.state).toBe('hidden');
    expect((await q.get(targets[3]))?.state).toBe('pending');
    expect(f.io.snapshot).toHaveBeenCalledTimes(3);
    expect(f.io.verify).toHaveBeenCalledTimes(4);
  });

  it('escalates overdue cases before IO despite a thousand removed jobs', async () => {
    const f = fixture(); const q = f.engine();
    removedBacklog(f, 1000);
    await q.admit(EVENT, report(1), 2);
    const second = 'f'.repeat(64);
    await q.admit(second, report(2), 2);
    for (let n = 0; n < 16; n++) f.later();
    vi.mocked(f.io.snapshot).mockImplementation(async () => {
      expect((await q.get(EVENT))?.escalatedAt).toBeDefined();
      expect((await q.get(second))?.escalatedAt).toBeDefined();
      return { event: { id: EVENT }, assets: [HASH] };
    });
    vi.mocked(f.io.verify).mockResolvedValue(true);
    await q.tick();
    expect((await q.get(EVENT))?.escalatedAt).toBeDefined();
    expect((await q.get(second))?.escalatedAt).toBeDefined();
    expect(f.io.snapshot).toHaveBeenCalledTimes(2);
    expect(f.io.verify).toHaveBeenCalledTimes(1);
  });

  it('preserves escalation when an older same-revision worker finishes', async () => {
    const f = fixture(); const q = f.engine();
    await q.admit(EVENT, report(1), 2);
    let release!: () => void; let started!: () => void;
    const begun = new Promise<void>(resolve => { started = resolve; });
    vi.mocked(f.io.snapshot).mockImplementationOnce(async () => {
      started(); await new Promise<void>(resolve => { release = resolve; });
      return { event: { id: EVENT }, assets: [HASH] };
    });
    const running = q.advance(EVENT); await begun;
    for (let n = 0; n < 16; n++) f.later();
    const tick = q.tick();
    // The deadline phase must commit while the existing IO is still blocked.
    for (let n = 0; n < 100 && !(await q.get(EVENT))?.escalatedAt; n++) await Promise.resolve();
    const escalatedAt = (await q.get(EVENT))?.escalatedAt;
    release(); await Promise.all([running, tick]);
    expect(escalatedAt).toBeDefined();
    expect((await q.get(EVENT))?.escalatedAt).toBe(escalatedAt);
    f.later(); await q.tick();
    expect((await q.history(EVENT)).filter(entry => (entry as { action: string }).action === 'overdue')).toHaveLength(1);
  });

  it('drains overdue deadlines without repeatedly selecting already escalated cases', async () => {
    const f = fixture(); const q = f.engine();
    for (let n = 1; n <= 101; n++) await q.admit(n.toString(16).padStart(64, '0'), report(n), 2);
    for (let n = 0; n < 16; n++) f.later();
    await q.tick();
    expect((await q.get('64'.padStart(64, '0')))?.escalatedAt).toBeDefined();
    expect((await q.get('65'.padStart(64, '0')))?.escalatedAt).toBeUndefined();
    await q.tick();
    expect((await q.get('65'.padStart(64, '0')))?.escalatedAt).toBeDefined();
    expect((await q.history('1'.padStart(64, '0'))).filter(entry => (entry as { action: string }).action === 'overdue')).toHaveLength(1);
  });

  it('recovers an older stored pending case and stops work after a successful restore', async () => {
    const f = fixture(); const q = f.engine();
    await q.admit(EVENT, report(1), 2); await q.admit(EVENT, report(2), 2);
    const c = (await q.get(EVENT))!;
    // Keep only data written by the previous scheduler version.
    f.data.clear(); f.data.set(`sexual-case:${EVENT}`, c); f.data.set(`sexual-job:${EVENT}`, true);
    await q.tick();
    expect((await q.get(EVENT))?.state).toBe('hidden');
    await q.decide(EVENT, c.revision, 'restore', 'reviewer', 'approved');
    await q.tick();
    expect((await q.get(EVENT))?.state).toBe('restored');
    for (let n = 0; n < 16; n++) f.later();
    await q.tick();
    expect(f.io.verify).toHaveBeenCalledTimes(2);
    expect((await q.history(EVENT)).some(entry => (entry as { action: string }).action === 'overdue')).toBe(false);
  });

  it('retries decision recording after restoration without undoing verified visibility', async () => {
    const f = fixture(); const q = f.engine();
    const recordDecision = vi.fn(async () => {});
    Object.assign(f.io, { recordDecision });
    await q.admit(EVENT, report(1), 2); await q.admit(EVENT, report(2), 2); await q.advance(EVENT);
    await q.decide(EVENT, (await q.get(EVENT))!.revision, 'restore', 'reviewer', 'approved');
    recordDecision.mockRejectedValue(new Error('D1 unavailable'));
    await q.advance(EVENT);
    expect((await q.get(EVENT))?.state).toBe('restored');
    expect((await q.get(EVENT))?.lastFailureStage).toBe('decision_record');
    expect((await q.get(EVENT))?.decisionRecordedAt).toBeUndefined();
    expect((await q.list()).map(item => item.eventId)).toContain(EVENT);
    for (let n = 0; n < 16; n++) f.later();
    await q.tick();
    expect((await q.get(EVENT))?.escalatedAt).toBeDefined();
    expect((await q.list()).map(item => item.eventId)).toContain(EVENT);
    recordDecision.mockResolvedValue(undefined);
    f.later(); await q.tick();
    expect((await q.get(EVENT))?.decisionRecordedAt).toBeDefined();
    expect((await q.get(EVENT))?.lastError).toBeUndefined();
    expect(recordDecision).toHaveBeenCalledTimes(3);
    expect(await q.list()).toEqual([]);
    await q.decide(EVENT, (await q.get(EVENT))!.revision, 'remove', 'reviewer', 'new decision');
    expect((await q.get(EVENT))?.decisionRecordedAt).toBeUndefined();
  });

  it('orders the urgent queue by deadline before limiting its size', async () => {
    const f = fixture(); const q = f.engine();
    const oldest = 'f'.repeat(64);
    await q.admit(oldest, report(1), 2);
    for (let n = 1; n <= 100; n++) {
      f.later();
      await q.admit(n.toString(16).padStart(64, '0'), report(n + 1), 2);
    }
    expect((await q.list())[0].eventId).toBe(oldest);
  });

  it('rechecks a previously verified hide and repairs missing enforcement', async () => {
    const f = fixture(); const q = f.engine();
    await q.admit(EVENT, report(1), 2); await q.admit(EVENT, report(2), 2); await q.advance(EVENT);
    vi.mocked(f.io.verify).mockResolvedValueOnce(false).mockResolvedValue(true);
    f.later(); await q.tick();
    expect(f.io.verify).toHaveBeenCalledTimes(3);
    expect(f.io.eventHold).toHaveBeenCalledTimes(2);
  });

  it('does not overwrite a newer restore while an older hide is in flight', async () => {
    const f = fixture(); const q = f.engine();
    await q.admit(EVENT, report(1), 2); await q.admit(EVENT, report(2), 2);
    let release!: () => void;
    let started!: () => void;
    const begun = new Promise<void>(resolve => { started = resolve; });
    vi.mocked(f.io.eventHold).mockImplementationOnce(async () => {
      started(); await new Promise<void>(resolve => { release = resolve; });
    });
    const running = q.advance(EVENT); await begun;
    await q.decide(EVENT, (await q.get(EVENT))!.revision, 'restore', 'reviewer', 'approved');
    release(); await running;
    expect((await q.get(EVENT))?.state).toBe('restored');
    expect((await q.get(EVENT))?.goal).toBe('restore');
    expect(f.io.eventHold).toHaveBeenLastCalledWith(EVENT, false, 3);
    expect(f.io.mediaHold).not.toHaveBeenCalledWith(HASH, `sexual:${EVENT}`, true, 2);
  });

  it('returns recent audit entries after more than one hundred reports', async () => {
    const f = fixture(); const q = f.engine();
    for (let i = 1; i <= 110; i++) { await q.admit(EVENT, report(i), 2); f.later(); }
    await q.decide(EVENT, (await q.get(EVENT))!.revision, 'restore', 'reviewer', 'approved');
    expect((await q.history(EVENT))[0]).toMatchObject({ action: 'restore', actor: 'reviewer' });
  });

  it('attributes failed periodic verification to public checks', async () => {
    const f = fixture(); const q = f.engine();
    await q.admit(EVENT, report(1), 2); await q.admit(EVENT, report(2), 2); await q.advance(EVENT);
    vi.mocked(f.io.verify).mockRejectedValueOnce(new Error('read incomplete'));
    f.later(); await q.tick();
    expect((await q.get(EVENT))?.lastFailureStage).toBe('public_verification');
    expect((await q.get(EVENT))?.state).toBe('pending');
    expect((await q.get(EVENT))?.verifiedAt).toBeUndefined();
  });

  it('archives a verified non-video target without holds or repeated work', async () => {
    const f = fixture(); const q = f.engine();
    vi.mocked(f.io.snapshot).mockRejectedValue(new OutsideVideoScope());
    await q.admit(EVENT, report(1), 2); await q.admit(EVENT, report(2), 2); await q.advance(EVENT);
    expect((await q.get(EVENT))?.state).toBe('out_of_scope');
    expect(await q.list()).toEqual([]);
    expect(f.io.eventHold).not.toHaveBeenCalled();
    expect(f.io.mediaHold).not.toHaveBeenCalled();
    expect(f.io.review).not.toHaveBeenCalled();
    await q.admit(EVENT, report(3), 2); f.later(); await q.tick(); await q.advance(EVENT);
    expect(f.io.snapshot).toHaveBeenCalledTimes(1);
    await expect(q.decide(EVENT, (await q.get(EVENT))!.revision, 'remove', 'reviewer', 'wrong stream')).rejects.toThrow('scope');
  });

  it('normalizes adult aliases without taking over child safety', () => {
    for (const s of ['NS-sexualContent', 'NS-sexual-content', 'pornography', 'nudity']) expect(adultSexualCategory(s)).toBe('sexual-content');
    for (const s of ['csam', 'sexual_minors', 'NS-csam', 'harassment']) expect(adultSexualCategory(s)).toBeNull();
  });

  it('opens review on the first report and counts distinct reporters across aliases', async () => {
    const f = fixture(); const q = f.engine();
    await q.admit(EVENT, report(1), 2);
    await q.advance(EVENT);
    expect((await q.get(EVENT))?.goal).toBe('review');
    expect(f.io.eventHold).not.toHaveBeenCalled();
    await q.admit(EVENT, { ...report(1), id: 'e'.repeat(64), reason: 'nudity' }, 2);
    expect((await q.get(EVENT))?.goal).toBe('review');
    await q.admit(EVENT, report(2, 'NS-sexual-content'), 2);
    await q.advance(EVENT);
    expect((await q.get(EVENT))?.state).toBe('hidden');
    expect(f.io.mediaHold).toHaveBeenCalledWith(HASH, `sexual:${EVENT}`, true, 2);
  });

  it('retains intent after an uncertain media response and recovers after eviction', async () => {
    const f = fixture(); const q = f.engine();
    await q.admit(EVENT, report(1), 2); await q.admit(EVENT, report(2), 2);
    vi.mocked(f.io.mediaHold).mockRejectedValueOnce(new Error('timeout'));
    await q.advance(EVENT);
    expect((await q.get(EVENT))?.state).toBe('pending');
    expect((await q.get(EVENT))?.lastError).toBeTruthy();
    f.later(); await f.engine().tick();
    expect((await q.get(EVENT))?.state).toBe('hidden');
    expect(f.io.snapshot).toHaveBeenCalledTimes(1);
  });

  it('does not mark success when verification fails', async () => {
    const f = fixture(); const q = f.engine();
    await q.admit(EVENT, report(1), 2); await q.admit(EVENT, report(2), 2);
    vi.mocked(f.io.verify).mockResolvedValue(false);
    await q.advance(EVENT);
    expect((await q.get(EVENT))?.state).toBe('pending');
    expect((await q.get(EVENT))?.verifiedAt).toBeUndefined();
  });

  it('a versioned human restore supersedes failed hides and survives new reports', async () => {
    const f = fixture(); const q = f.engine();
    await q.admit(EVENT, report(1), 2); await q.admit(EVENT, report(2), 2);
    vi.mocked(f.io.mediaHold).mockRejectedValueOnce(new Error('timeout'));
    await q.advance(EVENT);
    const current = (await q.get(EVENT))!;
    await expect(q.decide(EVENT, current.revision - 1, 'restore', 'reviewer', 'not explicit')).rejects.toThrow('revision');
    await q.decide(EVENT, current.revision, 'restore', 'reviewer', 'not explicit');
    f.later(); await q.tick();
    expect((await q.get(EVENT))?.state).toBe('restored');
    await q.admit(EVENT, report(3), 2); await q.advance(EVENT);
    expect((await q.get(EVENT))?.goal).toBe('restore');
    expect(vi.mocked(f.io.eventHold).mock.calls.at(-1)?.[1]).toBe(false);
    expect((await q.history(EVENT)).length).toBeGreaterThan(3);
  });

  it('releases only its own media hold and reports remaining restrictions', async () => {
    const f = fixture(); const q = f.engine();
    await q.admit(EVENT, report(1), 2); await q.admit(EVENT, report(2), 2); await q.advance(EVENT);
    const c = (await q.get(EVENT))!;
    vi.mocked(f.io.restorationStatus).mockResolvedValue('restricted');
    await q.decide(EVENT, c.revision, 'restore', 'reviewer', 'approved'); await q.advance(EVENT);
    expect((await q.get(EVENT))?.state).toBe('restored_restricted');
    expect(f.io.mediaHold).toHaveBeenLastCalledWith(HASH, `sexual:${EVENT}`, false, c.revision + 1);
  });

  it('records overdue escalation without releasing media, even when work is complete', async () => {
    const f = fixture(); const q = f.engine();
    await q.admit(EVENT, report(1), 2); await q.admit(EVENT, report(2), 2); await q.advance(EVENT);
    for (let i = 0; i < 16; i++) f.later();
    await q.tick();
    expect((await q.get(EVENT))?.escalatedAt).toBeDefined();
    expect((await q.get(EVENT))?.state).toBe('hidden');
  });

  it('keeps restoration pending until query-time visibility converges', async () => {
    const f = fixture(); const q = f.engine();
    await q.admit(EVENT, report(1), 2); await q.admit(EVENT, report(2), 2); await q.advance(EVENT);
    await q.decide(EVENT, (await q.get(EVENT))!.revision, 'restore', 'reviewer', 'approved');
    vi.mocked(f.io.restorationStatus).mockResolvedValueOnce('pending');
    await q.advance(EVENT);
    expect((await q.get(EVENT))?.state).toBe('pending');
    f.later(); await q.tick();
    expect((await q.get(EVENT))?.state).toBe('restored');
  });

  it('retries review delivery without undoing a verified hide', async () => {
    const f = fixture(); const q = f.engine();
    vi.mocked(f.io.review).mockRejectedValueOnce(new Error('COOP unavailable'));
    await q.admit(EVENT, report(1), 2); await q.admit(EVENT, report(2), 2); await q.advance(EVENT);
    expect((await q.get(EVENT))?.state).toBe('hidden');
    expect((await q.get(EVENT))?.reviewAcceptedAt).toBeUndefined();
    f.later(); await q.tick();
    expect((await q.get(EVENT))?.reviewAcceptedAt).toBeDefined();
  });
});
