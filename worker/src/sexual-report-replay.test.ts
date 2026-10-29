import { describe, expect, it, vi } from 'vitest';
import { finalizeEvent } from 'nostr-tools';
import { replayAdultReports } from './sexual-report-replay';
import { queryRelay } from './relay-profile';
vi.mock('./relay-profile', () => ({ queryRelay: vi.fn() }));
const event = finalizeEvent({ kind: 1984, created_at: 100, content: '', tags: [['e', 'a'.repeat(64), 'NS-sexualContent']] }, new Uint8Array(32).fill(3));
function fixture() {
  const data = new Map();
  return { data, storage: { get: async (key: string) => data.get(key), put: async (key: string, value: unknown) => { data.set(key, value); }, delete: async (key: string) => data.delete(key) } as unknown as DurableObjectStorage };
}
describe('adult report replay', () => {
  it('commits only confirmed and durably admitted report windows', async () => {
    const f = fixture(); const ingest = vi.fn(async () => {});
    vi.mocked(queryRelay).mockResolvedValue({ success: true, events: [event] });
    await replayAdultReports(f.storage, 'wss://relay.test', ingest, 200);
    expect(ingest).toHaveBeenCalledWith(event, 'NS-sexualContent', 'a'.repeat(64));
    expect(f.data.get('sexual-replay-through')).toBe(200);
    vi.mocked(queryRelay).mockResolvedValue({ success: false, events: [] });
    await expect(replayAdultReports(f.storage, 'wss://relay.test', ingest, 300)).rejects.toThrow();
    expect(f.data.get('sexual-replay-through')).toBe(200);
  });
  it('keeps its window when admission fails', async () => {
    const f = fixture();
    vi.mocked(queryRelay).mockResolvedValue({ success: true, events: [event] });
    await expect(replayAdultReports(f.storage, 'wss://relay.test', async () => { throw Error('storage down'); }, 200)).rejects.toThrow();
    expect(f.data.has('sexual-replay-through')).toBe(false);
  });
  it('never claims full coverage of a saturated same-second page', async () => {
    const f = fixture();
    vi.mocked(queryRelay).mockResolvedValue({ success: true, events: Array(100).fill(event) });
    await replayAdultReports(f.storage, 'wss://relay.test', async () => {}, 200);
    await expect(replayAdultReports(f.storage, 'wss://relay.test', async () => {}, 200)).rejects.toThrow('saturated');
    expect(f.data.has('sexual-replay-through')).toBe(false);
  });
});
