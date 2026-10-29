import { afterEach, describe, expect, it, vi } from 'vitest';
import { ReportWatcher, type ReportWatcherEnv, type ReportEvent } from './ReportWatcher';
import { createQuarantineIO } from './sexual-quarantine-io';
import { SexualQuarantine } from './sexual-quarantine';
import * as nip86 from './nip86';
import * as replay from './sexual-report-replay';
import { finalizeEvent } from 'nostr-tools';

vi.mock('./sexual-quarantine-io', () => ({ createQuarantineIO: vi.fn() }));
const ID = '1'.repeat(64);
function fixture(enabled = 'true') {
  const data = new Map<string, unknown>();
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
    mediaHold: vi.fn(async () => {}), verify: vi.fn(async () => true), restorationStatus: vi.fn(async () => 'visible' as const), review: vi.fn(async () => {}) };
  vi.mocked(createQuarantineIO).mockReturnValue(io);
  const env = { NOSTR_NSEC: 'test', RELAY_URL: 'wss://relay.test', AUTO_HIDE_ENABLED: 'true', SEXUAL_QUARANTINE_ENABLED: enabled } as ReportWatcherEnv;
  const watcher = new ReportWatcher(state, env);
  vi.spyOn(watcher as unknown as { hasBlockingHumanResolution(id: string, raw: boolean): Promise<boolean> }, 'hasBlockingHumanResolution').mockResolvedValue(false);
  const send = async (n: number, reason: string) => {
    await watcher.fetch(new Request('https://do/config', { method: 'PUT', body: JSON.stringify({ enabled: true, trustedClients: [], tiers: [{ kind: 'threshold', name: 'Adult', categories: ['NS-sexualContent'], threshold: 2, requireTrustedClient: false }] }) }));
    const event = finalizeEvent({ kind: 1984, created_at: 1, content: '', tags: [['e', ID, reason]] }, new Uint8Array(32).fill(n + 1));
    await (watcher as unknown as { handleReportEvent(e: ReportEvent): Promise<void> }).handleReportEvent(event as ReportEvent);
  };
  return { watcher, io, send, durable, storage, env };
}
afterEach(() => vi.restoreAllMocks());

describe('sexual quarantine watcher integration', () => {
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

  it('existing human restore coordinates the independent holds', async () => {
    const f = fixture(); await f.send(1, 'NS-sexualContent'); await f.send(2, 'NS-sexualContent');
    const response = await f.watcher.fetch(new Request('https://do/event-visibility', {
      method: 'POST', body: JSON.stringify({ eventId: ID, relayAction: 'allow', humanAction: 'allow_event', reason: 'approved' }),
    }));
    expect(response.status).toBe(200);
    expect(f.io.eventHold).toHaveBeenLastCalledWith(ID, false, 3);
  });
});
