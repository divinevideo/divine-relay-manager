// Test-only: a fake Funnelcake relay socket and a bulk-job drain loop, shared by
// the worker tests. Not imported by the worker itself.
import { vi } from 'vitest';
import { banEvent, type Nip86RpcResult } from '../nip86';
import { processBulkJob, type BulkModerateEnv } from '../bulk-moderate';
import { isVersionedKind, type BulkJobMessage } from '../../../shared/bulk-moderation';

// The account the tests act on, and every stored event's default author.
export const ACCOUNT = 'a'.repeat(64);

// An event the fake relay stores. A missing `created_at` is sent without one,
// which no honest relay does; such an event passes any `until`.
export interface RelayEvent {
  id: string;
  kind: number;
  pubkey?: string;
  created_at?: number;
  // An addressable event's d tag, sent as its only tag unless `tags` is given.
  d?: string;
  content?: string;
  tags?: string[][];
}

export const BAN_REFUSED: Nip86RpcResult = { success: false, error: 'relay refused' };

export interface RelayFakeOptions {
  // How each banEvent call answers (default: success). The relay hides an
  // event only once a ban of it succeeds, as funnelcake does.
  ban?: (id: string) => Nip86RpcResult | Promise<Nip86RpcResult>;
  // false: the relay acknowledges bans but keeps listing the events.
  bansTakeEffect?: boolean;
  // REQ filters the relay ignores, the way a misbehaving relay or proxy could.
  ignore?: { authors?: boolean; kinds?: boolean; until?: boolean };
  // Runs before each REQ is answered and may add events (an account posting
  // during the job).
  onReq?: (store: RelayEvent[]) => void;
  // Rewrites the events sent for one REQ: repeated frames, extra events.
  frames?: (events: RelayEvent[], reqIndex: number) => RelayEvent[];
  // How the relay answers REQ number `reqIndex` (0-based) instead of normally:
  // 'closed' sends CLOSED for it, 'closed-other' first sends a CLOSED for some
  // other subscription and then answers, 'error' and 'close' drop the socket,
  // and 'stall' never answers.
  socket?: (reqIndex: number) => 'closed' | 'closed-other' | 'error' | 'close' | 'stall' | undefined;
  // 'error' fails the connection; 'never' leaves it opening forever.
  connect?: 'error' | 'never';
  // Answer each REQ this long after it arrives, on a timer, instead of at once.
  delayMs?: number;
}

// Installs a WebSocket that answers REQs from `events` the way funnelcake's
// deduped_read_model_projection does: the authors, kinds, `until` and
// not-banned filters first, newest first, then one row per NIP-01 dedup key, so
// banning a replaceable or addressable event's newest version lists the one
// before it. In a test file that mocks ./nip86, it also answers banEvent.
// Returns the REQ filters it received.
export function relayFake(events: RelayEvent[], opts: RelayFakeOptions = {}) {
  const store = [...events];
  const banned = new Set<string>();
  const reqs: Array<Record<string, unknown>> = [];
  if (vi.isMockFunction(banEvent)) {
    vi.mocked(banEvent).mockImplementation(async (id: string) => {
      const result = await (opts.ban?.(id) ?? { success: true });
      if (result.success && opts.bansTakeEffect !== false) banned.add(id);
      return result;
    });
  }

  const author = (e: RelayEvent) => e.pubkey ?? ACCOUNT;
  const dedupKey = (e: RelayEvent) => {
    if (e.kind >= 30000 && e.kind < 40000) return `${author(e)}|${e.kind}|${e.d ?? ''}`;
    if (isVersionedKind(e.kind)) return `${author(e)}|${e.kind}`;
    return e.id;
  };
  function query(f: Record<string, unknown>): RelayEvent[] {
    const authors = opts.ignore?.authors ? undefined : f.authors as string[] | undefined;
    const kinds = opts.ignore?.kinds ? undefined : f.kinds as number[] | undefined;
    const until = opts.ignore?.until ? undefined : f.until as number | undefined;
    const rows = store
      .filter((e) => (!authors || authors.includes(author(e))) && (!kinds || kinds.includes(e.kind))
        && (until === undefined || e.created_at === undefined || e.created_at <= until) && !banned.has(e.id))
      .sort((a, b) => (b.created_at ?? 0) - (a.created_at ?? 0) || (a.id < b.id ? 1 : -1));
    const newest = new Map<string, RelayEvent>();
    for (const r of rows) if (!newest.has(dedupKey(r))) newest.set(dedupKey(r), r);
    return [...newest.values()].slice(0, (f.limit as number | undefined) ?? 500);
  }
  const wire = (e: RelayEvent) => ({
    id: e.id,
    pubkey: author(e),
    kind: e.kind,
    ...(e.created_at !== undefined ? { created_at: e.created_at } : {}),
    content: e.content ?? '',
    tags: e.tags ?? (e.d !== undefined ? [['d', e.d]] : []),
  });

  vi.spyOn(globalThis, 'WebSocket').mockImplementation((function () {
    const listeners = new Map<string, Array<(value?: unknown) => void>>();
    const emit = (type: string, value?: unknown) => listeners.get(type)?.forEach((h) => h(value));
    const frame = (msg: unknown[]) => emit('message', { data: JSON.stringify(msg) });
    if (opts.connect !== 'never') queueMicrotask(() => emit(opts.connect === 'error' ? 'error' : 'open'));
    return {
      addEventListener: (t: string, h: (value?: unknown) => void) => listeners.set(t, [...(listeners.get(t) || []), h]),
      send: (payload: string) => {
        const data = JSON.parse(payload);
        if (data[0] !== 'REQ') return;
        const reqIndex = reqs.length;
        reqs.push(data[2]);
        const how = opts.socket?.(reqIndex);
        if (how === 'stall') return;
        opts.onReq?.(store);
        let out = query(data[2]);
        if (opts.frames) out = opts.frames(out, reqIndex);
        const answer = () => {
          if (how === 'error' || how === 'close') { emit(how); return; }
          if (how === 'closed') { frame(['CLOSED', data[1], 'error: could not complete query']); return; }
          if (how === 'closed-other') frame(['CLOSED', 'someone-else', 'error: not yours']);
          for (const e of out) frame(['EVENT', data[1], wire(e)]);
          frame(['EOSE', data[1]]);
        };
        if (opts.delayMs !== undefined) setTimeout(answer, opts.delayMs);
        else queueMicrotask(answer);
      },
      close: vi.fn(),
    };
  } as unknown as typeof WebSocket));
  return { reqs, query };
}

// Runs a bulk job's chunks the way the queue would: each processBulkJob call's
// sent message is the next one delivered, until none is sent or `max` chunks
// have run. `sent` is the array the env's BULK_QUEUE pushes to.
export async function drainJob(
  env: BulkModerateEnv, sent: BulkJobMessage[], first: BulkJobMessage | undefined, max = 20,
): Promise<{ chunks: number; messages: BulkJobMessage[]; terminated: boolean }> {
  const messages: BulkJobMessage[] = [];
  let msg = first;
  let chunks = 0;
  while (msg && chunks < max) {
    chunks++;
    sent.length = 0;
    await processBulkJob(msg, env);
    msg = sent[0];
    if (msg) messages.push(msg);
  }
  return { chunks, messages, terminated: !msg };
}
