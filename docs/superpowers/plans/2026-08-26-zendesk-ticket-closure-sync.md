# Zendesk Ticket Closure Sync — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make relay-manager moderation actions reliably close linked Zendesk content-report tickets and clear the corresponding reports from the queue, with a visible linked-ticket panel and a manual close fallback.

**Architecture:** Three independent, independently-shippable PRs. PR 1 fixes the worker linkage/closure (derive author at parse time, close all matching tickets, normalize casing). PR 2 fixes the Reports queue so an event-scoped report clears when its author is banned. PR 3 adds admin-gated ticket read/close endpoints and an always-present linked-ticket panel in the report detail.

**Tech Stack:** Cloudflare Workers + D1 (worker), React 18 + TypeScript + TanStack Query 5 (frontend), Vitest.

**Spec:** `docs/superpowers/specs/2026-08-26-zendesk-ticket-closure-sync-design.md`

## Global Constraints

- Ticket closure is a **non-critical** side effect of moderation actions: awaited inside try/catch, logged on failure, never blocks the primary action. Never fire-and-forget.
- **New ticket endpoints are admin-gated.** Register them AFTER the `verifyAdminAccess()` gate in `worker/src/index.ts` (alongside `/api/decisions`). Do NOT place them under `/api/zendesk/*` — that prefix bypasses the admin gate (it has webhook/JWT auth instead).
- **Manual close is Zendesk-only.** It never writes a `moderation_decisions` row.
- Worker type-check gate: `cd worker && npm run typecheck`. Frontend type-check: `npx tsc -p tsconfig.app.json --noEmit` (bare `tsc --noEmit` is a false green).
- Worker tests: `cd worker && npx vitest run` excludes `*.d1.test.ts`; run `cd worker && npm run test:d1` for any change touching D1 reads/writes.
- Do not hardcode domains. Zendesk subdomain resolves via `resolveZendeskCreds(env)`.
- No secrets in code, logs, or fixtures. Use full 64-hex ids in tests (never truncate).

---

## PR 1 — Worker: reliable linkage + closure

Highest impact on the reported symptom. Two tasks, one commit each.

### Task 1.1: Close ALL matching open tickets + normalize target casing

**Files:**
- Modify: `worker/src/zendesk-sync.ts` (`syncZendeskAfterAction`, ~lines 143-227)
- Test: `worker/src/zendesk-sync.test.ts` (existing mock-DB pattern)

**Interfaces:**
- Consumes: existing `ZendeskSyncEnv`, `addZendeskInternalNote(ticketId, note, env, solve)`.
- Produces: no signature change. `syncZendeskAfterAction(env, action, targetType, targetId, moderator)` now resolves every matching open ticket, not just the first.

- [ ] **Step 1: Write the failing test** — add to `worker/src/zendesk-sync.test.ts`. Follow the file's existing mock-DB harness (it intercepts SQL by substring). Assert that when the lookup returns two open tickets for a target, both get an internal note + a `status='solved'` PUT, and both get a D1 `UPDATE ... status='resolved'`.

```ts
it('closes every open ticket linked to the same target, not just the first', async () => {
  // Arrange: mock DB returns TWO open tickets for the pubkey lookup, and
  // capture the fetch() calls to Zendesk + the UPDATE statements.
  const tickets = [{ ticket_id: 111 }, { ticket_id: 222 }];
  const updates: number[] = [];
  const solved: number[] = [];
  const env = makeEnvWithTicketLookup(tickets, {
    onUpdate: (id) => updates.push(id),
    onZendeskSolve: (id) => solved.push(id),
  });

  await syncZendeskAfterAction(env, 'ban_pubkey', 'pubkey', 'a'.repeat(64), 'b'.repeat(64));

  expect(solved.sort()).toEqual([111, 222]);
  expect(updates.sort()).toEqual([111, 222]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd worker && npx vitest run src/zendesk-sync.test.ts -t "closes every open ticket"`
Expected: FAIL — only ticket 111 is closed (current `.first()` behavior).

- [ ] **Step 3: Implement — select all, loop closures, normalize casing**

In `syncZendeskAfterAction`, replace the two `.first()` lookups with `.all()` and lowercase the bound target:

```ts
const id = targetId.toLowerCase();
let linkedTickets: Array<{ ticket_id: number }> = [];

if (targetType === 'event') {
  const res = await env.DB.prepare(
    `SELECT ticket_id FROM zendesk_tickets WHERE lower(event_id) = ? AND status = 'open'`
  ).bind(id).all<{ ticket_id: number }>();
  linkedTickets = res.results ?? [];
} else if (targetType === 'pubkey') {
  const res = await env.DB.prepare(
    `SELECT ticket_id FROM zendesk_tickets WHERE lower(author_pubkey) = ? AND status = 'open'`
  ).bind(id).all<{ ticket_id: number }>();
  linkedTickets = res.results ?? [];
}

if (linkedTickets.length === 0) {
  console.log('[syncZendeskAfterAction] No linked open ticket found, skipping');
  return;
}
```

Then wrap the existing note-build + `addZendeskInternalNote` + `UPDATE` in a loop over `linkedTickets`, using `ticket.ticket_id` in place of `linked.ticket_id`. Keep `isResolution`, `note`, and `actionDisplay` computed once before the loop.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd worker && npx vitest run src/zendesk-sync.test.ts`
Expected: PASS (new multi-ticket test + existing single-ticket tests).

- [ ] **Step 5: Type-check + commit**

```bash
cd worker && npm run typecheck
git add worker/src/zendesk-sync.ts worker/src/zendesk-sync.test.ts
git commit -m "fix(zendesk): close all open tickets for a target, case-insensitively"
```

> Note on `lower(...)` in the WHERE: existing rows may be stored mixed-case; `lower()` on the column makes the match robust regardless of stored casing. Task 1.2 additionally normalizes on write so new rows are already lowercase.

### Task 1.2: Derive `author_pubkey` from the event at parse time + lowercase on store

**Files:**
- Modify: `worker/src/index.ts` (`handleParseReport`, ~lines 2866-2930)
- Test: `worker/src/*.d1.test.ts` (new or existing D1-backed test for parse-report)

**Interfaces:**
- Consumes: existing `queryRelay({ ids, limit }, env.RELAY_URL)` used later for enrichment; `ensureZendeskTable`.
- Produces: a `zendesk_tickets` row whose `author_pubkey` is populated (lowercased) whenever the reported event is resolvable, even if the description carried no hex pubkey. `event_id` stored lowercased.

- [ ] **Step 1: Write the failing test** — a D1-backed test that posts a parse-report body whose description contains an `Event ID` but no pubkey line, with a stubbed relay returning that event authored by a known pubkey. Assert the stored row has `author_pubkey` = that pubkey (lowercase) and `event_id` lowercased.

```ts
it('derives author_pubkey from the reported event when the description omits it', async () => {
  const eventId = 'e'.repeat(64);
  const author = 'a'.repeat(64);
  const env = makeD1Env({ relayEvent: { id: eventId, pubkey: author, kind: 32, tags: [], content: '' } });
  const description = `Event ID: ${eventId.toUpperCase()}\nReason: spam`; // uppercase id, no pubkey

  await postParseReport(env, { ticket_id: 900, description });

  const row = await env.DB.prepare(`SELECT event_id, author_pubkey FROM zendesk_tickets WHERE ticket_id = 900`).first();
  expect(row.event_id).toBe(eventId);        // lowercased
  expect(row.author_pubkey).toBe(author);    // derived from the event
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd worker && npm run test:d1 -- -t "derives author_pubkey"`
Expected: FAIL — `author_pubkey` is null (no pubkey in description, no derivation).

- [ ] **Step 3: Implement — derive before insert, lowercase both ids**

In `handleParseReport`, after computing `event_id`/`author_pubkey` from regex and before the INSERT, add derivation and normalization. Reuse the enrichment fetch by moving the reported-event lookup ahead of the insert (or add a targeted lookup when the author is missing):

```ts
let eventId = event_id ? event_id.toLowerCase() : null;
let authorPubkey = author_pubkey ? author_pubkey.toLowerCase() : null;

// Best-effort: if we have an event but no author, derive the author from it so
// account-level actions (which match on author_pubkey) can close this ticket.
if (eventId && !authorPubkey) {
  try {
    const evt = await withTimeout(
      queryRelay({ ids: [eventId], limit: 1 }, env.RELAY_URL),
      ENRICHMENT_TIMEOUT_MS,
    );
    const pk = evt?.success && evt.events?.length ? (evt.events[0] as { pubkey?: string }).pubkey : undefined;
    if (pk && /^[a-f0-9]{64}$/i.test(pk)) authorPubkey = pk.toLowerCase();
  } catch (err) {
    console.warn('[handleParseReport] author derivation failed (continuing):', err);
  }
}
```

Then bind `eventId`/`authorPubkey` (not the raw `event_id`/`author_pubkey`) in the INSERT. Leave the existing "either id required" guard using the raw regex results so behavior at the guard is unchanged. If the later enrichment block re-fetches the event, it may now reuse `authorPubkey` for the profile lookup — keep that change minimal and only if it doesn't complicate the diff.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd worker && npm run test:d1`
Expected: PASS (new derivation test + existing parse-report tests).

- [ ] **Step 5: Type-check + commit**

```bash
cd worker && npm run typecheck
git add worker/src/index.ts worker/src/*.d1.test.ts
git commit -m "fix(zendesk): derive ticket author_pubkey from the reported event; store ids lowercase"
```

**PR 1 wrap-up:** open as draft, title `fix(zendesk): reliably close linked tickets on account-level actions`. Validation note in the PR: exercised via `npm run test:d1` + `npx vitest run`; Zendesk PUT path exercised by mock; staging deploy recommended before prod.

---

## PR 2 — Frontend: event reports clear when their author is banned

Single task. The only real gap is "Ban User" (`banpubkey`), which purges without adding events to `listbannedevents`. Bulk "Delete All Content" already `banevent`s each event, so those resolve today. Using `bannedPubkeys` specifically also excludes suspend (a separate list) automatically.

### Task 2.1: Cross-resolve event reports against the banned-pubkey set

**Files:**
- Create: `src/lib/reportResolution.ts` (pure helper)
- Create: `src/lib/reportResolution.test.ts`
- Modify: `src/components/Reports.tsx` (`consolidateReports`, `ConsolidatedReport`, and the resolved filters)

**Interfaces:**
- Produces: `isConsolidatedReportResolved(report, resolvedTargets, bannedPubkeys)` where `report: { target: {type,value}, authorPubkey?: string }`, `resolvedTargets: Set<string>` (keys `type:value`), `bannedPubkeys: Set<string>`. Returns boolean.
- Consumes (Reports.tsx): `getReportTargetIds` (already imported from `@/lib/constants`), `bannedPubkeys` query data.

- [ ] **Step 1: Write the failing test** (`src/lib/reportResolution.test.ts`)

```ts
import { isConsolidatedReportResolved } from './reportResolution';

const banned = new Set(['a'.repeat(64)]);

it('resolves an event report when its author is in the banned set', () => {
  const report = { target: { type: 'event' as const, value: 'e'.repeat(64) }, authorPubkey: 'a'.repeat(64) };
  expect(isConsolidatedReportResolved(report, new Set(), banned)).toBe(true);
});

it('does not resolve an event report whose author is not banned', () => {
  const report = { target: { type: 'event' as const, value: 'e'.repeat(64) }, authorPubkey: 'c'.repeat(64) };
  expect(isConsolidatedReportResolved(report, new Set(), banned)).toBe(false);
});

it('still resolves via an exact target-key match', () => {
  const report = { target: { type: 'event' as const, value: 'e'.repeat(64) }, authorPubkey: undefined };
  expect(isConsolidatedReportResolved(report, new Set(['event:' + 'e'.repeat(64)]), new Set())).toBe(true);
});

it('does not cross-resolve a pubkey-target report by ban (that is the exact-key path)', () => {
  const report = { target: { type: 'pubkey' as const, value: 'a'.repeat(64) }, authorPubkey: 'a'.repeat(64) };
  // pubkey targets resolve only via resolvedTargets (which already includes bans); the
  // cross-resolution rule is event-only, so with an empty resolvedTargets this is false.
  expect(isConsolidatedReportResolved(report, new Set(), banned)).toBe(false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/reportResolution.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement the helper** (`src/lib/reportResolution.ts`)

```ts
export interface ResolvableReport {
  target: { type: 'event' | 'pubkey'; value: string };
  authorPubkey?: string;
}

// A consolidated report is resolved when its exact target key is in
// resolvedTargets, OR — for an EVENT-scoped report — when its author pubkey is
// in the relay's banned-pubkey set. The event cross-resolution covers the
// banpubkey purge, which removes the author's events without registering each
// one in listbannedevents (so the exact event key never appears). Using the
// banned-pubkey set specifically excludes suspend, which is a separate,
// reversible holding state on a different list.
export function isConsolidatedReportResolved(
  report: ResolvableReport,
  resolvedTargets: Set<string>,
  bannedPubkeys: Set<string>,
): boolean {
  if (resolvedTargets.has(`${report.target.type}:${report.target.value}`)) return true;
  if (report.target.type === 'event' && report.authorPubkey && bannedPubkeys.has(report.authorPubkey)) {
    return true;
  }
  return false;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/reportResolution.test.ts`
Expected: PASS.

- [ ] **Step 5: Wire into Reports.tsx**

1. In `ConsolidatedReport` add `authorPubkey?: string`.
2. In `consolidateReports`, when creating a target's entry, set `authorPubkey: getReportTargetIds(report).pubkey`.
3. Build a banned-pubkey set near the memos: `const bannedPubkeySet = useMemo(() => new Set((bannedPubkeys ?? []).map(e => e.pubkey)), [bannedPubkeys]);`
4. Replace each `!resolvedTargets.has(\`${c.target.type}:${c.target.value}\`)` filter (the `hideResolved` sites ~587, ~674, and the detail check ~739) with `!isConsolidatedReportResolved(c, resolvedTargets, bannedPubkeySet)`. Import the helper.

- [ ] **Step 6: Verify + type-check + commit**

Run: `npx vitest run src/lib/reportResolution.test.ts && npx tsc -p tsconfig.app.json --noEmit`
Expected: PASS + clean type-check.

```bash
git add src/lib/reportResolution.ts src/lib/reportResolution.test.ts src/components/Reports.tsx
git commit -m "fix(reports): clear event-scoped reports when their author is banned"
```

**PR 2 wrap-up:** draft, title `fix(reports): clear event reports when the account is banned`. Note: no visual change beyond items leaving the queue; include a before/after of the queue count.

---

## PR 3 — UI: linked-ticket panel + manual close

Four tasks. Endpoints are admin-gated.

### Task 3.1: Worker `GET /api/tickets` — list linked tickets

**Files:**
- Modify: `worker/src/index.ts` (register route after the admin gate; add `handleGetLinkedTickets`)
- Modify: `worker/src/zendesk-sync.ts` (add `getLinkedTickets` query + `zendeskTicketUrl` helper)
- Test: `worker/src/*.d1.test.ts`

**Interfaces:**
- Produces: `GET /api/tickets?event=<hex>&pubkey=<hex>` → `{ success: true, tickets: Array<{ ticket_id: number; status: string; url: string }> }`. Union of event-linked and pubkey-linked rows, deduped by `ticket_id`.
- Produces (zendesk-sync): `getLinkedTickets(env, { eventId?, pubkey? }): Promise<Array<{ ticket_id; status; url }>>`.

- [ ] **Step 1: Write the failing test** — insert two rows (one event-linked, one pubkey-linked, one row shared), call the handler, assert deduped union with correct `url`s and statuses.

```ts
it('returns deduped linked tickets for an event and/or pubkey', async () => {
  const env = makeD1Env({ zendeskSubdomain: 'divine' });
  await seedTicket(env, { ticket_id: 1, event_id: 'e'.repeat(64), status: 'open' });
  await seedTicket(env, { ticket_id: 2, author_pubkey: 'a'.repeat(64), status: 'resolved' });

  const res = await handleGetLinkedTickets(env, { eventId: 'e'.repeat(64), pubkey: 'a'.repeat(64) });
  const body = await res.json();
  expect(body.tickets.map((t:any) => t.ticket_id).sort()).toEqual([1, 2]);
  expect(body.tickets.find((t:any) => t.ticket_id === 1).url).toContain('divine.zendesk.com/agent/tickets/1');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd worker && npm run test:d1 -- -t "returns deduped linked tickets"`
Expected: FAIL — handler/query not defined.

- [ ] **Step 3: Implement query + handler**

In `zendesk-sync.ts`:

```ts
export function zendeskTicketUrl(subdomain: string, ticketId: number): string {
  return `https://${subdomain}.zendesk.com/agent/tickets/${ticketId}`;
}

export async function getLinkedTickets(
  env: ZendeskSyncEnv,
  target: { eventId?: string; pubkey?: string },
): Promise<Array<{ ticket_id: number; status: string; url: string }>> {
  if (!env.DB) return [];
  await ensureZendeskTable(env.DB);
  const creds = await resolveZendeskCreds(env);
  const subdomain = creds?.subdomain ?? '';
  const byId = new Map<number, { ticket_id: number; status: string; url: string }>();
  const add = (rows: Array<{ ticket_id: number; status: string }>) => {
    for (const r of rows) byId.set(r.ticket_id, { ticket_id: r.ticket_id, status: r.status, url: zendeskTicketUrl(subdomain, r.ticket_id) });
  };
  if (target.eventId) {
    const r = await env.DB.prepare(`SELECT ticket_id, status FROM zendesk_tickets WHERE lower(event_id) = ?`).bind(target.eventId.toLowerCase()).all<{ ticket_id: number; status: string }>();
    add(r.results ?? []);
  }
  if (target.pubkey) {
    const r = await env.DB.prepare(`SELECT ticket_id, status FROM zendesk_tickets WHERE lower(author_pubkey) = ?`).bind(target.pubkey.toLowerCase()).all<{ ticket_id: number; status: string }>();
    add(r.results ?? []);
  }
  return [...byId.values()];
}
```

In `index.ts`, AFTER the `verifyAdminAccess()` gate (near the `/api/decisions` GET):

```ts
if (path === '/api/tickets' && request.method === 'GET') {
  const eventId = url.searchParams.get('event') ?? undefined;
  const pubkey = url.searchParams.get('pubkey') ?? undefined;
  return handleGetLinkedTickets(env, { eventId, pubkey }, corsHeaders);
}
```

Add the handler:

```ts
async function handleGetLinkedTickets(
  env: Env,
  target: { eventId?: string; pubkey?: string },
  corsHeaders: Record<string, string>,
): Promise<Response> {
  try {
    const tickets = await getLinkedTickets(env, target);
    return jsonResponse({ success: true, tickets }, 200, corsHeaders);
  } catch (err) {
    console.error('[handleGetLinkedTickets] error:', err);
    return jsonResponse({ success: true, tickets: [] }, 200, corsHeaders); // degrade to "no link"
  }
}
```

- [ ] **Step 4: Run tests + type-check**

Run: `cd worker && npm run test:d1 && npm run typecheck`
Expected: PASS + clean.

- [ ] **Step 5: Commit**

```bash
git add worker/src/index.ts worker/src/zendesk-sync.ts worker/src/*.d1.test.ts
git commit -m "feat(tickets): admin-gated GET /api/tickets to list linked Zendesk tickets"
```

### Task 3.2: Worker `POST /api/tickets/:id/close` — close a specific ticket

**Files:**
- Modify: `worker/src/index.ts` (route + `handleCloseTicket`)
- Test: `worker/src/*.d1.test.ts`

**Interfaces:**
- Produces: `POST /api/tickets/:id/close` body `{ moderatorPubkey?: string }` → `{ success: true }`. Adds an internal note, sets Zendesk `status='solved'`, sets D1 `status='resolved'`. Does NOT write `moderation_decisions`.

- [ ] **Step 1: Write the failing test** — call handler for ticket 555, assert a Zendesk solve PUT fired, D1 row status becomes `resolved`, and NO `moderation_decisions` insert occurred.

```ts
it('closes a ticket in Zendesk + D1 without writing a moderation decision', async () => {
  const env = makeD1Env({});
  await seedTicket(env, { ticket_id: 555, event_id: 'e'.repeat(64), status: 'open' });
  const decisionsBefore = await countRows(env, 'moderation_decisions');

  const res = await handleCloseTicket(env, 555, { moderatorPubkey: 'b'.repeat(64) }, {});
  expect((await res.json()).success).toBe(true);

  const row = await env.DB.prepare(`SELECT status FROM zendesk_tickets WHERE ticket_id = 555`).first();
  expect(row.status).toBe('resolved');
  expect(await countRows(env, 'moderation_decisions')).toBe(decisionsBefore); // no content decision
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd worker && npm run test:d1 -- -t "closes a ticket in Zendesk"`
Expected: FAIL — handler not defined.

- [ ] **Step 3: Implement route + handler**

Route (after the admin gate):

```ts
if (path.startsWith('/api/tickets/') && path.endsWith('/close') && request.method === 'POST') {
  const idStr = path.replace('/api/tickets/', '').replace('/close', '');
  const ticketId = Number.parseInt(idStr, 10);
  if (!Number.isInteger(ticketId)) return jsonResponse({ success: false, error: 'Invalid ticket id' }, 400, corsHeaders);
  const body = await request.json().catch(() => ({})) as { moderatorPubkey?: string };
  return handleCloseTicket(env, ticketId, body, corsHeaders);
}
```

Handler:

```ts
async function handleCloseTicket(
  env: Env,
  ticketId: number,
  body: { moderatorPubkey?: string },
  corsHeaders: Record<string, string>,
): Promise<Response> {
  try {
    const note = [
      '📋 **Ticket closed from Relay Manager**',
      '',
      `**Closed by:** ${body.moderatorPubkey ?? 'unknown'}`,
      `**Time:** ${new Date().toISOString()}`,
    ].join('\n');
    await addZendeskInternalNote(ticketId, note, env, true); // solve=true
    if (env.DB) {
      await ensureZendeskTable(env.DB);
      await env.DB.prepare(
        `UPDATE zendesk_tickets SET status = 'resolved', resolved_at = CURRENT_TIMESTAMP, resolution_action = 'manual_close', resolution_moderator = ? WHERE ticket_id = ?`
      ).bind(body.moderatorPubkey ?? null, ticketId).run();
    }
    return jsonResponse({ success: true }, 200, corsHeaders);
  } catch (err) {
    console.error('[handleCloseTicket] error:', err);
    return jsonResponse({ success: false, error: err instanceof Error ? err.message : 'Unknown error' }, 500, corsHeaders);
  }
}
```

- [ ] **Step 4: Run tests + type-check**

Run: `cd worker && npm run test:d1 && npm run typecheck`
Expected: PASS + clean.

- [ ] **Step 5: Commit**

```bash
git add worker/src/index.ts worker/src/*.d1.test.ts
git commit -m "feat(tickets): admin-gated POST /api/tickets/:id/close (Zendesk-only)"
```

### Task 3.3: Frontend adminApi client + hook wiring

**Files:**
- Modify: `src/lib/adminApi.ts` (add `getLinkedTickets`, `closeTicket`, a `LinkedTicket` type)
- Modify: `src/hooks/useAdminApi.ts` (expose both)
- Test: `src/lib/adminApi.test.ts` (existing fetch-mock pattern)

**Interfaces:**
- Produces: `getLinkedTickets(apiUrl, { eventId?, pubkey? }): Promise<LinkedTicket[]>`, `closeTicket(apiUrl, ticketId, moderatorPubkey?): Promise<void>`; `LinkedTicket = { ticket_id: number; status: string; url: string }`.
- Consumes: existing `apiRequest<T>(apiUrl, path, method, body?)` helper.

- [ ] **Step 1: Write the failing test** — mock fetch; assert `getLinkedTickets` calls `GET /api/tickets?event=..&pubkey=..` and returns `tickets`; assert `closeTicket` calls `POST /api/tickets/555/close`.

```ts
it('getLinkedTickets requests /api/tickets with target params', async () => {
  mockFetchOnce({ success: true, tickets: [{ ticket_id: 1, status: 'open', url: 'u' }] });
  const out = await getLinkedTickets('https://api', { eventId: 'e'.repeat(64) });
  expect(lastFetchUrl()).toContain('/api/tickets?event=' + 'e'.repeat(64));
  expect(out).toHaveLength(1);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/adminApi.test.ts -t "getLinkedTickets"`
Expected: FAIL — not exported.

- [ ] **Step 3: Implement**

```ts
export interface LinkedTicket { ticket_id: number; status: string; url: string; }

export async function getLinkedTickets(
  apiUrl: string,
  target: { eventId?: string; pubkey?: string },
): Promise<LinkedTicket[]> {
  const qs = new URLSearchParams();
  if (target.eventId) qs.set('event', target.eventId);
  if (target.pubkey) qs.set('pubkey', target.pubkey);
  const res = await apiRequest<{ tickets: LinkedTicket[] }>(apiUrl, `/api/tickets?${qs.toString()}`, 'GET');
  return res.tickets ?? [];
}

export async function closeTicket(apiUrl: string, ticketId: number, moderatorPubkey?: string): Promise<void> {
  await apiRequest(apiUrl, `/api/tickets/${ticketId}/close`, 'POST', { moderatorPubkey });
}
```

In `useAdminApi.ts`:

```ts
getLinkedTickets: (target: { eventId?: string; pubkey?: string }) => adminApi.getLinkedTickets(apiUrl, target),
closeTicket: (ticketId: number, moderatorPubkey?: string) => adminApi.closeTicket(apiUrl, ticketId, moderatorPubkey),
```

- [ ] **Step 4: Run tests + type-check**

Run: `npx vitest run src/lib/adminApi.test.ts && npx tsc -p tsconfig.app.json --noEmit`
Expected: PASS + clean.

- [ ] **Step 5: Commit**

```bash
git add src/lib/adminApi.ts src/hooks/useAdminApi.ts src/lib/adminApi.test.ts
git commit -m "feat(tickets): adminApi client for linked-ticket list + close"
```

### Task 3.4: LinkedTicketPanel component + integrate into ReportDetail

**Files:**
- Create: `src/components/LinkedTicketPanel.tsx`
- Modify: `src/components/ReportDetail.tsx` (render the panel; refetch on action complete)

**Interfaces:**
- Consumes: `useAdminApi().getLinkedTickets/closeTicket`, `useCurrentUser().getModeratorPubkey`, `useToast`, TanStack Query.
- Produces: `<LinkedTicketPanel eventId?={string} pubkey?={string} />`. Query key `['linked-tickets', eventId, pubkey]`.

- [ ] **Step 1: Implement the component** (no dedicated unit test — logic is thin and covered by adminApi tests; verify via type-check + manual/Playwright)

```tsx
export function LinkedTicketPanel({ eventId, pubkey }: { eventId?: string; pubkey?: string }) {
  const api = useAdminApi();
  const { toast } = useToast();
  const { getModeratorPubkey } = useCurrentUser();
  const qc = useQueryClient();
  const key = ['linked-tickets', eventId ?? null, pubkey ?? null];
  const { data: tickets, isLoading } = useQuery({
    queryKey: key,
    queryFn: () => api.getLinkedTickets({ eventId, pubkey }),
    enabled: !!(eventId || pubkey),
    staleTime: 15_000,
  });

  const closeMut = useMutation({
    mutationFn: async (ticketId: number) => {
      const moderator = await getModeratorPubkey();
      await api.closeTicket(ticketId, moderator);
    },
    onSuccess: () => { toast({ title: 'Ticket closed' }); qc.invalidateQueries({ queryKey: key }); },
    onError: (e: Error) => toast({ title: 'Failed to close ticket', description: e.message, variant: 'destructive' }),
  });

  if (isLoading) return <p className="text-sm text-muted-foreground">Checking linked tickets…</p>;
  if (!tickets || tickets.length === 0) return <p className="text-sm text-muted-foreground">No linked Zendesk ticket found</p>;

  const isOpen = (s: string) => s === 'open';
  return (
    <div className="space-y-1">
      {tickets.map(t => (
        <div key={t.ticket_id} className="flex items-center gap-2 text-sm">
          <a href={t.url} target="_blank" rel="noreferrer" className="underline">Zendesk #{t.ticket_id}</a>
          {isOpen(t.status)
            ? <>
                <Badge variant="outline">Open</Badge>
                <Button size="sm" variant="outline" disabled={closeMut.isPending} onClick={() => closeMut.mutate(t.ticket_id)}>
                  {closeMut.isPending ? 'Closing…' : 'Close ticket'}
                </Button>
              </>
            : <Badge variant="outline" className="border-green-500 text-green-600">Closed ✓</Badge>}
        </div>
      ))}
    </div>
  );
}
```

- [ ] **Step 2: Integrate into ReportDetail**

Render `<LinkedTicketPanel eventId={...} pubkey={...} />` under a "Linked ticket" heading near the report header (use the target's event id and the reported author pubkey already available in `ReportDetail`). Add the panel's query key to the `onActionComplete` invalidation path so it refetches after ban/delete (mirroring the existing `['decisions']` invalidation): `queryClient.invalidateQueries({ queryKey: ['linked-tickets'] })`.

- [ ] **Step 3: Type-check + build**

Run: `npx tsc -p tsconfig.app.json --noEmit && npx vite build`
Expected: clean type-check + successful build.

- [ ] **Step 4: Visual verification (Playwright)**

Load a report with a linked open ticket; confirm the panel shows the #, Open badge, and active Close button; take an auto-closing action and confirm the panel flips to `Closed ✓`; load a report with no linked ticket and confirm "No linked Zendesk ticket found". Screenshot each state for the PR.

- [ ] **Step 5: Commit**

```bash
git add src/components/LinkedTicketPanel.tsx src/components/ReportDetail.tsx
git commit -m "feat(reports): always-present linked-ticket panel with manual close"
```

**PR 3 wrap-up:** draft, title `feat(reports): linked Zendesk ticket panel + manual close`. Include the three state screenshots.

---

## Self-Review

**Spec coverage:**
- Fix 1a (derive author_pubkey, lowercase) → Task 1.2. ✓
- Fix 1b (close all, casing) → Task 1.1. ✓
- Fix 2 (event report cross-resolution) → Task 2.1 (refined to `bannedPubkeys`, which is tighter and auto-excludes suspend; matches the spec intent). ✓
- Fix 3 read endpoint → 3.1; close endpoint → 3.2; client → 3.3; panel + four states + refetch → 3.4. ✓
- D1-first status source → panel reads `/api/tickets` (D1). ✓
- Manual close Zendesk-only → 3.2 asserts no `moderation_decisions` write. ✓
- Out of scope (retroactive sweep, existing-row backfill) → not planned, per spec. ✓

**Spec refinement to fold back:** Fix 2 in the spec says "mirror resolutionActions"; the plan implements the tighter `bannedPubkeys` rule (bulk-delete already self-resolves via `listbannedevents`; only `banpubkey` needs help; `bannedPubkeys` excludes suspend by construction). Update the spec's Fix 2 paragraph to match before/alongside implementation.

**Placeholder scan:** none — all steps carry real code/assertions and exact commands.

**Type consistency:** `getLinkedTickets`/`closeTicket`/`LinkedTicket` names match across worker handler, adminApi, hook, and component. `isConsolidatedReportResolved` signature matches its test and its Reports.tsx call sites.

## Branch / workspace

- Fresh branch off `origin/main`, e.g. `divine/zendesk-ticket-closure`, in an isolated worktree (re-copy `.env.local` and `worker/.dev.vars`; run `npm ci --legacy-peer-deps` in `worker/` so D1 tests find `miniflare`). Three commits map to three PRs; split at PR boundaries if landing separately.
