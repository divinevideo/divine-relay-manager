// ABOUTME: Pins that every attribution call made through asModerator(token) sends
// ABOUTME: the X-Divine-Login-Token header, and the plain api sends none (#178).
import { renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAdminApi } from './useAdminApi';

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
  useAppContext: () => ({ config: { apiUrl: API_URL, relayUrl: 'wss://relay.example' } }),
}));

type Api = ReturnType<typeof useAdminApi>;
type Scoped = Omit<Api, 'asModerator'>;

const ATTRIBUTION_CALLS: Array<[string, (api: Scoped) => Promise<unknown>]> = [
  ['publishEvent', (a) => a.publishEvent({ kind: 1, content: 'x' })],
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
  it.each(ATTRIBUTION_CALLS)('asModerator(token).%s sends X-Divine-Login-Token', async (_name, invoke) => {
    const { result } = renderHook(() => useAdminApi());

    await invoke(result.current.asModerator(TOKEN));

    expect(mockFetch).toHaveBeenCalled();
    for (const headers of sentHeaders()) expect(headers[HEADER]).toBe(TOKEN);
  });

  it.each(ATTRIBUTION_CALLS)('the plain api.%s sends no login header', async (_name, invoke) => {
    const { result } = renderHook(() => useAdminApi());

    await invoke(result.current);

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
