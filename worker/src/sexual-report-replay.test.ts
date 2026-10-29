import { describe, expect, it, vi } from 'vitest';
import { finalizeEvent } from 'nostr-tools';
import { replayAdultReports, reportCategory } from './sexual-report-replay';
import { queryRelay } from './relay-profile';
vi.mock('./relay-profile', () => ({ queryRelay: vi.fn() }));
const event = finalizeEvent({ kind: 1984, created_at: 100, content: '', tags: [['e', 'a'.repeat(64), 'NS-sexualContent']] }, new Uint8Array(32).fill(3));
function fixture() {
  const data = new Map();
  return { data, storage: { get: async (key: string) => data.get(key), put: async (key: string, value: unknown) => { data.set(key, value); }, delete: async (key: string) => data.delete(key) } as unknown as DurableObjectStorage };
}
describe('report category', () => {
  it('preserves event-category precedence over an earlier pubkey tag', () => {
    expect(reportCategory([['p', 'b'.repeat(64), 'spam'], ['e', 'a'.repeat(64), 'NS-sexualContent']])).toBe('NS-sexualContent');
    expect(reportCategory([['e', 'a'.repeat(64), 'spam'], ['p', 'b'.repeat(64), 'NS-csam']])).toBe('NS-csam');
  });
  it('lets every shared CSAM category win over an adult category, ignoring case', () => {
    for (const child of ['sexual_minors', 'CSAM', 'NS-csam']) {
      expect(reportCategory([['report', 'NS-sexualContent'], ['l', child, 'MOD']])).toBe(child);
    }
    expect(reportCategory([['report', 'NS-sexualContent'], ['l', 'NS-childSafety', 'social.nos.ontology']])).toBe('NS-sexualContent');
  });
});
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
  it('leaves list reports to the live human-review path', async () => {
    const f = fixture(); const ingest = vi.fn(async () => {});
    const list = finalizeEvent({ kind: 1984, created_at: 100, content: '', tags: [
      ['e', 'a'.repeat(64), 'NS-sexualContent'], ['a', `30005:${'b'.repeat(64)}:favorites`],
    ] }, new Uint8Array(32).fill(4));
    vi.mocked(queryRelay).mockResolvedValue({ success: true, events: [list] });
    await replayAdultReports(f.storage, 'wss://relay.test', ingest, 200);
    expect(ingest).not.toHaveBeenCalled();
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
