// ABOUTME: A write the worker refuses with moderator_login_required reads as a plain
// ABOUTME: "sign in" message and raises the app's sign-in prompt, on every write path.
//
// With REQUIRE_MODERATOR_LOGIN on, the worker answers a write that carries no
// verified Divine login with 401 and code moderator_login_required (#405). The
// check is on that exact code, never on the message text.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import {
  ApiError,
  callRelayRpc,
  getSexualQuarantineCase,
  listBannedPubkeys,
  moderateAction,
  submitAIDetection,
} from './adminApi';
import {
  MODERATOR_LOGIN_REQUIRED_MESSAGE,
  subscribeModeratorLoginRequired,
} from './moderatorLoginRequired';

const API = 'https://api.example.test';

function respond(status: number, body: object): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}
const loginRefusal = () =>
  respond(401, { success: false, error: 'Sign in with Divine to continue', code: 'moderator_login_required' });

const fetchMock = vi.fn();
const prompted = vi.fn();
let unsubscribe: () => void;

beforeEach(() => {
  fetchMock.mockReset();
  prompted.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  unsubscribe = subscribeModeratorLoginRequired(prompted);
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  unsubscribe();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function rejection(p: Promise<unknown>): Promise<ApiError> {
  const err = await p.then(() => undefined, (e: unknown) => e);
  expect(err).toBeInstanceOf(ApiError);
  return err as ApiError;
}

describe('a write refused for want of a Divine login', () => {
  it('says so plainly and raises the sign-in prompt', async () => {
    fetchMock.mockResolvedValueOnce(loginRefusal());

    const err = await rejection(moderateAction(API, { action: 'hide_event', eventId: 'e'.repeat(64) }));

    expect(err.code).toBe('moderator_login_required');
    expect(err.statusCode).toBe(401);
    expect(err.message).toBe(MODERATOR_LOGIN_REQUIRED_MESSAGE);
    expect(prompted).toHaveBeenCalledTimes(1);
  });

  it('through the relay RPC path does the same', async () => {
    fetchMock.mockResolvedValueOnce(loginRefusal());

    const err = await rejection(callRelayRpc(API, 'banevent', ['e'.repeat(64), 'spam']));

    expect(err.code).toBe('moderator_login_required');
    expect(err.message).toBe(MODERATOR_LOGIN_REQUIRED_MESSAGE);
    expect(prompted).toHaveBeenCalledTimes(1);
  });

  // AI detection submit reports other failures as null, which its screen words
  // as "Check console". A missing login is thrown instead, so that screen's
  // catch shows the plain message beside the prompt.
  it('through AI detection submit is thrown with the plain message, not reported as null', async () => {
    fetchMock.mockResolvedValueOnce(loginRefusal());

    const err = await rejection(submitAIDetection(API, 'https://media.example.test/v.mp4', 'f'.repeat(64)));

    expect(err.code).toBe('moderator_login_required');
    expect(err.message).toBe(MODERATOR_LOGIN_REQUIRED_MESSAGE);
    expect(prompted).toHaveBeenCalledTimes(1);
  });
});

describe('what is not a missing login', () => {
  it('a 401 with another reason keeps its own message and raises no prompt', async () => {
    fetchMock.mockResolvedValueOnce(respond(401, { success: false, error: 'Unauthorized: admin access requires CF Access or X-Admin-Key header' }));

    const err = await rejection(moderateAction(API, { action: 'hide_event', eventId: 'e'.repeat(64) }));

    expect(err.message).toBe('Unauthorized: admin access requires CF Access or X-Admin-Key header');
    expect(prompted).not.toHaveBeenCalled();
  });

  it('a relay RPC failure with another reason raises no prompt', async () => {
    fetchMock.mockResolvedValueOnce(respond(401, { success: false, error: 'Unauthorized' }));

    const err = await rejection(callRelayRpc(API, 'banevent', ['e'.repeat(64), 'spam']));

    expect(err.message).toBe('Unauthorized');
    expect(prompted).not.toHaveBeenCalled();
  });

  it('a timed-out AI detection submit is still reported as null', async () => {
    fetchMock.mockRejectedValueOnce(new DOMException('timed out', 'TimeoutError'));

    expect(await submitAIDetection(API, 'https://media.example.test/v.mp4', 'f'.repeat(64))).toBeNull();
    expect(prompted).not.toHaveBeenCalled();
  });

  it('an AI detection submit failure with another reason raises no prompt', async () => {
    fetchMock.mockResolvedValueOnce(respond(401, { success: false, error: 'Unauthorized' }));

    expect(await submitAIDetection(API, 'https://media.example.test/v.mp4', 'f'.repeat(64))).toBeNull();
    expect(prompted).not.toHaveBeenCalled();
  });
});

// The suspended-content snapshot is a read the worker can refuse with the same
// code; its screen already says "Sign in with Divine to view the reported post"
// in place, so a read never raises the app-wide prompt.
describe('a read refused for want of a login', () => {
  it('keeps the code for its screen but raises no prompt', async () => {
    fetchMock.mockResolvedValueOnce(loginRefusal());

    const err = await rejection(getSexualQuarantineCase(API, 'e'.repeat(64), { snapshot: true }));

    expect(err.code).toBe('moderator_login_required');
    expect(prompted).not.toHaveBeenCalled();
  });

  it('through the relay RPC path raises no prompt', async () => {
    fetchMock.mockResolvedValueOnce(loginRefusal());

    await rejection(listBannedPubkeys(API));

    expect(prompted).not.toHaveBeenCalled();
  });
});
