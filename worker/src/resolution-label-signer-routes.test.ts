// A missing worker signing key answers the documented 502 before any D1 or
// relay work, on a cold isolate. The schema step is memoised per isolate, so
// only a cold one runs it; if it ran first, a D1 failure would turn the
// documented 502 (SIGNER_UNAVAILABLE) into a 500.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { SIGNER_UNAVAILABLE } from './resolution-labels';

let dbUses: string[];
let sockets: string[];

const downDb = {
  prepare(sql: string) { dbUses.push(sql); throw new Error('D1_ERROR: Network connection lost'); },
  async batch() { dbUses.push('batch'); throw new Error('D1_ERROR: Network connection lost'); },
  async exec() { dbUses.push('exec'); throw new Error('D1_ERROR: Network connection lost'); },
};

// No NOSTR_NSEC: the signing key cannot be resolved.
const env = () => ({
  ADMIN_API_KEY: 'k',
  RELAY_URL: 'wss://relay.example',
  DB: downDb,
}) as unknown as Parameters<(typeof import('./index'))['default']['fetch']>[1];

const get = (path: string) =>
  new Request(`https://api.example${path}`, { headers: { 'X-Admin-Key': 'k' } });

async function coldWorker() {
  vi.resetModules();
  return (await import('./index')).default;
}

beforeEach(() => {
  dbUses = [];
  sockets = [];
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.stubGlobal('WebSocket', class {
    constructor(url: string) { sockets.push(url); throw new Error('relay must not be queried'); }
  } as never);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('missing signing key fails before D1 and relay work', () => {
  it.each([
    '/api/reports?needs_attention=1',
    '/api/reports/resolved',
    '/api/resolution-label-targets',
    '/api/resolution-labels',
  ])('%s answers 502 with zero D1 calls and zero relay queries', async (path) => {
    const worker = await coldWorker();
    const res = await worker.fetch(get(path), env(), { waitUntil() {}, passThroughOnException() {} } as never);
    expect(res.status).toBe(502);
    expect(JSON.stringify(await res.json())).toContain(SIGNER_UNAVAILABLE);
    expect(dbUses).toEqual([]);
    expect(sockets).toEqual([]);
  });
});
