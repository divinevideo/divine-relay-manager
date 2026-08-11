# Age-Review Identity Capture Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Capture a human-readable identifier for an account at age-review case creation, before enforcement hides the profile, and use it to make Zendesk tickets and contacts say which account they concern.

**Architecture:** A shared relay-profile module (extracted from `index.ts` to avoid a circular import with `ReportWatcher`) fetches kind-0 at case creation on all three creation paths and stores name/nip05/vine-username on `age_review_cases`. A pure note-builder renders that identity into the case ticket's internal note and the parent contact's `notes`. The contact *name* carries the email alone until the parent replies, then upgrades to include the handle.

**Tech Stack:** Cloudflare Workers, D1 (SQLite), Durable Objects, TypeScript, Vitest, nostr-tools (NIP-19), Zendesk REST API v2.

**Spec:** `docs/superpowers/specs/2026-07-29-age-review-identity-capture-design.md`
**Issue:** divinevideo/divine-relay-manager#213

## Status (2026-08-04)

Tasks 1-8 are implemented and committed. **Task 9 (backfill) is deferred to its own PR** — it needs a staging dry-run and a reported yield split before it can be run against prod, which is its own review cycle.

Two additions beyond the original plan, both from revalidating it against the code:

- **Task 4 keeps the username.** `account_name` prefers `display_name`, so the operator-supplied username was discarded whenever one was given — permanently, since these rows stamp `identity_captured_at` and a backfill keyed on `IS NULL` never revisits them. It is now stored as the NIP-05 the username implies, with the identity domain in `NIP05_DOMAIN` config rather than hardcoded (staging accounts come from a different Keycast instance, and an unconfigured environment records nothing rather than a wrong address).
- **Contact verification before any write.** The plan's guard — "only when a real parent email is attached" — was necessary but not sufficient. See the constraint added below.

### Zendesk-side dependencies — both closed (verified live 2026-08-04)

1. **The parent-reply trigger was never a risk.** `Age Review: notify relay-manager on parent reply` gates on `role is end_user` in addition to `comment_is_public` and the `age-review` tag. An agent's own follow-up cannot fire the webhook, so it cannot advance a case or trigger the rename. The staging holds.
2. **The "Customer not responding" macro is fixed** in `divine-zendesk-tooling`. The real defect was not the requester name but that the macro set **no comment mode at all**, so it inherited the agent's composer state — the same macro either emailed the customer or wrote a private note depending on an incidental UI setting. On an age-review ticket both outcomes cause harm: a public comment satisfies `Age Review: clear parent-replied on agent reply` and drops the ticket out of the waiting-on-us view, while an internal one keeps it queued but never nudges the parent. It is now pinned public, and the greeting no longer interpolates the requester name (the `first_name` variant would be worse — it renders "Hello Claimed."). That defect predated this work.

## Global Constraints

- **`cd worker && npx vitest run` is a PARTIAL run.** `worker/vitest.config.ts` excludes `test/**/*.d1.test.ts` and `test/**/*.e2e.test.ts`. This change touches D1 schema and D1 writes, so **every task must also run `cd worker && npm run test:d1`**. A green partial run on a D1 change is a false green (see #208).
- Frontend type-check is `npx tsc -p tsconfig.app.json --noEmit`. Bare `npx tsc --noEmit` is a false green (root tsconfig has `"files": []`).
- There is **no `npm run lint`** in this repo, at the root or in `worker/`. CI (`.github/workflows/test.yml`) runs exactly four things: root `npm run test`, then `npm run typecheck`, `npm run test:run` and `npm run test:d1` in `worker/`. Run those four.
- **Never run `wrangler d1 migrations apply`** against this database. Schema is applied at runtime by `ensureSchema` in `worker/src/db.ts`, using idempotent `try { ALTER TABLE … ADD COLUMN } catch {}`.
- All profile-derived strings are attacker-controlled. They must pass through the existing `sanitizeInline` in `report-note.ts` (80-char cap, control characters stripped). Do not write a second sanitizer.
- **This repo is public.** No ticket numbers, case IDs, pubkeys, or user email addresses in code comments, commit messages, or PR text. Describe cases obliquely.
- Capture is best-effort. A relay failure logs and continues; it must never block case creation or enforcement.
- Contact-record writes happen **only** when a real parent email is attached. On the no-parent path the ticket requester is an admin account, and an unguarded write would corrupt a live admin profile.
- The account handle must not enter the contact `name` until the parent has replied. Zendesk renders the stored name into the `To:` header of outbound mail.
- **A non-null `parent_contact_email` does not prove the ticket's requester is that parent.** The address is supplied by the account under review and validated only as email-shaped; Zendesk resolves a requester by email to an *existing* user and permits agents to be requesters. So naming a Divine staff address makes that staff member the requester — and because a Zendesk display name is global, renaming them puts a minor's handle in the header of every mail they later send, on any ticket. The column is also written before the Zendesk call and that call's failure is swallowed, so it can assert a parent while the requester is still an admin. Resolve the contact and require an end user at exactly the address on the case before writing to `/users/{id}`.

---

### Task 1: Extract the relay profile fetch into a shared module

`queryRelay`, `withTimeout` and `ENRICHMENT_TIMEOUT_MS` are private to `index.ts`. `index.ts` re-exports the `ReportWatcher` Durable Object (`index.ts:47`), so importing them from `index.ts` into `ReportWatcher.ts` would be a circular import. Extract first.

**Files:**
- Create: `worker/src/relay-profile.ts`
- Create: `worker/src/relay-profile.test.ts`
- Modify: `worker/src/index.ts` (remove the private copies at `1632-1693` and `2364-2373`, import from the new module)

**Interfaces:**
- Consumes: `parseKind0Profile`, `ReportedProfile` from `./report-note`
- Produces:
  - `queryRelay(filter: object, relayUrl: string): Promise<{ success: boolean; events?: object[]; error?: string; complete?: boolean }>`
  - `withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | null>`
  - `ENRICHMENT_TIMEOUT_MS: number`
  - `fetchAccountIdentity(pubkey: string, relayUrl: string | undefined): Promise<ReportedProfile | null>`

- [ ] **Step 1: Write the failing test**

Mock the WebSocket, **not** the module. `fetchAccountIdentity` calls `queryRelay` inside the same module, so a `vi.spyOn(module, 'queryRelay')` would never intercept it and the test would pass or fail for the wrong reason. `queryRelay` uses `addEventListener`, so the `mockRelay` helper in `bulk-moderate.test.ts` is the right shape to copy.

```ts
// worker/src/relay-profile.test.ts
import { describe, it, expect, vi, afterEach } from 'vitest';
import { fetchAccountIdentity } from './relay-profile';

/** Mirrors mockRelay in bulk-moderate.test.ts: stub the socket so the real queryRelay runs. */
function mockRelay(events: Array<Record<string, unknown>>) {
  vi.spyOn(globalThis, 'WebSocket').mockImplementation((function () {
    const listeners = new Map<string, Array<(value?: unknown) => void>>();
    let subId = 'identity-test';
    queueMicrotask(() => {
      listeners.get('open')?.forEach((h) => h());
      for (const event of events) {
        listeners.get('message')?.forEach((h) => h({ data: JSON.stringify(['EVENT', subId, event]) }));
      }
      listeners.get('message')?.forEach((h) => h({ data: JSON.stringify(['EOSE', subId]) }));
    });
    return {
      addEventListener: (e: string, h: (value?: unknown) => void) => {
        listeners.set(e, [...(listeners.get(e) || []), h]);
      },
      send: vi.fn((payload: string) => {
        const parsed = JSON.parse(payload);
        if (parsed[0] === 'REQ') subId = parsed[1];
      }),
      close: vi.fn(),
    };
  } as unknown as typeof WebSocket));
}

afterEach(() => vi.restoreAllMocks());

describe('fetchAccountIdentity', () => {
  it('returns null when no relay URL is configured', async () => {
    expect(await fetchAccountIdentity('abc123', undefined)).toBeNull();
  });

  it('parses a kind-0 result into a profile', async () => {
    mockRelay([{
      id: 'e1', kind: 0, pubkey: 'abc123', tags: [],
      content: JSON.stringify({ display_name: 'Some One', nip05: 'x@y.z' }),
    }]);
    const profile = await fetchAccountIdentity('abc123', 'wss://relay.test');
    expect(profile?.name).toBe('Some One');
    expect(profile?.nip05).toBe('x@y.z');
  });

  it('returns null rather than throwing when the socket cannot be opened', async () => {
    vi.spyOn(globalThis, 'WebSocket').mockImplementation((() => {
      throw new Error('relay down');
    }) as unknown as typeof WebSocket);
    await expect(fetchAccountIdentity('abc123', 'wss://relay.test')).resolves.toBeNull();
  });

  it('returns null when the account has no kind-0', async () => {
    mockRelay([]);
    expect(await fetchAccountIdentity('abc123', 'wss://relay.test')).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd worker && npx vitest run src/relay-profile.test.ts`
Expected: FAIL — cannot resolve `./relay-profile`.

- [ ] **Step 3: Create the module**

Move `queryRelay` verbatim from `index.ts:1632-1693` and `withTimeout` + `ENRICHMENT_TIMEOUT_MS` verbatim from `index.ts:2364-2373` into the new file, adding `export` to each. Then append:

```ts
import { parseKind0Profile, type ReportedProfile } from './report-note';

/**
 * Best-effort kind-0 lookup for an account, used to capture a human-readable
 * identifier while one is still visible. A suspended account's content is hidden
 * from relay queries, so this must run before any enforcement leg fires.
 *
 * Never throws: enrichment must not be able to fail a case creation.
 */
export async function fetchAccountIdentity(
  pubkey: string,
  relayUrl: string | undefined,
): Promise<ReportedProfile | null> {
  if (!relayUrl) return null;
  try {
    const res = await withTimeout(
      queryRelay({ authors: [pubkey], kinds: [0], limit: 1 }, relayUrl),
      ENRICHMENT_TIMEOUT_MS,
    );
    if (res?.success && res.events?.length) {
      return parseKind0Profile(res.events[0] as { content?: string; tags?: string[][] });
    }
  } catch (err) {
    console.warn('[relay-profile] identity fetch failed (continuing without it):', err);
  }
  return null;
}
```

- [ ] **Step 4: Update `index.ts` to import rather than define**

Delete the two moved blocks from `index.ts` and add near the existing imports:

```ts
import { queryRelay, withTimeout, ENRICHMENT_TIMEOUT_MS, fetchAccountIdentity } from './relay-profile';
```

Leave every existing call site unchanged; the signatures are identical.

- [ ] **Step 5: Run the full worker suite plus type-check**

Run: `cd worker && npx vitest run && npm run test:d1`
Run: `npx tsc -p tsconfig.app.json --noEmit`
Expected: PASS. The extraction is behaviour-preserving, so any failure is a bad move, not a new bug.

- [ ] **Step 6: Commit**

```bash
git add worker/src/relay-profile.ts worker/src/relay-profile.test.ts worker/src/index.ts
git commit -m "refactor(worker): extract relay profile fetch into a shared module

ReportWatcher and age-review both need the kind-0 lookup, and index.ts
re-exports the ReportWatcher durable object, so importing from index would
be circular. Behaviour-preserving move plus a best-effort wrapper that
cannot throw."
```

---

### Task 2: Add the identity columns to `age_review_cases`

**Files:**
- Modify: `worker/src/db.ts` (append to the `age_review_cases` ALTER block, currently ending around line 111)
- Test: `worker/test/schema.d1.test.ts` (create if absent; note the `.d1.` infix — this file is excluded from the default run by design)

**Interfaces:**
- Produces: columns `account_name`, `account_nip05`, `account_vine_username`, `identity_captured_at` on `age_review_cases`

- [ ] **Step 1: Write the failing test**

```ts
// worker/test/schema.d1.test.ts
import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import { ensureSchema } from '../src/db';

describe('age_review_cases identity columns', () => {
  it('has the identity capture columns after ensureSchema', async () => {
    await ensureSchema(env.DB);
    const { results } = await env.DB.prepare(`PRAGMA table_info(age_review_cases)`).all<{ name: string }>();
    const columns = results.map(r => r.name);
    expect(columns).toContain('account_name');
    expect(columns).toContain('account_nip05');
    expect(columns).toContain('account_vine_username');
    expect(columns).toContain('identity_captured_at');
  });

  it('is idempotent when run twice', async () => {
    await ensureSchema(env.DB);
    await expect(ensureSchema(env.DB)).resolves.not.toThrow();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd worker && npm run test:d1`
Expected: FAIL — columns not found.

- [ ] **Step 3: Add the columns**

In `worker/src/db.ts`, after the `version` ALTER and before the `CREATE INDEX` block:

```ts
  // Human-readable identity for the reported account, captured at case creation.
  // Enforcement hides a suspended account's profile, so a later lookup returns
  // nothing; these columns preserve what was visible at the time.
  for (const column of [
    `account_name TEXT`,
    `account_nip05 TEXT`,
    `account_vine_username TEXT`,
    `identity_captured_at TEXT`,
  ]) {
    try {
      await db.prepare(`ALTER TABLE age_review_cases ADD COLUMN ${column}`).run();
    } catch {
      // Column already exists
    }
  }
```

- [ ] **Step 4: Run the tests**

Run: `cd worker && npm run test:d1 && npx vitest run`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add worker/src/db.ts worker/test/schema.d1.test.ts
git commit -m "feat(age-review): add identity columns to age_review_cases

identity_captured_at distinguishes looked-and-found-nothing from
never-looked, which the backfill needs to know which rows to retry."
```

---

### Task 3: Capture identity on both `ReportWatcher` case-creation paths

**Files:**
- Modify: `worker/src/ReportWatcher.ts` (auto-clear INSERT ~line 929; main INSERT ~line 955)
- Test: `worker/src/ReportWatcher.test.ts`

**Interfaces:**
- Consumes: `fetchAccountIdentity` from `./relay-profile` (Task 1); the columns from Task 2

- [ ] **Step 1: Write the failing test**

```ts
// append inside the existing ReportWatcher describe block
it('stores the account handle on the case when the relay has a kind-0', async () => {
  mockFetch.mockResolvedValue({ ok: true, json: async () => ({ result: true }) });
  vi.spyOn(relayProfile, 'fetchAccountIdentity').mockResolvedValue({
    name: 'Some One', nip05: 'x@y.z', isVineImport: false, vineUsername: undefined,
  });

  await watcher.fetch(new Request('https://do/start', { method: 'POST' }));
  await new Promise(resolve => setTimeout(resolve, 10));
  getLastMockWebSocket()!.simulateMessage(JSON.stringify(['EVENT', 'auto-hide-reports', {
    id: 'identity_capture_1', pubkey: 'reporter', kind: 1984, content: 'under 16',
    tags: [['p', 'target_identity_1'], ['report', 'underage_user']],
    created_at: Math.floor(Date.now() / 1000),
  }]));
  await new Promise(resolve => setTimeout(resolve, 50));

  const insert = mockDbPrepare.mock.calls.find(c => String(c[0]).includes('INSERT INTO age_review_cases'));
  expect(String(insert?.[0])).toContain('account_name');
  vi.restoreAllMocks();
});

it('still creates the case when the identity lookup fails', async () => {
  mockFetch.mockResolvedValue({ ok: true, json: async () => ({ result: true }) });
  vi.spyOn(relayProfile, 'fetchAccountIdentity').mockRejectedValue(new Error('relay down'));

  await watcher.fetch(new Request('https://do/start', { method: 'POST' }));
  await new Promise(resolve => setTimeout(resolve, 10));
  getLastMockWebSocket()!.simulateMessage(JSON.stringify(['EVENT', 'auto-hide-reports', {
    id: 'identity_capture_2', pubkey: 'reporter', kind: 1984, content: 'under 16',
    tags: [['p', 'target_identity_2'], ['report', 'underage_user']],
    created_at: Math.floor(Date.now() / 1000),
  }]));
  await new Promise(resolve => setTimeout(resolve, 50));

  expect(mockDbPrepare.mock.calls.some(c => String(c[0]).includes('INSERT INTO age_review_cases'))).toBe(true);
  vi.restoreAllMocks();
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd worker && npx vitest run src/ReportWatcher.test.ts`
Expected: FAIL — the INSERT does not mention `account_name`.

- [ ] **Step 3: Capture before the INSERT on the main path**

Add the import at the top of `ReportWatcher.ts`:

```ts
import { fetchAccountIdentity } from './relay-profile';
```

Immediately before the main `INSERT INTO age_review_cases` (~line 955):

```ts
    // Capture a readable identifier while one is still visible. This must stay
    // ahead of any enforcement leg: suspension hides the account's profile, and
    // a later lookup returns nothing. Never allowed to fail case creation.
    const identity = await fetchAccountIdentity(reportedPubkey, this.env.RELAY_URL).catch(() => null);
    const capturedAt = new Date().toISOString();
```

and replace the INSERT with:

```ts
    await this.env.DB.prepare(`
      INSERT INTO age_review_cases
      (id, pubkey, reporter_pubkey, report_id, suspected_age_band, state, allowed_resolution, deadline_at,
       account_name, account_nip05, account_vine_username, identity_captured_at)
      VALUES (?, ?, ?, ?, ?, 'open_reported', ?, ?, ?, ?, ?, ?)
    `).bind(
      caseId,
      reportedPubkey,
      event.pubkey,
      event.id,
      band,
      defaultResolutionForBand(band),
      deadline,
      identity?.name ?? null,
      identity?.nip05 ?? null,
      identity?.vineUsername ?? null,
      capturedAt,
    ).run();
```

- [ ] **Step 4: Do the same on the auto-clear path**

Immediately before the auto-clear INSERT (~line 929), add the same two lines, then extend that INSERT:

```ts
        const identity = await fetchAccountIdentity(reportedPubkey, this.env.RELAY_URL).catch(() => null);
        const capturedAt = new Date().toISOString();
        await this.env.DB.prepare(`
          INSERT INTO age_review_cases
          (id, pubkey, reporter_pubkey, report_id, suspected_age_band, state, allowed_resolution, resolution_note, created_via,
           account_name, account_nip05, account_vine_username, identity_captured_at)
          VALUES (?, ?, ?, ?, 'age_13_15', 'cleared', 'parent_video_or_email', 'Auto-cleared: previously verified minor', 'report', ?, ?, ?, ?)
        `).bind(
          caseId, reportedPubkey, event.pubkey, event.id,
          identity?.name ?? null,
          identity?.nip05 ?? null,
          identity?.vineUsername ?? null,
          capturedAt,
        ).run();
```

- [ ] **Step 5: Run the tests**

Run: `cd worker && npx vitest run && npm run test:d1`
Expected: PASS, including the failure-path test.

- [ ] **Step 6: Commit**

```bash
git add worker/src/ReportWatcher.ts worker/src/ReportWatcher.test.ts
git commit -m "feat(age-review): capture account identity when a report opens a case

Runs ahead of the enforcement legs, because suspension hides the profile
and a later lookup returns nothing. Failure is swallowed: enrichment must
never be able to stop a case being created."
```

---

### Task 4: Capture identity on the create-minor-account path

This path already receives `username` and `display_name` in the request body, so it needs no relay fetch.

**Files:**
- Modify: `worker/src/age-review.ts` (~line 547, the INSERT in `handleCreateMinorAccount`)
- Test: `worker/src/age-review.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
it('records the supplied display name and username on a created minor case', async () => {
  const req = new Request('https://api.test/api/age-review/minor-account', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'someuser', display_name: 'Some One' }),
  });
  await handleCreateMinorAccount(req, env, {});
  const insert = mockDbPrepare.mock.calls.find(c => String(c[0]).includes('INSERT INTO age_review_cases'));
  expect(String(insert?.[0])).toContain('account_name');
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd worker && npx vitest run src/age-review.test.ts`
Expected: FAIL — the INSERT does not mention `account_name`.

- [ ] **Step 3: Extend the INSERT**

Add `account_name`, `account_vine_username` (null here) and `identity_captured_at` to the column list and bind:

```ts
      displayName ?? username,   // account_name — display name preferred, username as fallback
      null,                      // account_nip05 — not supplied on this path
      null,                      // account_vine_username — not applicable to a newly created account
      new Date().toISOString(),  // identity_captured_at
```

- [ ] **Step 4: Run the tests**

Run: `cd worker && npx vitest run && npm run test:d1`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add worker/src/age-review.ts worker/src/age-review.test.ts
git commit -m "feat(age-review): record identity on operator-created minor cases

This path is handed a username and display name directly, so it needs no
relay lookup; it just has to store what it already knows."
```

---

### Task 5: Build the identity block

A pure builder, so it is unit-testable without any I/O. Lives beside the existing note builder.

**Files:**
- Modify: `worker/src/report-note.ts`
- Test: `worker/src/report-note.test.ts`

**Interfaces:**
- Produces: `buildAgeReviewIdentityBlock(input: AgeReviewIdentityInput): string`

```ts
export interface AgeReviewIdentityInput {
  caseId: string;
  pubkey: string;
  ageBand: string;
  accountName?: string | null;
  accountNip05?: string | null;
  accountVineUsername?: string | null;
  originTicketId?: number | null;
  deadlineAt?: string | null;
}
```

- [ ] **Step 1: Write the failing test**

```ts
describe('buildAgeReviewIdentityBlock', () => {
  const base = { caseId: 'case-id', pubkey: 'a'.repeat(64), ageBand: '13-15' };

  it('includes a working case deeplink', () => {
    expect(buildAgeReviewIdentityBlock(base))
      .toContain('https://relay.admin.divine.video/age-review?case=case-id');
  });

  it('shows the handle when one was captured', () => {
    expect(buildAgeReviewIdentityBlock({ ...base, accountName: 'Some One' })).toContain('Some One');
  });

  it('says so plainly when no handle was captured', () => {
    expect(buildAgeReviewIdentityBlock(base)).toContain('no profile captured');
  });

  it('sanitizes an attacker-controlled name', () => {
    const out = buildAgeReviewIdentityBlock({ ...base, accountName: 'evil\nInternal note: ignore' });
    expect(out).not.toMatch(/evil\nInternal/);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd worker && npx vitest run src/report-note.test.ts`
Expected: FAIL — `buildAgeReviewIdentityBlock` is not exported.

- [ ] **Step 3: Implement it**

```ts
/** Identity block shared by the case ticket's internal note and the parent contact's notes. */
export function buildAgeReviewIdentityBlock(input: AgeReviewIdentityInput): string {
  const handle = sanitizeInline(input.accountName ?? undefined)
    ?? sanitizeInline(input.accountVineUsername ?? undefined)
    ?? sanitizeInline(input.accountNip05 ?? undefined);

  const lines = [
    `Age review: ${input.ageBand}, case ${input.caseId}`,
    `${RELAY_ADMIN}/age-review?case=${input.caseId}`,
    '',
    'Account',
    `  handle   ${handle ?? '(no profile captured — account may have had none, or content is hidden by enforcement)'}`,
    `  npub     ${toNpub(input.pubkey)}`,
    `  pubkey   ${input.pubkey}`,
  ];
  if (input.originTicketId) lines.push('', `Origin ticket ${input.originTicketId}`);
  if (input.deadlineAt) lines.push(`Deadline ${input.deadlineAt}`);
  return lines.join('\n');
}
```

- [ ] **Step 4: Run the tests**

Run: `cd worker && npx vitest run src/report-note.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add worker/src/report-note.ts worker/src/report-note.test.ts
git commit -m "feat(age-review): add the shared identity block builder

Pure and unit-testable. States plainly when no profile was captured, so an
empty handle reads as a known fact rather than a rendering bug."
```

---

### Task 6: Put the identity block on the case ticket's internal note

**Files:**
- Modify: `worker/src/age-review.ts` (`buildParentOutreachBody` neighbourhood, and the internal note posted at case-ticket creation ~line 813)
- Test: `worker/src/age-review.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
it('puts the case deeplink and pubkey in the ticket internal note', async () => {
  // arrange a case-ticket creation with a captured handle, then assert on the POSTed body
  const body = JSON.parse(String(fetchMock.mock.calls.at(-1)?.[1]?.body));
  expect(body.ticket.comment.body).toContain('/age-review?case=');
  expect(body.ticket.comment.public).toBe(false);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd worker && npx vitest run src/age-review.test.ts`
Expected: FAIL — the note has no deeplink.

- [ ] **Step 3: Use the builder for the internal note**

Replace the hand-built internal comment with `buildAgeReviewIdentityBlock({...})`, passing the case row's captured columns. Keep `public: false`.

- [ ] **Step 4: Run the tests**

Run: `cd worker && npx vitest run && npm run test:d1`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add worker/src/age-review.ts worker/src/age-review.test.ts
git commit -m "feat(age-review): give the case ticket note a deeplink and identity

The note previously carried a pubkey, band and deadline with no way to
reach the case it describes."
```

---

### Task 7: Write the contact record, guarded on a real parent email

**Files:**
- Modify: `worker/src/age-review.ts` (~line 823 create-with-requester, ~line 864 parent-email PUT)
- Test: `worker/src/age-review.test.ts`

**Interfaces:**
- Consumes: `buildAgeReviewIdentityBlock` from `./report-note` (Task 5)
- Produces: `writeParentContactNotes(requesterId: number, block: string, zendesk: { auth: string; baseUrl: string }): Promise<void>` — reads the contact's existing `notes`, appends the block under a delimiter, and PUTs the result. Consumed by Task 8.

- [ ] **Step 1: Write the failing test**

```ts
it('sets the contact name to the email address at attach time, with no handle', async () => {
  await attachParentEmail('case-id', 'parent@example.test', env);
  const put = fetchMock.mock.calls.find(c => String(c[0]).includes('/tickets/'));
  const body = JSON.parse(String(put?.[1]?.body));
  expect(body.ticket.requester.name).toBe('parent@example.test');
  expect(body.ticket.requester.name).not.toContain('Claimed parent');
});

it('never writes contact notes when there is no parent email', async () => {
  await createCaseTicketWithoutParent('case-id', env);
  expect(fetchMock.mock.calls.some(c => String(c[0]).includes('/users/'))).toBe(false);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd worker && npx vitest run src/age-review.test.ts`
Expected: FAIL — the requester name is still the hardcoded role label.

- [ ] **Step 3: Replace the hardcoded name and add the contact write**

At both sites, change `requester: { email: parentEmail, name: 'Parent/Guardian' }` to `requester: { email: parentEmail, name: parentEmail }`.

Then, only on the paths that have a real `parentEmail`, resolve the requester id from the ticket response and `PUT /users/{id}` with the identity block appended to `notes` (read first, compose, do not clobber).

- [ ] **Step 4: Run the tests**

Run: `cd worker && npx vitest run && npm run test:d1`
Expected: PASS, including the no-parent guard.

- [ ] **Step 5: Commit**

```bash
git add worker/src/age-review.ts worker/src/age-review.test.ts
git commit -m "feat(age-review): identify the parent contact by address, add case notes

The role-label placeholder was written before the parent had ever mailed
us, so their real name was never captured and the queue read as anonymous.
The address is the join key and is safe in requester-visible headers.

Contact writes are gated on a real parent address: without one the ticket
requester is an admin account, and an unguarded write would land case data
on a live staff profile."
```

---

### Task 8: Upgrade the contact name once the parent replies

**Files:**
- Modify: `worker/src/age-review.ts` (`handleAgeReviewReplyWebhook`, ~line 1012)
- Test: `worker/src/age-review.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
it('upgrades the contact name to include the handle on the parent reply', async () => {
  // case has account_name 'Some One' and a parent contact
  await handleAgeReviewReplyWebhook(replyRequest, env, {});
  const put = fetchMock.mock.calls.find(c => String(c[0]).includes('/users/'));
  expect(JSON.parse(String(put?.[1]?.body)).user.name).toBe('Claimed parent of Some One');
});

it('leaves the name as the address when no handle was captured', async () => {
  // case has a null account_name
  await handleAgeReviewReplyWebhook(replyRequest, env, {});
  const put = fetchMock.mock.calls.find(c => String(c[0]).includes('/users/'));
  expect(put).toBeUndefined();
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd worker && npx vitest run src/age-review.test.ts`
Expected: FAIL — no `/users/` call is made.

- [ ] **Step 3: Add the upgrade after the state transition**

After the case advances to `submitted_for_review`, and only when `account_name` (or the vine-username fallback) is non-null, `PUT /users/{requester_id}` with `name: "Claimed parent of <sanitized handle>"`. Best-effort: a failure logs and does not affect the webhook's response.

"Claimed" is deliberate — whether they are the parent is exactly what the review exists to establish.

- [ ] **Step 4: Run the tests**

Run: `cd worker && npx vitest run && npm run test:d1`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add worker/src/age-review.ts worker/src/age-review.test.ts
git commit -m "feat(age-review): name the contact after the account once they reply

Staged deliberately. The stored contact name is rendered into the To:
header of outbound mail, and the address is supplied unverified by the
teen, so naming the contact after the account before anyone has replied
would disclose a handle to whoever holds a mistyped address. After a reply
the address is demonstrably held by someone engaging with the review."
```

---

### Task 9: Backfill existing cases

**Files:**
- Create: `worker/scripts/backfill-age-review-identity.ts`
- Test: manual dry-run against staging first

- [ ] **Step 1: Write the script with a dry-run default**

Select cases where `identity_captured_at IS NULL`, batch them, call `fetchAccountIdentity` per pubkey, and write results. Stamp `identity_captured_at` **whether or not anything resolved**, so a second run does not retry rows already known to be empty. Require an explicit `--execute` flag to write; dry run prints counts.

- [ ] **Step 2: Dry-run against staging**

Run: `cd worker && npx tsx scripts/backfill-age-review-identity.ts --env staging`
Expected: a count of candidate rows and how many resolved, with no writes.

- [ ] **Step 3: Execute against staging, then verify**

Run with `--execute`, then confirm a sample of rows has `identity_captured_at` set.

- [ ] **Step 4: Report expected prod yield before running prod**

Restricted accounts have their profiles hidden, so most `restricted_pending_user_response` rows will resolve to nothing and that is expected, not a failure. Report the split before asking for prod sign-off.

- [ ] **Step 5: Commit**

```bash
git add worker/scripts/backfill-age-review-identity.ts
git commit -m "feat(age-review): add the identity backfill script

Dry-run by default. Stamps identity_captured_at even when nothing resolved,
so repeat runs do not re-query accounts whose profile is permanently hidden."
```

---

## Final verification before opening the PR

- [ ] `cd worker && npx vitest run` — partial suite
- [ ] `cd worker && npm run test:d1` — **required**, this change touches D1 schema
- [ ] `npx tsc -p tsconfig.app.json --noEmit`
- [ ] `npm run lint`
- [ ] Confirm no ticket numbers, case IDs, pubkeys or email addresses appear in the diff or commit messages
- [ ] Confirm no enforcement leg can run before capture on either `ReportWatcher` path
- [ ] Confirm no `/users/` write happens on any path lacking a real parent email
