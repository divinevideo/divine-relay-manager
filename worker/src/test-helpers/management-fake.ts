// ABOUTME: Test-only fake for the services an account-state change talks to: the relay's
// ABOUTME: NIP-86 management API, Keycast's user-status route, and moderation-service notify.
import { vi } from 'vitest';

export interface ManagementState {
  // Relay ban list, by pubkey exactly as sent.
  banned: Set<string>;
  // Relay suspended list: pubkey -> reason (null when none was given).
  suspended: Map<string, string | null>;
  // Keycast account status by pubkey. A pubkey not in the map has no Keycast
  // account (self-custody), and Keycast answers user_not_found for it.
  keycast: Map<string, string>;
  // Make one service fail. Keys are NIP-86 method names (answered with an RPC
  // error), or 'keycast_get', 'keycast_put', 'notify' (answered with a 500).
  fail?: Partial<Record<string, true>>;
  // Runs before the relay answers this NIP-86 method: a concurrent change
  // (a timer claim) landing while the relay call is in flight.
  before?: Partial<Record<string, () => Promise<void>>>;
  // The pubkey the moderator login check (`/api/nostr`) answers with.
  moderator?: string;
}

export interface RpcCall { method: string; params: unknown[] }
export interface KeycastPut { pubkey: string; status: string; actor?: string }
export type NotifyBody = { recipientPubkey: string; action: string; reason: string; endsAt?: string } & Record<string, unknown>;

export function emptyManagementState(): ManagementState {
  return { banned: new Set(), suspended: new Map(), keycast: new Map() };
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { 'Content-Type': 'application/json' },
});

// Spies on global fetch and answers by URL. Anything it does not recognise gets a
// 404, so no request can leave the test.
export function managementFake(state: ManagementState) {
  const rpcCalls: RpcCall[] = [];
  const keycastPuts: KeycastPut[] = [];
  const keycastGets: string[] = [];
  const notifies: NotifyBody[] = [];
  const alerts: string[] = [];

  const spy = vi.spyOn(globalThis, 'fetch').mockImplementation((async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = input instanceof Request ? input : new Request(String(input), init);
    const url = new URL(req.url);

    if (url.pathname === '/api/v1/notify') {
      notifies.push(await req.json() as NotifyBody);
      if (state.fail?.notify) return new Response('notify failed', { status: 500 });
      return json({ dm_sent: true });
    }

    if (url.pathname === '/api/nostr') {
      return state.moderator ? json({ result: state.moderator }) : new Response('unauthorized', { status: 401 });
    }

    // Slack incoming-webhook path.
    if (url.pathname.startsWith('/services/')) {
      alerts.push((await req.json() as { text: string }).text);
      return new Response('ok', { status: 200 });
    }

    const status = url.pathname.match(/^\/api\/admin\/users\/([^/]+)\/status$/);
    if (status) {
      const pubkey = status[1];
      if (req.method === 'GET') {
        keycastGets.push(pubkey);
        if (state.fail?.keycast_get) return new Response('keycast down', { status: 500 });
        const current = state.keycast.get(pubkey);
        return current === undefined ? json({ error: 'user not found' }, 404) : json({ pubkey, status: current });
      }
      const body = await req.json() as { status: string; actor?: string };
      keycastPuts.push({ pubkey, status: body.status, ...(body.actor && { actor: body.actor }) });
      if (state.fail?.keycast_put) return new Response('keycast down', { status: 500 });
      if (!state.keycast.has(pubkey)) return json({ error: 'user not found' }, 404);
      state.keycast.set(pubkey, body.status);
      return new Response('', { status: 200 });
    }

    if (req.headers.get('Content-Type') === 'application/nostr+json+rpc') {
      const { method, params = [] } = await req.json() as { method: string; params?: unknown[] };
      rpcCalls.push({ method, params });
      await state.before?.[method]?.();
      if (state.fail?.[method]) return json({ error: `${method} refused` });
      const pubkey = String(params[0] ?? '');
      switch (method) {
        case 'banpubkey': state.banned.add(pubkey); return json({ result: true });
        case 'unbanpubkey': state.banned.delete(pubkey); return json({ result: true });
        case 'suspendpubkey':
          state.suspended.set(pubkey, params[1] === undefined ? null : String(params[1]));
          return json({ result: true });
        case 'unsuspendpubkey': state.suspended.delete(pubkey); return json({ result: true });
        case 'listbannedpubkeys': return json({ result: [...state.banned].map(pk => ({ pubkey: pk })) });
        case 'listsuspendedpubkeys':
          return json({ result: [...state.suspended].map(([pk, reason]) => ({ pubkey: pk, ...(reason !== null && { reason }) })) });
        default: return json({ result: true });
      }
    }

    return new Response('not found', { status: 404 });
  }) as typeof fetch);

  // Calls that change account state on the relay (reads excluded).
  const relayWrites = () => rpcCalls.filter(c => !c.method.startsWith('list'));

  return { spy, state, rpcCalls, relayWrites, keycastPuts, keycastGets, notifies, alerts };
}
