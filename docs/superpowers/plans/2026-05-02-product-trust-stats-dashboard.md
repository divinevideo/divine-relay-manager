# Product + Trust Stats Dashboard Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an in-app Product + Trust pulse and Stats & Trends page to relay-manager without changing `divine-funnelcake`.

**Architecture:** Add a relay-manager worker aggregate endpoint that composes existing Funnelcake REST reads, relay WebSocket queries, and report queue data into one dashboard payload. The frontend fetches that payload through `adminApi`, renders a compact top pulse in `RelayManager`, and exposes a `/stats` tab for details.

**Tech Stack:** Cloudflare Workers TypeScript, React 18, TanStack Query, React Router, Tailwind/shadcn UI, Vitest.

---

## File Structure

- Create `worker/src/dashboard-stats.ts`
  - Owns dashboard stat types, Funnelcake proxy reads, relay queries for recent video posts, report queue aggregation, partial-data statuses, and `handleDashboardStats`.
- Create `worker/src/dashboard-stats.test.ts`
  - Unit tests for aggregation behavior and partial failures.
- Modify `worker/src/index.ts`
  - Add `/api/dashboard-stats` route and import handler.
- Modify `src/lib/adminApi.ts`
  - Add dashboard stats response types and `fetchDashboardStats(apiUrl)`.
- Modify `src/hooks/useAdminApi.ts`
  - Bind `fetchDashboardStats`.
- Create `src/components/DashboardPulse.tsx`
  - Compact top strip with Active users, Video posts, Views / loops, Pending reports, and link to `/stats`.
- Create `src/components/DashboardPulse.test.tsx`
  - Render live, partial, and unavailable states.
- Create `src/components/StatsTrends.tsx`
  - Detail page for KPI cards, top videos, top creators, and data-source status.
- Create `src/components/StatsTrends.test.tsx`
  - Route-level rendering tests for fetched dashboard payload.
- Modify `src/components/RelayManager.tsx`
  - Add `stats` tab, render `DashboardPulse`, wire `StatsTrends`.
- Modify `src/AppRouter.tsx`
  - Add `/stats` route.

## Chunk 1: Worker Aggregate Endpoint

### Task 1: Define Dashboard Stats Contract

**Files:**
- Create: `worker/src/dashboard-stats.ts`
- Test: `worker/src/dashboard-stats.test.ts`

- [ ] **Step 1: Write failing tests for payload shape**

Add tests that import pure helpers from `dashboard-stats.ts`:

```ts
it('summarizes video activity from recent relay events', () => {
  const now = 1_800_000_000;
  const events = [
    { id: 'a', pubkey: 'alice', kind: 34236, created_at: now - 100, tags: [], content: '', sig: '' },
    { id: 'b', pubkey: 'alice', kind: 34235, created_at: now - 5000, tags: [], content: '', sig: '' },
    { id: 'c', pubkey: 'bob', kind: 22, created_at: now - 50, tags: [], content: '', sig: '' },
  ];

  expect(summarizeVideoActivity(events, now)).toEqual({
    postsLastHour: 2,
    postsLastDay: 3,
    activePublishersLastDay: 2,
  });
});

it('marks auth telemetry unavailable without failing dashboard stats', () => {
  expect(buildUnavailableAuthTelemetry()).toMatchObject({
    registrations: { status: 'unavailable' },
    logins: { status: 'unavailable' },
  });
});
```

- [ ] **Step 2: Run tests to verify RED**

Run: `npx vitest run worker/src/dashboard-stats.test.ts`

Expected: FAIL because `dashboard-stats.ts` and helpers do not exist.

- [ ] **Step 3: Implement minimal types and helpers**

Create:

```ts
export type MetricStatus = 'live' | 'partial' | 'unavailable' | 'error';

export interface DashboardMetric<T> {
  value: T;
  status: MetricStatus;
  message?: string;
}

export interface VideoActivitySummary {
  postsLastHour: number;
  postsLastDay: number;
  activePublishersLastDay: number;
}

export function summarizeVideoActivity(events: Array<{ pubkey: string; created_at: number }>, now: number): VideoActivitySummary {
  const oneHourAgo = now - 60 * 60;
  const oneDayAgo = now - 24 * 60 * 60;
  const dayPublishers = new Set<string>();

  let postsLastHour = 0;
  let postsLastDay = 0;

  for (const event of events) {
    if (event.created_at >= oneDayAgo) {
      postsLastDay += 1;
      dayPublishers.add(event.pubkey);
    }
    if (event.created_at >= oneHourAgo) {
      postsLastHour += 1;
    }
  }

  return {
    postsLastHour,
    postsLastDay,
    activePublishersLastDay: dayPublishers.size,
  };
}
```

- [ ] **Step 4: Run tests to verify GREEN**

Run: `npx vitest run worker/src/dashboard-stats.test.ts`

Expected: PASS for helper tests.

### Task 2: Fetch Existing Funnelcake Sources

**Files:**
- Modify: `worker/src/dashboard-stats.ts`
- Test: `worker/src/dashboard-stats.test.ts`

- [ ] **Step 1: Write failing tests for existing Funnelcake reads**

Mock `fetch` so:

- `https://relay.test.com/api/stats` returns `{ total_events: 100, total_videos: 25, vine_videos: 10 }`
- `https://relay.test.com/api/leaderboard/videos?period=day&limit=10` returns one entry with `views` and `loops`
- `https://relay.test.com/api/leaderboard/creators?period=day&limit=10` returns one creator

Assert `fetchFunnelcakeDashboardSources('https://relay.test.com')` returns stats, top videos, top creators, and summed day views/loops from returned entries.

- [ ] **Step 2: Run tests to verify RED**

Run: `npx vitest run worker/src/dashboard-stats.test.ts`

Expected: FAIL because `fetchFunnelcakeDashboardSources` is missing.

- [ ] **Step 3: Implement existing endpoint reads only**

Use `deriveFunnelcakeApiUrl(env.RELAY_URL, env.FUNNELCAKE_API_URL)` from `./funnelcake-proxy`.

Fetch only existing endpoints:

```ts
const [stats, videos, creators] = await Promise.allSettled([
  fetchJson<PlatformStats>(`${baseUrl}/api/stats`),
  fetchJson<LeaderboardResponse<LeaderboardVideo>>(`${baseUrl}/api/leaderboard/videos?period=day&limit=10`),
  fetchJson<LeaderboardResponse<LeaderboardCreator>>(`${baseUrl}/api/leaderboard/creators?period=day&limit=10`),
]);
```

If a source rejects, return that group with `status: 'error'` and keep the rest.

- [ ] **Step 4: Run tests to verify GREEN**

Run: `npx vitest run worker/src/dashboard-stats.test.ts`

Expected: PASS, including partial failure behavior.

### Task 3: Add Relay and Trust Aggregation

**Files:**
- Modify: `worker/src/dashboard-stats.ts`
- Test: `worker/src/dashboard-stats.test.ts`

- [ ] **Step 1: Write failing tests for relay/trust aggregation**

Stub `WebSocket` so it returns:

- recent video events for `{ kinds: [21, 22, 34235, 34236], since: now - 86400 }`
- report events for `{ kinds: [1984], limit: 200 }`
- resolution labels for `{ kinds: [1985], '#L': ['moderation/resolution'], limit: 500 }`

Assert pending report targets exclude resolved targets.

- [ ] **Step 2: Run tests to verify RED**

Run: `npx vitest run worker/src/dashboard-stats.test.ts`

Expected: FAIL because relay/trust aggregation is missing.

- [ ] **Step 3: Implement relay query helper and trust summary**

Use a local `queryRelayEvents(filter, relayUrl)` helper modeled on `queryRelay` in `worker/src/index.ts`. Keep timeout at 5 seconds.

Trust summary:

- Report target ID comes from first `e` tag, else first `p` tag.
- Resolution target ID comes from first `e` tag, else first `p` tag.
- Pending target count is unique report targets minus resolved targets.

- [ ] **Step 4: Run tests to verify GREEN**

Run: `npx vitest run worker/src/dashboard-stats.test.ts`

Expected: PASS.

### Task 4: Expose `/api/dashboard-stats`

**Files:**
- Modify: `worker/src/index.ts`
- Modify: `worker/src/dashboard-stats.ts`
- Test: `worker/src/dashboard-stats.test.ts`

- [ ] **Step 1: Write failing route test**

Call worker fetch:

```ts
const request = new Request('http://localhost/api/dashboard-stats', {
  headers: { 'Cf-Access-Jwt-Assertion': 'test' },
});

const response = await worker.fetch(request, env as never, mockCtx);
expect(response.status).toBe(200);
expect(await response.json()).toMatchObject({ success: true });
```

- [ ] **Step 2: Run tests to verify RED**

Run: `npx vitest run worker/src/dashboard-stats.test.ts`

Expected: FAIL because route is not registered.

- [ ] **Step 3: Register route**

In `worker/src/index.ts`:

```ts
import { handleDashboardStats } from './dashboard-stats';
```

Inside the authenticated route block:

```ts
if (path === '/api/dashboard-stats' && request.method === 'GET') {
  return handleDashboardStats(env, corsHeaders);
}
```

- [ ] **Step 4: Run tests to verify GREEN**

Run: `npx vitest run worker/src/dashboard-stats.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit worker endpoint**

```bash
git add worker/src/index.ts worker/src/dashboard-stats.ts worker/src/dashboard-stats.test.ts
git commit -m "feat: add dashboard stats aggregate endpoint"
```

## Chunk 2: Frontend API Contract

### Task 5: Add Admin API Client

**Files:**
- Modify: `src/lib/adminApi.ts`
- Modify: `src/lib/adminApi.test.ts`
- Modify: `src/hooks/useAdminApi.ts`

- [ ] **Step 1: Write failing client test**

Add to `src/lib/adminApi.test.ts`:

```ts
it('fetchDashboardStats calls /api/dashboard-stats', async () => {
  mockFetch.mockResolvedValueOnce({
    ok: true,
    json: async () => ({ success: true, stats: { generatedAt: '2026-05-02T00:00:00.000Z' } }),
  });

  const result = await fetchDashboardStats(API_URL);

  expect(mockFetch).toHaveBeenCalledWith(
    `${API_URL}/api/dashboard-stats`,
    expect.objectContaining({ method: 'GET' }),
  );
  expect(result.success).toBe(true);
});
```

- [ ] **Step 2: Run tests to verify RED**

Run: `npx vitest run src/lib/adminApi.test.ts`

Expected: FAIL because `fetchDashboardStats` is missing.

- [ ] **Step 3: Add types and client function**

Export `DashboardStatsResponse` and `fetchDashboardStats(apiUrl)`.

```ts
export async function fetchDashboardStats(apiUrl: string): Promise<DashboardStatsResponse> {
  return apiRequest<DashboardStatsResponse>(apiUrl, '/api/dashboard-stats', 'GET');
}
```

Bind it in `useAdminApi()`.

- [ ] **Step 4: Run tests to verify GREEN**

Run: `npx vitest run src/lib/adminApi.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit API client**

```bash
git add src/lib/adminApi.ts src/lib/adminApi.test.ts src/hooks/useAdminApi.ts
git commit -m "feat: add dashboard stats admin client"
```

## Chunk 3: Dashboard Pulse UI

### Task 6: Build Pulse Component

**Files:**
- Create: `src/components/DashboardPulse.tsx`
- Create: `src/components/DashboardPulse.test.tsx`

- [ ] **Step 1: Write failing render tests**

Mock `useAdminApi().fetchDashboardStats` to return:

- active publishers `12`
- video posts `3` last hour and `44` last day
- views/loops `1200 / 950`
- pending reports `7`

Assert those labels and values render, and that the “Open Stats & Trends” link points to `/stats`.

- [ ] **Step 2: Run tests to verify RED**

Run: `npx vitest run src/components/DashboardPulse.test.tsx`

Expected: FAIL because component does not exist.

- [ ] **Step 3: Implement `DashboardPulse`**

Use `useQuery` with query key `['dashboard-stats']` and `useAdminApi().fetchDashboardStats`.

Render four cards:

- Active users
- Video posts
- Views / loops
- Pending reports

Render unavailable/partial badges from metric status. Keep cards compact and responsive:

```tsx
<div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-4">
```

- [ ] **Step 4: Run tests to verify GREEN**

Run: `npx vitest run src/components/DashboardPulse.test.tsx`

Expected: PASS.

### Task 7: Wire Pulse Into RelayManager

**Files:**
- Modify: `src/components/RelayManager.tsx`

- [ ] **Step 1: Write failing integration test or route smoke test**

Add or extend a component test to render `RelayManager` in `TestApp` and assert `Product + Trust Pulse` appears.

- [ ] **Step 2: Run test to verify RED**

Run: `npx vitest run src/components/DashboardPulse.test.tsx`

Expected: FAIL until `RelayManager` renders pulse.

- [ ] **Step 3: Add pulse above tabs**

In `RelayManager`, import `DashboardPulse` and render it inside the main container before `Tabs`.

Change the container layout from a single `Tabs` child to a column:

```tsx
<div className="flex-1 min-h-0 overflow-hidden container mx-auto px-4 py-4 flex flex-col gap-4">
  <DashboardPulse />
  <Tabs value={currentTab} onValueChange={handleTabChange} className="flex-1 min-h-0 flex flex-col">
```

- [ ] **Step 4: Run tests to verify GREEN**

Run: `npx vitest run src/components/DashboardPulse.test.tsx`

Expected: PASS.

- [ ] **Step 5: Commit pulse**

```bash
git add src/components/DashboardPulse.tsx src/components/DashboardPulse.test.tsx src/components/RelayManager.tsx
git commit -m "feat: add product trust dashboard pulse"
```

## Chunk 4: Stats & Trends Page

### Task 8: Build Detail Page

**Files:**
- Create: `src/components/StatsTrends.tsx`
- Create: `src/components/StatsTrends.test.tsx`

- [ ] **Step 1: Write failing detail page test**

Mock dashboard stats and assert the page renders:

- `Stats & Trends`
- `Top videos today`
- `Top creators today`
- `Data sources`
- unavailable registration/login rows

- [ ] **Step 2: Run tests to verify RED**

Run: `npx vitest run src/components/StatsTrends.test.tsx`

Expected: FAIL because component does not exist.

- [ ] **Step 3: Implement `StatsTrends`**

Use the same query contract as `DashboardPulse`.

Render:

- KPI card grid
- Top videos list from `stats.funnelcake.topVideos.entries`
- Top creators list from `stats.funnelcake.topCreators.entries`
- Data-source status list

Do not add charts until the worker returns real time series.

- [ ] **Step 4: Run tests to verify GREEN**

Run: `npx vitest run src/components/StatsTrends.test.tsx`

Expected: PASS.

### Task 9: Add Route and Tab

**Files:**
- Modify: `src/AppRouter.tsx`
- Modify: `src/components/RelayManager.tsx`

- [ ] **Step 1: Write failing route/tab test**

Render `/stats` and assert the Stats & Trends tab/page appears.

- [ ] **Step 2: Run tests to verify RED**

Run: `npx vitest run src/components/StatsTrends.test.tsx`

Expected: FAIL because `/stats` is not routed.

- [ ] **Step 3: Wire route and tab**

In `AppRouter.tsx` add:

```tsx
<Route path="/stats" element={<Index />} />
```

In `RelayManager.tsx`:

- Add `{ id: 'stats', label: 'Stats', icon: BarChart3 }`
- Update `getTabFromPath` for `/stats`
- Change tab grid from `grid-cols-6` to `grid-cols-7`
- Add:

```tsx
<TabsContent value="stats" className="flex-1 min-h-0 overflow-auto mt-4">
  <StatsTrends />
</TabsContent>
```

- [ ] **Step 4: Run tests to verify GREEN**

Run: `npx vitest run src/components/StatsTrends.test.tsx`

Expected: PASS.

- [ ] **Step 5: Commit detail page**

```bash
git add src/components/StatsTrends.tsx src/components/StatsTrends.test.tsx src/AppRouter.tsx src/components/RelayManager.tsx
git commit -m "feat: add stats trends page"
```

## Chunk 5: Verification

### Task 10: Full Verification

**Files:**
- No new files.

- [ ] **Step 1: Run focused tests**

```bash
npx vitest run worker/src/dashboard-stats.test.ts src/lib/adminApi.test.ts src/components/DashboardPulse.test.tsx src/components/StatsTrends.test.tsx
```

Expected: PASS.

- [ ] **Step 2: Run type check**

```bash
npx tsc -p tsconfig.app.json --noEmit
```

Expected: PASS.

- [ ] **Step 3: Run full test command**

```bash
npm run test
```

Expected: PASS. This runs install, type-check, lint, Vitest, and Vite build.

- [ ] **Step 4: Start dev server for manual check**

```bash
npm run dev -- --host 127.0.0.1
```

Open the printed local URL and verify:

- The dashboard pulse appears above tabs
- The pulse link opens `/stats`
- The `Stats` tab opens the detail page
- Missing registration/login telemetry is clearly labeled unavailable
- Reports, Events, Users, Labels, Settings, and Debug tabs still work

- [ ] **Step 5: Final status**

```bash
git status --short
```

Expected: only intentional changes or unrelated pre-existing untracked files.
