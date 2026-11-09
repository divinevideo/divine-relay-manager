// Test-only: make miniflare 4 reuse its connections to the local workerd
// (issue #349).
//
// D1 tests call `mf.getD1Database()` and run queries from Node. Each query is
// an HTTP request to workerd. The async calls D1 tests make go through the
// undici `Pool` miniflare keeps on the main thread for the runtime, and
// miniflare 4 sets `reset: true` on every one of those requests, so undici
// sends `connection: close` and opens a new TCP connection per query.
// (miniflare's synchronous proxy path uses a separate Pool in a worker thread.
// It never sets `reset`, so it already reuses connections, and this file does
// not patch it.) Our side closes each one, which leaves its ephemeral port in
// TIME_WAIT for 30 s on macOS. A full `npm run test:d1` ran ~16,000 queries in
// that window, close to the whole macOS port range (49152-65535), and later
// queries failed to connect with EADDRNOTAVAIL. Linux CI passes, most likely
// because Linux has a bigger port range and, by default, reuses TIME_WAIT
// ports for loopback connections.
//
// The fix is upstream as cloudflare/workers-sdk#15781 (2026-10-05). It ships
// only in miniflare 5, which is still pre-release, while wrangler and
// vitest-pool-workers here pin miniflare 4. This file applies two of the
// upstream changes:
//   - `reset: false`, so connections are reused for every method;
//   - 1 s keep-alive, so idle sockets close on our side before workerd's 5 s
//     idle timeout can close one under a request.
// Upstream also sets `idempotent: false`, so a request is never pipelined
// behind another. undici 7 reads that flag only when a connection already has
// a request in flight, and with the default pipelining of 1 a busy connection
// takes no second request anyway, so it changes nothing here and is left out.
//
// miniflare creates the runtime pool with `new undici.Pool(...)` and reads
// `Pool` from undici's exports at that moment, so replacing the export here,
// before any test creates a Miniflare, changes the pools it creates.
// test/miniflare-keepalive.d1.test.ts fails if this stops taking effect.
//
// TODO(#369): delete this file and its `setupFiles` entry once the worker's
// miniflare includes cloudflare/workers-sdk#15781 (miniflare 5).
import { createRequire } from 'node:module';
import type { Dispatcher } from 'undici';

// Take undici from miniflare's own resolution path, so this patches the exact
// module instance miniflare uses rather than a different copy.
const require = createRequire(import.meta.url);
const miniflareRequire = createRequire(require.resolve('miniflare'));
const undici = miniflareRequire('undici') as typeof import('undici');

const RUNTIME_KEEP_ALIVE_MS = 1_000;
const PATCHED = Symbol.for('divine.test.miniflareKeepAlivePool');

function isLoopbackHttp(origin: unknown): boolean {
  try {
    const url = new URL(String(origin));
    return url.protocol === 'http:' && (url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '[::1]');
  } catch {
    return false;
  }
}

type UndiciWithMarker = typeof undici & { [PATCHED]?: true };

if (!(undici as UndiciWithMarker)[PATCHED]) {
  const OriginalPool = undici.Pool;

  class RuntimeKeepAlivePool extends OriginalPool {
    readonly #runtime: boolean;

    constructor(origin: ConstructorParameters<typeof OriginalPool>[0], options?: ConstructorParameters<typeof OriginalPool>[1]) {
      const runtime = isLoopbackHttp(origin);
      super(origin, runtime
        ? { ...options, keepAliveTimeout: RUNTIME_KEEP_ALIVE_MS, keepAliveMaxTimeout: RUNTIME_KEEP_ALIVE_MS }
        : options);
      this.#runtime = runtime;
    }

    dispatch(options: Dispatcher.DispatchOptions, handler: Dispatcher.DispatchHandler): boolean {
      // On the runtime pool, `reset: true` comes only from miniflare's
      // DispatchFetchDispatcher, which sets it on every request. Requests
      // without it pass through unchanged.
      if (this.#runtime && options.reset === true) {
        return super.dispatch({ ...options, reset: false }, handler);
      }
      return super.dispatch(options, handler);
    }
  }

  (undici as { Pool: typeof OriginalPool }).Pool = RuntimeKeepAlivePool;
  (undici as UndiciWithMarker)[PATCHED] = true;
}
