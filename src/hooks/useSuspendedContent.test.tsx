// ABOUTME: Pins the suspended-content viewer hooks: every read is a click, never a
// ABOUTME: mount, focus or reconnect, and a session change drops what was loaded.
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SuspendedAccountResponse, SuspendedEventResponse, NostrEventJson } from '../../shared/suspended-content';
import { useSuspendedAccount, useSuspendedPost } from './useSuspendedContent';

// Each view writes an audit row on the worker, so a request nobody clicked for
// is a false entry in that log. These run the real useAdminApi and adminApi
// down to fetch, so the header, the URL and the body are the ones sent.

const API_URL = 'https://api.example.test';
const TOKEN = 'moderator-login-token';
const MOD_A = 'a'.repeat(64);
const MOD_B = 'b'.repeat(64);
const AUTHOR = 'c'.repeat(64);
const EVENT_ID = 'd'.repeat(64);
const OLDER_ID = 'e'.repeat(64);

const ctx = vi.hoisted(() => ({
  apiUrl: '',
  isSignedIn: true,
  isResolving: false,
  pubkey: undefined as string | undefined,
  token: undefined as string | undefined,
}));
vi.mock('@/hooks/useAppContext', () => ({
  useAppContext: () => ({ config: { apiUrl: ctx.apiUrl, relayUrl: 'wss://relay.example.test' } }),
}));
vi.mock('@/hooks/useDivineSession', () => ({
  useDivineSession: () => ({
    isSignedIn: ctx.isSignedIn,
    isResolving: ctx.isResolving,
    pubkey: ctx.pubkey,
    getModeratorToken: () => ctx.token,
  }),
}));

function event(id: string, created_at = 100): NostrEventJson {
  return { id, pubkey: AUTHOR, created_at, kind: 1, tags: [], content: `post ${id.slice(0, 4)}`, sig: 'f'.repeat(128) };
}

const postResponse: SuspendedEventResponse = { success: true, event: event(EVENT_ID) };
function accountResponse(changes: Partial<SuspendedAccountResponse> = {}): SuspendedAccountResponse {
  return {
    success: true, pubkey: AUTHOR, profile: null, events: [event(EVENT_ID, 200)],
    nextUntil: 150, nextUntilId: OLDER_ID, ...changes,
  };
}

const fetchMock = vi.fn();
const calls = () => fetchMock.mock.calls.map(([url, init]) => ({
  url: String(url),
  method: (init as RequestInit).method,
  headers: (init as RequestInit).headers as Record<string, string>,
  body: JSON.parse((init as RequestInit).body as string) as Record<string, unknown>,
}));

beforeEach(() => {
  ctx.apiUrl = API_URL;
  ctx.isSignedIn = true;
  ctx.isResolving = false;
  ctx.pubkey = MOD_A;
  ctx.token = TOKEN;
  fetchMock.mockReset();
  fetchMock.mockImplementation(async (url: string) =>
    Response.json(url.endsWith('/event') ? postResponse : accountResponse()));
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

async function settle() {
  await act(async () => { await new Promise(r => setTimeout(r, 0)); });
}

describe('useSuspendedPost', () => {
  it('makes no request until load is called', async () => {
    const { result } = renderHook(() => useSuspendedPost({ eventId: EVENT_ID, surface: 'report' }));
    await settle();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.current.status).toBe('idle');
    expect(result.current.session).toBe('ready');
  });

  it('sends the login header, the event id and the surface, and returns the event', async () => {
    const { result } = renderHook(() => useSuspendedPost({ eventId: EVENT_ID, surface: 'age-review' }));

    act(() => result.current.load());
    await waitFor(() => expect(result.current.status).toBe('success'));

    expect(calls()).toEqual([expect.objectContaining({
      url: `${API_URL}/api/suspended-content/event`,
      method: 'POST',
      body: { eventId: EVENT_ID, surface: 'age-review' },
    })]);
    expect(calls()[0].headers['X-Divine-Login-Token']).toBe(TOKEN);
    expect(result.current.data?.event.id).toBe(EVENT_ID);
  });

  it('makes no request when signed out', async () => {
    ctx.isSignedIn = false;
    ctx.pubkey = undefined;
    ctx.token = undefined;
    const { result } = renderHook(() => useSuspendedPost({ eventId: EVENT_ID, surface: 'report' }));

    act(() => result.current.load());
    await settle();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.current.session).toBe('signed-out');
    expect(result.current.status).toBe('idle');
  });

  // The provider clears the pubkey whenever the credentials change, while
  // isSignedIn stays true: a token refresh, or another moderator's session
  // replacing this one. Nothing here can tell those apart, so the view ends
  // either way and a refresh costs one more click.
  it('drops the loaded post while the pubkey is unresolved, and does not reload it', async () => {
    const { result, rerender } = renderHook(() => useSuspendedPost({ eventId: EVENT_ID, surface: 'report' }));
    act(() => result.current.load());
    await waitFor(() => expect(result.current.status).toBe('success'));

    ctx.pubkey = undefined;
    ctx.isResolving = true;
    rerender();
    expect(result.current.status).toBe('idle');
    expect(result.current.data).toBeUndefined();
    expect(result.current.session).toBe('resolving');

    ctx.pubkey = MOD_A;
    ctx.isResolving = false;
    rerender();
    await settle();

    expect(result.current.status).toBe('idle');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('makes no request while the session has no resolved pubkey', async () => {
    ctx.pubkey = undefined;
    ctx.isResolving = true;
    const { result, rerender } = renderHook(() => useSuspendedPost({ eventId: EVENT_ID, surface: 'report' }));

    act(() => result.current.load());
    await settle();
    expect(result.current.session).toBe('resolving');

    // Settled with no identity: the worker could not verify this login either.
    ctx.isResolving = false;
    rerender();
    act(() => result.current.load());
    await settle();

    expect(result.current.session).toBe('unverified');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('drops the loaded post when another moderator resolves after an unresolved moment', async () => {
    const { result, rerender } = renderHook(() => useSuspendedPost({ eventId: EVENT_ID, surface: 'report' }));
    act(() => result.current.load());
    await waitFor(() => expect(result.current.status).toBe('success'));

    ctx.pubkey = undefined;
    rerender();
    ctx.pubkey = MOD_B;
    rerender();

    expect(result.current.status).toBe('idle');
    expect(result.current.data).toBeUndefined();
  });

  it('asks for sign-in without a request when the session has no usable token', async () => {
    ctx.token = undefined;
    const { result } = renderHook(() => useSuspendedPost({ eventId: EVENT_ID, surface: 'report' }));

    act(() => result.current.load());
    await settle();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.current.status).toBe('error');
    expect((result.current.error as { code?: string }).code).toBe('moderator_login_required');
  });

  it('does not refetch on window focus, visibility or reconnect', async () => {
    const { result } = renderHook(() => useSuspendedPost({ eventId: EVENT_ID, surface: 'report' }));
    act(() => result.current.load());
    await waitFor(() => expect(result.current.status).toBe('success'));

    window.dispatchEvent(new Event('focus'));
    document.dispatchEvent(new Event('visibilitychange'));
    window.dispatchEvent(new Event('online'));
    await settle();

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('carries the error code from the worker', async () => {
    fetchMock.mockImplementation(async () => Response.json(
      { success: false, error: 'Hidden for another reason, such as deleted or banned', code: 'hidden_for_another_reason' },
      { status: 404 },
    ));
    const { result } = renderHook(() => useSuspendedPost({ eventId: EVENT_ID, surface: 'report' }));

    act(() => result.current.load());
    await waitFor(() => expect(result.current.status).toBe('error'));

    expect((result.current.error as { code?: string; statusCode?: number })).toMatchObject({ code: 'hidden_for_another_reason', statusCode: 404 });
  });

  it('drops the loaded post on sign-out', async () => {
    const { result, rerender } = renderHook(() => useSuspendedPost({ eventId: EVENT_ID, surface: 'report' }));
    act(() => result.current.load());
    await waitFor(() => expect(result.current.status).toBe('success'));

    ctx.isSignedIn = false;
    ctx.pubkey = undefined;
    ctx.token = undefined;
    rerender();

    expect(result.current.status).toBe('idle');
    expect(result.current.data).toBeUndefined();
  });

  it('drops the loaded post when another moderator signs in, and does not reload it', async () => {
    const { result, rerender } = renderHook(() => useSuspendedPost({ eventId: EVENT_ID, surface: 'report' }));
    act(() => result.current.load());
    await waitFor(() => expect(result.current.status).toBe('success'));

    ctx.pubkey = MOD_B;
    rerender();
    await settle();

    expect(result.current.status).toBe('idle');
    expect(result.current.data).toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('drops the loaded post when the environment changes', async () => {
    const { result, rerender } = renderHook(() => useSuspendedPost({ eventId: EVENT_ID, surface: 'report' }));
    act(() => result.current.load());
    await waitFor(() => expect(result.current.status).toBe('success'));

    ctx.apiUrl = 'https://api.other.test';
    rerender();

    expect(result.current.status).toBe('idle');
    expect(result.current.data).toBeUndefined();
  });

  it('drops the loaded post when the event changes', async () => {
    const { result, rerender } = renderHook(
      ({ id }) => useSuspendedPost({ eventId: id, surface: 'report' }),
      { initialProps: { id: EVENT_ID } },
    );
    act(() => result.current.load());
    await waitFor(() => expect(result.current.status).toBe('success'));

    rerender({ id: OLDER_ID });

    expect(result.current.status).toBe('idle');
    expect(result.current.data).toBeUndefined();
  });

  it.each([
    ['success', () => Response.json({ success: true, event: event(OLDER_ID) })],
    ['failure', () => Response.json({ success: false, error: 'x', code: 'relay_error' }, { status: 502 })],
  ] as const)('a stale %s that lands after a newer view leaves the newer view alone', async (_kind, staleAnswer) => {
    const answers: Array<(r: Response) => void> = [];
    fetchMock.mockImplementation(() => new Promise<Response>(r => { answers.push(r); }));
    const { result, rerender } = renderHook(() => useSuspendedPost({ eventId: EVENT_ID, surface: 'report' }));
    act(() => result.current.load());

    ctx.isSignedIn = false;
    ctx.pubkey = undefined;
    rerender();
    ctx.isSignedIn = true;
    ctx.pubkey = MOD_A;
    rerender();
    act(() => result.current.load());
    await act(async () => { answers[1](Response.json(postResponse)); });
    await waitFor(() => expect(result.current.status).toBe('success'));

    await act(async () => { answers[0](staleAnswer()); });
    await settle();

    expect(result.current.status).toBe('success');
    expect(result.current.data?.event.id).toBe(EVENT_ID);
  });

  it('discards an answer that lands after a sign-out, even once the same moderator is back', async () => {
    let answer!: (r: Response) => void;
    fetchMock.mockImplementation(() => new Promise<Response>(r => { answer = r; }));
    const { result, rerender } = renderHook(() => useSuspendedPost({ eventId: EVENT_ID, surface: 'report' }));
    act(() => result.current.load());
    expect(result.current.status).toBe('loading');

    ctx.isSignedIn = false;
    ctx.pubkey = undefined;
    rerender();
    ctx.isSignedIn = true;
    ctx.pubkey = MOD_A;
    rerender();
    await act(async () => { answer(Response.json(postResponse)); });
    await settle();

    expect(result.current.status).toBe('idle');
    expect(result.current.data).toBeUndefined();
  });
});

describe('useSuspendedAccount', () => {
  it('makes no request until load is called', async () => {
    const { result } = renderHook(() => useSuspendedAccount({ pubkey: AUTHOR, surface: 'user' }));
    await settle();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.current.status).toBe('idle');
  });

  it('loads the first page with the login header, the surface and the content kinds', async () => {
    const { result } = renderHook(() => useSuspendedAccount({ pubkey: AUTHOR, surface: 'user' }));

    act(() => result.current.load());
    await waitFor(() => expect(result.current.status).toBe('success'));

    const [first] = calls();
    expect(first.url).toBe(`${API_URL}/api/suspended-content/account`);
    expect(first.headers['X-Divine-Login-Token']).toBe(TOKEN);
    expect(first.body).toMatchObject({ pubkey: AUTHOR, surface: 'user' });
    expect(first.body).not.toHaveProperty('until');
    expect(first.body).not.toHaveProperty('untilId');
    expect(Array.isArray(first.body.kinds)).toBe(true);
    expect(first.body.kinds).not.toContain(0);
    expect(result.current.pages).toHaveLength(1);
    expect(result.current.hasOlder).toBe(true);
  });

  it('load older sends until and untilId from the last page and appends the page', async () => {
    const { result } = renderHook(() => useSuspendedAccount({ pubkey: AUTHOR, surface: 'user' }));
    act(() => result.current.load());
    await waitFor(() => expect(result.current.status).toBe('success'));
    fetchMock.mockImplementation(async () => Response.json(accountResponse({
      events: [event(OLDER_ID, 120)], nextUntil: null, nextUntilId: null,
    })));

    act(() => result.current.loadOlder());
    await waitFor(() => expect(result.current.pages).toHaveLength(2));

    expect(calls()[1].body).toMatchObject({ pubkey: AUTHOR, surface: 'user', until: 150, untilId: OLDER_ID });
    expect(result.current.pages[1].events[0].id).toBe(OLDER_ID);
    expect(result.current.hasOlder).toBe(false);
  });

  it('a failed older page keeps the pages already loaded', async () => {
    const { result } = renderHook(() => useSuspendedAccount({ pubkey: AUTHOR, surface: 'user' }));
    act(() => result.current.load());
    await waitFor(() => expect(result.current.status).toBe('success'));
    fetchMock.mockImplementation(async () => Response.json({ success: false, error: 'x', code: 'relay_error' }, { status: 502 }));

    act(() => result.current.loadOlder());
    await waitFor(() => expect(result.current.olderStatus).toBe('error'));

    expect(result.current.pages).toHaveLength(1);
    expect(result.current.status).toBe('success');
    expect((result.current.olderError as { code?: string }).code).toBe('relay_error');
  });

  it('makes no request when signed out', async () => {
    ctx.isSignedIn = false;
    ctx.pubkey = undefined;
    ctx.token = undefined;
    const { result } = renderHook(() => useSuspendedAccount({ pubkey: AUTHOR, surface: 'user' }));

    act(() => result.current.load());
    await settle();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.current.session).toBe('signed-out');
    expect(result.current.status).toBe('idle');
  });

  it('drops every loaded page on sign-out', async () => {
    const { result, rerender } = renderHook(() => useSuspendedAccount({ pubkey: AUTHOR, surface: 'user' }));
    act(() => result.current.load());
    await waitFor(() => expect(result.current.status).toBe('success'));

    ctx.isSignedIn = false;
    ctx.pubkey = undefined;
    rerender();

    expect(result.current.status).toBe('idle');
    expect(result.current.pages).toEqual([]);
  });

  it('drops the pages when the account changes', async () => {
    const { result, rerender } = renderHook(
      ({ pk }) => useSuspendedAccount({ pubkey: pk, surface: 'user' }),
      { initialProps: { pk: AUTHOR } },
    );
    act(() => result.current.load());
    await waitFor(() => expect(result.current.status).toBe('success'));

    rerender({ pk: MOD_B });

    expect(result.current.status).toBe('idle');
    expect(result.current.pages).toEqual([]);
  });

  it.each([
    ['success', () => Response.json(accountResponse({ events: [event(OLDER_ID, 120)] }))],
    ['failure', () => Response.json({ success: false, error: 'x', code: 'relay_error' }, { status: 502 })],
  ] as const)('a stale first page (%s) that lands after a newer view leaves the newer view alone', async (_kind, staleAnswer) => {
    const answers: Array<(r: Response) => void> = [];
    fetchMock.mockImplementation(() => new Promise<Response>(r => { answers.push(r); }));
    const { result, rerender } = renderHook(() => useSuspendedAccount({ pubkey: AUTHOR, surface: 'user' }));
    act(() => result.current.load());

    ctx.isSignedIn = false;
    ctx.pubkey = undefined;
    rerender();
    ctx.isSignedIn = true;
    ctx.pubkey = MOD_A;
    rerender();
    act(() => result.current.load());
    await act(async () => { answers[1](Response.json(accountResponse())); });
    await waitFor(() => expect(result.current.status).toBe('success'));

    await act(async () => { answers[0](staleAnswer()); });
    await settle();

    expect(result.current.status).toBe('success');
    expect(result.current.pages).toHaveLength(1);
    expect(result.current.pages[0].events[0].id).toBe(EVENT_ID);
  });

  it('discards an older page that lands after a sign-out', async () => {
    const { result, rerender } = renderHook(() => useSuspendedAccount({ pubkey: AUTHOR, surface: 'user' }));
    act(() => result.current.load());
    await waitFor(() => expect(result.current.status).toBe('success'));
    let answer!: (r: Response) => void;
    fetchMock.mockImplementation(() => new Promise<Response>(r => { answer = r; }));
    act(() => result.current.loadOlder());

    ctx.isSignedIn = false;
    ctx.pubkey = undefined;
    rerender();
    ctx.isSignedIn = true;
    ctx.pubkey = MOD_A;
    rerender();
    await act(async () => { answer(Response.json(accountResponse({ events: [event(OLDER_ID, 120)] }))); });
    await settle();

    expect(result.current.pages).toEqual([]);
    expect(result.current.status).toBe('idle');
  });
});
