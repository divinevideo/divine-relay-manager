import { afterEach, describe, expect, it, vi } from 'vitest';
import { ReportWatcher, type ReportWatcherEnv, type ReportEvent } from './ReportWatcher';
import { createQuarantineIO } from './sexual-quarantine-io';
import { SexualQuarantine, OutsideVideoScope } from './sexual-quarantine';
import * as nip86 from './nip86';
import * as replay from './sexual-report-replay';
import * as relayProfile from './relay-profile';
import { finalizeEvent } from 'nostr-tools';

vi.mock('./sexual-quarantine-io', () => ({ createQuarantineIO: vi.fn() }));
const ID = '1'.repeat(64);
function fixture(enabled = 'true', data = new Map<string, unknown>()) {
  const storage = {
    get: async (key: string) => structuredClone(data.get(key)),
    put: async (key: string, value: unknown) => { data.set(key, structuredClone(value)); },
    delete: async (key: string) => data.delete(key),
    list: async ({ prefix = '', limit = 1000, startAfter = '' } = {}) => new Map([...data].filter(([k]) => k.startsWith(prefix) && k > startAfter).sort(([a], [b]) => a.localeCompare(b)).slice(0, limit)),
    setAlarm: vi.fn(),
  };
  const durable = { ...storage, transaction: async (fn: (tx: unknown) => unknown) => fn(storage) } as unknown as DurableObjectStorage;
  const state = { storage: durable, blockConcurrencyWhile: async (fn: () => unknown) => fn(), waitUntil: vi.fn() } as unknown as DurableObjectState;
  const io = { snapshot: vi.fn(async () => ({ event: { id: ID }, assets: [] })), eventHold: vi.fn(async () => {}),
    mediaHold: vi.fn(async () => {}), verify: vi.fn(async () => true), restorationStatus: vi.fn(async () => 'visible' as const), review: vi.fn(async () => {}), recordDecision: vi.fn(async () => {}) };
  vi.mocked(createQuarantineIO).mockReturnValue(io);
  const env = { NOSTR_NSEC: 'test', RELAY_URL: 'wss://relay.test', AUTO_HIDE_ENABLED: 'true', SEXUAL_QUARANTINE_ENABLED: enabled } as ReportWatcherEnv;
  const watcher = new ReportWatcher(state, env);
  vi.spyOn(watcher as unknown as { hasBlockingHumanResolution(id: string, raw: boolean): Promise<boolean> }, 'hasBlockingHumanResolution').mockResolvedValue(false);
  const send = async (n: number, reason: string) => {
    await watcher.fetch(new Request('https://do/config', { method: 'PUT', body: JSON.stringify({ enabled: true, trustedClients: [], tiers: [{ kind: 'threshold', name: 'Adult', categories: ['NS-sexualContent'], threshold: 2, requireTrustedClient: false }] }) }));
    const event = finalizeEvent({ kind: 1984, created_at: 1, content: '', tags: [['e', ID, reason]] }, new Uint8Array(32).fill(n + 1));
    await (watcher as unknown as { handleReportEvent(e: ReportEvent): Promise<void> }).handleReportEvent(event as ReportEvent);
    return event as ReportEvent;
  };
  return { watcher, io, send, durable, storage, state, env, data };
}
afterEach(() => vi.restoreAllMocks());

describe('sexual quarantine watcher integration', () => {
  it('keeps verified nonvideo reports on legacy enforcement while video quarantine is enabled', async () => {
    const f = fixture();
    f.io.snapshot.mockRejectedValue(new OutsideVideoScope());
    vi.spyOn(f.watcher as unknown as { countUniqueReporters(): Promise<number> }, 'countUniqueReporters').mockResolvedValue(2);
    const rpc = vi.spyOn(nip86, 'callNip86Rpc').mockResolvedValue({ success: true });
    await f.send(1, 'NS-sexualContent');
    expect(rpc).toHaveBeenCalledWith('banevent', [ID, expect.stringContaining('Auto-hidden: NS-sexualContent')], f.env);
    expect(await new SexualQuarantine(f.durable, f.io).get(ID)).toBeUndefined();
    expect(f.io.eventHold).not.toHaveBeenCalled();
  });

  it('keeps verified nonvideo legacy enforcement after quarantine admission is disabled', async () => {
    const f = fixture();
    f.env.SEXUAL_QUARANTINE_ENABLED = 'false';
    f.io.snapshot.mockRejectedValue(new OutsideVideoScope());
    vi.spyOn(f.watcher as unknown as { countUniqueReporters(): Promise<number> }, 'countUniqueReporters').mockResolvedValue(2);
    const rpc = vi.spyOn(nip86, 'callNip86Rpc').mockResolvedValue({ success: true });
    await f.send(1, 'NS-sexualContent');
    expect(rpc).toHaveBeenCalledWith('banevent', [ID, expect.stringContaining('Auto-hidden: NS-sexualContent')], f.env);
    expect(f.io.eventHold).not.toHaveBeenCalled();
  });

  it('retains replay on unknown targets then delivers verified nonvideo reports once', async () => {
    const f = fixture();
    f.io.snapshot.mockRejectedValue(new Error('Target unavailable'));
    vi.spyOn(f.watcher as unknown as { countUniqueReporters(): Promise<number> }, 'countUniqueReporters').mockResolvedValue(2);
    const rpc = vi.spyOn(nip86, 'callNip86Rpc').mockResolvedValue({ success: true });
    const event = await f.send(1, 'NS-sexualContent');
    vi.spyOn(relayProfile, 'queryRelay').mockResolvedValue({ success: true, events: [event] });
    const ingest = (report: ReportEvent, category: string, target: string) =>
      (f.watcher as unknown as { processAutoHide(e: ReportEvent, c: string, t: string, advance: boolean): Promise<void> }).processAutoHide(report, category, target, false);
    await expect(replay.replayAdultReports(f.durable, f.env.RELAY_URL, ingest, 10)).rejects.toThrow();
    expect(await f.durable.get('sexual-replay-through')).toBeUndefined();
    expect(rpc).not.toHaveBeenCalled();
    f.io.snapshot.mockRejectedValue(new OutsideVideoScope());
    await replay.replayAdultReports(f.durable, f.env.RELAY_URL, ingest, 10);
    await replay.replayAdultReports(f.durable, f.env.RELAY_URL, ingest, 30);
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(await f.durable.get('sexual-replay-through')).toBe(30);
    expect(f.io.eventHold).not.toHaveBeenCalled();
  });

  it('does not pin replay on untrusted reports for unavailable targets', async () => {
    const f = fixture();
    f.io.snapshot.mockRejectedValue(new Error('Target unavailable'));
    await f.watcher.fetch(new Request('https://do/config', { method: 'PUT', body: JSON.stringify({
      enabled: true, trustedClients: ['Divine'], tiers: [{ kind: 'threshold', name: 'Adult', categories: ['NS-sexualContent'], threshold: 2, requireTrustedClient: true }],
    }) }));
    const event = finalizeEvent({ kind: 1984, created_at: 1, content: '', tags: [['e', ID, 'NS-sexualContent'], ['client', 'Untrusted']] }, new Uint8Array(32).fill(9));
    vi.spyOn(relayProfile, 'queryRelay').mockResolvedValue({ success: true, events: [event] });
    await replay.replayAdultReports(f.durable, f.env.RELAY_URL,
      (report, category, target) => (f.watcher as unknown as { processAutoHide(e: ReportEvent, c: string, t: string, advance: boolean): Promise<void> }).processAutoHide(report, category, target, false), 10);
    expect(f.io.snapshot).not.toHaveBeenCalled();
    expect(await f.durable.get('sexual-replay-through')).toBe(10);
    expect(await new SexualQuarantine(f.durable, f.io).get(ID)).toBeUndefined();
  });

  it('preserves exact-category legacy eligibility when the video tier rejects the client', async () => {
    const f = fixture();
    f.io.snapshot.mockRejectedValue(new OutsideVideoScope());
    vi.spyOn(f.watcher as unknown as { countUniqueReporters(): Promise<number> }, 'countUniqueReporters').mockResolvedValue(2);
    const rpc = vi.spyOn(nip86, 'callNip86Rpc').mockResolvedValue({ success: true });
    await f.watcher.fetch(new Request('https://do/config', { method: 'PUT', body: JSON.stringify({
      enabled: true, trustedClients: ['Divine'], tiers: [
        { kind: 'threshold', name: 'Video', categories: ['NS-sexualContent'], threshold: 2, requireTrustedClient: true },
        { kind: 'threshold', name: 'Other', categories: ['nudity'], threshold: 2, requireTrustedClient: false },
      ],
    }) }));
    const event = finalizeEvent({ kind: 1984, created_at: 1, content: '', tags: [['e', ID, 'nudity']] }, new Uint8Array(32).fill(9));
    await (f.watcher as unknown as { handleReportEvent(e: ReportEvent): Promise<void> }).handleReportEvent(event as ReportEvent);
    expect(rpc).toHaveBeenCalledWith('banevent', [ID, expect.stringContaining('Auto-hidden: nudity')], f.env);
    expect(f.io.eventHold).not.toHaveBeenCalled();
  });

  it('retains legacy processed-report dedup across watcher restart', async () => {
    const f = fixture();
    f.io.snapshot.mockRejectedValue(new OutsideVideoScope());
    vi.spyOn(f.watcher as unknown as { countUniqueReporters(): Promise<number> }, 'countUniqueReporters').mockResolvedValue(2);
    const rpc = vi.spyOn(nip86, 'callNip86Rpc').mockResolvedValue({ success: true });
    await f.send(1, 'NS-sexualContent');
    const restarted = fixture('true', f.data);
    restarted.io.snapshot.mockRejectedValue(new OutsideVideoScope());
    vi.spyOn(restarted.watcher as unknown as { countUniqueReporters(): Promise<number> }, 'countUniqueReporters').mockResolvedValue(2);
    await restarted.send(1, 'NS-sexualContent');
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(restarted.io.snapshot).not.toHaveBeenCalled();
  });

  it('leaves generic non-video moderation with its existing owner', async () => {
    const f = fixture();
    f.io.snapshot.mockRejectedValueOnce(new OutsideVideoScope());
    await f.send(1, 'NS-sexualContent');
    const rpc = vi.spyOn(nip86, 'callNip86Rpc').mockResolvedValue({ success: true });
    for (const [relayAction, humanAction] of [['hide', 'hide_event'], ['allow', 'allow_event'], ['review', 'dismiss_report']]) {
      const response = await f.watcher.fetch(new Request('https://do/event-visibility', {
        method: 'POST', body: JSON.stringify({ eventId: ID, relayAction, humanAction, reason: 'other stream decision' }),
      }));
      expect(response.status).toBe(200);
    }
    expect(rpc).toHaveBeenCalledWith('banevent', [ID, 'other stream decision'], expect.anything());
    expect(rpc).toHaveBeenCalledWith('allowevent', [ID], expect.anything());
    expect(f.io.eventHold).not.toHaveBeenCalled();
  });

  it('rejects an unversioned legacy restore after a newer human remove', async () => {
    const f = fixture(); await f.send(1, 'NS-sexualContent'); await f.send(2, 'NS-sexualContent');
    const q = new SexualQuarantine(f.durable, f.io);
    await q.decide(ID, (await q.get(ID))!.revision, 'remove', 'reviewer', 'Explicit activity confirmed');
    await q.advance(ID);
    const response = await f.watcher.fetch(new Request('https://do/event-visibility', {
      method: 'POST', body: JSON.stringify({ eventId: ID, relayAction: 'allow', humanAction: 'allow_event', reason: 'old delivery' }),
    }));
    expect(response.status).toBe(409);
    expect((await q.get(ID))?.goal).toBe('remove');
    expect(f.io.eventHold).not.toHaveBeenCalledWith(ID, false, expect.anything());
  });

  it('keeps unrelated human hides independent from the sexual case', async () => {
    const f = fixture(); await f.send(1, 'NS-sexualContent');
    const rpc = vi.spyOn(nip86, 'callNip86Rpc').mockResolvedValue({ success: true });
    await f.watcher.fetch(new Request('https://do/event-visibility', {
      method: 'POST', body: JSON.stringify({ eventId: ID, relayAction: 'hide', humanAction: 'hide_event', reason: 'another policy' }),
    }));
    expect(rpc).toHaveBeenCalledWith('banevent', [ID, 'another policy'], expect.anything());
    expect((await new SexualQuarantine(f.durable, f.io).get(ID))?.goal).toBe('review');
  });

  it('does not admit a forged report from the live subscription', async () => {
    const f = fixture(); await f.send(1, 'NS-sexualContent');
    const event = finalizeEvent({ kind: 1984, created_at: 1, content: '', tags: [['e', ID, 'nudity']] }, new Uint8Array(32).fill(5));
    await (f.watcher as unknown as { handleReportEvent(e: ReportEvent): Promise<void> }).handleReportEvent({ ...event, content: 'tampered' } as ReportEvent);
    expect((await new SexualQuarantine(f.durable, f.io).get(ID))?.reporters).toBe(1);
  });

  it('never falls back to legacy adult bans after quarantine admission is disabled', async () => {
    const f = fixture(); await f.send(1, 'NS-sexualContent');
    f.env.SEXUAL_QUARANTINE_ENABLED = 'false';
    const legacy = vi.spyOn(f.watcher as unknown as { processThresholdAutoHide(): Promise<void> }, 'processThresholdAutoHide').mockResolvedValue();
    await f.send(2, 'NS-sexualContent');
    expect(legacy).not.toHaveBeenCalled();
    expect((await new SexualQuarantine(f.durable, f.io).get(ID))?.reporters).toBe(1);
  });

  it('admits aliases to one durable case and schedules recovery', async () => {
    const f = fixture();
    await f.send(1, 'NS-sexualContent'); await f.send(2, 'nudity');
    const c = await new SexualQuarantine(f.durable, f.io).get(ID);
    expect(c?.state).toBe('hidden');
    expect(c?.reporters).toBe(2);
    expect(f.storage.setAlarm).toHaveBeenCalled();
  });

  it('resumes durable work while report watching is stopped', async () => {
    const f = fixture();
    const q = new SexualQuarantine(f.durable, f.io);
    await q.admit(ID, { id: '2'.repeat(64), pubkey: '3'.repeat(64), reason: 'nudity' }, 2);
    await q.admit(ID, { id: '4'.repeat(64), pubkey: '5'.repeat(64), reason: 'nudity' }, 2);
    await f.watcher.alarm();
    expect((await q.get(ID))?.state).toBe('hidden');
  });

  it('keeps the watcher alarm running when case recovery fails', async () => {
    const f = fixture();
    await f.durable.put('sexual-jobs-exist', true);
    await f.durable.put(`sexual-job:${ID}`, true);
    vi.spyOn(SexualQuarantine.prototype, 'tick').mockRejectedValue(new Error('storage unavailable'));
    const connect = vi.spyOn(f.watcher as unknown as { connect(): void }, 'connect').mockImplementation(() => {});
    (f.watcher as unknown as { running: boolean }).running = true;
    await expect(f.watcher.alarm()).resolves.toBeUndefined();
    expect(connect).toHaveBeenCalled();
    expect(f.storage.setAlarm).toHaveBeenCalled();
  });

  it('does not admit new replay reports while watching is stopped', async () => {
    const f = fixture(); await f.send(1, 'NS-sexualContent');
    const replayReports = vi.spyOn(replay, 'replayAdultReports').mockResolvedValue();
    await f.watcher.alarm();
    expect(replayReports).not.toHaveBeenCalled();
  });

  it('requires a current revision for reviewer decisions', async () => {
    const f = fixture(); await f.send(1, 'NS-sexualContent');
    const response = await f.watcher.fetch(new Request(`https://do/sexual-quarantine/${ID}`, {
      method: 'POST', body: JSON.stringify({ revision: 0, decision: 'restore', actor: 'reviewer', reason: 'approved' }),
    }));
    expect(response.status).toBe(409);
  });

  it('reports failed human-decision projection instead of a successful restore', async () => {
    const f = fixture(); await f.send(1, 'NS-sexualContent'); await f.send(2, 'NS-sexualContent');
    f.io.recordDecision.mockRejectedValue(new Error('Projection unavailable'));
    const response = await f.watcher.fetch(new Request('https://do/event-visibility', {
      method: 'POST', body: JSON.stringify({ eventId: ID, relayAction: 'allow', humanAction: 'allow_event', reason: 'approved' }),
    }));
    expect(response.status).toBe(502);
    expect((await new SexualQuarantine(f.durable, f.io).get(ID))?.decisionRecordedAt).toBeUndefined();
  });

  it.each(['auto', ' auto ', '   '])('rejects automated or blank actor %j on the human case-decision endpoint', async actor => {
    const f = fixture(); await f.send(1, 'NS-sexualContent');
    const response = await f.watcher.fetch(new Request(`https://do/sexual-quarantine/${ID}`, {
      method: 'POST', body: JSON.stringify({ revision: 1, decision: 'restore', actor, reason: 'approved' }),
    }));
    expect(response.status).toBe(400);
    expect((await new SexualQuarantine(f.durable, f.io).get(ID))?.actor).toBeUndefined();
  });

  it('existing human restore coordinates the independent holds', async () => {
    const f = fixture(); await f.send(1, 'NS-sexualContent'); await f.send(2, 'NS-sexualContent');
    const response = await f.watcher.fetch(new Request('https://do/event-visibility', {
      method: 'POST', body: JSON.stringify({ eventId: ID, relayAction: 'allow', humanAction: 'allow_event', reason: 'approved' }),
    }));
    expect(response.status).toBe(200);
    expect(f.io.eventHold).toHaveBeenLastCalledWith(ID, false, 3);
  });
});
