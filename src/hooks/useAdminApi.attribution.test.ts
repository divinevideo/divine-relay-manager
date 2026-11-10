// ABOUTME: Pins that every attribution call made through asModerator(token) sends
// ABOUTME: the X-Divine-Login-Token header, and the plain useAdminApi() has none of them (#178).
import { renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildAdminApi, useAdminApi, type ModeratorApi, type PlainAdminApi } from './useAdminApi';

// The worker records the moderator it verifies from this header, and nothing
// else. Each useAdminApi wrapper rewrites its argument list by hand, so a
// wrapper that forgets to pass `{ loginToken }` on leaves that action
// unattributed while tsc and the component tests (which mock this hook) stay
// green. This table runs the REAL wrappers over the REAL adminApi down to fetch.
// A new attribution function belongs in it.

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
  ['logDecision', (a) => a.logDecision({ targetType: 'event', targetId: 'e1', action: 'x' })],
  ['closeTicket', (a) => a.closeTicket(55)],
  ['confirmAutoHide', (a) => a.confirmAutoHide({ eventId: 'e1' })],
  ['updateAgeReviewCase', (a) => a.updateAgeReviewCase('case-1', { state: 'x', expected_version: 1 })],
  ['bulkModerate', (a) => a.bulkModerate(PK, 'delete-all', 'r')],
  ['decideSexualQuarantine', (a) => a.decideSexualQuarantine('e1', { revision: 1, decision: 'restore', reason: 'r' })],
  // Opens a suspended author's quarantine snapshot, which the worker audits
  // against the verified login.
  ['getSexualQuarantineSnapshot', (a) => a.getSexualQuarantineSnapshot('e1')],
  // Also /api/relay-rpc, which records the verified moderator: UserManagement
  // and DebugPanel call callRelayRpc directly for account actions.
  ['callRelayRpc', (a) => a.callRelayRpc('unbanpubkey', [PK])],
  ['banEvent', (a) => a.banEvent('e1', 'r')],
  ['allowEvent', (a) => a.allowEvent('e1')],
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
  // type. callRelayRpc stays for reads (RelaySettings' relay-config methods).
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

// Type-level: tsc (run by `npm run test`) fails if any of these becomes
// reachable on the plain api again. Never called; it only has to type-check.
export function plainApiHasNoAttributionCalls(api: PlainAdminApi): void {
  // @ts-expect-error attribution calls go through asModerator(token)
  void api.decideSexualQuarantine;
  // @ts-expect-error attribution calls go through asModerator(token)
  void api.getSexualQuarantineSnapshot;
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
  // Reads stay, and so does callRelayRpc.
  void api.listBannedPubkeys;
  void api.callRelayRpc;
}
