# Reports Resolution-State Completeness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop the reports queue presenting already-handled targets as unhandled when its four resolution sources are missing, errored, or silently truncated.

**Architecture:** The queue hides handled work by subtracting `resolvedTargets` from the list, so an unavailable source makes the queue bigger and wrong rather than smaller and safe. Frontend: collapse the four independently-patched queries into one source descriptor, block a cold render until every gating source has settled, banner a warm failure while the stale set keeps filtering, and offer an explicit unfiltered-view override so a moderator is never locked out. Worker: both capped endpoints report whether they truncated and how far back they reach.

**Tech Stack:** React 18 + TypeScript + TanStack Query 5 (frontend), Cloudflare Workers + D1 (worker), Vitest + Testing Library (tests).

**Spec:** `docs/superpowers/specs/2026-08-05-reports-resolution-state-completeness-design.md`

## Global Constraints

- Branch `fix/221-resolution-state-completeness`, cut from `origin/main` at b0af9bf. Not stacked on PR #186; rebase once #186 lands.
- This repo is PUBLIC. No pubkeys, report ids, npubs, or account identifiers from production in commits, PR bodies, comments, or test fixtures. Test fixtures use repeated-character hex (`'a'.repeat(64)`), matching `src/components/Reports.test.tsx`.
- No `Co-Authored-By` lines in commits. No em dashes in PR or commit prose.
- D1 schema is runtime `ensureSchema`. NEVER run `wrangler d1 migrations apply`.
- Four validation gates, all of which must pass and any of which can be green while another is red:
  - `npm run test` (tsc app + eslint + vitest + build)
  - `cd worker && npm run typecheck`
  - `cd worker && npx vitest run` (excludes `*.d1.test.ts` and `*.e2e.test.ts`)
  - `cd worker && npm run test:d1`
- `moderation_decisions.created_at` is **TEXT** (`CURRENT_TIMESTAMP`, UTC, `YYYY-MM-DD HH:MM:SS`). Nostr `created_at` is **unix seconds**. `adminApi` normalizes both to epoch milliseconds.
- Worker and Pages deploy separately, so the frontend must tolerate a worker that does not yet send `truncated` / `oldest_covered`: absent means `truncated: false`, `oldestCovered: null`.
- Nothing is pushed and no PR is opened until Matt approves the PR body.

---

## File Structure

**Worker**
- `worker/src/index.ts` — `handleGetAllDecisions` (~line 1336) and the `/api/resolution-labels` route (~line 537) gain truncation reporting.
- `worker/src/index.test.ts` — route-level truncation tests with a stub D1 and a stubbed relay.
- `worker/test/decisions-truncation.d1.test.ts` (new) — real Miniflare D1 proving the cap and `oldest_covered` against >1000 real rows.

**Client API layer**
- `src/lib/adminApi.ts` — `getAllDecisions` and `fetchResolutionLabels` return `TruncatableResult<T>` instead of a bare array; new exported `TruncatableResult` type and `parseOldestCovered` helper.
- `src/lib/adminApi.test.ts` — shape and normalization tests.
- `src/components/DebugPanel.tsx:179` — call-site update.

**Reports UI**
- `src/components/Reports.tsx` — source descriptor, gate, blocked pane with override, warm banners, truncation banner.
- `src/components/ResolutionStateNotice.tsx` (new) — the blocked pane and the banner presentations, so `Reports.tsx` holds the policy and this file holds the copy and markup.
- `src/components/Reports.resolution-state.test.tsx` (new) — all control/cold/warm/negative tests for this behavior. Kept out of `Reports.test.tsx` because that file's global `vi.mock` of `ReportDetail` is scoped to it and its fixtures serve #158.
- `src/test/TestApp.tsx` — `retryDelay: 0`.

---

## Task 1: Worker reports truncation on /api/decisions

**Files:**
- Modify: `worker/src/index.ts:1336-1370` (`handleGetAllDecisions`)
- Test: `worker/src/index.test.ts`, `worker/test/decisions-truncation.d1.test.ts` (create)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `GET /api/decisions` responds `{ success: true, decisions: ModerationDecisionRow[], truncated: boolean, oldest_covered: string | null }`. `decisions` is at most 1000 rows, newest first. `oldest_covered` is the `created_at` TEXT of the last returned row, or `null` when there are no rows. Task 3 consumes this.

- [ ] **Step 1: Write the failing route test**

Append to `worker/src/index.test.ts`:

```ts
describe('GET /api/decisions truncation reporting (#221)', () => {
  function makeDecisionsEnv(rowCount: number) {
    const rows = Array.from({ length: rowCount }, (_, i) => ({
      id: rowCount - i,
      target_type: 'pubkey',
      target_id: 'a'.repeat(64),
      action: 'dismissed',
      // Newest first, one second apart, so the oldest returned row is predictable.
      created_at: `2026-06-${String(14 + Math.floor(i / 100)).padStart(2, '0')} 00:00:${String(i % 60).padStart(2, '0')}`,
    }));
    return {
      ALLOWED_ORIGINS: 'https://app.divine.video',
      RELAY_URL: 'wss://relay.divine.video',
      ADMIN_API_KEY: 'test-admin-key',
      DB: {
        prepare: (_sql: string) => ({
          bind: (limit: number) => ({
            all: async () => ({ results: rows.slice(0, limit) }),
          }),
          run: async () => ({}),
          all: async () => ({ results: [] }),
        }),
      },
    } as never;
  }

  async function getDecisions(env: never) {
    return worker.fetch(
      new Request('https://api.example/api/decisions', {
        headers: { 'X-Admin-Key': 'test-admin-key' },
      }),
      env,
      ctx
    );
  }

  it('reports truncated with the oldest covered row when more than 1000 decisions exist', async () => {
    const res = await getDecisions(makeDecisionsEnv(1500));
    const body = await res.json() as { decisions: unknown[]; truncated: boolean; oldest_covered: string | null };

    expect(res.status).toBe(200);
    expect(body.decisions).toHaveLength(1000);
    expect(body.truncated).toBe(true);
    // The 1001st row must not leak out, and oldest_covered describes what DID come back.
    expect(body.oldest_covered).toBe('2026-06-23 00:00:39');
  });

  it('reports not truncated when the table fits under the cap', async () => {
    const res = await getDecisions(makeDecisionsEnv(3));
    const body = await res.json() as { decisions: unknown[]; truncated: boolean; oldest_covered: string | null };

    expect(body.decisions).toHaveLength(3);
    expect(body.truncated).toBe(false);
    expect(body.oldest_covered).toBe('2026-06-14 00:00:02');
  });

  it('reports a null oldest_covered on an empty table rather than truncated', async () => {
    const res = await getDecisions(makeDecisionsEnv(0));
    const body = await res.json() as { decisions: unknown[]; truncated: boolean; oldest_covered: string | null };

    expect(body.decisions).toEqual([]);
    expect(body.truncated).toBe(false);
    expect(body.oldest_covered).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test and verify it fails**

Run: `cd worker && npx vitest run src/index.test.ts -t "truncation reporting"`
Expected: FAIL. `truncated` is `undefined` (the handler does not send it) and the 1500-row case returns 1500 rows because the current query is `LIMIT 1000` unbound and the stub honours the bound limit.

- [ ] **Step 3: Implement truncation reporting**

In `worker/src/index.ts`, replace the query and response inside `handleGetAllDecisions`:

```ts
// The queue subtracts these rows to hide handled work, so a silently capped
// read un-hides resolved targets with nothing saying why (#221). Fetch one
// past the cap: a full extra row is the truncation signal, and no second
// COUNT query is needed.
const DECISIONS_LIMIT = 1000;

const decisions = await env.DB.prepare(`
  SELECT * FROM moderation_decisions
  ORDER BY created_at DESC
  LIMIT ?
`).bind(DECISIONS_LIMIT + 1).all();

const rows = (decisions.results || []) as Array<Record<string, unknown>>;
const truncated = rows.length > DECISIONS_LIMIT;
const kept = truncated ? rows.slice(0, DECISIONS_LIMIT) : rows;
const oldestCovered = kept.length > 0
  ? (kept[kept.length - 1].created_at as string ?? null)
  : null;

return new Response(JSON.stringify({
  success: true,
  decisions: kept,
  truncated,
  oldest_covered: oldestCovered,
}), {
  status: 200,
  headers: { 'Content-Type': 'application/json', ...corsHeaders },
});
```

- [ ] **Step 4: Run the test and verify it passes**

Run: `cd worker && npx vitest run src/index.test.ts -t "truncation reporting"`
Expected: PASS (3 tests).

- [ ] **Step 5: Write the D1 test**

Create `worker/test/decisions-truncation.d1.test.ts`:

```ts
// Real-D1 (Miniflare SQLite) proof that /api/decisions caps at 1000 rows and
// reports how far back the returned window reaches. The stubbed-DB test in
// src/index.test.ts cannot catch a bad ORDER BY or a bind mismatch, because
// the stub does the ordering itself.
import { Miniflare } from 'miniflare';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { ensureSchema } from '../src/db';
import worker from '../src/index';

let mf: Miniflare;
let DB: D1Database;

const ctx = {} as ExecutionContext;

beforeAll(async () => {
  mf = new Miniflare({
    modules: true,
    script: 'export default { fetch() { return new Response("ok"); } };',
    compatibilityDate: '2024-12-01',
    compatibilityFlags: ['nodejs_compat'],
    d1Databases: ['DB'],
  });
  DB = (await mf.getD1Database('DB')) as unknown as D1Database;
  await ensureSchema(DB);

  // 1005 rows, oldest first, so row N has a strictly increasing created_at.
  const stmt = DB.prepare(
    `INSERT INTO moderation_decisions (target_type, target_id, action, created_at)
     VALUES (?, ?, ?, ?)`
  );
  const batch = [];
  for (let i = 0; i < 1005; i++) {
    const day = String(1 + Math.floor(i / 100)).padStart(2, '0');
    const sec = String(i % 60).padStart(2, '0');
    const min = String(Math.floor((i % 100) / 60)).padStart(2, '0');
    batch.push(stmt.bind('pubkey', 'a'.repeat(64), 'dismissed', `2026-06-${day} 00:${min}:${sec}`));
  }
  await DB.batch(batch);
});

afterAll(async () => {
  await mf?.dispose();
});

function env() {
  return {
    ALLOWED_ORIGINS: 'https://app.divine.video',
    RELAY_URL: 'wss://relay.divine.video',
    ADMIN_API_KEY: 'test-admin-key',
    DB,
  } as never;
}

describe('/api/decisions truncation against real D1 (#221)', () => {
  it('returns the newest 1000 rows and flags truncation', async () => {
    const res = await worker.fetch(
      new Request('https://api.example/api/decisions', { headers: { 'X-Admin-Key': 'test-admin-key' } }),
      env(),
      ctx
    );
    const body = await res.json() as {
      decisions: Array<{ created_at: string }>;
      truncated: boolean;
      oldest_covered: string | null;
    };

    expect(res.status).toBe(200);
    expect(body.decisions).toHaveLength(1000);
    expect(body.truncated).toBe(true);

    // Newest first, and oldest_covered matches the last row actually returned.
    const first = body.decisions[0].created_at;
    const last = body.decisions[body.decisions.length - 1].created_at;
    expect(first > last).toBe(true);
    expect(body.oldest_covered).toBe(last);

    // The 5 rows beyond the cap are the OLDEST ones, not an arbitrary slice.
    const oldestInTable = await DB.prepare(
      'SELECT created_at FROM moderation_decisions ORDER BY created_at ASC LIMIT 1'
    ).first<{ created_at: string }>();
    expect(body.oldest_covered! > oldestInTable!.created_at).toBe(true);
  });
});
```

- [ ] **Step 6: Run the D1 test and verify it passes**

Run: `cd worker && npm run test:d1`
Expected: PASS, including the new file. If it dies on a missing `miniflare`, run `cd worker && npm ci --legacy-peer-deps` first.

- [ ] **Step 7: Typecheck the worker**

Run: `cd worker && npm run typecheck`
Expected: exit 0. This is a separate CI gate from the vitest runs and has been red while they were green.

- [ ] **Step 8: Commit**

```bash
git add worker/src/index.ts worker/src/index.test.ts worker/test/decisions-truncation.d1.test.ts
git commit -m "feat(worker): report truncation and coverage window on /api/decisions (#221)"
```

---

## Task 2: Worker reports truncation on /api/resolution-labels

**Files:**
- Modify: `worker/src/index.ts:537-543`
- Test: `worker/src/index.test.ts`

**Interfaces:**
- Consumes: nothing from Task 1.
- Produces: `GET /api/resolution-labels` responds `{ success: true, events: NostrEvent[], truncated: boolean, oldest_covered: number | null }`. `oldest_covered` is unix **seconds** (the minimum `created_at` among returned events), or `null` when empty. Task 3 consumes this.

- [ ] **Step 1: Write the failing test**

Append to `worker/src/index.test.ts`. `queryRelay` opens a real WebSocket, so stub the global:

```ts
describe('GET /api/resolution-labels truncation reporting (#221)', () => {
  // Minimal fake relay: accepts the REQ, replays the given events, then EOSE.
  function stubRelay(events: Array<{ id: string; created_at: number }>) {
    class FakeWebSocket {
      onmessage: ((e: { data: string }) => void) | null = null;
      onopen: (() => void) | null = null;
      onerror: (() => void) | null = null;
      onclose: (() => void) | null = null;
      constructor(_url: string) {
        setTimeout(() => this.onopen?.(), 0);
      }
      send(raw: string) {
        const [, subId] = JSON.parse(raw) as [string, string];
        setTimeout(() => {
          for (const ev of events) {
            this.onmessage?.({ data: JSON.stringify(['EVENT', subId, ev]) });
          }
          this.onmessage?.({ data: JSON.stringify(['EOSE', subId]) });
        }, 0);
      }
      close() { /* no-op */ }
    }
    vi.stubGlobal('WebSocket', FakeWebSocket as never);
  }

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  async function getLabels() {
    return worker.fetch(
      new Request('https://api.example/api/resolution-labels', {
        headers: { 'X-Admin-Key': 'test-admin-key' },
      }),
      { ALLOWED_ORIGINS: 'https://app.divine.video', RELAY_URL: 'wss://relay.divine.video', ADMIN_API_KEY: 'test-admin-key' } as never,
      ctx
    );
  }

  it('flags truncation when the relay fills the 500-event limit', async () => {
    stubRelay(Array.from({ length: 500 }, (_, i) => ({ id: String(i).padStart(64, '0'), created_at: 1_760_000_000 - i })));

    const body = await (await getLabels()).json() as { events: unknown[]; truncated: boolean; oldest_covered: number | null };

    expect(body.events).toHaveLength(500);
    expect(body.truncated).toBe(true);
    expect(body.oldest_covered).toBe(1_760_000_000 - 499);
  });

  it('does not flag truncation below the limit', async () => {
    stubRelay([
      { id: 'a'.repeat(64), created_at: 1_760_000_000 },
      { id: 'b'.repeat(64), created_at: 1_759_000_000 },
    ]);

    const body = await (await getLabels()).json() as { events: unknown[]; truncated: boolean; oldest_covered: number | null };

    expect(body.truncated).toBe(false);
    expect(body.oldest_covered).toBe(1_759_000_000);
  });

  it('reports a null oldest_covered when the relay returns nothing', async () => {
    stubRelay([]);

    const body = await (await getLabels()).json() as { events: unknown[]; truncated: boolean; oldest_covered: number | null };

    expect(body.events).toEqual([]);
    expect(body.truncated).toBe(false);
    expect(body.oldest_covered).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test and verify it fails**

Run: `cd worker && npx vitest run src/index.test.ts -t "resolution-labels truncation"`
Expected: FAIL with `truncated` undefined.

- [ ] **Step 3: Implement**

Replace the `/api/resolution-labels` route body in `worker/src/index.ts`:

```ts
if (path === '/api/resolution-labels' && request.method === 'GET') {
  // A label that ages out of this window stops hiding its target, and the
  // queue then shows handled work as pending with nothing explaining it
  // (#221). Say when the window is full and how far back it reaches. A
  // corpus of exactly RESOLUTION_LABEL_LIMIT over-warns by one case, which
  // is the safe direction to be wrong.
  const RESOLUTION_LABEL_LIMIT = 500;
  const result = await queryRelay(
    { kinds: [1985], '#L': ['moderation/resolution'], limit: RESOLUTION_LABEL_LIMIT },
    env.RELAY_URL
  );
  if (!result.success) {
    return jsonResponse({ success: false, error: result.error }, 502, corsHeaders);
  }
  const events = (result.events || []) as Array<{ created_at?: number }>;
  const timestamps = events
    .map((e) => e.created_at)
    .filter((t): t is number => typeof t === 'number');
  return jsonResponse({
    success: true,
    events: result.events,
    truncated: events.length >= RESOLUTION_LABEL_LIMIT,
    oldest_covered: timestamps.length > 0 ? Math.min(...timestamps) : null,
  }, 200, corsHeaders);
}
```

- [ ] **Step 4: Run the test and verify it passes**

Run: `cd worker && npx vitest run src/index.test.ts -t "resolution-labels truncation"`
Expected: PASS (3 tests).

- [ ] **Step 5: Run the whole worker suite and typecheck**

Run: `cd worker && npx vitest run && npm run typecheck`
Expected: both exit 0. The WebSocket stub must not leak into other tests; if unrelated relay tests fail, the `afterEach(vi.unstubAllGlobals)` is missing or scoped wrong.

- [ ] **Step 6: Commit**

```bash
git add worker/src/index.ts worker/src/index.test.ts
git commit -m "feat(worker): report truncation and coverage window on /api/resolution-labels (#221)"
```

---

## Task 3: Client API layer carries truncation

**Files:**
- Modify: `src/lib/adminApi.ts:402-405` (`fetchResolutionLabels`), `src/lib/adminApi.ts:559-572` (`getAllDecisions`)
- Modify: `src/components/DebugPanel.tsx:179`
- Modify: `src/components/Reports.tsx:406` and `:456` (call sites only, behavior unchanged in this task)
- Test: `src/lib/adminApi.test.ts`

**Interfaces:**
- Consumes: the two worker response shapes from Tasks 1 and 2.
- Produces:
  ```ts
  export interface TruncatableResult<T> {
    items: T[];
    truncated: boolean;
    oldestCovered: number | null; // epoch MILLISECONDS, or null
  }
  export function getAllDecisions(apiUrl: string): Promise<TruncatableResult<ModerationDecision>>;
  export function fetchResolutionLabels(apiUrl: string): Promise<TruncatableResult<NostrEvent>>;
  ```
  Tasks 4 to 7 consume these.

- [ ] **Step 1: Write the failing tests**

Append to `src/lib/adminApi.test.ts`:

```ts
describe('resolution source truncation reporting (#221)', () => {
  it('normalizes the decisions TEXT timestamp to epoch milliseconds and carries truncated', async () => {
    mockFetchOnce({ success: true, decisions: [{ id: 1 }], truncated: true, oldest_covered: '2026-06-14 00:00:00' });

    const result = await getAllDecisions(API_URL);

    expect(result.items).toHaveLength(1);
    expect(result.truncated).toBe(true);
    // SQLite CURRENT_TIMESTAMP is UTC with no zone suffix. Parsing it as
    // local time would shift the reported coverage date by the TZ offset.
    expect(result.oldestCovered).toBe(Date.UTC(2026, 5, 14, 0, 0, 0));
  });

  it('normalizes the label unix seconds to epoch milliseconds', async () => {
    mockFetchOnce({ success: true, events: [], truncated: true, oldest_covered: 1_760_000_000 });

    const result = await fetchResolutionLabels(API_URL);

    expect(result.truncated).toBe(true);
    expect(result.oldestCovered).toBe(1_760_000_000_000);
  });

  it('defaults to not-truncated when the worker predates the field', async () => {
    // Pages and the worker deploy separately, so the new frontend must not
    // read a missing field as "truncated" and warn on every load.
    mockFetchOnce({ success: true, decisions: [{ id: 1 }] });

    const result = await getAllDecisions(API_URL);

    expect(result.truncated).toBe(false);
    expect(result.oldestCovered).toBeNull();
  });

  it('reports an unparseable oldest_covered as null instead of NaN', async () => {
    mockFetchOnce({ success: true, decisions: [], truncated: false, oldest_covered: 'not-a-timestamp' });

    const result = await getAllDecisions(API_URL);

    expect(result.oldestCovered).toBeNull();
  });
});
```

Use the file's existing fetch-mocking helper. If it has none named `mockFetchOnce`, define one locally in this describe block, matching how the surrounding tests stub `fetch`:

```ts
function mockFetchOnce(body: unknown) {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })));
}
```

- [ ] **Step 2: Run the tests and verify they fail**

Run: `npx vitest run src/lib/adminApi.test.ts -t "truncation reporting"`
Expected: FAIL. `result.items` is undefined because both functions still return bare arrays.

- [ ] **Step 3: Implement the shape change**

In `src/lib/adminApi.ts`:

```ts
// A capped resolution read that does not say it was capped un-hides handled
// work with nothing explaining why (#221). oldestCovered is normalized to
// epoch milliseconds here so callers never juggle SQLite TEXT against Nostr
// unix seconds.
export interface TruncatableResult<T> {
  items: T[];
  truncated: boolean;
  oldestCovered: number | null;
}

// SQLite CURRENT_TIMESTAMP has no zone suffix but IS UTC; Nostr created_at is
// unix seconds. Anything else is reported as unknown rather than NaN.
export function parseOldestCovered(value: string | number | null | undefined): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value * 1000 : null;
  if (typeof value !== 'string' || value.length === 0) return null;
  const parsed = Date.parse(value.includes('T') ? value : `${value.replace(' ', 'T')}Z`);
  return Number.isNaN(parsed) ? null : parsed;
}
```

```ts
export async function fetchResolutionLabels(apiUrl: string): Promise<TruncatableResult<NostrEvent>> {
  const data = await apiRequest<{
    success: boolean;
    events: NostrEvent[];
    truncated?: boolean;
    oldest_covered?: number | null;
  }>(apiUrl, '/api/resolution-labels', 'GET');
  return {
    items: sanitizeRelayEvents(data.events),
    truncated: data.truncated === true,
    oldestCovered: parseOldestCovered(data.oldest_covered),
  };
}
```

```ts
export async function getAllDecisions(apiUrl: string): Promise<TruncatableResult<ModerationDecision>> {
  const data = await apiRequest<{
    success: boolean;
    decisions: ModerationDecision[];
    truncated?: boolean;
    oldest_covered?: string | null;
    error?: string;
  }>(apiUrl, '/api/decisions', 'GET');

  if (!data.success) {
    console.error('[adminApi] getAllDecisions failed:', data.error);
    throw new ApiError(data.error || 'Failed to get decisions');
  }

  return {
    items: data.decisions || [],
    truncated: data.truncated === true,
    oldestCovered: parseOldestCovered(data.oldest_covered),
  };
}
```

- [ ] **Step 4: Update the two call sites so nothing changes behaviorally yet**

`src/components/DebugPanel.tsx:179`:

```ts
const result = await getAllDecisions();
return { success: true, data: result.items, duration: Date.now() - start };
```

`src/components/Reports.tsx`, inside the labels query, replace `queryFn: fetchResolutionLabels` with a wrapper that keeps `data` an array for now:

```ts
queryFn: async () => (await fetchResolutionLabels()).items,
```

and in the decisions query:

```ts
return (await getAllDecisions()).items;
```

(Task 7 lifts these back to the full result once the UI consumes truncation. Doing it here keeps this task's diff a pure shape change with no behavior change to review.)

- [ ] **Step 5: Run the tests and typecheck**

Run: `npx vitest run src/lib/adminApi.test.ts && npx tsc -p tsconfig.app.json --noEmit`
Expected: both exit 0. Bare `tsc --noEmit` is a false green in this repo (root tsconfig is `files: []` with project references), so always pass `-p tsconfig.app.json`.

- [ ] **Step 6: Commit**

```bash
git add src/lib/adminApi.ts src/lib/adminApi.test.ts src/components/DebugPanel.tsx src/components/Reports.tsx
git commit -m "feat(api): carry resolution-source truncation through the client layer (#221)"
```

---

## Task 4: Block a cold render until every gating source has loaded

**Files:**
- Modify: `src/test/TestApp.tsx`
- Modify: `src/components/Reports.tsx:400-462` (queries), `:876-896` (gate)
- Test: `src/components/Reports.resolution-state.test.tsx` (create)

**Interfaces:**
- Consumes: `TruncatableResult` call sites from Task 3.
- Produces:
  ```ts
  interface ResolutionSource {
    key: 'labels' | 'banned-pubkeys' | 'banned-events' | 'decisions';
    label: string;        // moderator-facing, e.g. 'Banned accounts'
    hasData: boolean;
    error: unknown;
    updatedAt: number;    // epoch ms, 0 when never loaded
    isPending: boolean;
    gatesAlways: boolean; // decisions gates every view, the rest only the resolved filter
  }
  const resolutionSources: ResolutionSource[];
  const resolvedFilterActive: boolean;    // hideResolved && !showPendingReview
  const gatingSources: ResolutionSource[];
  const blockingLoad: ResolutionSource[]; // gating, no data, still pending
  ```
  Tasks 5 to 7 consume these.

- [ ] **Step 1: Give the test harness a zero retry delay**

`src/test/TestApp.tsx`:

```tsx
const queryClient = new QueryClient({
  defaultOptions: {
    // retryDelay: 0 because components that set their own `retry` opt back
    // into React Query's 1000ms default backoff, which pushes error-state
    // assertions past the 1000ms findBy timeout and flakes under CI load.
    queries: { retry: false, retryDelay: 0 },
    mutations: { retry: false, retryDelay: 0 },
  },
});
```

- [ ] **Step 2: Write the control test and the failing gate test**

Create `src/components/Reports.resolution-state.test.tsx`:

```tsx
// ABOUTME: resolvedTargets is subtractive, so a resolution source that is
// ABOUTME: missing or errored un-hides handled work rather than hiding more (#221)

import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { nip19 } from 'nostr-tools';
import TestApp from '@/test/TestApp';
import { Reports } from './Reports';

// The detail pane is irrelevant here and pulls in relay traffic of its own.
vi.mock('@/components/ReportDetail', () => ({
  ReportDetail: () => <div data-testid="detail" />,
}));

const REPORTED_PUBKEY = 'd'.repeat(64);
const REPORTED_NPUB = nip19.npubEncode(REPORTED_PUBKEY);

const REPORT = {
  id: 'a'.repeat(64),
  pubkey: 'b'.repeat(64),
  created_at: 1751000000,
  kind: 1984,
  tags: [['p', REPORTED_PUBKEY, 'spam']],
  content: 'comment spam',
  sig: 'e'.repeat(128),
};

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

// Each source can be told to succeed with data, succeed empty, or fail.
interface SourceState {
  labels?: 'resolves' | 'empty' | 'error';
  bannedPubkeys?: 'resolves' | 'empty' | 'error';
  bannedEvents?: 'empty' | 'error';
  decisions?: 'resolves' | 'empty' | 'error';
  slow?: Array<'labels' | 'bannedPubkeys' | 'bannedEvents' | 'decisions'>;
}

function stubFetch(state: SourceState) {
  const never = new Promise<Response>(() => {});
  const slow = new Set(state.slow ?? []);

  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);

    if (url.includes('/api/reports')) {
      return jsonResponse({ success: true, events: [REPORT] });
    }

    if (url.includes('/api/resolution-labels')) {
      if (slow.has('labels')) return never;
      if (state.labels === 'error') return jsonResponse({ success: false, error: 'relay timeout' }, 502);
      return jsonResponse({
        success: true,
        events: state.labels === 'resolves'
          ? [{
              id: 'f'.repeat(64),
              pubkey: 'b'.repeat(64),
              created_at: 1751000100,
              kind: 1985,
              tags: [['L', 'moderation/resolution'], ['p', REPORTED_PUBKEY]],
              content: '',
              sig: 'e'.repeat(128),
            }]
          : [],
      });
    }

    if (url.includes('/api/decisions')) {
      if (slow.has('decisions')) return never;
      if (state.decisions === 'error') return jsonResponse({ success: false, error: 'cold start timeout' }, 500);
      return jsonResponse({
        success: true,
        decisions: state.decisions === 'resolves'
          ? [{ id: 1, target_type: 'pubkey', target_id: REPORTED_PUBKEY, action: 'dismissed', created_at: '2026-06-14 00:00:00' }]
          : [],
      });
    }

    if (url.includes('/api/relay-rpc')) {
      const method = String(init?.body ?? '').includes('listbannedpubkeys') ? 'bannedPubkeys' : 'bannedEvents';
      if (slow.has(method)) return never;
      const mode = method === 'bannedPubkeys' ? state.bannedPubkeys : state.bannedEvents;
      if (mode === 'error') return jsonResponse({ success: false, error: 'nip-86 failed' }, 500);
      return jsonResponse({
        success: true,
        result: mode === 'resolves' ? [{ pubkey: REPORTED_PUBKEY }] : [],
      });
    }

    return jsonResponse({ success: true });
  }));
}

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function renderReports() {
  return render(
    <TestApp>
      <Reports relayUrl="wss://relay.example" />
    </TestApp>
  );
}

describe('resolution sources genuinely hide handled work (controls)', () => {
  // These controls exist so the tests below measure an ACTUAL un-hide. Without
  // them, a target that was never filtered in the first place would make every
  // "it appears" assertion pass for the wrong reason.
  it('hides a target resolved by a resolution label', async () => {
    stubFetch({ labels: 'resolves', bannedPubkeys: 'empty', bannedEvents: 'empty', decisions: 'empty' });
    renderReports();

    await waitFor(() => expect(screen.getByText(/0 pending/i)).toBeInTheDocument());
    expect(screen.queryByText(REPORTED_NPUB)).not.toBeInTheDocument();
  });

  it('hides a target resolved by the banned pubkeys list', async () => {
    stubFetch({ labels: 'empty', bannedPubkeys: 'resolves', bannedEvents: 'empty', decisions: 'empty' });
    renderReports();

    await waitFor(() => expect(screen.getByText(/0 pending/i)).toBeInTheDocument());
    expect(screen.queryByText(REPORTED_NPUB)).not.toBeInTheDocument();
  });

  it('hides a target resolved by a moderation decision', async () => {
    stubFetch({ labels: 'empty', bannedPubkeys: 'empty', bannedEvents: 'empty', decisions: 'resolves' });
    renderReports();

    await waitFor(() => expect(screen.getByText(/0 pending/i)).toBeInTheDocument());
    expect(screen.queryByText(REPORTED_NPUB)).not.toBeInTheDocument();
  });

  it('shows the target when no source resolves it', async () => {
    stubFetch({ labels: 'empty', bannedPubkeys: 'empty', bannedEvents: 'empty', decisions: 'empty' });
    renderReports();

    expect(await screen.findByText(REPORTED_NPUB)).toBeInTheDocument();
  });
});

describe('cold load does not render an unfiltered queue (#221)', () => {
  it('keeps the skeleton up while the banned pubkeys list is still loading', async () => {
    // Reports resolve fast; this source never does. Before the fix the queue
    // painted the already-banned target as pending in the gap.
    stubFetch({ labels: 'empty', bannedPubkeys: 'resolves', bannedEvents: 'empty', decisions: 'empty', slow: ['bannedPubkeys'] });
    renderReports();

    await waitFor(() => expect(screen.getAllByText(/reports/i).length).toBeGreaterThan(0));
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByText(REPORTED_NPUB)).not.toBeInTheDocument();
  });

  it('keeps the skeleton up while resolution labels are still loading', async () => {
    stubFetch({ labels: 'resolves', bannedPubkeys: 'empty', bannedEvents: 'empty', decisions: 'empty', slow: ['labels'] });
    renderReports();

    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByText(REPORTED_NPUB)).not.toBeInTheDocument();
  });

  it('renders once every gating source has landed', async () => {
    stubFetch({ labels: 'empty', bannedPubkeys: 'empty', bannedEvents: 'empty', decisions: 'empty' });
    renderReports();

    expect(await screen.findByText(REPORTED_NPUB)).toBeInTheDocument();
  });
});
```

- [ ] **Step 3: Run the tests and verify the controls pass and the gate tests fail**

Run: `npx vitest run src/components/Reports.resolution-state.test.tsx`
Expected: the four control tests PASS, the two "keeps the skeleton up" tests FAIL (the target renders, because only `decisionsLoading` gates today). If a control fails, stop: the fixture is not actually resolving that target and every later assertion in that describe block would be meaningless.

- [ ] **Step 4: Implement the source descriptor and the gate**

In `src/components/Reports.tsx`, destructure error, freshness, and pending state from all four resolution queries and give the three that lack it `retry: 1`:

```tsx
const {
  data: resolutionLabels,
  error: labelsError,
  dataUpdatedAt: labelsUpdatedAt,
  isPending: labelsPending,
} = useQuery({
  queryKey: ['resolution-labels', relayUrl],
  queryFn: async () => (await fetchResolutionLabels()).items,
  refetchInterval: 15 * 1000,
  placeholderData: (previousData) => previousData,
  retry: 1,
});
```

Apply the same four-field destructure to the banned-pubkeys, banned-events, and decisions queries (`bannedPubkeysError` / `bannedPubkeysUpdatedAt` / `bannedPubkeysPending`, and so on), and set `retry: 1` on each. Update the comment above the decisions query rather than deleting it:

```tsx
// retry: 1, not 0. The original reasoning still holds (stacking retries on a
// cold-start timeout compounds latency), but it no longer justifies zero:
// resolvedTargets is subtractive, so a source that gives up immediately does
// not fail safe, it un-hides work already handled (#221). One retry buys back
// most of the single-timeout case without stacking.
```

Then, after the `pendingReviewTargets` memo:

```tsx
// The four sources that build resolvedTargets, described once so the gate,
// the banners, and the blocked pane cannot drift apart the way the queries
// themselves did.
interface ResolutionSource {
  key: 'labels' | 'banned-pubkeys' | 'banned-events' | 'decisions';
  label: string;
  hasData: boolean;
  error: unknown;
  updatedAt: number;
  isPending: boolean;
  gatesAlways: boolean;
}

const resolutionSources = useMemo<ResolutionSource[]>(() => [
  {
    key: 'labels',
    label: 'Resolution labels',
    hasData: !!resolutionLabels,
    error: labelsError,
    updatedAt: labelsUpdatedAt,
    isPending: labelsPending,
    gatesAlways: false,
  },
  {
    key: 'banned-pubkeys',
    label: 'Banned accounts',
    hasData: !!bannedPubkeys,
    error: bannedPubkeysError,
    updatedAt: bannedPubkeysUpdatedAt,
    isPending: bannedPubkeysPending,
    gatesAlways: false,
  },
  {
    key: 'banned-events',
    label: 'Banned posts',
    hasData: !!bannedEvents,
    error: bannedEventsError,
    updatedAt: bannedEventsUpdatedAt,
    isPending: bannedEventsPending,
    gatesAlways: false,
  },
  {
    // Decisions feeds pendingReviewTargets as well as resolvedTargets, and
    // pendingReviewTargets is applied on every path (filtered TO it in the
    // pending view, filtered OUT of it otherwise). So it gates regardless of
    // the hide-resolved toggle, which is what the old decisionsLoading guard
    // did for loading and failed to do for errors.
    key: 'decisions',
    label: 'Moderation decisions',
    hasData: !!allDecisions,
    error: decisionsError,
    updatedAt: decisionsUpdatedAt,
    isPending: decisionsPending,
    gatesAlways: true,
  },
], [
  resolutionLabels, labelsError, labelsUpdatedAt, labelsPending,
  bannedPubkeys, bannedPubkeysError, bannedPubkeysUpdatedAt, bannedPubkeysPending,
  bannedEvents, bannedEventsError, bannedEventsUpdatedAt, bannedEventsPending,
  allDecisions, decisionsError, decisionsUpdatedAt, decisionsPending,
]);

const resolvedFilterActive = hideResolved && !showPendingReview;
const gatingSources = resolutionSources.filter(s => s.gatesAlways || resolvedFilterActive);
const blockingLoad = gatingSources.filter(s => !s.hasData && s.isPending);
```

Replace the gate at `Reports.tsx:878`:

```tsx
// Wait for reports AND every gating resolution source. A source that has not
// landed contributes nothing to resolvedTargets, so rendering here would show
// handled work as pending, and would show auto-hidden content in the default
// view (#221).
if (isLoading || blockingLoad.length > 0) {
```

- [ ] **Step 5: Run the tests and verify they pass**

Run: `npx vitest run src/components/Reports.resolution-state.test.tsx`
Expected: PASS (7 tests).

- [ ] **Step 6: Run the full frontend suite**

Run: `npm run test`
Expected: exit 0. `Reports.test.tsx` (#158) must still pass: it stubs all four endpoints, so it satisfies the new gate.

- [ ] **Step 7: Commit**

```bash
git add src/test/TestApp.tsx src/components/Reports.tsx src/components/Reports.resolution-state.test.tsx
git commit -m "fix(reports): wait for every resolution source before rendering the queue (#221)"
```

---

## Task 5: Blocked pane for a cold error, with an explicit override

**Files:**
- Create: `src/components/ResolutionStateNotice.tsx`
- Modify: `src/components/Reports.tsx` (blocked-pane branch, override state, persistent warning)
- Test: `src/components/Reports.resolution-state.test.tsx`

**Interfaces:**
- Consumes: `ResolutionSource`, `gatingSources`, `resolvedFilterActive` from Task 4.
- Produces:
  ```tsx
  export function ResolutionUnavailablePane(props: {
    sources: Array<{ key: string; label: string }>;
    decisionsUnavailable: boolean;
    onRetry: () => void;
    onOverride: () => void;
  }): JSX.Element;

  export function ResolutionOverrideWarning(props: {
    sources: Array<{ key: string; label: string }>;
    decisionsUnavailable: boolean;
  }): JSX.Element;
  ```
  Task 6 adds a third export to this file.

- [ ] **Step 1: Write the failing tests**

Append to `src/components/Reports.resolution-state.test.tsx`:

```tsx
describe('cold error blocks the queue and offers an override (#221)', () => {
  it('blocks rather than presenting a resolved target as pending when decisions fails cold', async () => {
    // decisions is the source that would have hidden this target.
    stubFetch({ labels: 'empty', bannedPubkeys: 'empty', bannedEvents: 'empty', decisions: 'error' });
    renderReports();

    expect(await screen.findByText(/resolution state is unavailable/i)).toBeInTheDocument();
    expect(screen.getByText(/moderation decisions/i)).toBeInTheDocument();
    expect(screen.queryByText(REPORTED_NPUB)).not.toBeInTheDocument();
  });

  it('blocks when the banned accounts list fails cold', async () => {
    stubFetch({ labels: 'empty', bannedPubkeys: 'error', bannedEvents: 'empty', decisions: 'empty' });
    renderReports();

    expect(await screen.findByText(/resolution state is unavailable/i)).toBeInTheDocument();
    expect(screen.getByText(/banned accounts/i)).toBeInTheDocument();
  });

  it('renders the unfiltered queue with a persistent warning once the moderator overrides', async () => {
    stubFetch({ labels: 'empty', bannedPubkeys: 'error', bannedEvents: 'empty', decisions: 'empty' });
    const user = userEvent.setup();
    renderReports();

    await user.click(await screen.findByRole('button', { name: /show the queue without resolution filtering/i }));

    expect(await screen.findByText(REPORTED_NPUB)).toBeInTheDocument();
    // The warning must persist alongside the list, not flash and vanish.
    expect(screen.getByText(/some of these may already be handled/i)).toBeInTheDocument();
  });

  it('warns that auto-hidden content can appear when decisions is the failed source', async () => {
    stubFetch({ labels: 'empty', bannedPubkeys: 'empty', bannedEvents: 'empty', decisions: 'error' });
    const user = userEvent.setup();
    renderReports();

    await user.click(await screen.findByRole('button', { name: /show the queue without resolution filtering/i }));

    expect(await screen.findByText(/auto-hidden/i)).toBeInTheDocument();
  });

  it('does not block on a cold labels error while hide-resolved is off', async () => {
    // resolvedTargets is not applied in that view, so labels cannot un-hide
    // anything and blocking would be a lie.
    stubFetch({ labels: 'error', bannedPubkeys: 'empty', bannedEvents: 'empty', decisions: 'empty' });
    const user = userEvent.setup();
    renderReports();

    await user.click(await screen.findByRole('switch', { name: /hide resolved/i }));

    expect(await screen.findByText(REPORTED_NPUB)).toBeInTheDocument();
    expect(screen.queryByText(/resolution state is unavailable/i)).not.toBeInTheDocument();
  });

  it('shows no unavailable pane when every source is healthy', async () => {
    // Pinning the negative: a pane that renders unconditionally passes every
    // positive test above.
    stubFetch({ labels: 'empty', bannedPubkeys: 'empty', bannedEvents: 'empty', decisions: 'empty' });
    renderReports();

    await screen.findByText(REPORTED_NPUB);
    expect(screen.queryByText(/resolution state is unavailable/i)).not.toBeInTheDocument();
  });
});
```

Add `import userEvent from '@testing-library/user-event';` to the file's imports. Confirm the hide-resolved control's accessible name against `Reports.tsx` before relying on `/hide resolved/i`; if it is not a labelled switch, select it the way the existing suite does and note the selector in a comment.

- [ ] **Step 2: Run and verify failure**

Run: `npx vitest run src/components/Reports.resolution-state.test.tsx -t "cold error"`
Expected: FAIL. No pane exists; the queue renders the target unfiltered.

- [ ] **Step 3: Create the notice component**

`src/components/ResolutionStateNotice.tsx`:

```tsx
// ABOUTME: Moderator-facing notices for incomplete resolution state: the
// ABOUTME: blocked pane, its override warning, and the stale-source banner (#221)

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { AlertTriangle } from 'lucide-react';

export interface NoticeSource {
  key: string;
  label: string;
}

function sourceList(sources: NoticeSource[]): string {
  return sources.map(s => s.label).join(', ');
}

// Shown instead of the queue when a resolution source failed with no previous
// data to fall back on. Rendering the list here would present handled work as
// pending, which is the bug; rendering nothing at all would lock the moderator
// out, which is its own failure. So: say what is missing, and let them proceed
// deliberately.
export function ResolutionUnavailablePane({
  sources,
  decisionsUnavailable,
  onRetry,
  onOverride,
}: {
  sources: NoticeSource[];
  decisionsUnavailable: boolean;
  onRetry: () => void;
  onOverride: () => void;
}) {
  return (
    <Card className="h-[calc(100vh-200px)]">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <AlertTriangle className="h-5 w-5 text-amber-500" />
          Resolution state is unavailable
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-sm text-muted-foreground">
          The queue cannot tell which reports have already been handled, so it is not
          showing the list. Unavailable: {sourceList(sources)}.
        </p>
        <p className="text-sm text-muted-foreground">
          This usually clears on the next automatic refresh.
        </p>
        <div className="flex flex-wrap gap-2">
          <Button onClick={onRetry}>Retry</Button>
          <Button variant="outline" onClick={onOverride}>
            Show the queue without resolution filtering
          </Button>
        </div>
        {decisionsUnavailable && (
          <p className="text-xs text-muted-foreground">
            Without moderation decisions, the unfiltered queue also includes auto-hidden
            content that is normally kept out of this view.
          </p>
        )}
      </CardContent>
    </Card>
  );
}

// Stays on screen for as long as the override is in effect. A one-off toast
// would let a moderator forget they are looking at an unfiltered queue.
export function ResolutionOverrideWarning({
  sources,
  decisionsUnavailable,
}: {
  sources: NoticeSource[];
  decisionsUnavailable: boolean;
}) {
  return (
    <Alert variant="destructive" className="mt-2 py-2">
      <AlertDescription className="text-xs">
        Resolution filtering is off ({sourceList(sources)} unavailable), so some of these
        may already be handled.
        {decisionsUnavailable && ' Auto-hidden content is included.'}
      </AlertDescription>
    </Alert>
  );
}
```

- [ ] **Step 4: Wire it into Reports**

In `src/components/Reports.tsx`, add the override state next to the other `useState` calls:

```tsx
// Component-local on purpose: the override survives polls within this mount so
// a moderator is not thrown back to the blocked pane every 15s, and resets on
// reload so the safe default reasserts itself.
const [resolutionOverride, setResolutionOverride] = useState(false);
```

Derive the blocked set alongside `blockingLoad` from Task 4:

```tsx
const blockingErrors = gatingSources.filter(s => !s.hasData && s.error);
const decisionsUnavailable = blockingErrors.some(s => s.key === 'decisions');
```

Add the branch after the existing `if (error && !reports)` check:

```tsx
if (blockingErrors.length > 0 && !resolutionOverride) {
  return (
    <ResolutionUnavailablePane
      sources={blockingErrors.map(s => ({ key: s.key, label: s.label }))}
      decisionsUnavailable={decisionsUnavailable}
      onRetry={() => {
        queryClient.invalidateQueries({ queryKey: ['resolution-labels'] });
        queryClient.invalidateQueries({ queryKey: ['banned-pubkeys'] });
        queryClient.invalidateQueries({ queryKey: ['banned-events'] });
        queryClient.invalidateQueries({ queryKey: ['decisions'] });
      }}
      onOverride={() => setResolutionOverride(true)}
    />
  );
}
```

Render the persistent warning inside the list card header, next to where the other alerts go (the `CardHeader` block around `Reports.tsx:985`):

```tsx
{resolutionOverride && blockingErrors.length > 0 && (
  <ResolutionOverrideWarning
    sources={blockingErrors.map(s => ({ key: s.key, label: s.label }))}
    decisionsUnavailable={decisionsUnavailable}
  />
)}
```

Import both components at the top of `Reports.tsx`.

- [ ] **Step 5: Run and verify pass**

Run: `npx vitest run src/components/Reports.resolution-state.test.tsx`
Expected: PASS (13 tests).

- [ ] **Step 6: Full frontend gate**

Run: `npm run test`
Expected: exit 0.

- [ ] **Step 7: Commit**

```bash
git add src/components/ResolutionStateNotice.tsx src/components/Reports.tsx src/components/Reports.resolution-state.test.tsx
git commit -m "fix(reports): block on a cold resolution failure with an explicit override (#221)"
```

---

## Task 6: Warm failure keeps filtering and banners the stale source

**Files:**
- Modify: `src/components/ResolutionStateNotice.tsx` (add `StaleResolutionBanner`)
- Modify: `src/components/Reports.tsx`
- Test: `src/components/Reports.resolution-state.test.tsx`

**Interfaces:**
- Consumes: `ResolutionSource` from Task 4, `NoticeSource` from Task 5.
- Produces:
  ```tsx
  export function StaleResolutionBanner(props: {
    sources: Array<{ key: string; label: string; updatedAt: number }>;
  }): JSX.Element;
  ```

- [ ] **Step 1: Write the failing tests**

Append to `src/components/Reports.resolution-state.test.tsx`:

```tsx
describe('warm failure keeps the stale filter and says so (#221)', () => {
  // A refresh that fails still has the last good set, and that set still hides
  // the handled work. Blocking here would cost availability for no safety gain.
  function stubFetchThenFail(state: SourceState, failing: 'bannedPubkeys') {
    let call = 0;
    const good = vi.fn();
    stubFetch(state);
    const healthy = globalThis.fetch as unknown as typeof fetch;
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      const isTarget = url.includes('/api/relay-rpc')
        && String(init?.body ?? '').includes('listbannedpubkeys');
      if (isTarget) {
        call++;
        if (call > 1) return jsonResponse({ success: false, error: 'nip-86 failed' }, 500);
      }
      good(failing);
      return healthy(input, init);
    }));
  }

  it('still hides a target resolved by a source whose refresh has started failing', async () => {
    vi.useFakeTimers();
    stubFetchThenFail({ labels: 'empty', bannedPubkeys: 'resolves', bannedEvents: 'empty', decisions: 'empty' }, 'bannedPubkeys');
    renderReports();

    await vi.waitFor(() => expect(screen.getByText(/0 pending/i)).toBeInTheDocument());
    // Drive the 15s poll into its failure.
    await vi.advanceTimersByTimeAsync(16_000);

    expect(screen.queryByText(REPORTED_NPUB)).not.toBeInTheDocument();
    expect(await screen.findByText(/showing resolution state from/i)).toBeInTheDocument();
    vi.useRealTimers();
  });

  it('shows no stale banner while every source is refreshing cleanly', async () => {
    // The negative. A banner rendered unconditionally passes the test above.
    stubFetch({ labels: 'empty', bannedPubkeys: 'resolves', bannedEvents: 'empty', decisions: 'empty' });
    renderReports();

    await waitFor(() => expect(screen.getByText(/0 pending/i)).toBeInTheDocument());
    expect(screen.queryByText(/showing resolution state from/i)).not.toBeInTheDocument();
  });
});
```

If driving the poll with fake timers proves brittle against React Query's internals, replace the first test with a direct one: seed the query cache with good data via a pre-populated `QueryClient`, then render with a failing fetch. Do not weaken the assertion; the point is that the target stays hidden AND the banner appears.

- [ ] **Step 2: Run and verify failure**

Run: `npx vitest run src/components/Reports.resolution-state.test.tsx -t "warm failure"`
Expected: FAIL on the missing banner text. The "still hides" half should already pass, because `placeholderData` retains the previous set. That is the point: the banner is what is missing, not the filtering.

- [ ] **Step 3: Add the banner component**

Append to `src/components/ResolutionStateNotice.tsx`:

```tsx
// A source whose refresh is failing but which still holds its last good data.
// The filter is still correct as of that timestamp, so the queue stays up and
// the moderator is told how old the resolution state is.
export function StaleResolutionBanner({
  sources,
}: {
  sources: Array<NoticeSource & { updatedAt: number }>;
}) {
  const oldest = Math.min(...sources.map(s => s.updatedAt));
  const minutes = Math.max(0, Math.floor((Date.now() - oldest) / 60_000));
  const age = minutes < 1 ? 'less than a minute ago' : `${minutes} minute${minutes === 1 ? '' : 's'} ago`;

  return (
    <Alert className="mt-2 py-2">
      <AlertDescription className="text-xs">
        {sourceList(sources)} could not refresh. Showing resolution state from {age};
        retrying automatically.
      </AlertDescription>
    </Alert>
  );
}
```

- [ ] **Step 4: Wire it in**

In `src/components/Reports.tsx`, alongside `blockingErrors`:

```tsx
// Errored but still holding previous data: filter with the stale set, say so.
const staleSources = gatingSources.filter(s => s.hasData && s.error);
```

Render it in the same header block as the override warning:

```tsx
{staleSources.length > 0 && (
  <StaleResolutionBanner
    sources={staleSources.map(s => ({ key: s.key, label: s.label, updatedAt: s.updatedAt }))}
  />
)}
```

- [ ] **Step 5: Run and verify pass**

Run: `npx vitest run src/components/Reports.resolution-state.test.tsx`
Expected: PASS (15 tests).

- [ ] **Step 6: Commit**

```bash
git add src/components/ResolutionStateNotice.tsx src/components/Reports.tsx src/components/Reports.resolution-state.test.tsx
git commit -m "fix(reports): banner a stale resolution source instead of failing silently (#221)"
```

---

## Task 7: Surface truncated resolution history

**Files:**
- Modify: `src/components/Reports.tsx` (labels and decisions queries lift back to the full `TruncatableResult`)
- Modify: `src/components/ResolutionStateNotice.tsx` (add `TruncatedHistoryBanner`)
- Test: `src/components/Reports.resolution-state.test.tsx`

**Interfaces:**
- Consumes: `TruncatableResult` from Task 3.
- Produces:
  ```tsx
  export function TruncatedHistoryBanner(props: { oldestCovered: number }): JSX.Element;
  ```

- [ ] **Step 1: Write the failing tests**

Append to `src/components/Reports.resolution-state.test.tsx`:

```tsx
describe('truncated resolution history is stated, not silent (#221)', () => {
  function stubTruncated(oldestCovered: string | null, truncated: boolean) {
    stubFetch({ labels: 'empty', bannedPubkeys: 'empty', bannedEvents: 'empty', decisions: 'empty' });
    const healthy = globalThis.fetch as unknown as typeof fetch;
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.includes('/api/decisions')) {
        return jsonResponse({ success: true, decisions: [], truncated, oldest_covered: oldestCovered });
      }
      return healthy(input, init);
    }));
  }

  it('names the date resolution history reaches back to', async () => {
    stubTruncated('2026-06-14 00:00:00', true);
    renderReports();

    expect(await screen.findByText(/resolution history only reaches back to/i)).toBeInTheDocument();
    expect(screen.getByText(/jun 14, 2026/i)).toBeInTheDocument();
  });

  it('shows no truncation banner when the window covers everything', async () => {
    stubTruncated('2026-06-14 00:00:00', false);
    renderReports();

    await screen.findByText(REPORTED_NPUB);
    expect(screen.queryByText(/resolution history only reaches back to/i)).not.toBeInTheDocument();
  });

  it('shows no truncation banner against a worker that predates the field', async () => {
    // Pages and the worker deploy separately; a missing field is not truncation.
    stubFetch({ labels: 'empty', bannedPubkeys: 'empty', bannedEvents: 'empty', decisions: 'empty' });
    renderReports();

    await screen.findByText(REPORTED_NPUB);
    expect(screen.queryByText(/resolution history only reaches back to/i)).not.toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run and verify failure**

Run: `npx vitest run src/components/Reports.resolution-state.test.tsx -t "truncated resolution history"`
Expected: FAIL on the missing banner.

- [ ] **Step 3: Lift the queries back to the full result**

In `src/components/Reports.tsx`, change the two query functions from Task 3's `.items` wrappers to keep the whole result, and derive the arrays:

```tsx
const {
  data: labelsResult,
  error: labelsError,
  dataUpdatedAt: labelsUpdatedAt,
  isPending: labelsPending,
} = useQuery({
  queryKey: ['resolution-labels', relayUrl],
  queryFn: fetchResolutionLabels,
  refetchInterval: 15 * 1000,
  placeholderData: (previousData) => previousData,
  retry: 1,
});
const resolutionLabels = labelsResult?.items;
```

Same shape for decisions (`decisionsResult`, then `const allDecisions = decisionsResult?.items;`). Every downstream use of `resolutionLabels` / `allDecisions` keeps working unchanged, including `decisionsForTarget(allDecisions, ...)`.

Then:

```tsx
// The oldest point either capped source can still speak to. A target resolved
// before this is invisible to the filter and would sit in the queue forever
// with nothing explaining why.
const truncatedOldestCovered = useMemo(() => {
  const bounds = [
    labelsResult?.truncated ? labelsResult.oldestCovered : null,
    decisionsResult?.truncated ? decisionsResult.oldestCovered : null,
  ].filter((v): v is number => typeof v === 'number');
  return bounds.length > 0 ? Math.max(...bounds) : null;
}, [labelsResult, decisionsResult]);
```

`Math.max` because the queue can only see back as far as the *more* limited of the two windows.

- [ ] **Step 4: Add the banner and render it**

Append to `src/components/ResolutionStateNotice.tsx`:

```tsx
export function TruncatedHistoryBanner({ oldestCovered }: { oldestCovered: number }) {
  const date = new Date(oldestCovered).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });

  return (
    <Alert className="mt-2 py-2">
      <AlertDescription className="text-xs">
        Resolution history only reaches back to {date}. Anything resolved before then may
        be listed as pending.
      </AlertDescription>
    </Alert>
  );
}
```

In `Reports.tsx`, in the same header block:

```tsx
{truncatedOldestCovered !== null && resolvedFilterActive && (
  <TruncatedHistoryBanner oldestCovered={truncatedOldestCovered} />
)}
```

- [ ] **Step 5: Run and verify pass**

Run: `npx vitest run src/components/Reports.resolution-state.test.tsx`
Expected: PASS (18 tests). The date assertion depends on the runner's locale; if `toLocaleDateString` yields something other than `Jun 14, 2026` under the test environment, assert on a locale-stable substring (the year and the day) rather than loosening the test to `/2026/`.

- [ ] **Step 6: Commit**

```bash
git add src/components/Reports.tsx src/components/ResolutionStateNotice.tsx src/components/Reports.resolution-state.test.tsx
git commit -m "feat(reports): state how far back resolution history reaches when capped (#221)"
```

---

## Task 8: Mutation verification and the four gates

**Files:** none modified permanently. This task proves the tests written above can actually fail.

**Interfaces:**
- Consumes: everything.
- Produces: a written record of which mutation killed which test, to go in the PR body.

- [ ] **Step 1: Protect the working tree before mutating**

Mutations get reverted from a copy, never with `git checkout <file>`, which would discard unrelated uncommitted work in the same file.

```bash
mkdir -p /tmp/mutation-backup
cp src/components/Reports.tsx /tmp/mutation-backup/
cp src/components/ResolutionStateNotice.tsx /tmp/mutation-backup/
cp worker/src/index.ts /tmp/mutation-backup/
git status --porcelain   # expect clean; commit anything outstanding first
```

- [ ] **Step 2: Mutate one guard at a time**

Apply each mutation ALONE, run the suite, record which tests die, then restore from `/tmp/mutation-backup/` before the next one. A coarse mutation that removes two routes to the same outcome will go red while certifying a test that is actually inert.

| # | Mutation | Expected to kill |
|---|---|---|
| 1 | In the gate, drop `blockingLoad.length > 0` back to `decisionsLoading` only | both "keeps the skeleton up" tests, nothing else |
| 2 | In `blockingErrors`, drop the `!s.hasData` condition | the warm-failure "still hides" test (a stale source would wrongly block) |
| 3 | In `blockingErrors`, drop the `s.error` condition | the healthy-sources negative test |
| 4 | Change `gatesAlways` on decisions from `true` to `false` | the cold decisions-error block test |
| 5 | Remove the `resolvedFilterActive` term from `gatingSources` | the "does not block on a cold labels error while hide-resolved is off" test |
| 6 | Make `ResolutionOverrideWarning` render `null` | the persistent-warning assertion only |
| 7 | In `staleSources`, drop `s.hasData` | the stale-banner negative test |
| 8 | In `TruncatedHistoryBanner`'s render condition, drop `truncatedOldestCovered !== null` | the two truncation negatives |
| 9 | Worker: change `LIMIT ?` bind back to `DECISIONS_LIMIT` | the 1500-row route test and the D1 test |
| 10 | Worker: hardcode `truncated: false` on `/api/resolution-labels` | the 500-event label test only |

- [ ] **Step 3: Record the results**

For each mutation, note the exact test names that failed. Any mutation that kills nothing means the corresponding guard is untested; write the missing test before moving on. Any mutation that kills more tests than the table predicts means two guards share a route and the tests cannot tell them apart; split the test.

- [ ] **Step 4: Restore and confirm the tree is clean**

```bash
cp /tmp/mutation-backup/Reports.tsx src/components/
cp /tmp/mutation-backup/ResolutionStateNotice.tsx src/components/
cp /tmp/mutation-backup/index.ts worker/src/
git status --porcelain   # expect clean
```

- [ ] **Step 5: Run all four gates**

```bash
npm run test
cd worker && npm run typecheck
cd worker && npx vitest run
cd worker && npm run test:d1
```

Expected: all four exit 0. They disagree with each other regularly; a green vitest run has hidden a red `worker typecheck` in this repo before.

- [ ] **Step 6: Verify the frontend build carries both environments**

```bash
npx vite build
grep -o 'api-relay-[a-z]*\.divine\.video' dist/assets/*.js | sort -u
```

Expected: both the staging and prod API domains appear. A build without `.env.local` ships zero environments, which has caused a full frontend outage before. `.env.local` was copied into this worktree during setup.

---

## Post-implementation

- [ ] `superpowers:verification-before-completion` before claiming anything is done.
- [ ] `divine-plugin:review-before-commit` on the final diff.
- [ ] `superpowers:requesting-code-review` + `superpowers:receiving-code-review`, looped until a pass surfaces nothing left to resolve. One round is not the bar.
- [ ] Draft the PR body inline for Matt. Nothing is pushed and no PR is opened until he says go.
- [ ] After PR #186 merges, rebase onto `origin/main` and reconcile: `TestApp.tsx`'s `retryDelay: 0` should resolve to identical content, and #186's `labelsError && !resolutionLabels` banner is replaced by this branch's unified policy (cold blocks, warm banners).
- [ ] Review requested via `requesting-divine-review`, which requests the team, never an individual. Matt marks ready, not me.
