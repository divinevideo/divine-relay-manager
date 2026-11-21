// ABOUTME: Pins that every write made through asModerator(token) sends the
// ABOUTME: X-Divine-Login-Token header, and the plain useAdminApi() has none of them (#178).
import { renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '@/lib/adminApi';
import { buildAdminApi, useAdminApi, type ModeratorApi, type PlainAdminApi } from './useAdminApi';

// The worker records the moderator it verifies from this header, and nothing
// else. Each useAdminApi wrapper rewrites its argument list by hand, so a
// wrapper that forgets to pass `{ loginToken }` on leaves that action
// unattributed while tsc and the component tests (which mock this hook) stay
// green. This table runs the REAL wrappers over the REAL adminApi down to fetch.
// A new write belongs in it.

const API_URL = 'https://api.example';
const TOKEN = 'login-token-under-test';
const PK = 'a'.repeat(64);
const HEADER = 'X-Divine-Login-Token';

vi.mock('@/hooks/useAppContext', () => ({
  useAppContext: () => ({ config: { apiUrl: API_URL, relayUrl: RELAY_URL } }),
}));

const RELAY_URL = 'wss://relay.example';

const ATTRIBUTION_CALLS: Array<[string, (api: ModeratorApi) => Promise<unknown>]> = [
  ['publishEvent', (a) => a.publishEvent({ kind: 1985, content: 'x' })],
  ['publishLabel', (a) => a.publishLabel({ targetType: 'event', targetValue: 'e1', namespace: 'ns', labels: ['l'] })],
  ['publishLabelAndBan', (a) => a.publishLabelAndBan({ targetType: 'pubkey', targetValue: PK, namespace: 'ns', labels: ['l'], shouldBan: true })],
  ['markAsReviewed', (a) => a.markAsReviewed('event', 'e1', 'reviewed', 'c')],
  ['moderateAction', (a) => a.moderateAction({ action: 'hide_event', eventId: 'e1' })],
  ['deleteEvent', (a) => a.deleteEvent('e1', 'r', PK)],
  ['hideEvent', (a) => a.hideEvent('e1', 'r')],
  ['restoreEvent', (a) => a.restoreEvent('e1', 'r')],
  ['allowPubkey', (a) => a.allowPubkey(PK)],
  ['banPubkey', (a) => a.banPubkey(PK, 'r')],
  ['unbanPubkey', (a) => a.unbanPubkey(PK)],
  ['suspendPubkey', (a) => a.suspendPubkey(PK, 'r')],
  ['unsuspendPubkey', (a) => a.unsuspendPubkey(PK)],
  // Answers with the end date a real success carries; the table's generic answer has none.
  ['changeSuspensionEnd', (a) => {
    mockFetch.mockResolvedValueOnce({
      ok: true, status: 200, json: async () => ({ success: true, endsAt: '2026-11-21T00:00:00.000Z', decisionRecorded: true }),
    });
    return a.changeSuspensionEnd(PK, { value: 12, unit: 'hours' });
  }],
  ['logDecision', (a) => a.logDecision({ targetType: 'event', targetId: 'e1', action: 'x' })],
  ['closeTicket', (a) => a.closeTicket(55)],
  ['confirmAutoHide', (a) => a.confirmAutoHide({ eventId: 'e1' })],
  ['updateAgeReviewCase', (a) => a.updateAgeReviewCase('case-1', { state: 'x', expected_version: 1 })],
  ['bulkModerate', (a) => a.bulkModerate(PK, 'delete-all', 'r')],
  ['decideSexualQuarantine', (a) => a.decideSexualQuarantine('e1', { revision: 1, decision: 'restore', reason: 'r' })],
  // Opens a suspended author's quarantine snapshot, which the worker audits
  // against the verified login.
  ['getSexualQuarantineSnapshot', (a) => a.getSexualQuarantineSnapshot('e1')],
  // The suspended-content viewer: the worker refuses without a verified login
  // and records each view against it.
  ['viewSuspendedPost', (a) => a.viewSuspendedPost({ eventId: PK, surface: 'report' })],
  ['viewSuspendedAccount', (a) => a.viewSuspendedAccount({ pubkey: PK, surface: 'user' })],
  // Also /api/relay-rpc, which records the verified moderator: UserManagement
  // and DebugPanel call callRelayRpc directly for account actions.
  ['callRelayRpc', (a) => a.callRelayRpc('unbanpubkey', [PK])],
  ['banEvent', (a) => a.banEvent('e1', 'r')],
  ['allowEvent', (a) => a.allowEvent('e1')],
  // Writes that record no moderator still need the login once
  // REQUIRE_MODERATOR_LOGIN is on, or the worker refuses them.
  ['moderateMedia', (a) => a.moderateMedia('f'.repeat(64), 'SAFE', 'r')],
  ['deleteMedia', (a) => a.deleteMedia('f'.repeat(64), 'r')],
  ['unblockMedia', (a) => a.unblockMedia('f'.repeat(64), 'r')],
  ['deleteDecisions', (a) => a.deleteDecisions('e1', 'event')],
  ['updateAgeReviewConfig', (a) => a.updateAgeReviewConfig({ auto_delete_on_deny: true })],
  ['createMinorAccount', (a) => a.createMinorAccount('kid', 'Kid', 12, 'op-1')],
  ['submitAIDetection', (a) => a.submitAIDetection('https://v.example/x.mp4', 'f'.repeat(64), 'e1')],
];

const mockFetch = vi.fn();

function sentHeaders(): Array<Record<string, string>> {
  return mockFetch.mock.calls.map(([, init]) => (init as RequestInit).headers as Record<string, string>);
}

beforeEach(() => {
  mockFetch.mockReset();
  // One answer that satisfies every call in the table: success, a job id for
  // the bulk enqueue, and a result for the relay RPCs.
  mockFetch.mockImplementation(async () => ({
    ok: true,
    status: 200,
    json: async () => ({ success: true, jobId: 'job-1', result: [] }),
  }));
  vi.stubGlobal('fetch', mockFetch);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('useAdminApi attribution header', () => {
  it('asModerator(token).getSexualQuarantineSnapshot asks for the snapshot; the plain case read does not', async () => {
    const { result } = renderHook(() => useAdminApi());
    await result.current.asModerator(TOKEN).getSexualQuarantineSnapshot('e1');
    await result.current.getSexualQuarantineCase('e1');
    const urls = mockFetch.mock.calls.map(([url]) => String(url));
    expect(urls).toEqual([
      `${API_URL}/api/report-watcher/sexual-quarantine/e1?snapshot=1`,
      `${API_URL}/api/report-watcher/sexual-quarantine/e1`,
    ]);
    expect(sentHeaders()[1]).not.toHaveProperty(HEADER);
  });

  it('the viewer calls POST the request body to the audited endpoints', async () => {
    const { result } = renderHook(() => useAdminApi());
    const act = result.current.asModerator(TOKEN);
    await act.viewSuspendedPost({ eventId: PK, surface: 'report' });
    await act.viewSuspendedAccount({ pubkey: PK, surface: 'age-review', until: 5, untilId: PK });
    const calls = mockFetch.mock.calls.map(([url, init]) => [String(url), (init as RequestInit).method, JSON.parse((init as RequestInit).body as string)]);
    expect(calls).toEqual([
      [`${API_URL}/api/suspended-content/event`, 'POST', { eventId: PK, surface: 'report' }],
      [`${API_URL}/api/suspended-content/account`, 'POST', { pubkey: PK, surface: 'age-review', until: 5, untilId: PK }],
    ]);
  });

  it.each(ATTRIBUTION_CALLS)('asModerator(token).%s sends X-Divine-Login-Token', async (_name, invoke) => {
    const { result } = renderHook(() => useAdminApi());

    await invoke(result.current.asModerator(TOKEN));

    expect(mockFetch).toHaveBeenCalled();
    for (const headers of sentHeaders()) expect(headers[HEADER]).toBe(TOKEN);
  });

  // With no login bound, a call sends no header. buildAdminApi directly, because
  // the plain useAdminApi() no longer has these calls at all (see below).
  it.each(ATTRIBUTION_CALLS)('buildAdminApi with no token: %s sends no login header', async (_name, invoke) => {
    await invoke(buildAdminApi(API_URL, RELAY_URL));

    expect(mockFetch).toHaveBeenCalled();
    for (const headers of sentHeaders()) expect(headers).not.toHaveProperty(HEADER);
  });

  // An action has to take the login at the click to record a moderator, so the
  // plain api leaves every attribution call out, at runtime as well as in its
  // type. callRelayRpc stays for relay reads (list*, get*); relay writes,
  // RelaySettings' config changes included, go through asModerator.
  it.each(ATTRIBUTION_CALLS.filter(([name]) => name !== 'callRelayRpc'))(
    'the plain api has no %s', (name) => {
      const { result } = renderHook(() => useAdminApi());
      expect(result.current).not.toHaveProperty(name);
      expect(result.current.asModerator(TOKEN)).toHaveProperty(name);
    },
  );

  it('the plain api.callRelayRpc sends no login header', async () => {
    const { result } = renderHook(() => useAdminApi());

    await result.current.callRelayRpc('listbannedpubkeys');

    expect(mockFetch).toHaveBeenCalled();
    for (const headers of sentHeaders()) expect(headers).not.toHaveProperty(HEADER);
  });

  it('asModerator(undefined) sends no login header', async () => {
    const { result } = renderHook(() => useAdminApi());

    await result.current.asModerator(undefined).logDecision({ targetType: 'event', targetId: 'e1', action: 'x' });

    expect(sentHeaders()[0]).not.toHaveProperty(HEADER);
  });

  // The token is bound when asModerator is called, so it cannot change under
  // an action that already took it.
  it('binds the token given to asModerator, not a later one', async () => {
    const { result } = renderHook(() => useAdminApi());
    const first = result.current.asModerator('token-a');
    result.current.asModerator('token-b');

    await first.hideEvent('e1');

    expect(sentHeaders()[0][HEADER]).toBe('token-a');
  });
});

// The wrappers rewrite their argument lists by hand, so a new argument the wrapper
// forgets to forward passes tsc and every component test (they mock this hook).
// These run the real wrappers down to the request body.
describe('timed suspension arguments reach the request', () => {
  const sentBodies = () => mockFetch.mock.calls.map(([, init]) => (init as RequestInit).body as string);
  const sentUrls = () => mockFetch.mock.calls.map(([url]) => String(url));

  it('suspendPubkey forwards a duration', async () => {
    const { result } = renderHook(() => useAdminApi());
    await result.current.asModerator(TOKEN).suspendPubkey(PK, 'r', { value: 3, unit: 'days' });
    expect(JSON.parse(sentBodies()[0])).toEqual({
      method: 'suspendpubkey', params: [PK, 'r'], suspension: { duration: { value: 3, unit: 'days' } },
    });
  });

  // Both at once, so a wrapper that forwards the login but not the duration (or the reverse) fails.
  it('suspendPubkey sends the login token and the duration together', async () => {
    const { result } = renderHook(() => useAdminApi());
    await result.current.asModerator(TOKEN).suspendPubkey(PK, 'r', { value: 3, unit: 'days' });
    expect(sentHeaders()[0][HEADER]).toBe(TOKEN);
    expect(JSON.parse(sentBodies()[0]).suspension).toEqual({ duration: { value: 3, unit: 'days' } });
  });

  it('suspendPubkey forwards an explicit open end as duration null', async () => {
    const { result } = renderHook(() => useAdminApi());
    await result.current.asModerator(TOKEN).suspendPubkey(PK, 'r', null);
    expect(sentBodies()[0]).toBe(JSON.stringify({
      method: 'suspendpubkey', params: [PK, 'r'], suspension: { duration: null },
    }));
  });

  it('suspendPubkey with no duration argument sends no suspension key', async () => {
    const { result } = renderHook(() => useAdminApi());
    await result.current.asModerator(TOKEN).suspendPubkey(PK, 'r');
    expect(JSON.parse(sentBodies()[0])).not.toHaveProperty('suspension');
  });

  it('unbanPubkey forwards the suspension choice', async () => {
    const { result } = renderHook(() => useAdminApi());
    await result.current.asModerator(TOKEN).unbanPubkey(PK, 'end_now');
    expect(sentBodies()[0]).toBe(JSON.stringify({
      method: 'unbanpubkey', params: [PK], suspensionChoice: 'end_now',
    }));
  });

  it('unbanPubkey with no choice sends no suspensionChoice key', async () => {
    const { result } = renderHook(() => useAdminApi());
    await result.current.asModerator(TOKEN).unbanPubkey(PK);
    expect(sentBodies()[0]).toBe(JSON.stringify({ method: 'unbanpubkey', params: [PK] }));
  });

  it('changeSuspensionEnd posts the pubkey and duration to /api/suspensions/end', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true, status: 200,
      json: async () => ({ success: true, endsAt: '2026-11-21T00:00:00.000Z', decisionRecorded: true }),
    });
    const { result } = renderHook(() => useAdminApi());
    const out = await result.current.asModerator(TOKEN).changeSuspensionEnd(PK, { value: 12, unit: 'hours' });
    expect(sentUrls()[0]).toBe(`${API_URL}/api/suspensions/end`);
    expect(JSON.parse(sentBodies()[0])).toEqual({ pubkey: PK, duration: { value: 12, unit: 'hours' } });
    expect(out).toEqual({ endsAt: '2026-11-21T00:00:00.000Z', decisionRecorded: true });
  });

  it('changeSuspensionEnd rejects with the body code on a refusal', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false, status: 409, statusText: 'Conflict',
      json: async () => ({ success: false, error: 'This account is banned.', code: 'account_banned' }),
    });
    const { result } = renderHook(() => useAdminApi());
    const error = await result.current.asModerator(TOKEN)
      .changeSuspensionEnd(PK, { value: 1, unit: 'days' }).catch((e: unknown) => e) as ApiError;
    expect(error).toBeInstanceOf(ApiError);
    expect(error.code).toBe('account_banned');
    expect(error.statusCode).toBe(409);
  });

  it('the plain api lists timed suspensions with a GET to /api/suspensions', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true, status: 200,
      json: async () => ({ success: true, suspensions: [{ pubkey: PK, endsAt: null, status: 'active' }] }),
    });
    const { result } = renderHook(() => useAdminApi());
    const list = await result.current.listTimedSuspensions();
    expect(sentUrls()[0]).toBe(`${API_URL}/api/suspensions`);
    expect((mockFetch.mock.calls[0][1] as RequestInit).method).toBe('GET');
    expect(list).toEqual([{ pubkey: PK, endsAt: null, status: 'active' }]);
  });
});

// Type-level: tsc (run by `npm run test`) fails if any of these becomes
// reachable on the plain api again. Never called; it only has to type-check.
export function plainApiHasNoAttributionCalls(api: PlainAdminApi): void {
  // @ts-expect-error attribution calls go through asModerator(token)
  void api.decideSexualQuarantine;
  // @ts-expect-error attribution calls go through asModerator(token)
  void api.getSexualQuarantineSnapshot;
  // @ts-expect-error attribution calls go through asModerator(token)
  void api.viewSuspendedPost;
  // @ts-expect-error attribution calls go through asModerator(token)
  void api.viewSuspendedAccount;
  // @ts-expect-error attribution calls go through asModerator(token)
  void api.publishEvent;
  // @ts-expect-error attribution calls go through asModerator(token)
  void api.moderateAction;
  // @ts-expect-error attribution calls go through asModerator(token)
  void api.deleteEvent;
  // @ts-expect-error attribution calls go through asModerator(token)
  void api.hideEvent;
  // @ts-expect-error attribution calls go through asModerator(token)
  void api.restoreEvent;
  // @ts-expect-error attribution calls go through asModerator(token)
  void api.banPubkey;
  // @ts-expect-error attribution calls go through asModerator(token)
  void api.allowPubkey;
  // @ts-expect-error attribution calls go through asModerator(token)
  void api.banEvent;
  // @ts-expect-error attribution calls go through asModerator(token)
  void api.allowEvent;
  // @ts-expect-error attribution calls go through asModerator(token)
  void api.unbanPubkey;
  // @ts-expect-error attribution calls go through asModerator(token)
  void api.suspendPubkey;
  // @ts-expect-error attribution calls go through asModerator(token)
  void api.unsuspendPubkey;
  // @ts-expect-error attribution calls go through asModerator(token)
  void api.changeSuspensionEnd;
  // @ts-expect-error attribution calls go through asModerator(token)
  void api.publishLabel;
  // @ts-expect-error attribution calls go through asModerator(token)
  void api.publishLabelAndBan;
  // @ts-expect-error attribution calls go through asModerator(token)
  void api.markAsReviewed;
  // @ts-expect-error attribution calls go through asModerator(token)
  void api.logDecision;
  // @ts-expect-error attribution calls go through asModerator(token)
  void api.confirmAutoHide;
  // @ts-expect-error attribution calls go through asModerator(token)
  void api.updateAgeReviewCase;
  // @ts-expect-error attribution calls go through asModerator(token)
  void api.bulkModerate;
  // @ts-expect-error attribution calls go through asModerator(token)
  void api.closeTicket;
  // @ts-expect-error writes go through asModerator(token)
  void api.moderateMedia;
  // @ts-expect-error writes go through asModerator(token)
  void api.deleteMedia;
  // @ts-expect-error writes go through asModerator(token)
  void api.unblockMedia;
  // @ts-expect-error writes go through asModerator(token)
  void api.deleteDecisions;
  // @ts-expect-error writes go through asModerator(token)
  void api.updateAgeReviewConfig;
  // @ts-expect-error writes go through asModerator(token)
  void api.createMinorAccount;
  // @ts-expect-error writes go through asModerator(token)
  void api.submitAIDetection;
  // Reads stay, and so does callRelayRpc.
  void api.listBannedPubkeys;
  void api.callRelayRpc;
}
