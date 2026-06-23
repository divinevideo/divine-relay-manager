// END-TO-END: relay-manager's REAL NIP-86 client (suspendPubkey/unsuspendPubkey/
// banPubkey) against a LIVE funnelcake (cake relay + funnel management) backed by
// real ClickHouse. Proves the downstream effect C1/C9 depend on:
//   - suspendpubkey actually HIDES the user's existing events at the relay (C1)
//   - banpubkey actually purges/hides them (C9)
// This is the cross-system validation that worker-only tests can't give.
//
// Prereqs (started out-of-band):
//   cake   :7777  (BIND_ADDR=127.0.0.1:7777, CLICKHOUSE_URL=...:18123)
//   funnel :8080  (ADMIN_PUBKEYS=<pubkey of TEST_NSEC>, RELAY_URL=http://127.0.0.1:8080)
import { describe, it, expect } from 'vitest';
import { generateSecretKey, getPublicKey, finalizeEvent } from 'nostr-tools/pure';
import { suspendPubkey, banPubkey, type Nip86Env } from '../src/nip86';

const CAKE_WS = 'ws://127.0.0.1:7777';
// Admin nsec whose pubkey is funnel's ADMIN_PUBKEYS (same key as nip86.test.ts).
const TEST_NSEC = 'nsec1vl029mgpspedva04g90vltkh6fvh240zqtv9k0t9af8935ke9laqsnlfe5';
const env = { NOSTR_NSEC: TEST_NSEC, RELAY_URL: 'http://127.0.0.1:8080' } as Nip86Env;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function publish(signed: object): Promise<void> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(CAKE_WS);
    const timer = setTimeout(() => { ws.close(); reject(new Error('publish timeout')); }, 8000);
    ws.onopen = () => ws.send(JSON.stringify(['EVENT', signed]));
    ws.onmessage = (e) => {
      const msg = JSON.parse(e.data as string);
      if (msg[0] === 'OK') {
        clearTimeout(timer); ws.close();
        if (msg[2]) resolve(); else reject(new Error(`relay rejected EVENT: ${msg[3]}`));
      }
    };
    ws.onerror = () => { clearTimeout(timer); reject(new Error('ws error (publish)')); };
  });
}

function reqAuthorIds(pubkey: string): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(CAKE_WS);
    const ids: string[] = [];
    const sub = `s${Math.floor(performance.now())}`;
    const timer = setTimeout(() => { ws.close(); reject(new Error('req timeout')); }, 8000);
    ws.onopen = () => ws.send(JSON.stringify(['REQ', sub, { authors: [pubkey], kinds: [1] }]));
    ws.onmessage = (e) => {
      const msg = JSON.parse(e.data as string);
      if (msg[0] === 'EVENT' && msg[1] === sub) ids.push(msg[2].id);
      else if (msg[0] === 'EOSE' && msg[1] === sub) { clearTimeout(timer); ws.close(); resolve(ids); }
    };
    ws.onerror = () => { clearTimeout(timer); reject(new Error('ws error (req)')); };
  });
}

// Poll until predicate holds (relay ingest + MV are async/batched).
async function waitFor(fn: () => Promise<boolean>, label: string, ms = 12000) {
  const start = performance.now();
  while (performance.now() - start < ms) {
    if (await fn()) return;
    await sleep(500);
  }
  throw new Error(`timeout waiting for: ${label}`);
}

async function makeAuthorWithEvent() {
  const sk = generateSecretKey();
  const pk = getPublicKey(sk);
  const ev = finalizeEvent(
    { kind: 1, content: `age-review e2e ${pk.slice(0, 8)}`, tags: [], created_at: Math.floor(Date.now() / 1000) },
    sk,
  );
  await publish(ev);
  await waitFor(async () => (await reqAuthorIds(pk)).includes(ev.id), `event ${ev.id.slice(0, 8)} visible`);
  return { pk, id: ev.id };
}

describe('C1/C9 e2e: relay-manager NIP-86 -> live funnelcake', () => {
  it('C1: suspendPubkey hides the author\'s existing events at the relay', async () => {
    const { pk, id } = await makeAuthorWithEvent();
    expect((await reqAuthorIds(pk))).toContain(id); // visible before

    const res = await suspendPubkey(pk, 'age_review', env);
    expect(res.success).toBe(true); // funnel accepted the real NIP-98 request

    await waitFor(async () => !(await reqAuthorIds(pk)).includes(id), 'event hidden after suspend');
    expect((await reqAuthorIds(pk))).not.toContain(id); // hidden after
  });

  it('C9: banPubkey hides/purges the author\'s events at the relay', async () => {
    const { pk, id } = await makeAuthorWithEvent();
    expect((await reqAuthorIds(pk))).toContain(id);

    const res = await banPubkey(pk, 'age_review_denied', env);
    expect(res.success).toBe(true);

    await waitFor(async () => !(await reqAuthorIds(pk)).includes(id), 'event gone after ban');
    expect((await reqAuthorIds(pk))).not.toContain(id);
  });
});
