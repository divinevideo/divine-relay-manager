// Real signed-event mapping + ReportWatcher admission. Only external transports
// and the existing human-resolution DB read are synthetic.
import { afterEach, expect, it, vi } from 'vitest';
import { finalizeEvent } from 'nostr-tools';
import { ReportWatcher, type ReportWatcherEnv, type ReportEvent } from './ReportWatcher';
import type { SexualQuarantine } from './sexual-quarantine';
import { callNip86Rpc } from './nip86';
import { queryRelay } from './relay-profile';

vi.mock('./nip86', async original => ({ ...await original<typeof import('./nip86')>(), callNip86Rpc: vi.fn() }));
vi.mock('./relay-profile', async original => ({ ...await original<typeof import('./relay-profile')>(), queryRelay: vi.fn() }));
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it('admits and enforces a signed video despite unusable ancillary metadata', async () => {
  const hash = 'a'.repeat(64);
  const video = finalizeEvent({ kind: 21, created_at: 1, content: '', tags: [
    ['url', `https://media.example.test/${hash}.mp4`], ['image', 'not-a-url'],
    ['thumb', 'https://media.example.test/thumbnail.jpg'],
  ] }, new Uint8Array(32).fill(2));
  let held = false;
  const hold = `sexual:${video.id}`;
  vi.mocked(queryRelay).mockImplementation(async () => ({ success: true, events: held ? [] : [video] }));
  vi.mocked(callNip86Rpc).mockImplementation(async (method, params) => {
    if (method === 'seteventhold') {
      held = params[3] === 1;
      return { success: true, result: { hold_id: hold, version: params[2], active: held ? 1 : 0 } };
    }
    if (method === 'geteventholds') return { success: true, result: [{ hold_id: hold, version: 2, active: held ? 1 : 0 }] };
    return { success: true, result: video };
  });
  const requests: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
    const url = String(input); requests.push(url);
    if (url.startsWith('https://coop.example.test/')) return new Response(null, { status: 202 });
    if (url.includes('/admin/api/blob/')) return Response.json({ sha256: hash, owner: video.pubkey });
    if (url.includes('/admin/api/quarantine')) return Response.json({ quarantined: held,
      holds: [{ hold_id: hold, version: 2, active: held }] });
    return new Response(null, { status: held || url.endsWith('/thumbnail.jpg') ? 404 : 200 });
  }));
  const data = new Map<string, unknown>();
  const store = {
    get: async (key: string) => structuredClone(data.get(key)),
    put: async (key: string, value: unknown) => { data.set(key, structuredClone(value)); },
    delete: async (key: string) => data.delete(key),
    list: async ({ prefix = '', limit = 1000, startAfter = '' } = {}) => new Map([...data]
      .filter(([key]) => key.startsWith(prefix) && key > startAfter).sort(([a], [b]) => a.localeCompare(b)).slice(0, limit)),
    setAlarm: vi.fn(),
    getAlarm: vi.fn(async () => null),
  };
  const storage = { ...store, transaction: async (fn: (tx: unknown) => unknown) => fn(store) };
  const state = { storage, blockConcurrencyWhile: async (fn: () => unknown) => fn(), waitUntil: vi.fn() } as unknown as DurableObjectState;
  const watcher = new ReportWatcher(state, { NOSTR_NSEC: 'test', RELAY_URL: 'wss://relay.example.test',
    SEXUAL_QUARANTINE_ENABLED: 'true', AUTO_HIDE_ENABLED: 'true', CDN_DOMAIN: 'media.example.test',
    BLOSSOM_WEBHOOK_SECRET: 'synthetic-only', COOP_URL: 'https://coop.example.test', COOP_API_KEY: 'synthetic-only',
    REVIEWER_BASE_URL: 'https://review.example.test' } as ReportWatcherEnv);
  vi.spyOn(watcher as unknown as { hasBlockingHumanResolution(): Promise<boolean> }, 'hasBlockingHumanResolution').mockResolvedValue(false);
  await watcher.fetch(new Request('https://do/config', { method: 'PUT', body: JSON.stringify({ enabled: true,
    trustedClients: [], tiers: [{ kind: 'threshold', name: 'Adult', categories: ['nudity'], threshold: 2, requireTrustedClient: false }] }) }));
  for (const n of [3, 4]) {
    const report = finalizeEvent({ kind: 1984, created_at: 2, content: '', tags: [['e', video.id, 'nudity']] }, new Uint8Array(32).fill(n));
    await (watcher as unknown as { handleReportEvent(e: ReportEvent): Promise<void> }).handleReportEvent(report as ReportEvent);
  }
  const q = (watcher as unknown as { sexualQuarantine(): SexualQuarantine }).sexualQuarantine();
  const c = await q.get(video.id);
  expect(c).toMatchObject({ reporters: 2, state: 'hidden', snapshot: { assets: [hash], unmappedMediaPaths: ['/thumbnail.jpg'] } });
  expect(c?.reviewAcceptedAt).toBeDefined();
  expect(requests).toContain('https://media.example.test/thumbnail.jpg');
  expect(requests).toContain('https://media.example.test/admin/api/quarantine');
});
