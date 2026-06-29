# Greenlight Consent Funnel Dashboard v1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `GET /api/age-review/funnel` endpoint and a funnel summary panel to relay-manager, showing the 13-15 Greenlight cohort moving from request through approval, sourced from D1 (moderation outcomes) plus Zendesk tag counts (helpdesk intake).

**Architecture:** A new admin-guarded worker endpoint runs one D1 group-by over `age_review_cases` and a few Zendesk Search counts, buckets them into funnel stages, and returns a small JSON payload. A React panel in the existing Age Review tab renders it. The endpoint is the durable contract that admin.divine.video can syndicate later (out of scope here). All work lives in the `divine-relay-manager` repo.

**Tech Stack:** Cloudflare Workers (TypeScript), D1, Zendesk Search API, React + TanStack Query, shadcn/ui, Vitest.

## Global Constraints

- Repo: `divine-relay-manager`. No new dependencies.
- D1 schema is maintained at runtime by `ensureSchema`; this feature adds **no** schema change. Never run `wrangler d1 migrations apply`.
- Reuse existing helpers: `json(body, status, corsHeaders)`, `resolveZendeskCreds(env)`, `apiRequest<T>(apiUrl, path, method)`. Do not reimplement them.
- Zendesk auth pattern (verbatim from `zendesk-sync.ts`): `btoa(\`${email}/token:${apiToken}\`)`, base `https://${subdomain}.zendesk.com`, header `Authorization: Basic ${auth}`.
- Graceful degradation: a Zendesk failure must never block the moderation (D1) half of the response.
- Run `npx eslint .` before any push (tsc + tests are not enough for this repo).
- Commits: Conventional Commit style, no `Co-Authored-By` lines.
- Canonical values (verbatim): age bands `under_13` | `age_13_15` | `age_16_plus_claimed`; terminal states `cleared`, `denied_closed`; `created_via` of `report` | `minor_onboarding`. `AGE_BANDS` and `TERMINAL_STATES` are exported from `shared/age-review.ts`.

---

### Task 1: Funnel types and moderation bucketing

**Files:**
- Modify: `shared/age-review.ts` (append exports)
- Modify: `worker/src/age-review.ts` (add pure `bucketModerationCounts`)
- Test: `worker/src/age-review.test.ts` (append a describe block)

**Interfaces:**
- Produces: `FunnelModerationCounts` and `AgeReviewFunnelResponse` types (shared); `bucketModerationCounts(rows: FunnelRow[]): FunnelModerationCounts` (worker).
- Consumes: `AgeBand`, `TERMINAL_STATES` from `shared/age-review.ts`.

- [ ] **Step 1: Add the shared types**

In `shared/age-review.ts`, append:

```ts
export interface FunnelModerationCounts {
  in_progress: number;
  approved: { total: number; restored: number; new_minor: number };
  denied_expired: number;
}

export interface AgeReviewFunnelResponse {
  success: boolean;
  age_band: AgeBand;
  helpdesk: {
    source: 'zendesk';
    band_scope: 'all_bands';
    reports_in: number | null;
    requests_in: number | null;
    video_received: number | null;
  };
  moderation: FunnelModerationCounts & { source: 'd1'; band_scope: AgeBand };
  generated_at: string;
}
```

- [ ] **Step 2: Write the failing test**

In `worker/src/age-review.test.ts`, add the import `bucketModerationCounts` to the existing `./age-review` import block, then append:

```ts
describe('bucketModerationCounts', () => {
  it('sums non-terminal states into in_progress and splits approved by created_via', () => {
    const result = bucketModerationCounts([
      { state: 'cleared', created_via: 'report', c: 3 },
      { state: 'cleared', created_via: 'minor_onboarding', c: 2 },
      { state: 'denied_closed', created_via: 'report', c: 1 },
      { state: 'submitted_for_review', created_via: 'report', c: 4 },
      { state: 'restricted_pending_parental_consent', created_via: 'report', c: 5 },
    ]);
    expect(result.in_progress).toBe(9);
    expect(result.approved).toEqual({ total: 5, restored: 3, new_minor: 2 });
    expect(result.denied_expired).toBe(1);
  });

  it('returns zeroes for an empty set', () => {
    expect(bucketModerationCounts([])).toEqual({
      in_progress: 0,
      approved: { total: 0, restored: 0, new_minor: 0 },
      denied_expired: 0,
    });
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx vitest run worker/src/age-review.test.ts -t bucketModerationCounts`
Expected: FAIL with "bucketModerationCounts is not defined" (or import error).

- [ ] **Step 4: Implement the pure function**

In `worker/src/age-review.ts`, add the import `FunnelModerationCounts` to the existing `../../shared/age-review` import block, then add near the other exported helpers:

```ts
export interface FunnelRow {
  state: string;
  created_via: string | null;
  c: number;
}

export function bucketModerationCounts(rows: FunnelRow[]): FunnelModerationCounts {
  const terminal = new Set<string>(TERMINAL_STATES);
  let in_progress = 0;
  let approvedTotal = 0;
  let approvedNewMinor = 0;
  let denied_expired = 0;

  for (const row of rows) {
    const count = row.c ?? 0;
    if (row.state === 'cleared') {
      approvedTotal += count;
      if (row.created_via === 'minor_onboarding') approvedNewMinor += count;
    } else if (row.state === 'denied_closed') {
      denied_expired += count;
    } else if (!terminal.has(row.state)) {
      in_progress += count;
    }
  }

  return {
    in_progress,
    approved: {
      total: approvedTotal,
      restored: approvedTotal - approvedNewMinor,
      new_minor: approvedNewMinor,
    },
    denied_expired,
  };
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run worker/src/age-review.test.ts -t bucketModerationCounts`
Expected: PASS (2 tests).

- [ ] **Step 6: Commit**

```bash
git add shared/age-review.ts worker/src/age-review.ts worker/src/age-review.test.ts
git commit -m "feat(age-review): add funnel types and moderation bucketing"
```

---

### Task 2: Zendesk tag-count helper

**Files:**
- Modify: `worker/src/age-review.ts` (add `fetchZendeskTagCount`)
- Test: `worker/src/age-review.test.ts` (append a describe block)

**Interfaces:**
- Produces: `fetchZendeskTagCount(creds: { subdomain: string; email: string; apiToken: string }, query: string): Promise<number | null>`.
- Uses the Zendesk Search count endpoint `/api/v2/search/count.json?query=...`, which returns `{ "count": number }`.

- [ ] **Step 1: Write the failing test**

In `worker/src/age-review.test.ts`, add `fetchZendeskTagCount` to the `./age-review` import block, then append:

```ts
describe('fetchZendeskTagCount', () => {
  const creds = { subdomain: 'rabblelabs', email: 'a@b.co', apiToken: 'tok' };

  afterEach(() => { vi.unstubAllGlobals(); });

  it('builds the search/count URL and returns the count', async () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ count: 7 }) });
    vi.stubGlobal('fetch', mockFetch);

    const result = await fetchZendeskTagCount(creds, 'type:ticket tags:age-review-response');

    expect(result).toBe(7);
    const calledUrl = mockFetch.mock.calls[0][0] as string;
    expect(calledUrl).toContain('https://rabblelabs.zendesk.com/api/v2/search/count.json?query=');
    expect(calledUrl).toContain(encodeURIComponent('type:ticket tags:age-review-response'));
  });

  it('returns null on a non-ok response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, json: async () => ({}) }));
    expect(await fetchZendeskTagCount(creds, 'q')).toBeNull();
  });

  it('returns null when fetch throws', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network')));
    expect(await fetchZendeskTagCount(creds, 'q')).toBeNull();
  });
});
```

Ensure `afterEach` is in the file's vitest import (`import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';`).

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run worker/src/age-review.test.ts -t fetchZendeskTagCount`
Expected: FAIL with "fetchZendeskTagCount is not defined".

- [ ] **Step 3: Implement the helper**

In `worker/src/age-review.ts`, add:

```ts
export async function fetchZendeskTagCount(
  creds: { subdomain: string; email: string; apiToken: string },
  query: string,
): Promise<number | null> {
  try {
    const auth = btoa(`${creds.email}/token:${creds.apiToken}`);
    const url = `https://${creds.subdomain}.zendesk.com/api/v2/search/count.json?query=${encodeURIComponent(query)}`;
    const response = await fetch(url, { headers: { Authorization: `Basic ${auth}` } });
    if (!response.ok) return null;
    const data = await response.json() as { count?: number };
    return typeof data.count === 'number' ? data.count : null;
  } catch {
    return null;
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run worker/src/age-review.test.ts -t fetchZendeskTagCount`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add worker/src/age-review.ts worker/src/age-review.test.ts
git commit -m "feat(age-review): add Zendesk tag-count helper"
```

---

### Task 3: Funnel handler and route

**Files:**
- Modify: `worker/src/age-review.ts` (add `handleGetAgeReviewFunnel`)
- Modify: `worker/src/index.ts` (import + route, beside the cases route at line 559)
- Test: `worker/src/age-review.test.ts` (append a describe block)

**Interfaces:**
- Consumes: `bucketModerationCounts`, `fetchZendeskTagCount` (Tasks 1-2), `resolveZendeskCreds(env)`, `json(...)`, `AGE_BANDS`.
- Produces: `handleGetAgeReviewFunnel(request: Request, env: AgeReviewEnv, corsHeaders: Record<string, string>): Promise<Response>` returning an `AgeReviewFunnelResponse`.

- [ ] **Step 1: Write the failing test**

In `worker/src/age-review.test.ts`, add `handleGetAgeReviewFunnel` to the `./age-review` import block, then append:

```ts
describe('handleGetAgeReviewFunnel', () => {
  const cors = { 'Access-Control-Allow-Origin': '*' };
  const groupRows = [
    { state: 'cleared', created_via: 'report', c: 3 },
    { state: 'cleared', created_via: 'minor_onboarding', c: 2 },
    { state: 'denied_closed', created_via: 'report', c: 1 },
    { state: 'submitted_for_review', created_via: 'report', c: 4 },
  ];
  const mockDb = {
    prepare: vi.fn().mockReturnValue({
      bind: vi.fn().mockReturnValue({ all: vi.fn().mockResolvedValue({ results: groupRows }) }),
    }),
  };
  const req = new Request('https://api.test/api/age-review/funnel?age_band=age_13_15');

  afterEach(() => { vi.unstubAllGlobals(); });

  it('returns moderation counts and nulls helpdesk when Zendesk creds are absent', async () => {
    const env = makeEnv(mockDb); // no ZENDESK_* set
    const res = await handleGetAgeReviewFunnel(req, env, cors);
    const body = await res.json() as import('../../shared/age-review').AgeReviewFunnelResponse;

    expect(res.status).toBe(200);
    expect(body.moderation.approved).toEqual({ total: 5, restored: 3, new_minor: 2 });
    expect(body.moderation.in_progress).toBe(4);
    expect(body.moderation.denied_expired).toBe(1);
    expect(body.helpdesk).toMatchObject({ reports_in: null, requests_in: null, video_received: null });
    expect(body.age_band).toBe('age_13_15');
  });

  it('populates helpdesk counts when Zendesk creds resolve', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ count: 9 }) }));
    const env = makeEnv(mockDb, {
      ZENDESK_SUBDOMAIN: 'rabblelabs', ZENDESK_EMAIL: 'a@b.co', ZENDESK_API_TOKEN: 'tok',
    });
    const res = await handleGetAgeReviewFunnel(req, env, cors);
    const body = await res.json() as import('../../shared/age-review').AgeReviewFunnelResponse;

    expect(body.helpdesk.requests_in).toBe(9);
    expect(body.helpdesk.video_received).toBe(9);
    expect(body.helpdesk.reports_in).toBe(9);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run worker/src/age-review.test.ts -t handleGetAgeReviewFunnel`
Expected: FAIL with "handleGetAgeReviewFunnel is not defined".

- [ ] **Step 3: Implement the handler**

In `worker/src/age-review.ts`, add `AgeBand`, `AGE_BANDS` are already imported. Add `type AgeReviewFunnelResponse` to the `../../shared/age-review` import block. Then add:

```ts
export async function handleGetAgeReviewFunnel(
  request: Request,
  env: AgeReviewEnv,
  corsHeaders: Record<string, string>,
): Promise<Response> {
  if (!env.DB) return json({ success: false, error: 'Database not configured' }, 500, corsHeaders);

  const url = new URL(request.url);
  const bandParam = url.searchParams.get('age_band');
  const ageBand: AgeBand = bandParam && AGE_BANDS.includes(bandParam as AgeBand)
    ? (bandParam as AgeBand)
    : 'age_13_15';

  const rows = await env.DB.prepare(
    'SELECT state, created_via, COUNT(*) AS c FROM age_review_cases WHERE suspected_age_band = ? GROUP BY state, created_via',
  ).bind(ageBand).all<FunnelRow>();
  const moderation = bucketModerationCounts(rows.results ?? []);

  let reports_in: number | null = null;
  let requests_in: number | null = null;
  let video_received: number | null = null;

  const creds = await resolveZendeskCreds(env);
  if (creds) {
    [requests_in, video_received, reports_in] = await Promise.all([
      fetchZendeskTagCount(creds, 'type:ticket tags:age-review-response'),
      fetchZendeskTagCount(creds, 'type:ticket tags:consent_video_received'),
      fetchZendeskTagCount(creds, 'type:ticket tags:age-review -tags:age-review-response'),
    ]);
  }

  const payload: AgeReviewFunnelResponse = {
    success: true,
    age_band: ageBand,
    helpdesk: { source: 'zendesk', band_scope: 'all_bands', reports_in, requests_in, video_received },
    moderation: { source: 'd1', band_scope: ageBand, ...moderation },
    generated_at: new Date().toISOString(),
  };
  return json(payload, 200, corsHeaders);
}
```

- [ ] **Step 4: Wire the route**

In `worker/src/index.ts`, add `handleGetAgeReviewFunnel,` to the import block from `./age-review` (around line 21). Then, immediately before the existing cases route at line 559, add:

```ts
      if (path === '/api/age-review/funnel' && request.method === 'GET') {
        return handleGetAgeReviewFunnel(request, env, corsHeaders);
      }
```

This sits inside the same admin-guarded block as the other `/api/age-review/*` routes, so it inherits `verifyAdminAccess`.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run worker/src/age-review.test.ts -t handleGetAgeReviewFunnel`
Expected: PASS (2 tests).

- [ ] **Step 6: Typecheck the worker route change**

Run: `npx tsc -p tsconfig.app.json --noEmit`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add worker/src/age-review.ts worker/src/index.ts worker/src/age-review.test.ts
git commit -m "feat(age-review): add funnel endpoint GET /api/age-review/funnel"
```

---

### Task 4: Frontend API client and hook binding

**Files:**
- Modify: `src/lib/adminApi.ts` (add `getAgeReviewFunnel`)
- Modify: `src/hooks/useAdminApi.ts` (bind it)

**Interfaces:**
- Produces: `adminApi.getAgeReviewFunnel(apiUrl: string, ageBand?: string): Promise<AgeReviewFunnelResponse>` and the bound `api.getAgeReviewFunnel(ageBand?: string)`.
- Consumes: `apiRequest`, `AgeReviewFunnelResponse` (Task 1).

- [ ] **Step 1: Add the API function**

In `src/lib/adminApi.ts`, near `getAgeReviewCases`, add:

```ts
export async function getAgeReviewFunnel(
  apiUrl: string,
  ageBand: string = 'age_13_15',
): Promise<import('../../shared/age-review').AgeReviewFunnelResponse> {
  return apiRequest<import('../../shared/age-review').AgeReviewFunnelResponse>(
    apiUrl,
    `/api/age-review/funnel?age_band=${encodeURIComponent(ageBand)}`,
    'GET',
  );
}
```

- [ ] **Step 2: Bind it in the hook**

In `src/hooks/useAdminApi.ts`, inside the `boundApi` object next to `getAgeReviewCases`, add:

```ts
    getAgeReviewFunnel: (ageBand?: string) =>
      adminApi.getAgeReviewFunnel(apiUrl, ageBand),
```

- [ ] **Step 3: Typecheck**

Run: `npx tsc -p tsconfig.app.json --noEmit`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add src/lib/adminApi.ts src/hooks/useAdminApi.ts
git commit -m "feat(age-review): add funnel API client and hook binding"
```

---

### Task 5: Funnel panel component and mount

**Files:**
- Create: `src/components/AgeReviewFunnel.tsx`
- Modify: `src/components/AgeReview.tsx` (mount the panel above the split layout)
- Test: `src/components/AgeReviewFunnel.test.tsx`

**Interfaces:**
- Consumes: `useAdminApi().getAgeReviewFunnel`, `AgeReviewFunnelResponse`, shadcn `Card`, `Badge`.
- Produces: the `AgeReviewFunnel` component (default-free named export).

- [ ] **Step 1: Write the failing render test**

Create `src/components/AgeReviewFunnel.test.tsx`:

```tsx
import { describe, it, expect, vi } from 'vitest';
import '@testing-library/jest-dom';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactElement } from 'react';
import { AgeReviewFunnel } from './AgeReviewFunnel';

vi.mock('@/hooks/useAdminApi', () => ({
  useAdminApi: () => ({
    getAgeReviewFunnel: vi.fn().mockResolvedValue({
      success: true,
      age_band: 'age_13_15',
      helpdesk: { source: 'zendesk', band_scope: 'all_bands', reports_in: 12, requests_in: 8, video_received: 5 },
      moderation: { source: 'd1', band_scope: 'age_13_15', in_progress: 4, approved: { total: 3, restored: 2, new_minor: 1 }, denied_expired: 1 },
      generated_at: '2026-06-29T00:00:00Z',
    }),
  }),
}));

function renderWithClient(ui: ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

describe('AgeReviewFunnel', () => {
  it('renders stage labels and counts from the payload', async () => {
    renderWithClient(<AgeReviewFunnel />);
    expect(await screen.findByText('Requests in')).toBeInTheDocument();
    expect(await screen.findByText('8')).toBeInTheDocument();
    expect(await screen.findByText('Video received')).toBeInTheDocument();
    expect(await screen.findByText('Approved')).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/components/AgeReviewFunnel.test.tsx`
Expected: FAIL (module `./AgeReviewFunnel` not found).

- [ ] **Step 3: Implement the component**

Create `src/components/AgeReviewFunnel.tsx`:

```tsx
import { useQuery } from "@tanstack/react-query";
import { useAdminApi } from "@/hooks/useAdminApi";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";

function fmt(n: number | null): string {
  return n == null ? "—" : String(n);
}

export function AgeReviewFunnel() {
  const api = useAdminApi();
  const { data, isLoading } = useQuery({
    queryKey: ['age-review-funnel', 'age_13_15'],
    queryFn: () => api.getAgeReviewFunnel('age_13_15'),
    staleTime: 60_000,
    refetchInterval: 60_000,
  });

  if (isLoading) {
    return (
      <Card className="p-3">
        <Skeleton className="h-5 w-48 mb-3" />
        <div className="grid grid-cols-3 sm:grid-cols-6 gap-3">
          {Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-14" />)}
        </div>
      </Card>
    );
  }

  if (!data?.success) {
    return (
      <Card className="p-3 text-sm text-muted-foreground">
        Funnel data unavailable.
      </Card>
    );
  }

  const stages: { label: string; value: number | null; sub?: string }[] = [
    { label: "Reports in", value: data.helpdesk.reports_in, sub: "helpdesk" },
    { label: "Requests in", value: data.helpdesk.requests_in, sub: "helpdesk" },
    { label: "Video received", value: data.helpdesk.video_received, sub: "helpdesk" },
    { label: "In progress", value: data.moderation.in_progress, sub: "moderation" },
    { label: "Approved", value: data.moderation.approved.total, sub: `${data.moderation.approved.restored} restored / ${data.moderation.approved.new_minor} new` },
    { label: "Denied / expired", value: data.moderation.denied_expired, sub: "moderation" },
  ];

  return (
    <Card className="p-3">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-medium">Greenlight: age-review consent funnel</h3>
        <Badge variant="secondary" className="text-xs">13-15</Badge>
      </div>
      <div className="grid grid-cols-3 sm:grid-cols-6 gap-3">
        {stages.map((s) => (
          <div key={s.label} className="rounded-md border p-2">
            <div className="text-xl font-semibold tabular-nums">{fmt(s.value)}</div>
            <div className="text-xs font-medium mt-0.5">{s.label}</div>
            {s.sub && <div className="text-[10px] text-muted-foreground mt-0.5">{s.sub}</div>}
          </div>
        ))}
      </div>
      <div className="text-[10px] text-muted-foreground mt-2">
        Helpdesk stages count all age-review tickets; moderation stages are 13-15 only.
      </div>
    </Card>
  );
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/components/AgeReviewFunnel.test.tsx`
Expected: PASS.

- [ ] **Step 5: Mount the panel in the Age Review tab**

In `src/components/AgeReview.tsx`, add the import at the top:

```tsx
import { AgeReviewFunnel } from "@/components/AgeReviewFunnel";
```

Replace the desktop `return` block (the `<div className="h-full flex gap-4">` ... closing `</div>` at the end of the component) with:

```tsx
  return (
    <div className="h-full flex flex-col gap-4">
      <AgeReviewFunnel />
      <div className="flex-1 min-h-0 flex gap-4">
        <Card className="w-[360px] shrink-0 flex flex-col overflow-hidden">
          {listContent}
        </Card>
        <Card className="flex-1 overflow-hidden">
          {detailContent}
        </Card>
      </div>
    </div>
  );
```

(The mobile `return` block is left unchanged for v1.)

- [ ] **Step 6: Typecheck and lint**

Run: `npx tsc -p tsconfig.app.json --noEmit && npx eslint .`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add src/components/AgeReviewFunnel.tsx src/components/AgeReviewFunnel.test.tsx src/components/AgeReview.tsx
git commit -m "feat(age-review): add Greenlight funnel panel to Age Review tab"
```

---

## Final verification

- [ ] Run the full pipeline: `npm test` (runs tsc, eslint, vitest, and the build).
- [ ] Manual check on staging: open the Age Review tab and confirm the funnel card renders, the moderation counts match the case list for the 13-15 band, and the helpdesk counts populate (or show "—" if Zendesk creds are not configured in that environment).

## Self-review notes (coverage against spec)

- Funnel stages (spec table): reports/requests/video from Zendesk tags, in-progress/approved/denied from D1 group-by. Covered in Tasks 1-3 and the panel in Task 5.
- Two-source assembly and graceful Zendesk degradation: Task 3, with an explicit no-creds test.
- Band scope labeling (helpdesk all-bands, moderation 13-15): encoded in the response `band_scope` fields and surfaced in the panel footnote.
- Admin auth: inherited by route placement (Task 3, Step 4).
- Out of scope for v1 (per spec follow-ons): Zendesk band tags, per-case video join, admin.divine.video syndication, the webform. Not in this plan by design.
