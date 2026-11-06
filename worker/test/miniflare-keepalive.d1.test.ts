// Guards the keep-alive shim in test/setup/miniflare-keepalive.ts (issue #349).
//
// Every D1 call a test makes from Node goes over HTTP to the local workerd.
// Stock miniflare 4 closes that connection after each call, so each call costs
// an ephemeral port that sits in TIME_WAIT for 30 s on macOS. A full
// `npm run test:d1` made ~16,000 of them and ran out of ports. These tests
// fail if the shim stops reusing connections, for example after a miniflare
// upgrade changes the internals it relies on.
import { subscribe, unsubscribe } from 'node:diagnostics_channel';
import { Miniflare } from 'miniflare';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

let mf: Miniflare;
let DB: D1Database;

beforeAll(async () => {
  mf = new Miniflare({
    modules: true,
    script: 'export default { fetch() { return new Response("ok"); } };',
    compatibilityDate: '2024-12-01',
    d1Databases: ['DB'],
  });
  DB = (await mf.getD1Database('DB')) as unknown as D1Database;
  await DB.prepare('CREATE TABLE t (x INTEGER)').run();
});
afterAll(async () => { await mf?.dispose(); });

// Counts new TCP connections undici opens while `body` runs.
async function countConnections(body: () => Promise<void>): Promise<number> {
  let connections = 0;
  const onConnected = () => { connections++; };
  subscribe('undici:client:connected', onConnected);
  try {
    await body();
  } finally {
    unsubscribe('undici:client:connected', onConnected);
  }
  return connections;
}

describe('miniflare runtime connections (#349)', () => {
  it('reuses connections across sequential D1 calls instead of opening one per call', async () => {
    const connections = await countConnections(async () => {
      for (let i = 0; i < 200; i++) {
        await DB.prepare('INSERT INTO t (x) VALUES (?)').bind(i).run();
        await DB.prepare('SELECT x FROM t WHERE x = ?').bind(i).first();
      }
    });
    // 400 calls. Without the shim this is 400 or more. With it, a quiet run
    // opens 1, but a loaded full `npm run test:d1` once opened 4 (cause not
    // traced; a stall past the 1 s idle close would do it). The bound leaves
    // room for that while still failing if connections stop being reused.
    expect(connections).toBeLessThanOrEqual(20);
    const row = await DB.prepare('SELECT COUNT(*) AS n FROM t').first<{ n: number }>();
    expect(row?.n).toBe(200);
  });

  it('keeps working on the reused connection after a D1 call fails', async () => {
    const connections = await countConnections(async () => {
      await expect(DB.prepare('SELECT * FROM no_such_table').all()).rejects.toThrow(/no such table/);
      for (let i = 0; i < 50; i++) {
        const row = await DB.prepare('SELECT ? AS n').bind(i).first<{ n: number }>();
        expect(row?.n).toBe(i);
      }
    });
    // 51 calls; without the shim this is 51 or more.
    expect(connections).toBeLessThanOrEqual(10);
  });

  it('closes idle connections itself, before workerd can close them under a reused request', async () => {
    // workerd drops idle connections after about 5 s. If undici kept a socket
    // that long, a call could be written to a socket workerd is closing and
    // fail. The shim closes idle sockets after 1 s.
    //
    // This uses its own Miniflare and plain dispatchFetch() calls, with every
    // response body read and no D1 proxies. On the shared instance above,
    // miniflare can send background requests when garbage collection frees proxy
    // objects from earlier calls. One landing near the end of the idle wait
    // keeps a socket open, and the check below would fail with a working shim.
    // Sockets are filtered to this instance's port so the shared instance's
    // traffic can't count either way.
    const fresh = new Miniflare({
      modules: true,
      script: 'export default { fetch() { return new Response("ok"); } };',
      compatibilityDate: '2024-12-01',
    });
    try {
      const url = await fresh.ready;
      const port = Number(url.port);
      const call = async () => {
        const res = await fresh.dispatchFetch(url);
        expect(await res.text()).toBe('ok');
      };
      const sockets: Array<{ destroyed: boolean; remotePort?: number }> = [];
      const onConnected = ({ socket }: { socket: { destroyed: boolean; remotePort?: number } }) => {
        if (socket.remotePort === port) sockets.push(socket);
      };

      // Open a connection, then leave it idle well past the 1 s close.
      await call();
      await new Promise((resolve) => setTimeout(resolve, 2_500));
      subscribe('undici:client:connected', onConnected as (message: unknown) => void);
      try {
        await call();
      } finally {
        unsubscribe('undici:client:connected', onConnected as (message: unknown) => void);
      }
      // This is the idle-close check. The first call's socket should have
      // closed during the wait, so this call must open a new one. If none
      // opened, it reused a socket that outlived 2.5 s idle.
      expect(
        sockets.length,
        'no new connection: an earlier socket outlived 2.5 s idle, so idle sockets are not closing at 1 s',
      ).toBeGreaterThanOrEqual(1);
      // The socket this call opened must also close within 2.5 s of going idle.
      await new Promise((resolve) => setTimeout(resolve, 2_500));
      expect(
        sockets.every((socket) => socket.destroyed),
        'a socket opened by this call was still open after 2.5 s idle',
      ).toBe(true);
      // A fresh connection works after the idle close.
      await call();
    } finally {
      await fresh.dispose();
    }
  });
});
