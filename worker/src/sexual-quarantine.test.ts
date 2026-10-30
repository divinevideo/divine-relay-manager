import { describe, expect, it, vi } from 'vitest';
import { finalizeEvent } from 'nostr-tools';
import { SexualQuarantine, OutsideVideoScope, QuarantineConflict, adultSexualCategory, type QuarantineIO, type SexualCase } from './sexual-quarantine';

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
  it('keeps COOP delivery outages out of the three urgent enforcement slots', async () => {
    const f = fixture(); const q = f.engine();
    vi.mocked(f.io.review).mockRejectedValue(new Error('COOP unavailable'));
    vi.mocked(f.io.verify).mockResolvedValue(true);
    for (let n = 1; n <= 3; n++) {
      const id = n.toString(16).padStart(64, '0');
      await q.admit(id, report(n * 2), 2); await q.admit(id, report(n * 2 + 1), 2);
      await q.advance(id);
    }
    f.later();
    const targets = ['d'.repeat(64), 'e'.repeat(64), 'f'.repeat(64)];
    for (const [n, id] of targets.entries()) {
      await q.admit(id, report(100 + n * 2), 2); await q.admit(id, report(101 + n * 2), 2);
    }
    vi.mocked(f.io.mediaHold).mockRejectedValue(new Error('temporary enforcement outage'));
    await q.tick();
    vi.mocked(f.io.mediaHold).mockResolvedValue(undefined);
    f.later(); await q.tick();
    for (const id of targets) expect((await q.get(id))?.state).toBe('hidden');
    expect((await q.get('1'.padStart(64, '0')))?.reviewAcceptedAt).toBeUndefined();
  });

  it('retains report provenance while coalescing repeated failures by revision and stage', async () => {
    const f = fixture(); const q = f.engine();
    const source = { id: report(1).id, content: 'original synthetic report evidence' };
    await q.admit(EVENT, { ...report(1), source }, 2); await q.admit(EVENT, report(2), 2);
    vi.mocked(f.io.verify).mockResolvedValue(false);
    vi.mocked(f.io.review).mockRejectedValue(new Error('COOP unavailable'));
    for (let n = 0; n < 110; n++) {
      await q.advance(EVENT);
      for (let minute = 0; minute < 5; minute++) f.later();
    }
    const history = await q.history(EVENT) as Record<string, unknown>[];
    expect(history.find(entry => entry.id === report(1).id)).toMatchObject({ source });
    const failures = history.filter(entry => entry.action === 'retry' && entry.stage === 'public_verification');
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({ revision: 2, occurrences: 110 });
    expect(history.filter(entry => entry.stage === 'review_delivery')).toHaveLength(1);
  });

  it.each(['restore', 'remove'] as const)('records acknowledged human %s intent while public verification remains pending', async decision => {
    const f = fixture(); const q = f.engine();
    const recorded: SexualCase[] = [];
    f.io.recordDecision = async c => { recorded.push(structuredClone(c)); };
    await q.admit(EVENT, report(1), 2); await q.admit(EVENT, report(2), 2); await q.advance(EVENT);
    await q.decide(EVENT, (await q.get(EVENT))!.revision, decision, 'reviewer', 'human review');
    expect((await q.get(EVENT))?.holdsAppliedAt).toBeUndefined();
    vi.mocked(f.io.verify).mockResolvedValue(false);
    await q.advance(EVENT);
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({ goal: decision, revision: 3, state: 'pending', holdsAppliedAt: 1000 });
    const c = (await q.get(EVENT))!;
    expect(c.state).toBe('pending');
    expect(c.holdsAppliedAt).toBe(1000);
    expect(c.decisionRecordedAt).toBe(1000);
    expect(c.verifiedAt).toBeUndefined();
    f.later(); await q.tick();
    expect(recorded).toHaveLength(1);
    await q.decide(EVENT, c.revision, decision === 'restore' ? 'remove' : 'restore', 'reviewer', 'changed decision');
    expect((await q.get(EVENT))?.holdsAppliedAt).toBeUndefined();
  });

  it('does not record human intent until every own hold command is acknowledged', async () => {
    const f = fixture(); const q = f.engine();
    const recorded: SexualCase[] = [];
    f.io.recordDecision = async c => { recorded.push(structuredClone(c)); };
    await q.admit(EVENT, report(1), 2); await q.admit(EVENT, report(2), 2); await q.advance(EVENT);
    await q.decide(EVENT, (await q.get(EVENT))!.revision, 'remove', 'reviewer', 'human review');
    vi.mocked(f.io.mediaHold).mockRejectedValueOnce(new Error('uncertain acknowledgment'));
    await q.advance(EVENT);
    expect((await q.get(EVENT))?.holdsAppliedAt).toBeUndefined();
    expect(recorded).toEqual([]);
    f.later(); await q.tick();
    expect(recorded).toHaveLength(1);
    expect(recorded[0].holdsAppliedAt).toBe(61_000);
  });

  it('starts a fresh hide deadline when a later report crosses the threshold', async () => {
    const f = fixture(); const q = f.engine();
    await q.admit(EVENT, report(1), 2);
    for (let n = 0; n < 16; n++) f.later();
    await q.tick();
    expect((await q.get(EVENT))?.escalatedAt).toBeDefined();
    await q.admit(EVENT, report(2), 2);
    const c = (await q.get(EVENT))!;
    expect(c.createdAt).toBe(1000);
    expect(c.hideTriggeredAt).toBe(961_000);
    expect(c.deadlineAt).toBe(1_861_000);
    expect(c.escalatedAt).toBeUndefined();
    await q.tick();
    expect((await q.get(EVENT))?.escalatedAt).toBeUndefined();
  });

  it('pages the review queue exclusively while prioritizing pending cases over older review cases', async () => {
    const f = fixture(); const q = f.engine();
    for (let n = 1; n <= 101; n++) await q.admit(n.toString(16).padStart(64, '0'), report(n), 2);
    f.later();
    const urgent = 'f'.repeat(64);
    await q.admit(urgent, report(201), 2); await q.admit(urgent, report(202), 2);
    const first = await q.listPage();
    expect(first.cases).toHaveLength(100);
    expect(first.cases[0].eventId).toBe(urgent);
    expect(first.nextCursor).toBeDefined();
    const second = await q.listPage(first.nextCursor);
    expect(second.cases).toHaveLength(2);
    expect(second.nextCursor).toBeUndefined();
    expect(new Set([...first.cases, ...second.cases].map(c => c.eventId)).size).toBe(102);
    await expect(q.listPage('foreign-index:key')).rejects.toThrow('cursor');
  });

  it('reindexes every legacy queue page even when the previous scheduler marked migration ready', async () => {
    const f = fixture(); const q = f.engine();
    f.data.set('sexual-scheduler-v2-ready', true);
    for (let n = 1; n <= 201; n++) {
      const eventId = n.toString(16).padStart(64, '0');
      const c: SexualCase = { eventId, revision: 1, goal: 'review', state: 'review', reporters: 1, threshold: 2,
        firstReport: report(n), createdAt: 1000, updatedAt: 1000, deadlineAt: 901000, attempts: 0, retryAt: 0 };
      f.data.set(`sexual-case:${eventId}`, c);
      f.data.set(`sexual-review:0000000000901000:${eventId}`, eventId);
      f.data.set(`sexual-job:${eventId}`, true);
    }
    const seen: string[] = []; let cursor: string | undefined;
    do {
      const page = await q.listPage(cursor);
      seen.push(...page.cases.map(c => c.eventId)); cursor = page.nextCursor;
    } while (cursor);
    expect(seen).toHaveLength(201);
    expect(new Set(seen).size).toBe(201);
  });

  it('journals ambiguous hold attempts before IO and restores only attempted assets with a newer fence', async () => {
    const f = fixture(); const q = f.engine();
    const ineligible = 'b'.repeat(64);
    const snapshot = { event: { id: EVENT }, assets: [HASH, ineligible], mediaPaths: ['/video.mp4', '/preview.jpg'] };
    f.io.resolveAssets = async () => ({ assets: [HASH], incomplete: true });
    const heldVersions = new Map<string, { held: boolean; version: number }>();
    const apply = (sha: string, held: boolean, version: number) => {
      if (version >= (heldVersions.get(sha)?.version || 0)) heldVersions.set(sha, { held, version });
    };
    const observedJournals: (string[] | undefined)[] = [];
    const commands: { sha: string; held: boolean; version: number }[] = [];
    let finishOldWrite!: () => void;
    f.io.mediaHold = async (sha, _hold, held, version) => {
      commands.push({ sha, held, version });
      if (held) {
        observedJournals.push((await f.engine().get(EVENT))?.mediaHoldAssets);
        finishOldWrite = () => apply(sha, held, version);
        throw new Error('response timed out before the service applied the request');
      }
      apply(sha, held, version);
    };
    vi.mocked(f.io.verify).mockImplementation(async (candidate, _hold, held) => !held && candidate.assets.every(sha => !heldVersions.get(sha)?.held));
    vi.mocked(f.io.restorationStatus).mockResolvedValue('visible');
    await q.admit(EVENT, report(1), 2, snapshot); await q.admit(EVENT, report(2), 2);
    await q.advance(EVENT);
    expect(observedJournals).toEqual([[HASH]]);
    expect((await f.engine().get(EVENT))?.mediaHoldAssets).toEqual([HASH]);
    expect((await q.get(EVENT))?.holdsAppliedAt).toBeUndefined();
    f.later(); await q.advance(EVENT);
    expect(observedJournals).toEqual([[HASH], [HASH]]);
    expect((await q.history(EVENT)).filter(entry => (entry as { action?: string }).action === 'media_hold_intent'))
      .toEqual([expect.objectContaining({ revision: 2, sha256: HASH })]);
    await q.decide(EVENT, (await q.get(EVENT))!.revision, 'restore', 'reviewer', 'approved');
    expect((await q.get(EVENT))?.mediaHoldAssets).toEqual([HASH]);
    await f.engine().advance(EVENT);
    expect(commands.filter(command => !command.held)).toEqual([{ sha: HASH, held: false, version: 3 }]);
    expect(f.io.verify).toHaveBeenLastCalledWith({ ...snapshot, assets: [HASH] }, `sexual:${EVENT}`, false);
    expect(f.io.restorationStatus).toHaveBeenLastCalledWith(snapshot);
    finishOldWrite();
    expect(heldVersions.get(HASH)).toEqual({ held: false, version: 3 });
    expect(heldVersions.has(ineligible)).toBe(false);
    expect((await q.get(EVENT))?.state).toBe('restored');
    expect((await f.engine().get(EVENT))?.snapshot).toEqual(snapshot);
  });

  it('retains the union of attempted media across resolver changes and human decisions', async () => {
    const f = fixture(); const q = f.engine();
    const second = 'b'.repeat(64); let eligible = [HASH];
    f.io.resolveAssets = async () => ({ assets: eligible, incomplete: true });
    vi.mocked(f.io.verify).mockResolvedValue(false);
    await q.admit(EVENT, report(1), 2, { event: { id: EVENT }, assets: [HASH, second] });
    await q.admit(EVENT, report(2), 2); await q.advance(EVENT);
    eligible = [second]; f.later(); await q.advance(EVENT);
    expect((await q.get(EVENT))?.mediaHoldAssets).toEqual([HASH, second]);
    await q.decide(EVENT, (await q.get(EVENT))!.revision, 'remove', 'reviewer', 'reviewed');
    eligible = [HASH]; await q.advance(EVENT);
    expect((await f.engine().get(EVENT))?.mediaHoldAssets).toEqual([HASH, second]);
    const intents = (await q.history(EVENT)).filter(entry => (entry as { action?: string }).action === 'media_hold_intent');
    expect(intents).toHaveLength(2);
    expect(intents).toEqual(expect.arrayContaining([
      expect.objectContaining({ sha256: HASH, revision: 2 }), expect.objectContaining({ sha256: second, revision: 2 }),
    ]));
    await q.decide(EVENT, (await q.get(EVENT))!.revision, 'restore', 'reviewer', 'approved');
    await q.advance(EVENT);
    expect(f.io.mediaHold).toHaveBeenCalledWith(HASH, `sexual:${EVENT}`, false, 4);
    expect(f.io.mediaHold).toHaveBeenCalledWith(second, `sexual:${EVENT}`, false, 4);
  });

  it('restores a first-report case without allocating any media hold IDs', async () => {
    const f = fixture(); const q = f.engine();
    const snapshot = { event: { id: EVENT }, assets: [HASH], mediaPaths: ['/video.mp4'] };
    await q.admit(EVENT, report(1), 2, snapshot);
    expect((await f.engine().get(EVENT))?.mediaHoldAssets).toEqual([]);
    await q.decide(EVENT, (await q.get(EVENT))!.revision, 'restore', 'reviewer', 'approved');
    await q.advance(EVENT);
    expect(f.io.mediaHold).not.toHaveBeenCalled();
    expect(f.io.verify).toHaveBeenLastCalledWith({ ...snapshot, assets: [] }, `sexual:${EVENT}`, false);
    expect(f.io.restorationStatus).toHaveBeenLastCalledWith(snapshot);
    expect((await q.get(EVENT))?.state).toBe('restored');
    expect((await f.engine().get(EVENT))?.snapshot).toEqual(snapshot);
  });

  it('detects an independent restriction on a candidate this case never attempted to hold', async () => {
    const f = fixture(); const q = f.engine();
    const independent = 'b'.repeat(64);
    const snapshot = { event: { id: EVENT }, assets: [HASH, independent], mediaPaths: ['/video.mp4', '/preview.jpg'] };
    vi.mocked(f.io.restorationStatus).mockImplementation(async candidate => candidate.assets.includes(independent) ? 'restricted' : 'visible');
    await q.admit(EVENT, report(1), 2, snapshot);
    await q.decide(EVENT, (await q.get(EVENT))!.revision, 'restore', 'reviewer', 'approved');
    await q.advance(EVENT);
    expect(f.io.mediaHold).not.toHaveBeenCalled();
    expect(f.io.verify).toHaveBeenLastCalledWith({ ...snapshot, assets: [] }, `sexual:${EVENT}`, false);
    expect((await q.get(EVENT))?.state).toBe('restored_restricted');
    expect(f.io.restorationStatus).toHaveBeenLastCalledWith(snapshot);
  });

  it('conservatively releases every signed candidate for a legacy case without an attempt journal', async () => {
    const f = fixture(); const q = f.engine();
    const second = 'b'.repeat(64);
    const c = await q.admit(EVENT, report(1), 2, { event: { id: EVENT }, assets: [HASH, second] });
    const stored = f.data.get(`sexual-case:${EVENT}`) as SexualCase;
    delete stored.mediaHoldAssets; f.data.set(`sexual-case:${EVENT}`, stored);
    await q.decide(EVENT, c.revision, 'restore', 'reviewer', 'approved');
    await q.advance(EVENT);
    expect(f.io.mediaHold).toHaveBeenCalledWith(HASH, `sexual:${EVENT}`, false, 2);
    expect(f.io.mediaHold).toHaveBeenCalledWith(second, `sexual:${EVENT}`, false, 2);
    expect((await q.get(EVENT))?.state).toBe('restored');
  });

  it('retries temporary media eligibility gaps without changing archived candidate evidence', async () => {
    const f = fixture(); const q = f.engine();
    const snapshot = { event: { id: EVENT }, assets: [HASH] };
    const resolveAssets = vi.fn().mockResolvedValueOnce({ assets: [], incomplete: true })
      .mockResolvedValue({ assets: [HASH], incomplete: false });
    f.io.resolveAssets = resolveAssets;
    vi.mocked(f.io.verify).mockImplementation(async candidate => !candidate.mappingIncomplete && candidate.assets.includes(HASH));
    await q.admit(EVENT, report(1), 2, snapshot); await q.admit(EVENT, report(2), 2);
    await q.advance(EVENT);
    expect((await q.get(EVENT))?.state).toBe('pending');
    expect(f.io.mediaHold).not.toHaveBeenCalled();
    expect(f.io.verify).toHaveBeenLastCalledWith(expect.objectContaining({ assets: [], mappingIncomplete: true }), `sexual:${EVENT}`, true);
    expect((await f.engine().get(EVENT))?.snapshot).toEqual(snapshot);
    f.later(); await q.tick();
    expect((await q.get(EVENT))?.state).toBe('hidden');
    expect(f.io.mediaHold).toHaveBeenLastCalledWith(HASH, `sexual:${EVENT}`, true, 2);
    expect((await f.engine().get(EVENT))?.snapshot).toEqual(snapshot);
    await q.decide(EVENT, (await q.get(EVENT))!.revision, 'restore', 'reviewer', 'approved');
    resolveAssets.mockRejectedValue(new Error('eligibility service unavailable'));
    await q.advance(EVENT);
    expect((await q.get(EVENT))?.state).toBe('restored');
    expect(f.io.mediaHold).toHaveBeenLastCalledWith(HASH, `sexual:${EVENT}`, false, 3);
    expect(resolveAssets).toHaveBeenCalledTimes(2);
  });

  it('does not let a missing snapshot block delivery of another ready case', async () => {
    const f = fixture(); const q = f.engine();
    const missing = '1'.padStart(64, '0');
    vi.mocked(f.io.snapshot).mockImplementation(async id => {
      if (id === missing) throw new Error('target unavailable');
      return { event: { id }, assets: [HASH] };
    });
    vi.mocked(f.io.verify).mockResolvedValue(true);
    await q.admit(missing, report(1), 2); await q.advance(missing);
    await q.admit(EVENT, report(2), 2); await q.admit(EVENT, report(3), 2);
    vi.mocked(f.io.review).mockRejectedValueOnce(new Error('COOP unavailable'));
    await q.advance(EVENT);
    f.later(); await q.tick();
    expect((await q.get(missing))?.snapshot).toBeUndefined();
    expect((await q.get(EVENT))?.reviewAcceptedAt).toBeDefined();
  });

  it('keeps original audit entries immutable while exposing summarized retry counts', async () => {
    const f = fixture(); const q = f.engine();
    await q.admit(EVENT, report(1), 2); await q.admit(EVENT, report(2), 2);
    vi.mocked(f.io.verify).mockResolvedValue(false);
    await q.advance(EVENT);
    const [key, initial] = [...f.data].find(([key, value]) => key.startsWith(`sexual-audit:${EVENT}:`)
      && (value as { stage?: string }).stage === 'public_verification')!;
    f.later(); await q.advance(EVENT);
    expect(f.data.get(key)).toEqual(initial);
    expect((await q.history(EVENT)).find(entry => (entry as { stage?: string }).stage === 'public_verification'))
      .toMatchObject({ occurrences: 2, at: 1000, lastAt: 61_000 });
  });

  it('clears a recovered enforcement failure after public verification succeeds', async () => {
    const f = fixture(); const q = f.engine();
    await q.admit(EVENT, report(1), 2); await q.admit(EVENT, report(2), 2);
    vi.mocked(f.io.verify).mockResolvedValueOnce(false);
    await q.advance(EVENT);
    expect((await q.get(EVENT))?.lastFailureStage).toBe('public_verification');
    f.later(); await q.tick();
    expect((await q.get(EVENT))?.state).toBe('hidden');
    expect((await q.get(EVENT))?.lastError).toBeUndefined();
    expect((await q.get(EVENT))?.lastFailureStage).toBeUndefined();
  });

  it('backs delivery off independently from frequent enforcement retries', async () => {
    const f = fixture(); const q = f.engine();
    await q.admit(EVENT, report(1), 2); await q.admit(EVENT, report(2), 2);
    vi.mocked(f.io.verify).mockResolvedValue(false);
    vi.mocked(f.io.review).mockRejectedValue(new Error('COOP unavailable'));
    await q.advance(EVENT); await q.advance(EVENT);
    expect((await q.get(EVENT))?.deliveryAttempts).toBe(1);
    for (let n = 0; n < 3; n++) { f.later(); await q.tick(); }
    const c = (await q.get(EVENT))!;
    expect(c.deliveryAttempts).toBe(3);
    expect(c.deliveryRetryAt).toBe(241_000);
    expect(c.state).toBe('pending');
    expect(c.attempts).toBe(4);
  });

  it('enforces a newer decision while an older COOP request is still in flight', async () => {
    const f = fixture(); const q = f.engine();
    await q.admit(EVENT, report(1), 2); await q.admit(EVENT, report(2), 2);
    let release!: () => void; let started!: () => void;
    const begun = new Promise<void>(resolve => { started = resolve; });
    vi.mocked(f.io.review).mockImplementationOnce(async () => {
      started(); await new Promise<void>(resolve => { release = resolve; });
    });
    const old = q.advance(EVENT); await begun;
    await q.decide(EVENT, (await q.get(EVENT))!.revision, 'restore', 'reviewer', 'approved');
    await q.advance(EVENT, false);
    expect((await q.get(EVENT))?.state).toBe('restored');
    expect((await q.get(EVENT))?.reviewAcceptedAt).toBeUndefined();
    release(); await old;
    expect((await q.get(EVENT))?.revision).toBe(3);
    expect((await q.get(EVENT))?.reviewAcceptedAt).toBeDefined();
    expect(f.io.review).toHaveBeenLastCalledWith(expect.objectContaining({ revision: 3, goal: 'restore' }));
  });

  it('archives an admission snapshot without repeating the target read', async () => {
    const f = fixture(); const q = f.engine();
    const snapshot = { event: { id: EVENT, kind: 21 }, assets: [HASH] };
    await q.admit(EVENT, report(1), 2, snapshot);
    await q.admit(EVENT, report(2), 2, { event: { id: EVENT, changed: true }, assets: [] });
    await q.advance(EVENT);
    expect(f.io.snapshot).not.toHaveBeenCalled();
    expect((await f.engine().get(EVENT))?.snapshot).toEqual(snapshot);
  });

  it('uses a typed conflict only for stale or missing case revisions', async () => {
    const f = fixture(); const q = f.engine();
    const c = await q.admit(EVENT, report(1), 2);
    await expect(q.decide(EVENT, c.revision + 1, 'remove', 'reviewer', 'reviewed')).rejects.toBeInstanceOf(QuarantineConflict);
    await expect(q.decide(EVENT, c.revision, 'remove', 'auto', 'reviewed')).rejects.not.toBeInstanceOf(QuarantineConflict);
  });

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

  it('delivers priority review even while enforcement needs a retry', async () => {
    const f = fixture(); const q = f.engine();
    await q.admit(EVENT, report(1), 2); await q.admit(EVENT, report(2), 2);
    vi.mocked(f.io.mediaHold).mockRejectedValueOnce(new Error('unavailable'));
    await q.advance(EVENT);
    expect((await q.get(EVENT))?.state).toBe('pending');
    expect(f.io.review).toHaveBeenCalledTimes(1);
    expect((await q.get(EVENT))?.reviewAcceptedAt).toBeDefined();
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

  it('lets every selected case finish before reporting a failed tick', async () => {
    const f = fixture(); const q = f.engine();
    const other = '2'.repeat(64);
    await q.admit(EVENT, report(1), 2); await q.admit(other, report(2), 2);
    let finished = false;
    vi.spyOn(q, 'advance').mockImplementation(async eventId => {
      if (eventId === EVENT) throw new Error('storage unavailable');
      await new Promise(resolve => setTimeout(resolve, 10));
      finished = true;
    });
    await expect(q.tick()).rejects.toThrow('storage unavailable');
    expect(finished).toBe(true);
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
