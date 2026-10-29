import { describe, expect, it, vi } from 'vitest';
import { SexualQuarantine, adultSexualCategory, type QuarantineIO } from './sexual-quarantine';

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
    put: async (key: string, value: unknown) => { data.set(key, structuredClone(value)); },
    delete: async (key: string) => data.delete(key),
    list: async ({ prefix, limit = 1000, startAfter = '', reverse = false }: { prefix: string; limit?: number; startAfter?: string; reverse?: boolean }) =>
      new Map([...data].filter(([k]) => k.startsWith(prefix) && k > startAfter).sort(([a], [b]) => reverse ? b.localeCompare(a) : a.localeCompare(b)).slice(0, limit)),
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

describe('adult sexual report quarantine', () => {
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
