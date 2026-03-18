# Funnelcake REST Reads Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace WebSocket Nostr queries with Funnelcake REST API calls for event and profile lookups in the report detail view, dramatically reducing report loading time.

**Architecture:** Worker proxy endpoints forward requests to Funnelcake's REST API (same host as relay, ClickHouse-backed). Frontend hooks try REST first, fall back to WebSocket on failure. Environment switching is handled by the worker, keeping the frontend environment-agnostic.

**Tech Stack:** Cloudflare Workers (worker proxy), React + TanStack Query (frontend hooks), Vitest (worker + frontend tests)

**Spec:** `docs/superpowers/specs/2026-03-15-funnelcake-rest-reads-design.md`

---

## File Structure

**Worker (new):**
- `worker/src/funnelcake-proxy.ts` -- URL derivation helper + proxy fetch logic
- `worker/src/funnelcake-proxy.test.ts` -- unit tests for URL derivation and proxy behavior

**Worker (modify):**
- `worker/src/index.ts` -- add two route handlers, import proxy module

**Frontend (new):**
- `src/lib/funnelcakeApi.ts` -- REST fetch functions for event and user endpoints
- `src/lib/funnelcakeApi.test.ts` -- unit tests for fetch functions

**Frontend (modify):**
- `src/hooks/useThread.ts` -- use REST for event fetches, WebSocket fallback
- `src/hooks/useAuthor.ts` -- use REST for profile fetches, WebSocket fallback

---

## Chunk 1: Worker proxy

### Task 1: URL derivation and proxy fetch module

**Files:**
- Create: `worker/src/funnelcake-proxy.ts`
- Create: `worker/src/funnelcake-proxy.test.ts`

- [ ] **Step 1: Write failing tests for URL derivation**

In `worker/src/funnelcake-proxy.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { deriveFunnelcakeApiUrl, proxyFunnelcakeRequest } from './funnelcake-proxy';

describe('deriveFunnelcakeApiUrl', () => {
  it('converts wss relay URL to https API URL', () => {
    expect(deriveFunnelcakeApiUrl('wss://relay.divine.video'))
      .toBe('https://relay.divine.video');
  });

  it('converts ws to http (local dev)', () => {
    expect(deriveFunnelcakeApiUrl('ws://localhost:4444'))
      .toBe('http://localhost:4444');
  });

  it('uses explicit override when provided', () => {
    expect(deriveFunnelcakeApiUrl('wss://relay.divine.video', 'https://custom-api.example.com'))
      .toBe('https://custom-api.example.com');
  });

  it('strips trailing slash from relay URL', () => {
    expect(deriveFunnelcakeApiUrl('wss://relay.divine.video/'))
      .toBe('https://relay.divine.video');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd worker && npx vitest run src/funnelcake-proxy.test.ts`
Expected: FAIL -- module not found

- [ ] **Step 3: Implement URL derivation**

In `worker/src/funnelcake-proxy.ts`:

```typescript
// ABOUTME: Funnelcake REST API proxy helpers
// ABOUTME: Derives API URL from relay WebSocket URL, proxies fetch requests

/**
 * Derive the Funnelcake REST API base URL from the relay WebSocket URL.
 * Funnelcake API runs on the same host as the relay.
 * Optional explicit override for environments where they diverge.
 */
export function deriveFunnelcakeApiUrl(relayUrl: string, explicitOverride?: string): string {
  if (explicitOverride) return explicitOverride;
  return relayUrl
    .replace(/^wss:/, 'https:')
    .replace(/^ws:/, 'http:')
    .replace(/\/$/, '');
}

/**
 * Proxy a request to Funnelcake's REST API.
 * Forwards the response body and cache headers.
 * Returns null on non-200 responses (caller handles fallback).
 */
export async function proxyFunnelcakeRequest(
  funnelcakeBaseUrl: string,
  path: string,
  corsHeaders: Record<string, string>,
): Promise<Response> {
  const url = `${funnelcakeBaseUrl}${path}`;
  const upstream = await fetch(url, {
    headers: { 'Accept': 'application/json' },
  });

  // Forward upstream response with cache headers preserved
  const responseHeaders: Record<string, string> = {
    'Content-Type': 'application/json',
    ...corsHeaders,
  };
  const cacheControl = upstream.headers.get('Cache-Control');
  if (cacheControl) {
    responseHeaders['Cache-Control'] = cacheControl;
  }

  return new Response(upstream.body, {
    status: upstream.status,
    headers: responseHeaders,
  });
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd worker && npx vitest run src/funnelcake-proxy.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: Write failing tests for proxy fetch**

Add to `worker/src/funnelcake-proxy.test.ts`:

```typescript
describe('proxyFunnelcakeRequest', () => {
  it('proxies a successful response with cache headers', async () => {
    // Mock global fetch
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url === 'https://relay.divine.video/api/event/abc123') {
        return new Response(JSON.stringify({ id: 'abc123', kind: 1 }), {
          status: 200,
          headers: {
            'Content-Type': 'application/json',
            'Cache-Control': 'public, max-age=300',
          },
        });
      }
      return new Response('Not found', { status: 404 });
    };

    try {
      const response = await proxyFunnelcakeRequest(
        'https://relay.divine.video',
        '/api/event/abc123',
        { 'Access-Control-Allow-Origin': '*' },
      );
      expect(response.status).toBe(200);
      expect(response.headers.get('Cache-Control')).toBe('public, max-age=300');
      expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*');
      const body = await response.json();
      expect(body.id).toBe('abc123');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('forwards 404 status from upstream', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => {
      return new Response(JSON.stringify({ error: 'Event not found' }), {
        status: 404,
        headers: { 'Cache-Control': 'no-store' },
      });
    };

    try {
      const response = await proxyFunnelcakeRequest(
        'https://relay.divine.video',
        '/api/event/nonexistent',
        {},
      );
      expect(response.status).toBe(404);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
```

- [ ] **Step 6: Run tests to verify they pass** (implementation already exists)

Run: `cd worker && npx vitest run src/funnelcake-proxy.test.ts`
Expected: PASS (6 tests)

- [ ] **Step 7: Commit**

```bash
git add worker/src/funnelcake-proxy.ts worker/src/funnelcake-proxy.test.ts
git commit -m "feat: add Funnelcake REST API proxy helpers with tests"
```

### Task 2: Wire proxy endpoints into worker router

**Files:**
- Modify: `worker/src/index.ts`

- [ ] **Step 1: Add FUNNELCAKE_API_URL to Env interface**

In `worker/src/index.ts`, add to the `Env` interface (around line 50):

```typescript
  FUNNELCAKE_API_URL?: string;  // Explicit Funnelcake API URL override (derived from RELAY_URL if not set)
```

- [ ] **Step 2: Add import for proxy module**

At the top of `worker/src/index.ts`, add:

```typescript
import { deriveFunnelcakeApiUrl, proxyFunnelcakeRequest } from './funnelcake-proxy';
```

- [ ] **Step 3: Add route handlers for both proxy endpoints**

In the fetch handler's routing section (after the existing `/api/*` routes, before the catch-all), add:

```typescript
      // Funnelcake REST API proxy — fast reads via ClickHouse
      if (path.startsWith('/api/funnelcake/')) {
        return handleFunnelcakeProxy(path, env, corsHeaders);
      }
```

Then add the handler function:

```typescript
async function handleFunnelcakeProxy(
  path: string,
  env: Env,
  corsHeaders: Record<string, string>,
): Promise<Response> {
  const funnelcakeUrl = deriveFunnelcakeApiUrl(
    env.RELAY_URL || 'wss://relay.divine.video',
    env.FUNNELCAKE_API_URL,
  );

  // /api/funnelcake/event/{id} → /api/event/{id}
  const eventMatch = path.match(/^\/api\/funnelcake\/event\/([a-f0-9]{64})$/i);
  if (eventMatch) {
    return proxyFunnelcakeRequest(funnelcakeUrl, `/api/event/${eventMatch[1]}`, corsHeaders);
  }

  // /api/funnelcake/users/{pubkey} → /api/users/{pubkey}
  const userMatch = path.match(/^\/api\/funnelcake\/users\/([a-f0-9]{64})$/i);
  if (userMatch) {
    return proxyFunnelcakeRequest(funnelcakeUrl, `/api/users/${userMatch[1]}`, corsHeaders);
  }

  return new Response(JSON.stringify({ error: 'Not found' }), {
    status: 404,
    headers: { 'Content-Type': 'application/json', ...corsHeaders },
  });
}
```

- [ ] **Step 4: Verify build passes**

Run: `cd worker && npx vitest run`
Expected: All existing tests pass, no import errors

- [ ] **Step 5: Commit**

```bash
git add worker/src/index.ts
git commit -m "feat: add Funnelcake REST API proxy routes for event and user lookups"
```

---

## Chunk 2: Frontend REST fetch functions

### Task 3: Funnelcake API client functions

**Files:**
- Create: `src/lib/funnelcakeApi.ts`
- Create: `src/lib/funnelcakeApi.test.ts`

- [ ] **Step 1: Write failing tests for event fetch**

In `src/lib/funnelcakeApi.test.ts`:

```typescript
import { describe, it, expect, vi, afterEach } from 'vitest';
import { fetchFunnelcakeEvent, fetchFunnelcakeUser } from './funnelcakeApi';

describe('fetchFunnelcakeEvent', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns a NostrEvent on success', async () => {
    const mockEvent = {
      id: 'abc123'.padEnd(64, '0'),
      pubkey: 'def456'.padEnd(64, '0'),
      kind: 1,
      created_at: 1700000000,
      tags: [],
      content: 'hello',
      sig: 'sig'.padEnd(128, '0'),
    };
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify(mockEvent), { status: 200 }),
    );

    const result = await fetchFunnelcakeEvent('https://api-relay-prod.divine.video', mockEvent.id);
    expect(result).toEqual(mockEvent);
    expect(globalThis.fetch).toHaveBeenCalledWith(
      `https://api-relay-prod.divine.video/api/funnelcake/event/${mockEvent.id}`,
      expect.objectContaining({ headers: expect.any(Object) }),
    );
  });

  it('returns null on 404', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response('', { status: 404 }),
    );
    const result = await fetchFunnelcakeEvent('https://api-relay-prod.divine.video', 'a'.repeat(64));
    expect(result).toBeNull();
  });

  it('returns null on network error', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(new Error('Network error'));
    const result = await fetchFunnelcakeEvent('https://api-relay-prod.divine.video', 'a'.repeat(64));
    expect(result).toBeNull();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/lib/funnelcakeApi.test.ts`
Expected: FAIL -- module not found

- [ ] **Step 3: Implement event fetch**

In `src/lib/funnelcakeApi.ts`:

```typescript
// ABOUTME: REST client for Funnelcake API proxy endpoints
// ABOUTME: Used by useThread and useAuthor for fast ClickHouse-backed reads

import type { NostrEvent } from '@nostrify/nostrify';
import { getApiHeaders } from './adminApi';

/**
 * Fetch a Nostr event by ID via the Funnelcake REST API proxy.
 * Returns null on any error (caller falls back to WebSocket).
 */
export async function fetchFunnelcakeEvent(
  apiUrl: string,
  eventId: string,
): Promise<NostrEvent | null> {
  try {
    const response = await fetch(`${apiUrl}/api/funnelcake/event/${eventId}`, {
      headers: getApiHeaders(''),
    });
    if (!response.ok) return null;
    return await response.json() as NostrEvent;
  } catch {
    return null;
  }
}

/**
 * Fetch user profile data via the Funnelcake REST API proxy.
 * Returns flattened metadata matching the shape useAuthor consumers expect.
 * Returns null on any error (caller falls back to WebSocket).
 */
export async function fetchFunnelcakeUser(
  apiUrl: string,
  pubkey: string,
): Promise<{ metadata: Record<string, string | undefined> } | null> {
  try {
    const response = await fetch(`${apiUrl}/api/funnelcake/users/${pubkey}`, {
      headers: getApiHeaders(''),
    });
    if (!response.ok) return null;
    const data = await response.json() as {
      profile?: Record<string, string | undefined>;
    };
    if (!data.profile) return null;
    return { metadata: data.profile };
  } catch {
    return null;
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/lib/funnelcakeApi.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 5: Write failing tests for user fetch**

Add to `src/lib/funnelcakeApi.test.ts`:

```typescript
describe('fetchFunnelcakeUser', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns flattened metadata on success', async () => {
    const mockUser = {
      pubkey: 'abc'.padEnd(64, '0'),
      profile: {
        name: 'alice',
        display_name: 'Alice',
        picture: 'https://example.com/pic.jpg',
        about: 'hello',
        nip05: 'alice@example.com',
      },
      social: { follower_count: 10 },
      stats: { video_count: 5 },
    };
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify(mockUser), { status: 200 }),
    );

    const result = await fetchFunnelcakeUser('https://api-relay-prod.divine.video', mockUser.pubkey);
    expect(result).toEqual({ metadata: mockUser.profile });
  });

  it('returns null when profile is missing', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ pubkey: 'a'.repeat(64) }), { status: 200 }),
    );
    const result = await fetchFunnelcakeUser('https://api-relay-prod.divine.video', 'a'.repeat(64));
    expect(result).toBeNull();
  });

  it('returns null on network error', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(new Error('fail'));
    const result = await fetchFunnelcakeUser('https://api-relay-prod.divine.video', 'a'.repeat(64));
    expect(result).toBeNull();
  });
});
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx vitest run src/lib/funnelcakeApi.test.ts`
Expected: PASS (6 tests)

- [ ] **Step 7: Commit**

```bash
git add src/lib/funnelcakeApi.ts src/lib/funnelcakeApi.test.ts
git commit -m "feat: add Funnelcake REST API client functions with tests"
```

---

## Chunk 3: Hook integration

### Task 4: Update useThread to use REST with WebSocket fallback

**Files:**
- Modify: `src/hooks/useThread.ts`

- [ ] **Step 1: Add apiUrl parameter and REST import**

Update `useThread` to accept an optional `apiUrl` parameter and import `fetchFunnelcakeEvent`:

```typescript
import { fetchFunnelcakeEvent } from '@/lib/funnelcakeApi';
```

Change the function signature:

```typescript
export function useThread(eventId: string | undefined, depth: number = 3, apiUrl?: string) {
```

Add `apiUrl` to the query key:

```typescript
    queryKey: ['thread', eventId, depth, apiUrl],
```

- [ ] **Step 2: Replace main event fetch with REST-first pattern**

Replace the main event fetch block (the `nostr.query([{ ids: [eventId] }])` call) with:

```typescript
      // Fetch the main event -- try REST first for speed, fall back to WebSocket
      let event: NostrEvent | undefined;
      if (apiUrl) {
        const restEvent = await fetchFunnelcakeEvent(apiUrl, eventId);
        if (restEvent) event = restEvent;
      }
      if (!event) {
        const [wsEvent] = await nostr.query(
          [{ ids: [eventId], limit: 1 }],
          { signal: combinedSignal }
        );
        event = wsEvent;
      }
```

- [ ] **Step 3: Replace ancestor fetch with REST-first pattern**

Replace the ancestor fetch section (the `Promise.all` block that queries by `ancestorIds`) with:

```typescript
      // Fetch ancestors -- try REST in parallel, fall back to WebSocket batch
      let ancestorEvents: NostrEvent[] = [];
      if (apiUrl && ancestorIds.length > 0) {
        const restResults = await Promise.all(
          ancestorIds.slice(0, depth).map(id => fetchFunnelcakeEvent(apiUrl, id))
        );
        ancestorEvents = restResults.filter((e): e is NostrEvent => e !== null);
      }
      // Fall back to WebSocket if REST didn't return all ancestors
      if (ancestorEvents.length < ancestorIds.slice(0, depth).length) {
        const missingIds = ancestorIds.slice(0, depth).filter(
          id => !ancestorEvents.find(e => e.id === id)
        );
        if (missingIds.length > 0) {
          const wsAncestors = await nostr.query(
            [{ ids: missingIds, limit: missingIds.length }],
            { signal: combinedSignal }
          );
          ancestorEvents = [...ancestorEvents, ...wsAncestors];
        }
      }

      // Replies stay on WebSocket for now (Phase 2)
      const replies = await nostr.query(
        [{ kinds: [1], '#e': [eventId], limit: 20 }],
        { signal: combinedSignal }
      );
```

Also update the ancestor ordering section to use `ancestorEvents` instead of the old variable name.

- [ ] **Step 4: Update repost original event fetch to use REST**

In the repost handling section, replace the `nostr.query` call for the original event:

```typescript
          if (!repostedEvent) {
            if (apiUrl) {
              repostedEvent = await fetchFunnelcakeEvent(apiUrl, originalEventTag[1]) || null;
            }
            if (!repostedEvent) {
              const [fetchedOriginal] = await nostr.query(
                [{ ids: [originalEventTag[1]], limit: 1 }],
                { signal: combinedSignal }
              );
              repostedEvent = fetchedOriginal || null;
            }
          }
```

- [ ] **Step 5: Verify build passes**

Run: `npm run build`
Expected: Build succeeds with no TypeScript errors

- [ ] **Step 6: Commit**

```bash
git add src/hooks/useThread.ts
git commit -m "feat: useThread uses Funnelcake REST API with WebSocket fallback"
```

### Task 5: Update useAuthor to use REST with WebSocket fallback

**Files:**
- Modify: `src/hooks/useAuthor.ts`

- [ ] **Step 1: Read current useAuthor implementation**

Read: `src/hooks/useAuthor.ts`

- [ ] **Step 2: Add apiUrl parameter and REST-first fetch**

Import the REST client:

```typescript
import { fetchFunnelcakeUser } from '@/lib/funnelcakeApi';
```

Change the function signature:

```typescript
export function useAuthor(pubkey: string | undefined, apiUrl?: string) {
```

Add `apiUrl` to the query key:

```typescript
    queryKey: ['author', pubkey, apiUrl],
```

Replace the `queryFn` body with REST-first pattern:

```typescript
    queryFn: async ({ signal }) => {
      if (!pubkey) return { event: undefined, metadata: undefined };

      // Try REST first for speed
      if (apiUrl) {
        const restResult = await fetchFunnelcakeUser(apiUrl, pubkey);
        if (restResult) {
          return { event: undefined, metadata: restResult.metadata };
        }
      }

      // Fall back to WebSocket
      const [event] = await nostr.query(
        [{ kinds: [0], authors: [pubkey!], limit: 1 }],
        { signal: AbortSignal.any([signal, AbortSignal.timeout(3000)]) },
      );

      if (!event) {
        return { event: undefined, metadata: undefined };
      }

      try {
        const metadata = JSON.parse(event.content);
        return { event, metadata };
      } catch {
        return { event };
      }
    },
```

- [ ] **Step 3: Verify build passes**

Run: `npm run build`
Expected: Build succeeds

- [ ] **Step 4: Commit**

```bash
git add src/hooks/useAuthor.ts
git commit -m "feat: useAuthor uses Funnelcake REST API with WebSocket fallback"
```

### Task 6: Pass apiUrl from consumers to hooks

**Files:**
- Modify: `src/hooks/useReportContext.ts` (passes apiUrl to useThread and useAuthor)
- Modify: `src/components/ThreadContext.tsx` (passes apiUrl to useAuthor in PostCard)
- Modify: `src/components/ThreadModal.tsx` (passes apiUrl to useAuthor)

- [ ] **Step 1: Update useReportContext to pass apiUrl**

`useReportContext` calls `useThread` and `useAuthor`. Add `apiUrl` parameter and pass it through:

```typescript
import { useAppContext } from '@/hooks/useAppContext';

export function useReportContext(report: NostrEvent | null) {
  const { config } = useAppContext();
  const apiUrl = config.apiUrl;
```

Then pass `apiUrl` as the third argument to `useThread(reportedEventId, 3, apiUrl)` and to any `useAuthor` calls.

- [ ] **Step 2: Update PostCard in ThreadContext to pass apiUrl**

`PostCard` calls `useAuthor(event.pubkey)`. It needs `apiUrl`. Add it as a prop:

```typescript
function PostCard({
  event,
  isReported = false,
  depth = 0,
  apiUrl,
}: {
  event: NostrEvent;
  isReported?: boolean;
  depth?: number;
  apiUrl?: string;
}) {
  const author = useAuthor(event.pubkey, apiUrl);
```

Update both `<PostCard>` call sites in `ThreadContext` to pass `apiUrl`:

```typescript
export function ThreadContext({ ancestors, reportedEvent, onViewFullThread, isLoading, apiUrl }: ThreadContextProps) {
```

Add `apiUrl?: string` to `ThreadContextProps`.

- [ ] **Step 3: Update ThreadModal PostCard to pass apiUrl**

Same pattern as ThreadContext -- add `apiUrl` prop, pass to `useAuthor`.

- [ ] **Step 4: Update ReportDetail to pass apiUrl to ThreadContext**

In `ReportDetail.tsx`, where `<ThreadContext>` is rendered, add the `apiUrl` prop from `useAppContext`.

- [ ] **Step 5: Verify build passes**

Run: `npm run build`
Expected: Build succeeds

- [ ] **Step 6: Commit**

```bash
git add src/hooks/useReportContext.ts src/components/ThreadContext.tsx src/components/ThreadModal.tsx src/components/ReportDetail.tsx
git commit -m "feat: wire apiUrl through to useThread and useAuthor consumers"
```

---

## Chunk 4: Benchmarking, branch setup, and local testing

### Task 7: Add performance measurement

**Files:**
- Modify: `src/components/ReportDetail.tsx`

The goal is to measure time from "report selected" to "all context loaded" so we can compare WebSocket-only (before) vs REST-first (after) with the same local data.

- [ ] **Step 1: Add perf timing to ReportDetail**

Near the top of the `ReportDetail` component (after the `useReportContext` call), add:

```typescript
// Temporary perf measurement — remove after benchmarking
const perfStart = useRef(Date.now());
useEffect(() => {
  // Reset timer when report changes
  perfStart.current = Date.now();
}, [report?.id]);

useEffect(() => {
  if (report?.id && !context.isLoading) {
    const elapsed = Date.now() - perfStart.current;
    console.log(`[perf] Report ${report.id.slice(0, 12)}... context loaded in ${elapsed}ms`);
  }
}, [report?.id, context.isLoading]);
```

Add `useRef` to the React imports if not already present.

- [ ] **Step 2: Collect baseline measurements (WebSocket-only)**

Before switching to the `feat/funnelcake-rest-reads` branch, run the local stack on the current branch (`feature/csam-auto-hide`) with the perf measurement. Open 3-5 different reports and record the console timings. These are the baseline numbers.

Save results to a scratch note or `.context/` file, e.g.:
```
Baseline (WebSocket-only):
  Report abc123... context loaded in 3420ms
  Report def456... context loaded in 2890ms
  Report ghi789... context loaded in 4100ms
```

- [ ] **Step 3: Collect REST measurements**

After implementing Tasks 1-6 on the `feat/funnelcake-rest-reads` branch, run the same local stack with Funnelcake REST enabled. Open the same reports and record timings.

```
REST-first:
  Report abc123... context loaded in 340ms
  Report def456... context loaded in 280ms
  Report ghi789... context loaded in 410ms
```

Compare. The REST path should be roughly an order of magnitude faster for event and profile fetches.

- [ ] **Step 4: Remove perf measurement before PR**

Remove the `useRef`/`useEffect` timing code from `ReportDetail.tsx`. It's temporary benchmarking, not permanent instrumentation.

- [ ] **Step 5: Commit removal**

```bash
git add src/components/ReportDetail.tsx
git commit -m "chore: remove temporary perf measurement"
```

### Task 8: Create branch and verify

- [ ] **Step 1: Create feature branch from main**

```bash
cd ~/code/divine-relay-manager
git checkout main
git checkout -b feat/funnelcake-rest-reads
```

Note: Implementation should be done on this branch. All commits from Tasks 1-6 land here.

- [ ] **Step 2: After all implementation, run full test suite**

```bash
cd worker && npx vitest run
cd .. && npx vitest run
npm run build
```

Expected: All tests pass, build succeeds.

### Task 9: Local functional testing

- [ ] **Step 1: Start local Funnelcake relay**

```bash
cd ~/code/divine-relay-test
./scripts/setup-cluster.sh
./scripts/relays/setup-funnelcake.sh
```

Relay at `ws://localhost:4444`, API at `http://localhost:3333`

- [ ] **Step 2: Verify Funnelcake REST API is accessible locally**

```bash
curl -s http://localhost:3333/health
curl -s http://localhost:3333/api/stats
```

Expected: JSON responses. If `/api/stats` returns 401, `API_TOKEN` is set and we need to configure it in `.dev.vars`.

- [ ] **Step 3: Start worker, Caddy, and Vite (per local-dev-setup memory)**

```bash
# Terminal 1: Caddy
cd ~/code/divine-relay-manager/.certs && caddy run --config Caddyfile

# Terminal 2: Wrangler (add FUNNELCAKE_API_URL to .dev.vars if Funnelcake API is on a different port)
cd ~/code/divine-relay-manager/worker && npx wrangler dev

# Terminal 3: Vite
cd ~/code/divine-relay-manager && npx vite --port 8080
```

Add to `worker/.dev.vars` if needed:
```
FUNNELCAKE_API_URL=http://localhost:3333
```

- [ ] **Step 4: Seed test data**

Use existing seed scripts or `nak` to publish a kind 1984 report against a known event to the local relay.

- [ ] **Step 5: Verify REST proxy in browser**

Open `https://localhost:8080`, navigate to Reports. Open a report. In the browser Network tab, verify:
- Requests to `/api/funnelcake/event/{id}` return 200 with event JSON
- Requests to `/api/funnelcake/users/{pubkey}` return 200 with user data
- No WebSocket event/profile queries for the same data (only replies still use WebSocket)

Also check `wrangler tail` or wrangler dev console for proxy logs.

- [ ] **Step 6: Test WebSocket fallback**

Stop the Funnelcake API (or set `FUNNELCAKE_API_URL` to a bad URL in `.dev.vars`). Reload the report. Verify:
- Report still loads (slower, via WebSocket)
- Console shows fallback warnings (not errors)
- No UI errors or blank content

- [ ] **Step 7: Teardown**

```bash
cd ~/code/divine-relay-test && ./scripts/teardown-cluster.sh
pkill -f "caddy run"
```
