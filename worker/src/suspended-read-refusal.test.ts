import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import worker from './index';
import { isBannedEventRead, isSuspendedReadMethod } from './suspended-content';

// The relay serves a suspended account's hidden events through two NIP-86 admin
// reads. /api/relay-rpc must never forward them: it has no verified-moderator
// check and writes no audit row, so the audited viewer is the only way in.

const TEST_NSEC = 'nsec1vl029mgpspedva04g90vltkh6fvh240zqtv9k0t9af8935ke9laqsnlfe5';
const MANAGEMENT_URL = 'https://relay.example.test/management';
const ctx = {} as ExecutionContext;

function makeEnv() {
  return {
    ALLOWED_ORIGINS: 'https://app.example.test',
    RELAY_URL: 'wss://relay.example.test',
    ADMIN_API_KEY: 'test-admin-key',
    MOD_RELAY_ADMIN_KEY: { get: vi.fn(async () => 'mod-shared-key') },
    NOSTR_NSEC: TEST_NSEC,
  } as never;
}

function rpcRequest(method: unknown, key = 'test-admin-key'): Request {
  return new Request('https://api.example.test/api/relay-rpc', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Admin-Key': key,
      Origin: 'https://app.example.test',
    },
    body: JSON.stringify({ method, params: ['a'.repeat(64)] }),
  });
}

describe('/api/relay-rpc refuses suspended-account reads', () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    // A relay that would happily answer, so a forwarded read shows up as a 200.
    fetchSpy = vi.fn(async () => new Response(JSON.stringify({ result: [] }), { status: 200 }));
    vi.stubGlobal('fetch', fetchSpy);
  });

  afterEach(() => vi.unstubAllGlobals());

  it.each([
    'getsuspendedevent',
    'listsuspendedpubkeyevents',
    'GetSuspendedEvent',
    ' listsuspendedpubkeyevents ',
  ])('refuses %j with 403 and never calls the relay', async (method) => {
    const response = await worker.fetch(rpcRequest(method), makeEnv(), ctx);

    expect(response.status).toBe(403);
    const body = await response.json() as { success: boolean; code?: string };
    expect(body.success).toBe(false);
    expect(body.code).toBe('suspended_read_not_allowed');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("refuses on moderation-service's MOD_RELAY_ADMIN_KEY too", async () => {
    const response = await worker.fetch(
      rpcRequest('listsuspendedpubkeyevents', 'mod-shared-key'), makeEnv(), ctx,
    );

    expect(response.status).toBe(403);
    const body = await response.json() as { code?: string };
    expect(body.code).toBe('suspended_read_not_allowed');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('still forwards other methods', async () => {
    const response = await worker.fetch(rpcRequest('listsuspendedpubkeys'), makeEnv(), ctx);

    expect(response.status).toBe(200);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(MANAGEMENT_URL);
    expect(JSON.parse(init.body as string).method).toBe('listsuspendedpubkeys');
  });
});

describe('isSuspendedReadMethod', () => {
  // The relay's RpcRequest.method is a String, so a non-string never dispatches
  // there; the check only has to answer false without throwing.
  it.each([undefined, null, 42, true, ['getsuspendedevent'], { method: 'getsuspendedevent' }])(
    'answers false for the non-string %j',
    (method) => {
      expect(isSuspendedReadMethod(method)).toBe(false);
    },
  );
});

// getbannedevent serves any individually banned (or held) event without checking
// whether its author is suspended, so banevent-then-getbannedevent would read a
// suspended account's post. The worker checks the author itself.
describe('/api/relay-rpc getbannedevent refuses a suspended author', () => {
  const AUTHOR = 'ab'.repeat(32);
  const EVENT_ID = 'cd'.repeat(32);
  const SECRET = 'suspended-account-secret-content';
  const bannedEvent = { id: EVENT_ID, pubkey: AUTHOR, created_at: 1, kind: 1, tags: [], content: SECRET, sig: 'ef'.repeat(64) };

  type Relay = { event?: unknown; suspended?: () => Response };
  let relay: Relay;
  let fetchSpy: ReturnType<typeof vi.fn>;

  const rpcMethodsCalled = () => fetchSpy.mock.calls.map(
    ([, init]) => JSON.parse((init as RequestInit).body as string).method as string,
  );
  const suspendedList = (pubkeys: string[]) => () =>
    new Response(JSON.stringify({ result: pubkeys.map(pubkey => ({ pubkey })) }), { status: 200 });

  beforeEach(() => {
    relay = { event: bannedEvent, suspended: suspendedList([]) };
    // A relay that dispatches on the method (normalised, as a lenient relay
    // would) so the worker's own check is what decides.
    fetchSpy = vi.fn(async (_url: string, init: RequestInit) => {
      const { method } = JSON.parse(init.body as string) as { method: string };
      const m = method.trim().toLowerCase();
      if (m === 'getbannedevent') {
        return relay.event === undefined
          ? new Response(JSON.stringify({ error: 'Event not found or not banned' }), { status: 200 })
          : new Response(JSON.stringify({ result: relay.event }), { status: 200 });
      }
      if (m === 'listsuspendedpubkeys') return relay.suspended!();
      return new Response(JSON.stringify({ error: `unexpected ${method}` }), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchSpy);
  });

  afterEach(() => vi.unstubAllGlobals());

  const read = (method = 'getbannedevent') => worker.fetch(
    new Request('https://api.example.test/api/relay-rpc', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Admin-Key': 'test-admin-key', Origin: 'https://app.example.test' },
      body: JSON.stringify({ method, params: [EVENT_ID] }),
    }),
    makeEnv(),
    ctx,
  );

  async function expectRefused(response: Response, status: number, code: string) {
    expect(response.status).toBe(status);
    const text = await response.text();
    expect(text).not.toContain(SECRET);
    const body = JSON.parse(text) as { success: boolean; code?: string; result?: unknown };
    expect(body.success).toBe(false);
    expect(body.code).toBe(code);
    expect(body.result).toBeUndefined();
  }

  it('returns an individually banned event whose author is not suspended', async () => {
    relay.suspended = suspendedList(['99'.repeat(32)]);
    const response = await read();

    expect(response.status).toBe(200);
    const body = await response.json() as { success: boolean; result: { content: string } };
    expect(body.success).toBe(true);
    expect(body.result.content).toBe(SECRET);
  });

  it('refuses an individually banned event whose author is suspended', async () => {
    relay.suspended = suspendedList(['99'.repeat(32), AUTHOR]);
    await expectRefused(await read(), 403, 'suspended_read_not_allowed');
    // The author check reads the suspension list after the event, never before.
    expect(rpcMethodsCalled()).toEqual(['getbannedevent', 'listsuspendedpubkeys']);
  });

  it.each(['GetBannedEvent', ' getbannedevent '])('applies the author check to the variant %j', async (method) => {
    relay.suspended = suspendedList([AUTHOR]);
    await expectRefused(await read(method), 403, 'suspended_read_not_allowed');
  });

  it('matches a suspension listed in uppercase', async () => {
    relay.suspended = suspendedList([AUTHOR.toUpperCase()]);
    await expectRefused(await read(), 403, 'suspended_read_not_allowed');
  });

  it('matches an event whose pubkey arrives in uppercase', async () => {
    relay.event = { ...bannedEvent, pubkey: AUTHOR.toUpperCase() };
    relay.suspended = suspendedList([AUTHOR]);
    await expectRefused(await read(), 403, 'suspended_read_not_allowed');
  });

  it('sees a suspension on the very next read (no stale suspension list)', async () => {
    expect((await read()).status).toBe(200);
    relay.suspended = suspendedList([AUTHOR]);
    await expectRefused(await read(), 403, 'suspended_read_not_allowed');
  });

  it('fails closed with 503 when the suspension list cannot be read', async () => {
    relay.suspended = () => new Response('upstream down', { status: 502, statusText: 'Bad Gateway' });
    await expectRefused(await read(), 503, 'suspension_status_unavailable');
  });

  it('fails closed with 503 when the suspension list is not a list', async () => {
    relay.suspended = () => new Response(JSON.stringify({ result: { pubkey: AUTHOR } }), { status: 200 });
    await expectRefused(await read(), 503, 'suspension_status_unavailable');
  });

  it('fails closed with 503 when the suspension list read throws', async () => {
    // An unreadable body makes callNip86Rpc throw rather than return a failure.
    relay.suspended = () => new Response('<html>not json</html>', { status: 200 });
    await expectRefused(await read(), 503, 'suspension_status_unavailable');
  });

  // funnelcake answers listsuspendedpubkeys with SuspendedPubkey objects whose
  // `pubkey` is always a string. Anything else is unreadable, and an unreadable
  // entry could be the author, so the read cannot prove the author is clear.
  it.each([
    ['null', null],
    ['a bare pubkey string', 'ab'.repeat(32)],
    ['a number', 42],
    ['a nested array', ['ab'.repeat(32)]],
    ['a null pubkey', { pubkey: null }],
    ['a missing pubkey', { reason: 'spam' }],
    ['a renamed key', { pk: 'ab'.repeat(32) }],
    ['a non-string pubkey', { pubkey: ['ab'.repeat(32)] }],
  ])('fails closed with 503 when a list entry is %s', async (_label, entry) => {
    relay.suspended = () => new Response(
      JSON.stringify({ result: [{ pubkey: '99'.repeat(32) }, entry] }), { status: 200 },
    );
    await expectRefused(await read(), 503, 'suspension_status_unavailable');
  });

  it('reads a legacy non-hex suspension entry as a value, not as unreadable', async () => {
    // FixedString rows written before canonical-hex enforcement can come back as
    // any string. They can never equal an event pubkey, so they must not block
    // every banned-event view behind a 503.
    relay.suspended = suspendedList(['', 'not-a-pubkey', '99'.repeat(32)]);
    const response = await read();
    expect(response.status).toBe(200);
  });

  it('fails closed with 503 when the event names no author', async () => {
    relay.event = { ...bannedEvent, pubkey: undefined };
    await expectRefused(await read(), 503, 'suspension_status_unavailable');
  });

  it('passes the relay\'s "not banned" negative through untouched, without a list read', async () => {
    relay.event = undefined;
    const response = await read();

    expect(response.status).toBe(400);
    const body = await response.json() as { error: string; code?: string };
    expect(body.error).toBe('Event not found or not banned');
    expect(body.code).toBeUndefined();
    expect(rpcMethodsCalled()).toEqual(['getbannedevent']);
  });
});

describe('isBannedEventRead', () => {
  it.each(['getbannedevent', 'GetBannedEvent', ' getbannedevent\n'])('matches %j', (method) => {
    expect(isBannedEventRead(method)).toBe(true);
  });

  it.each([undefined, null, 7, ['getbannedevent'], 'getbannedevents', 'listbannedevents'])('does not match %j', (method) => {
    expect(isBannedEventRead(method)).toBe(false);
  });
});
