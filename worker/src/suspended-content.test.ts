// ABOUTME: Unit tests for the suspended-content relay reads, with the relay's management endpoint stubbed.
// ABOUTME: Pins the request each read sends, the mapping of funnelcake's errors to codes, and the shape checks.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readAuthorSuspension, readSuspendedAccountPage, readSuspendedEvent } from './suspended-content';

const TEST_NSEC = 'nsec1vl029mgpspedva04g90vltkh6fvh240zqtv9k0t9af8935ke9laqsnlfe5';
const MANAGEMENT_URL = 'https://relay.example.test/management';
const env = { RELAY_URL: 'wss://relay.example.test', NOSTR_NSEC: TEST_NSEC };

const AUTHOR = 'a'.repeat(64);
const OTHER = 'b'.repeat(64);
const EVENT_ID = 'c'.repeat(64);

function event(overrides: Record<string, unknown> = {}) {
  return { id: EVENT_ID, pubkey: AUTHOR, created_at: 1_700_000_000, kind: 1, tags: [['t', 'x']], content: 'hidden words', sig: 'f'.repeat(128), ...overrides };
}

let relay: ReturnType<typeof vi.fn>;
function answer(body: unknown, status = 200) {
  relay.mockImplementation(async () => new Response(JSON.stringify(body), { status }));
}
function sentBody(call = 0): { method: string; params: unknown[] } {
  const [url, init] = relay.mock.calls[call];
  expect(String(url)).toBe(MANAGEMENT_URL);
  return JSON.parse(init.body);
}

beforeEach(() => {
  relay = vi.fn();
  vi.stubGlobal('fetch', relay);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('readSuspendedEvent', () => {
  it('sends getsuspendedevent [id] to the relay management URL and returns the event', async () => {
    answer({ result: event() });
    expect(await readSuspendedEvent(EVENT_ID, env)).toEqual({ ok: true, value: event() });
    expect(sentBody()).toEqual({ method: 'getsuspendedevent', params: [EVENT_ID] });
  });

  it('accepts the live version of an addressable event, whose id differs from the requested one', async () => {
    answer({ result: event({ id: 'd'.repeat(64), kind: 34236 }) });
    expect(await readSuspendedEvent(EVENT_ID, env)).toMatchObject({ ok: true, value: { id: 'd'.repeat(64) } });
  });

  it.each([
    ['Event author is not suspended', 409, 'not_suspended'],
    ['Event not found, superseded, or hidden by a filter other than suspension', 404, 'hidden_for_another_reason'],
    ['Unknown method: getsuspendedevent', 501, 'viewer_unsupported'],
    ["This endpoint does not serve suspended-account reads; use the relay's NIP-86 endpoint", 501, 'viewer_unsupported'],
    ['Failed to get suspended event: boom', 502, 'relay_error'],
  ])('maps the relay error %j to %i %s', async (error, status, code) => {
    answer({ error });
    expect(await readSuspendedEvent(EVENT_ID, env)).toEqual({ ok: false, status, code });
  });

  it('an HTTP error is a relay_error', async () => {
    answer({}, 500);
    expect(await readSuspendedEvent(EVENT_ID, env)).toEqual({ ok: false, status: 502, code: 'relay_error' });
  });

  it('a timeout is a relay_error', async () => {
    relay.mockRejectedValue(Object.assign(new Error('timed out'), { name: 'TimeoutError' }));
    expect(await readSuspendedEvent(EVENT_ID, env)).toEqual({ ok: false, status: 502, code: 'relay_error' });
  });

  it('an unreadable body is a relay_error, not a throw', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    relay.mockImplementation(async () => new Response('<html>', { status: 200 }));
    expect(await readSuspendedEvent(EVENT_ID, env)).toEqual({ ok: false, status: 502, code: 'relay_error' });
  });

  it.each([
    ['null', null],
    ['a string', 'event'],
    ['a short id', event({ id: 'c'.repeat(63) })],
    ['an uppercase pubkey', event({ pubkey: AUTHOR.toUpperCase() })],
    ['no content', event({ content: undefined })],
    ['tags that are not a list of lists', event({ tags: ['t'] })],
    ['a non-integer kind', event({ kind: '1' })],
  ])('a malformed result (%s) is a relay_error', async (_name, result) => {
    answer({ result });
    expect(await readSuspendedEvent(EVENT_ID, env)).toEqual({ ok: false, status: 502, code: 'relay_error' });
  });

  it('never logs event content', async () => {
    const spies = (['log', 'warn', 'error'] as const).map(level => vi.spyOn(console, level).mockImplementation(() => {}));
    answer({ result: event() });
    await readSuspendedEvent(EVENT_ID, env);
    answer({ result: event({ id: 'short' }) });
    await readSuspendedEvent(EVENT_ID, env);
    for (const spy of spies) for (const call of spy.mock.calls) expect(call.map(String).join(' ')).not.toContain('hidden words');
  });
});

describe('readSuspendedAccountPage', () => {
  const page = { events: [event(), event({ id: 'e'.repeat(64), created_at: 1_699_999_999 })], next_until: 1_699_999_999, next_until_id: 'e'.repeat(64) };

  it('sends listsuspendedpubkeyevents with an options object holding only the fields given', async () => {
    answer({ result: page });
    await readSuspendedAccountPage({ pubkey: AUTHOR, limit: 50 }, env);
    expect(sentBody()).toEqual({ method: 'listsuspendedpubkeyevents', params: [AUTHOR, { limit: 50 }] });

    await readSuspendedAccountPage({ pubkey: AUTHOR, until: 5, untilId: EVENT_ID, kinds: [0], limit: 1 }, env);
    expect(sentBody(1)).toEqual({
      method: 'listsuspendedpubkeyevents',
      params: [AUTHOR, { kinds: [0], until: 5, until_id: EVENT_ID, limit: 1 }],
    });
  });

  it('sends no options object when no option is given', async () => {
    answer({ result: page });
    await readSuspendedAccountPage({ pubkey: AUTHOR }, env);
    expect(sentBody()).toEqual({ method: 'listsuspendedpubkeyevents', params: [AUTHOR] });
  });

  it('returns the events and the next cursor', async () => {
    answer({ result: page });
    expect(await readSuspendedAccountPage({ pubkey: AUTHOR }, env)).toEqual({
      ok: true, value: { events: page.events, nextUntil: 1_699_999_999, nextUntilId: 'e'.repeat(64) },
    });
  });

  it('a last page has null cursors', async () => {
    answer({ result: { events: [], next_until: null, next_until_id: null } });
    expect(await readSuspendedAccountPage({ pubkey: AUTHOR }, env)).toEqual({
      ok: true, value: { events: [], nextUntil: null, nextUntilId: null },
    });
  });

  it.each([
    ['Pubkey is not suspended', 409, 'not_suspended'],
    ['Unknown method: listsuspendedpubkeyevents', 501, 'viewer_unsupported'],
    ["This endpoint does not serve suspended-account reads; use the relay's NIP-86 endpoint", 501, 'viewer_unsupported'],
    ['unknown option: foo', 502, 'relay_error'],
  ])('maps the relay error %j to %i %s', async (error, status, code) => {
    answer({ error });
    expect(await readSuspendedAccountPage({ pubkey: AUTHOR }, env)).toEqual({ ok: false, status, code });
  });

  it("a page with another author's event is a relay_error", async () => {
    answer({ result: { ...page, events: [event(), event({ id: 'e'.repeat(64), pubkey: OTHER })] } });
    expect(await readSuspendedAccountPage({ pubkey: AUTHOR }, env)).toEqual({ ok: false, status: 502, code: 'relay_error' });
  });

  it.each([
    ['no events list', { next_until: null, next_until_id: null }],
    ['a malformed event', { events: [event({ sig: 1 })], next_until: null, next_until_id: null }],
    ['a string next_until', { events: [], next_until: '5', next_until_id: null }],
    ['a bad next_until_id', { events: [], next_until: 5, next_until_id: 'x' }],
    ['a list instead of a page', []],
  ])('a malformed result (%s) is a relay_error', async (_name, result) => {
    answer({ result });
    expect(await readSuspendedAccountPage({ pubkey: AUTHOR }, env)).toEqual({ ok: false, status: 502, code: 'relay_error' });
  });
});

describe('readAuthorSuspension', () => {
  it('true when the list names the author, in any case', async () => {
    answer({ result: [{ pubkey: OTHER }, { pubkey: AUTHOR.toUpperCase() }] });
    expect(await readAuthorSuspension(AUTHOR, env)).toBe(true);
    expect(sentBody()).toEqual({ method: 'listsuspendedpubkeys', params: [] });
  });

  it('false when it does not', async () => {
    answer({ result: [{ pubkey: OTHER }] });
    expect(await readAuthorSuspension(AUTHOR, env)).toBe(false);
  });

  it.each([
    ['a failed read', { error: 'boom' }],
    ['a result that is not a list', { result: {} }],
    ['an entry without a pubkey', { result: [{}] }],
  ])("'unknown' on %s", async (_name, body) => {
    answer(body);
    expect(await readAuthorSuspension(AUTHOR, env)).toBe('unknown');
  });
});
