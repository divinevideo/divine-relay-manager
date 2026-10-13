# Sticky approved-minor state on age-review approval — Implementation Plan (relay-manager)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When a moderator explicitly approves an existing account as a 13-15 protected minor, record an active protected-minor subject atomically with the case transition and project `verified_minor` onto keycast, so later under-16 reports auto-clear.

**Architecture:** The D1 subject is the source of truth and keycast's flag is a projection with cron retry, mirroring the deny path in the other direction. The PATCH carries an explicit `resolution`; an approval writes the subject, binding and projection job in the same `db.batch` as the case's compare-and-swap. The projection-job cron is generalized to project each subject's current classification (set or clear), fixing a job-drop that approvals would otherwise expose.

**Tech Stack:** Cloudflare Workers (TypeScript), D1 (SQLite), Vitest + Miniflare, React 18 + TanStack Query + shadcn/ui.

**Spec:** `docs/superpowers/specs/2026-10-12-age-review-sticky-approved-minor-design.md` (this worktree). Companion keycast plan: keycast branch `feat/set-verified-minor`, `docs/superpowers/plans/2026-10-12-set-verified-minor.md`.

## Global Constraints

- Work only in this repository's worktree for branch `feat/192-sticky-approved-minor` (based on `origin/main` `8ea1ded`).
- **Push nothing, open no PR, file no issue, deploy nothing.** Matt gives the go for each. Commits are local.
- No `Co-Authored-By` or Claude attribution lines in commits.
- Keycast contract (from the keycast plan): `PUT {KEYCAST_URL}/api/admin/users/{pubkey}/verified-minor?actor=&reason=`, bearer `KEYCAST_SERVICE_TOKEN`; 200 on set or already-set; 404 `{"error":"user not found"}` for no account; 409 `{"error":"account_unclaimed: ..."}` for a credential-less row.
- `resolution` values: exactly `'approved_minor'` and `'not_minor'`. Keycast reason for a set: `'age_review_approved'`.
- `approved_minor` requires the effective band `age_13_15`.
- Never fire-and-forget; every external call is awaited and its result recorded (AGENTS.md).
- No test may reach a deployed service. Tests stub `fetch`; the local stack uses local services only.
- Never truncate pubkeys. Test pubkeys that reach `protected_minor_account_bindings` must be 64 lowercase hex (the table CHECKs it).
- Verification commands (all must pass before the branch is called done): `npx tsc -p tsconfig.app.json --noEmit`; `cd worker && npm run typecheck`; `cd worker && npx vitest run`; `cd worker && npm run test:d1`; `npx vitest run` (root); `npx vite build`.
- Mutation checks: back up with `cp` to a temporary directory outside the repo and restore with `cp`. Never `git checkout` a file to undo a mutation. Each guard dies to exactly one mutation.

## Review Focus

- An account that already has an active binding (an onboarded minor whose keycast read failed, so a case opened) is approved again: no second subject, no unique-index failure, and the existing subject gets the projection job.
- A worker deployed before keycast ships the route: the set gets keycast's generic 404, which must count as `failed` and leave the job pending, not `not_applicable`.
- A PATCH that changes the band to 13-15 and approves in one request must use the post-update band.
- A cleared case's resolution shows in the UI after the page reloads (persisted, not just in the mutation response).
- A moderator double-clicks Approve: the second PATCH must 400 (`Cannot modify a closed case`) and write no second subject.

---

### Task 1: `setVerifiedMinor` in the keycast client

**Files:**
- Modify: `worker/src/keycast-client.ts` (types at top; replace the body of `clearVerifiedMinor` ~line 147 with a shared helper; add `setVerifiedMinor`)
- Test: `worker/src/keycast-client.test.ts`

**Interfaces:**
- Produces: `KeycastResult.unclaimed?: boolean`; `KeycastReason` gains `'age_review_approved'`; `export async function setVerifiedMinor(pubkey: string, actor: string | undefined, reason: KeycastReason | undefined, env: KeycastEnv): Promise<KeycastResult>`. `clearVerifiedMinor` keeps its exact signature and behavior.

- [ ] **Step 1: Write the failing tests** (append inside the top-level `describe`, beside `describe('clearVerifiedMinor', ...)`, reusing `VALID_PUBKEY`, `makeEnv`, `fetchMock`)

```ts
  describe('setVerifiedMinor', () => {
    it('sends PUT to the verified-minor endpoint with actor and reason', async () => {
      const actor = 'b'.repeat(64);
      const result = await setVerifiedMinor(VALID_PUBKEY, actor, 'age_review_approved', makeEnv());
      expect(result).toEqual({ success: true });
      const [url, opts] = fetchMock.mock.calls[0];
      expect(url).toBe(
        `https://login.test.divine.video/api/admin/users/${VALID_PUBKEY}/verified-minor?actor=${actor}&reason=age_review_approved`,
      );
      expect(opts.method).toBe('PUT');
      expect(opts.headers['Authorization']).toBe('Bearer test-service-token');
    });

    it("reports keycast's own user-not-found as notFound (self-custody)", async () => {
      fetchMock.mockResolvedValue({ ok: false, status: 404, text: () => Promise.resolve('{"error":"user not found"}') });
      const result = await setVerifiedMinor(VALID_PUBKEY, undefined, 'age_review_approved', makeEnv());
      expect(result).toMatchObject({ success: false, status: 404, notFound: true });
    });

    it('treats a 404 without keycast\'s body (route not deployed) as a failure, not notFound', async () => {
      fetchMock.mockResolvedValue({ ok: false, status: 404, text: () => Promise.resolve('Not Found') });
      const result = await setVerifiedMinor(VALID_PUBKEY, undefined, 'age_review_approved', makeEnv());
      expect(result.success).toBe(false);
      expect(result.notFound).toBeUndefined();
      expect(result.unclaimed).toBeUndefined();
    });

    it('reports a 409 account_unclaimed refusal as unclaimed', async () => {
      fetchMock.mockResolvedValue({
        ok: false, status: 409,
        text: () => Promise.resolve('{"error":"account_unclaimed: account has no login credentials"}'),
      });
      const result = await setVerifiedMinor(VALID_PUBKEY, undefined, 'age_review_approved', makeEnv());
      expect(result).toMatchObject({ success: false, status: 409, unclaimed: true });
    });

    it('does not treat an unrelated 409 as unclaimed', async () => {
      fetchMock.mockResolvedValue({ ok: false, status: 409, text: () => Promise.resolve('{"error":"conflict"}') });
      const result = await setVerifiedMinor(VALID_PUBKEY, undefined, 'age_review_approved', makeEnv());
      expect(result.unclaimed).toBeUndefined();
    });

    it('refuses a malformed pubkey without calling keycast', async () => {
      const result = await setVerifiedMinor('nope', undefined, 'age_review_approved', makeEnv());
      expect(result).toEqual({ success: false, error: 'invalid pubkey: must be 64 hex chars' });
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });
```
Add `setVerifiedMinor` to the file's import from `./keycast-client`.

- [ ] **Step 2: Run to verify failure**

Run: `cd worker && npx vitest run src/keycast-client.test.ts`
Expected: FAIL, `setVerifiedMinor` is not exported.

- [ ] **Step 3: Implement**

In the types:

```ts
  notFound?: boolean;
  /**
   * Keycast refused to flag this row because it has no login credentials
   * (409 account_unclaimed). Permanent for this account: a retry cannot succeed.
   */
  unclaimed?: boolean;
}

export type KeycastReason =
  | 'age_review' | 'age_review_denied' | 'age_review_expired' | 'age_review_approved' | 'moderation';
```

Add beside `isKeycastUserNotFound`:

```ts
function isKeycastAccountUnclaimed(text: string): boolean {
  try {
    const data = JSON.parse(text.trim()) as Record<string, unknown>;
    return typeof data.error === 'string' && data.error.startsWith('account_unclaimed');
  } catch {
    return false;
  }
}
```

Replace `clearVerifiedMinor`'s body with a call to one shared helper, and add `setVerifiedMinor`:

```ts
/**
 * PUT sets and DELETE clears keycast's verified_minor flag. The two calls share
 * every rule -- pubkey guard, actor drop, query string, and how a refusal is
 * classified -- so they share this body.
 */
async function callVerifiedMinor(
  method: 'PUT' | 'DELETE',
  pubkey: string,
  actor: string | undefined,
  reason: KeycastReason | undefined,
  env: KeycastEnv,
): Promise<KeycastResult> {
  const verb = method === 'PUT' ? 'set' : 'clear';
  if (!env.KEYCAST_URL || !env.KEYCAST_SERVICE_TOKEN) {
    return { success: false, error: 'not configured' };
  }
  if (!HEX_64.test(pubkey)) {
    return { success: false, error: 'invalid pubkey: must be 64 hex chars' };
  }
  const token = await resolveToken(env.KEYCAST_SERVICE_TOKEN);
  if (!token) {
    return { success: false, error: 'not configured' };
  }

  const params = new URLSearchParams();
  if (actor) {
    if (HEX_64.test(actor)) {
      params.set('actor', actor);
    } else {
      console.warn(`[keycast] dropping malformed actor for verified_minor ${verb}; audit falls back to log-only`);
    }
  }
  if (reason) {
    params.set('reason', reason);
  }
  const qs = params.size > 0 ? `?${params.toString()}` : '';

  try {
    const res = await fetch(`${env.KEYCAST_URL}/api/admin/users/${pubkey}/verified-minor${qs}`, {
      method,
      headers: { 'Authorization': `Bearer ${token}` },
    });
    if (!res.ok) {
      const text = await res.text();
      if (res.status === 404 && isKeycastUserNotFound(text)) {
        console.log(`[keycast] verified_minor ${verb} not applicable: no keycast account (self-custody)`);
        return { success: false, status: 404, notFound: true, error: `404: ${text}` };
      }
      if (res.status === 409 && isKeycastAccountUnclaimed(text)) {
        console.error(`[keycast] verified_minor ${verb} refused: account has no login credentials`);
        return { success: false, status: 409, unclaimed: true, error: `409: ${text}` };
      }
      console.error(`[keycast] verified_minor ${verb} failed: ${res.status}`);
      return { success: false, status: res.status, error: `${res.status}: ${text}` };
    }
    return { success: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[keycast] verified_minor ${verb} failed: ${msg}`);
    return { success: false, error: msg };
  }
}

export async function clearVerifiedMinor(
  pubkey: string,
  actor: string | undefined,
  reason: KeycastReason | undefined,
  env: KeycastEnv,
): Promise<KeycastResult> {
  return callVerifiedMinor('DELETE', pubkey, actor, reason, env);
}

/**
 * Confer verified_minor on an existing keycast account (age-review approval,
 * #192). Requires keycast's PUT route; a keycast without it answers a bare 404,
 * which is a failure the projection cron retries, never notFound.
 */
export async function setVerifiedMinor(
  pubkey: string,
  actor: string | undefined,
  reason: KeycastReason | undefined,
  env: KeycastEnv,
): Promise<KeycastResult> {
  return callVerifiedMinor('PUT', pubkey, actor, reason, env);
}
```
Keep the existing doc comment that sits above `clearVerifiedMinor`.

- [ ] **Step 4: Run to verify pass**

Run: `cd worker && npx vitest run src/keycast-client.test.ts && npm run typecheck`
Expected: PASS, including every pre-existing `clearVerifiedMinor` test (they prove the refactor).

- [ ] **Step 5: Mutation-check** — change `startsWith('account_unclaimed')` to `includes('')`: only `does not treat an unrelated 409 as unclaimed` fails. Restore from backup.

- [ ] **Step 6: Commit**

```bash
git add worker/src/keycast-client.ts worker/src/keycast-client.test.ts
git commit -m "feat(age-review): keycast client call to set verified_minor"
```

---

### Task 2: Project each subject's current classification

**Files:**
- Modify: `worker/src/protected-minors.ts` (`clearSubject` job insert ~line 98; `pendingProjectionJobs` ~line 120)
- Modify: `worker/src/age-review.ts` (cron projection loop ~line 2035-2062; import `setVerifiedMinor`)
- Test: `worker/test/protected-minors.d1.test.ts`, `worker/test/age-review-cron.d1.test.ts`

**Interfaces:**
- Consumes: `setVerifiedMinor`, `KeycastResult.unclaimed` (Task 1).
- Produces: `pendingProjectionJobs(db): Promise<Array<{ pubkey: string; reason: string; classification: 'active' | 'cleared' }>>`. `clearSubject` re-arms an existing job row to `pending`.

- [ ] **Step 1: Write the failing tests**

In `worker/test/protected-minors.d1.test.ts` (inside the existing `describe`; it already resets schema per test — reuse its reset helper and `DB`):

```ts
  it('a clear after a completed approval projection re-arms the job instead of dropping it', async () => {
    const pubkey = 'd'.repeat(64);
    const { subjectId } = await createSubjectWithBinding(DB, 'case-approved-then-denied', pubkey);
    const earlier = '2026-01-01T00:00:00.000Z';
    await DB.prepare(`INSERT INTO protected_minor_projection_jobs
      (subject_id, pubkey, reason, state, created_at, updated_at)
      VALUES (?, ?, 'age_review_approved', 'complete', ?, ?)`).bind(subjectId, pubkey, earlier, earlier).run();

    const result = await clearSubject(DB, pubkey, undefined, 'age_review_denied');
    expect(result.success).toBe(true);

    const job = await DB.prepare(`SELECT state, reason FROM protected_minor_projection_jobs WHERE subject_id = ?`)
      .bind(subjectId).first<{ state: string; reason: string }>();
    expect(job).toEqual({ state: 'pending', reason: 'age_review_denied' });
    const jobs = await pendingProjectionJobs(DB);
    expect(jobs).toContainEqual({ pubkey, reason: 'age_review_denied', classification: 'cleared' });
  });
```
Import `pendingProjectionJobs` alongside the file's existing imports from `../src/protected-minors`.

In `worker/test/age-review-cron.d1.test.ts`, after the existing settle test (same `vi.spyOn(globalThis, 'fetch')` pattern; the file has `afterEach` restoring mocks — confirm, else call `vi.restoreAllMocks()` at the end):

```ts
  it('projects an active subject with PUT and a cleared one with DELETE', async () => {
    const now = new Date().toISOString();
    const activeKey = 'e'.repeat(64);
    const clearedKey = 'f'.repeat(64);
    await DB.prepare(`INSERT OR REPLACE INTO protected_minor_subjects
      (subject_id, classification_state, classified_at) VALUES ('subj-active', 'active', ?)`).bind(now).run();
    await DB.prepare(`INSERT OR REPLACE INTO protected_minor_subjects
      (subject_id, classification_state, classified_at, cleared_at, clear_reason, clear_reason_class)
      VALUES ('subj-cleared', 'cleared', ?, ?, 'age_review_denied', 'valid_prior')`).bind(now, now).run();
    for (const [subject, key, reason] of [
      ['subj-active', activeKey, 'age_review_approved'],
      ['subj-cleared', clearedKey, 'age_review_denied'],
    ]) {
      await DB.prepare(`INSERT OR REPLACE INTO protected_minor_projection_jobs
        (subject_id, pubkey, reason, state, created_at, updated_at) VALUES (?, ?, ?, 'pending', ?, ?)`)
        .bind(subject, key, reason, now, now).run();
    }
    const calls: Array<{ url: string; method: string }> = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
      if (String(input).includes('/verified-minor')) {
        calls.push({ url: String(input), method: init?.method ?? 'GET' });
        return Promise.resolve(new Response('{}', { status: 200 }));
      }
      return Promise.resolve(new Response('ok', { status: 200 }));
    });

    await checkAgeReviewDeadlines({ ...cronEnv, KEYCAST_URL: 'https://login.test.divine.video', KEYCAST_SERVICE_TOKEN: 'test-token' });

    expect(calls).toContainEqual({
      url: `https://login.test.divine.video/api/admin/users/${activeKey}/verified-minor?reason=age_review_approved`,
      method: 'PUT',
    });
    expect(calls).toContainEqual({
      url: `https://login.test.divine.video/api/admin/users/${clearedKey}/verified-minor?reason=age_review_denied`,
      method: 'DELETE',
    });
    const pending = await DB.prepare(
      "SELECT COUNT(*) AS c FROM protected_minor_projection_jobs WHERE state = 'pending'",
    ).first<{ c: number }>();
    expect(pending!.c).toBe(0);
  });

  it('settles a set refused as account_unclaimed rather than retrying it forever', async () => {
    const now = new Date().toISOString();
    await DB.prepare(`INSERT OR REPLACE INTO protected_minor_subjects
      (subject_id, classification_state, classified_at) VALUES ('subj-unclaimed', 'active', ?)`).bind(now).run();
    await DB.prepare(`INSERT OR REPLACE INTO protected_minor_projection_jobs
      (subject_id, pubkey, reason, state, created_at, updated_at)
      VALUES ('subj-unclaimed', ?, 'age_review_approved', 'pending', ?, ?)`).bind('9'.repeat(64), now, now).run();
    vi.spyOn(globalThis, 'fetch').mockImplementation((input) =>
      Promise.resolve(String(input).includes('/verified-minor')
        ? new Response('{"error":"account_unclaimed: account has no login credentials"}', { status: 409 })
        : new Response('ok', { status: 200 })));

    await checkAgeReviewDeadlines({ ...cronEnv, KEYCAST_URL: 'https://login.test.divine.video', KEYCAST_SERVICE_TOKEN: 'test-token' });

    const row = await DB.prepare("SELECT state FROM protected_minor_projection_jobs WHERE subject_id = 'subj-unclaimed'")
      .first<{ state: string }>();
    expect(row!.state).toBe('complete');
  });
```
If the cron test file's `reset()` does not clear `protected_minor_projection_jobs` / `protected_minor_subjects`, add `DELETE FROM` for both at the top of each new test so the earlier settle test's rows cannot leak in.

- [ ] **Step 2: Run to verify failure**

Run: `cd worker && npm run test:d1 -- test/protected-minors.d1.test.ts test/age-review-cron.d1.test.ts`
Expected: the re-arm test FAILS (job stays `complete`), the dispatch test FAILS (DELETE sent for the active subject), the unclaimed test FAILS (job stays pending).

- [ ] **Step 3: Implement**

In `clearSubject`, change the job insert's conflict clause:

```ts
      db.prepare(`INSERT INTO protected_minor_projection_jobs
        (subject_id, pubkey, reason, state, created_at, updated_at)
        VALUES (?, ?, ?, 'pending', ?, ?)
        ON CONFLICT(subject_id) DO UPDATE SET pubkey = excluded.pubkey, reason = excluded.reason,
          state = 'pending', updated_at = excluded.updated_at`)
        .bind(subject.subject_id, projectionPubkey, reason, now, now),
```
and add one line to the comment block above the batch (or above the statement if there is none):
`// One job row per subject projects whatever it last became; an approval (#192) may already own it, so re-arm rather than skip.`

Replace `pendingProjectionJobs`:

```ts
/**
 * Pending projections, each with its subject's CURRENT classification: the cron
 * projects `active` as a keycast set and `cleared` as a keycast clear. One row per
 * subject means the latest transition wins, which is the state keycast must match.
 */
export async function pendingProjectionJobs(db: D1Database): Promise<Array<{
  pubkey: string; reason: string; classification: 'active' | 'cleared';
}>> {
  const rows = await db.prepare(`SELECT j.pubkey, j.reason, s.classification_state AS classification
    FROM protected_minor_projection_jobs j
    JOIN protected_minor_subjects s ON s.subject_id = j.subject_id
    WHERE j.state = 'pending' ORDER BY j.updated_at, j.created_at LIMIT 100`)
    .all<{ pubkey: string; reason: string; classification: string }>();
  return rows.results.flatMap((row) =>
    typeof row.pubkey === 'string' && typeof row.reason === 'string'
      && (row.classification === 'active' || row.classification === 'cleared')
      ? [{ pubkey: row.pubkey, reason: row.reason, classification: row.classification }]
      : []);
}
```

In `age-review.ts`, import `setVerifiedMinor` (and `type KeycastReason` if not already imported) from `./keycast-client`, then replace the body of the cron's `for (const job of projectionJobs)` try block:

```ts
    try {
      const result = job.classification === 'active'
        ? await setVerifiedMinor(job.pubkey, undefined, job.reason as KeycastReason, env)
        : await clearVerifiedMinor(job.pubkey, undefined, job.reason as KeycastReason, env);
      // Settled when there is nothing left a retry could change: applied, no
      // keycast account (notFound), or a row keycast refuses to flag (unclaimed).
      // Left pending, those re-call keycast every tick and trip the retention
      // overdue-projection alarm.
      if (result.success || result.notFound || result.unclaimed) await markProjectionComplete(env.DB, job.pubkey);
      else {
        await markProjectionAttempt(env.DB, job.pubkey);
        console.error(`[age-review] Keycast protected-minor projection retry failed: ${result.error}`);
      }
    } catch (error) {
```
(the `catch` block stays as it is). Delete the now-superseded comment that explains `notFound` only for the clear case, keeping its substance in the new comment above.

- [ ] **Step 4: Run to verify pass**

Run: `cd worker && npm run test:d1 && npx vitest run && npm run typecheck`
Expected: PASS, including the existing deny/expiry projection tests.

- [ ] **Step 5: Mutation-check (one at a time, `cp` backup/restore)**

1. Revert the `ON CONFLICT ... DO UPDATE` to `DO NOTHING` → only the re-arm test fails.
2. Make the cron always call `clearVerifiedMinor` → only the dispatch test fails.
3. Drop `|| result.unclaimed` from the settle condition → only the unclaimed test fails.

- [ ] **Step 6: Commit**

```bash
git add worker/src/protected-minors.ts worker/src/age-review.ts worker/test/protected-minors.d1.test.ts worker/test/age-review-cron.d1.test.ts
git commit -m "fix(age-review): project a protected subject's current classification, not only clears"
```

---

### Task 3: `resolution` on the PATCH, persisted as `clear_resolution`

**Files:**
- Modify: `shared/age-review.ts` (new union near `AGE_BANDS`; `AgeReviewCase` ~line 220; `AgeReviewEnforcement` ~line 269)
- Modify: `worker/src/db.ts` (`CREATE TABLE age_review_cases` ~line 83; column loop ~line 121)
- Create: `worker/migrations/0016_age_review_clear_resolution.sql`
- Modify: `worker/src/age-review.ts` (`handleUpdateAgeReviewCase`, after the "Age band change" block)
- Modify: existing tests that PATCH `state: 'cleared'` (find with the grep in Step 1)
- Test: `worker/test/age-review-handler.d1.test.ts`

**Interfaces:**
- Produces: `CLEAR_RESOLUTIONS`, `type ClearResolution`, `isClearResolution(value: unknown): value is ClearResolution`; `AgeReviewCase.clear_resolution?: ClearResolution | null`; `AgeReviewEnforcement.subjectActivate?`, `keycastMinorSet?`, `keycastMinorSetError?`; the validated, persisted `body.resolution` (Task 4 derives `approvingMinor` from it).

- [ ] **Step 1: Write the failing tests** (new `describe` in `worker/test/age-review-handler.d1.test.ts`, using the file's `reset`, `patch`, `DB`)

```ts
describe('clear resolution on the PATCH', () => {
  beforeEach(async () => {
    await reset();
    for (const table of ['protected_minor_projection_jobs', 'protected_minor_account_bindings', 'protected_minor_subjects']) {
      await DB.prepare(`DELETE FROM ${table}`).run();
    }
  });

  // Hex pubkey: once Task 4 lands, an approval binds it and the bindings table CHECKs the shape.
  async function insertBandCase(id: string, band: string) {
    await DB.prepare(
      `INSERT INTO age_review_cases (id, pubkey, state, suspected_age_band, deadline_at, clock_paused, version)
       VALUES (?, ?, 'under_moderator_review', ?, ?, 0, 0)`,
    ).bind(id, 'a'.repeat(64), band, new Date(Date.now() + 9 * 864e5).toISOString()).run();
  }
  const caseRow = (id: string) => DB.prepare('SELECT state, clear_resolution FROM age_review_cases WHERE id = ?')
    .bind(id).first<{ state: string; clear_resolution: string | null }>();

  it('rejects a Clear with no resolution and leaves the case open', async () => {
    await insertBandCase('r-none', 'age_13_15');
    const res = await patch('r-none', { state: 'cleared' });
    expect(res.status).toBe(400);
    expect(await caseRow('r-none')).toEqual({ state: 'under_moderator_review', clear_resolution: null });
  });

  it('rejects an unknown resolution', async () => {
    await insertBandCase('r-bad', 'age_13_15');
    const res = await patch('r-bad', { state: 'cleared', resolution: 'maybe' });
    expect(res.status).toBe(400);
    expect((await caseRow('r-bad'))!.state).toBe('under_moderator_review');
  });

  it('rejects a resolution sent without a Clear', async () => {
    await insertBandCase('r-orphan', 'age_13_15');
    const res = await patch('r-orphan', { state: 'needs_follow_up', resolution: 'not_minor' });
    expect(res.status).toBe(400);
    expect((await caseRow('r-orphan'))!.state).toBe('under_moderator_review');
  });

  it('rejects approved_minor outside the 13-15 band', async () => {
    await insertBandCase('r-adult', 'age_16_plus_claimed');
    const res = await patch('r-adult', { state: 'cleared', resolution: 'approved_minor' });
    expect(res.status).toBe(400);
    expect((await caseRow('r-adult'))!.state).toBe('under_moderator_review');
  });

  it('uses the post-update band when the same PATCH sets 13-15 and approves', async () => {
    await insertBandCase('r-reband', 'age_16_plus_claimed');
    const res = await patch('r-reband', {
      state: 'cleared', resolution: 'approved_minor', suspected_age_band: 'age_13_15',
    });
    expect(res.status).not.toBe(400);
    expect(await caseRow('r-reband')).toEqual({ state: 'cleared', clear_resolution: 'approved_minor' });
  });

  it('persists not_minor and writes no protected-minor subject', async () => {
    await insertBandCase('r-dismiss', 'age_13_15');
    const res = await patch('r-dismiss', { state: 'cleared', resolution: 'not_minor' });
    expect(res.status).not.toBe(400);
    expect(await caseRow('r-dismiss')).toEqual({ state: 'cleared', clear_resolution: 'not_minor' });
    const subjects = await DB.prepare(
      "SELECT COUNT(*) AS c FROM protected_minor_subjects WHERE source_case_id = 'r-dismiss'",
    ).first<{ c: number }>();
    expect(subjects!.c).toBe(0);
  });

  it('ensureSchema adds clear_resolution idempotently', async () => {
    await ensureSchema(DB);
    await ensureSchema(DB);
    const cols = await DB.prepare('PRAGMA table_info(age_review_cases)').all<{ name: string }>();
    expect(cols.results.map((c) => c.name)).toContain('clear_resolution');
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd worker && npm run test:d1 -- test/age-review-handler.d1.test.ts`
Expected: FAIL (no `clear_resolution` column; Clear without resolution returns 200/207).

- [ ] **Step 3: Implement shared types** in `shared/age-review.ts`

After the `AGE_BANDS` lines:

```ts
// How a `cleared` case was resolved (#192). `cleared` alone is overloaded: a
// confirmed 13-15 minor and a dismissed report both end there, and only the
// former may confer durable protected-minor status.
export const CLEAR_RESOLUTIONS = ['approved_minor', 'not_minor'] as const;
export type ClearResolution = typeof CLEAR_RESOLUTIONS[number];
export function isClearResolution(value: unknown): value is ClearResolution {
  return typeof value === 'string' && (CLEAR_RESOLUTIONS as readonly string[]).includes(value);
}
```

In `AgeReviewCase`, after `redacted_at?`:

```ts
  /** Set when a case is cleared (#192). Null on cases cleared before it existed. */
  clear_resolution?: ClearResolution | null;
```

In `AgeReviewEnforcement`, after `subjectClearError?`:

```ts
  /** Protected-minor subject recorded with an approval; atomic with the case update (#192). */
  subjectActivate?: EnforcementLegStatus;
  /** Keycast verified_minor set on approval; retried by the projection cron (#192). */
  keycastMinorSet?: EnforcementLegStatus;
  keycastMinorSetError?: string;
```

- [ ] **Step 4: Implement the schema**

`worker/src/db.ts`: add `clear_resolution TEXT CHECK (clear_resolution IN ('approved_minor', 'not_minor')),` to the `CREATE TABLE age_review_cases` column list after `redacted_at TEXT,`, and extend the column loop:

```ts
  for (const column of [
    `closed_at TEXT`,
    `redacted_at TEXT`,
    `clear_resolution TEXT CHECK (clear_resolution IN ('approved_minor', 'not_minor'))`,
  ]) {
```

`worker/migrations/0016_age_review_clear_resolution.sql`:

```sql
-- How a cleared age-review case was resolved (#192). Production schema is also healed by ensureSchema().
ALTER TABLE age_review_cases ADD COLUMN clear_resolution TEXT
  CHECK (clear_resolution IN ('approved_minor', 'not_minor'));
```

- [ ] **Step 5: Implement the validation** in `handleUpdateAgeReviewCase`, directly after the "Age band change" block (import `isClearResolution`, `CLEAR_RESOLUTIONS` from `../../shared/age-review`):

```ts
  // Clear resolution (#192). The moderator states which kind of Clear this is,
  // because only an explicit 13-15 approval may confer durable protected-minor
  // status; dismissing a report on a default-band case must not.
  if (body.resolution !== undefined || body.state === 'cleared') {
    if (body.state !== 'cleared') {
      return json({ success: false, error: "resolution is only valid with state 'cleared'" }, 400, corsHeaders);
    }
    if (!isClearResolution(body.resolution)) {
      return json({
        success: false,
        error: `resolution must be one of: ${CLEAR_RESOLUTIONS.join(', ')}`,
      }, 400, corsHeaders);
    }
    // Band validity was checked above, so the post-update band is one of AGE_BANDS.
    const effectiveBand = typeof body.suspected_age_band === 'string'
      ? body.suspected_age_band
      : existing.suspected_age_band;
    if (body.resolution === 'approved_minor' && effectiveBand !== 'age_13_15') {
      return json({ success: false, error: 'approved_minor requires the 13-15 age band' }, 400, corsHeaders);
    }
    updates.push('clear_resolution = ?');
    binds.push(body.resolution);
  }
```

- [ ] **Step 5b: Onboarding parity.** In `handleCreateMinorAccount`'s `INSERT INTO age_review_cases` (~line 802), add `clear_resolution` to the column list after `closed_at` and the literal `'approved_minor'` as the matching value, so an onboarded case and an approved one record the same resolution. Add to the existing onboarding test in `worker/test/protected-minors.d1.test.ts` (`records onboarding case, subject, binding, and operation atomically`) an assertion that the created case has `clear_resolution = 'approved_minor'`; confirm it fails before the SQL change and passes after.

- [ ] **Step 6: Update existing Clear callers in tests**

Run: `grep -rn "state: 'cleared'" worker/src/age-review.test.ts worker/test src/components/*.test.tsx | grep -v "as const\|makeCase"`
For every PATCH body that sends `state: 'cleared'`, add `resolution: 'not_minor'` (it preserves today's behaviour exactly). Do not change fixtures that only describe a case already in `cleared`.

- [ ] **Step 7: Run to verify pass**

Run: `cd worker && npm run test:d1 && npx vitest run && npm run typecheck && cd .. && npx tsc -p tsconfig.app.json --noEmit`
Expected: PASS.

- [ ] **Step 8: Mutation-check (one at a time)**

1. Remove the `body.state !== 'cleared'` return → only `rejects a resolution sent without a Clear` fails.
2. Remove the `isClearResolution` return → only `rejects a Clear with no resolution` and `rejects an unknown resolution` fail (both test the same guard; acceptable).
3. Replace `effectiveBand` with `existing.suspected_age_band` → only `uses the post-update band` fails.
4. Remove the band return → only `rejects approved_minor outside the 13-15 band` fails.

- [ ] **Step 9: Commit**

```bash
git add shared/age-review.ts worker/src/db.ts worker/migrations/0016_age_review_clear_resolution.sql worker/src/age-review.ts worker/test/age-review-handler.d1.test.ts worker/src/age-review.test.ts src/components
git commit -m "feat(age-review): require an explicit resolution when clearing a case"
```

---

### Task 4: Atomic approval: registry writes and the keycast set leg

**Files:**
- Modify: `worker/src/protected-minors.ts` (new `approvalRegistryStatements` after `createSubjectWithBinding`)
- Modify: `worker/src/age-review.ts` (CAS ~line 400; enforcement legs ~line 540-640)
- Test: `worker/test/age-review-handler.d1.test.ts`

**Interfaces:**
- Consumes: `approvingMinor` (Task 3), `setVerifiedMinor` + `unclaimed` (Task 1), `markProjectionComplete`.
- Produces: `export function approvalRegistryStatements(db: D1Database, input: { caseId: string; pubkey: string; landedVersion: number; now: string }): D1PreparedStatement[]`; response `enforcement.subjectActivate` / `keycastMinorSet` / `keycastMinorSetError`.

- [ ] **Step 1: Write the failing tests** (new `describe` in `worker/test/age-review-handler.d1.test.ts`; import `resolveByPubkey` from `../src/protected-minors`)

```ts
describe('approving a 13-15 minor', () => {
  const pubkey = '7'.repeat(64);
  const keycastEnv = () => ({ ...env, KEYCAST_URL: 'https://login.test.divine.video', KEYCAST_SERVICE_TOKEN: 'test-token' });
  let keycastPuts: string[];

  beforeEach(async () => {
    await reset();
    for (const table of ['protected_minor_projection_jobs', 'protected_minor_account_bindings', 'protected_minor_subjects']) {
      await DB.prepare(`DELETE FROM ${table}`).run();
    }
    await DB.prepare(
      `INSERT INTO age_review_cases (id, pubkey, state, suspected_age_band, deadline_at, clock_paused, version)
       VALUES ('ap', ?, 'submitted_for_review', 'age_13_15', ?, 0, 0)`,
    ).bind(pubkey, new Date(Date.now() + 9 * 864e5).toISOString()).run();
    keycastPuts = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
      if (String(input).includes('/verified-minor') && init?.method === 'PUT') keycastPuts.push(String(input));
      return Promise.resolve(new Response('{}', { status: 200 }));
    });
  });
  afterEach(() => vi.restoreAllMocks());

  function approve(body: Record<string, unknown> = {}) {
    const req = new Request('https://api.test/api/age-review/cases/ap', {
      method: 'PATCH',
      body: JSON.stringify({ state: 'cleared', resolution: 'approved_minor', ...body }),
    });
    return handleUpdateAgeReviewCase(req, 'ap', keycastEnv(), cors);
  }
  const pendingJobs = async () => (await DB.prepare(
    "SELECT COUNT(*) AS c FROM protected_minor_projection_jobs WHERE state = 'pending'",
  ).first<{ c: number }>())!.c;

  it('records an active subject sourced from the case and projects verified_minor', async () => {
    const res = await approve();
    const body = await res.json() as { enforcement: { subjectActivate: string; keycastMinorSet: string } };
    expect(body.enforcement.subjectActivate).toBe('ok');
    expect(body.enforcement.keycastMinorSet).toBe('ok');
    expect(await resolveByPubkey(DB, pubkey)).not.toBeNull();
    const subject = await DB.prepare('SELECT source_case_id, classification_state FROM protected_minor_subjects')
      .first<{ source_case_id: string; classification_state: string }>();
    expect(subject).toEqual({ source_case_id: 'ap', classification_state: 'active' });
    expect(keycastPuts).toEqual([
      `https://login.test.divine.video/api/admin/users/${pubkey}/verified-minor?reason=age_review_approved`,
    ]);
    expect(await pendingJobs()).toBe(0);
  });

  // The handler's up-front version check rejects a stale client before the batch
  // runs, so the batch's own CAS guard is only reachable under a true race. Drive
  // the statements directly to prove each write is gated on the CAS having landed.
  describe('approvalRegistryStatements guard', () => {
    async function runWith(landedVersion: number) {
      await DB.batch(approvalRegistryStatements(DB, {
        caseId: 'ap', pubkey, landedVersion, now: new Date().toISOString(),
      }));
    }

    it('writes subject, binding and job when the case landed at that version as approved_minor', async () => {
      await DB.prepare("UPDATE age_review_cases SET state = 'cleared', clear_resolution = 'approved_minor', version = 3 WHERE id = 'ap'").run();
      await runWith(3);
      expect(await resolveByPubkey(DB, pubkey)).not.toBeNull();
      expect(await pendingJobs()).toBe(1);
    });

    it('writes nothing when the CAS missed (case not at the landed version)', async () => {
      await DB.prepare("UPDATE age_review_cases SET state = 'cleared', clear_resolution = 'approved_minor', version = 3 WHERE id = 'ap'").run();
      await runWith(4);
      expect(await resolveByPubkey(DB, pubkey)).toBeNull();
      expect(await pendingJobs()).toBe(0);
    });

    it('writes nothing for a case resolved as not_minor', async () => {
      await DB.prepare("UPDATE age_review_cases SET state = 'cleared', clear_resolution = 'not_minor', version = 3 WHERE id = 'ap'").run();
      await runWith(3);
      expect(await resolveByPubkey(DB, pubkey)).toBeNull();
    });
  });

  it('reuses an existing active subject instead of creating a second one', async () => {
    await createSubjectWithBinding(DB, 'onboarding-case', pubkey);
    const res = await approve();
    expect(res.status).not.toBe(500);
    const count = await DB.prepare('SELECT COUNT(*) AS c FROM protected_minor_subjects').first<{ c: number }>();
    expect(count!.c).toBe(1);
    expect(keycastPuts).toHaveLength(1);
  });

  it('keeps the job pending when keycast fails (route not yet deployed)', async () => {
    vi.restoreAllMocks();
    vi.spyOn(globalThis, 'fetch').mockImplementation((input) => Promise.resolve(
      String(input).includes('/verified-minor') ? new Response('Not Found', { status: 404 }) : new Response('{}', { status: 200 }),
    ));
    const res = await approve();
    expect(res.status).toBe(207);
    const body = await res.json() as { enforcementComplete: boolean; enforcement: { keycastMinorSet: string } };
    expect(body.enforcementComplete).toBe(false);
    expect(body.enforcement.keycastMinorSet).toBe('failed');
    expect(await pendingJobs()).toBe(1);
    expect(await resolveByPubkey(DB, pubkey)).not.toBeNull(); // the approval itself stands
  });

  it('settles the job for a self-custody account (keycast user not found)', async () => {
    vi.restoreAllMocks();
    vi.spyOn(globalThis, 'fetch').mockImplementation((input) => Promise.resolve(
      String(input).includes('/verified-minor')
        ? new Response('{"error":"user not found"}', { status: 404 })
        : new Response('{}', { status: 200 }),
    ));
    const body = await (await approve()).json() as { enforcement: { keycastMinorSet: string } };
    expect(body.enforcement.keycastMinorSet).toBe('not_applicable');
    expect(await pendingJobs()).toBe(0);
  });

  it('settles but reports a set keycast refuses as account_unclaimed', async () => {
    vi.restoreAllMocks();
    vi.spyOn(globalThis, 'fetch').mockImplementation((input) => Promise.resolve(
      String(input).includes('/verified-minor')
        ? new Response('{"error":"account_unclaimed: account has no login credentials"}', { status: 409 })
        : new Response('{}', { status: 200 }),
    ));
    const res = await approve();
    expect(res.status).toBe(207);
    const body = await res.json() as { enforcement: { keycastMinorSet: string } };
    expect(body.enforcement.keycastMinorSet).toBe('failed');
    expect(await pendingJobs()).toBe(0);
  });

  it('a second Approve on the closed case is refused and writes nothing', async () => {
    await approve();
    const again = await approve();
    expect(again.status).toBe(400);
    const count = await DB.prepare('SELECT COUNT(*) AS c FROM protected_minor_subjects').first<{ c: number }>();
    expect(count!.c).toBe(1);
  });

  it('not_minor makes no keycast set call', async () => {
    const req = new Request('https://api.test/api/age-review/cases/ap', {
      method: 'PATCH', body: JSON.stringify({ state: 'cleared', resolution: 'not_minor' }),
    });
    const body = await (await handleUpdateAgeReviewCase(req, 'ap', keycastEnv(), cors)).json() as {
      enforcement: { keycastMinorSet: string; subjectActivate: string };
    };
    expect(body.enforcement.keycastMinorSet).toBe('not_attempted');
    expect(body.enforcement.subjectActivate).toBe('not_attempted');
    expect(keycastPuts).toHaveLength(0);
  });
});
```
Add `afterEach` to the vitest import at the top of the file if missing, and import `approvalRegistryStatements` and `resolveByPubkey` from `../src/protected-minors`. The relay and bulk legs will report `failed` in these tests (no relay configured), so assert on status 200 only where the test needs it; where a test asserts `res.status === 200`, change it to read the keycast leg instead if the relay leg makes it 207. Keep assertions on the legs this task owns.

- [ ] **Step 2: Run to verify failure**

Run: `cd worker && npm run test:d1 -- test/age-review-handler.d1.test.ts`
Expected: FAIL (no subject written; `subjectActivate` / `keycastMinorSet` undefined).

- [ ] **Step 3: Implement `approvalRegistryStatements`** in `worker/src/protected-minors.ts`

```ts
/**
 * Registry writes for an age-review approval (#192), run in the SAME db.batch as
 * the case's compare-and-swap UPDATE and after it. Every write is gated on the CAS
 * having landed (the case at the bumped version, resolved as approved_minor), so a
 * lost CAS writes nothing, and the batch's transaction means an approved case never
 * exists without its subject. A pubkey that already holds an active binding (an
 * onboarded account, say) keeps its subject; only the projection job is (re)armed.
 * The "no active binding" test matches idx_protected_minor_active_pubkey_binding,
 * so these inserts can never trip it and roll the approval back.
 */
export function approvalRegistryStatements(
  db: D1Database,
  input: { caseId: string; pubkey: string; landedVersion: number; now: string },
): D1PreparedStatement[] {
  const subjectId = crypto.randomUUID();
  const bindingId = crypto.randomUUID();
  const landed = `EXISTS (SELECT 1 FROM age_review_cases
    WHERE id = ?1 AND version = ?2 AND clear_resolution = 'approved_minor')`;
  const noActiveBinding = `NOT EXISTS (SELECT 1 FROM protected_minor_account_bindings
    WHERE pubkey = ?3 AND unbound_at IS NULL)`;
  return [
    db.prepare(`INSERT INTO protected_minor_subjects (subject_id, source_case_id, classification_state, classified_at)
      SELECT ?5, ?1, 'active', ?4 WHERE ${landed} AND ${noActiveBinding}`)
      .bind(input.caseId, input.landedVersion, input.pubkey, input.now, subjectId),
    db.prepare(`INSERT INTO protected_minor_account_bindings (id, subject_id, pubkey, bound_at)
      SELECT ?6, subject_id, ?3, ?4 FROM protected_minor_subjects
      WHERE subject_id = ?5 AND ${landed} AND ${noActiveBinding}`)
      .bind(input.caseId, input.landedVersion, input.pubkey, input.now, subjectId, bindingId),
    db.prepare(`INSERT INTO protected_minor_projection_jobs (subject_id, pubkey, reason, state, created_at, updated_at)
      SELECT b.subject_id, ?3, 'age_review_approved', 'pending', ?4, ?4
      FROM protected_minor_account_bindings b
      JOIN protected_minor_subjects s ON s.subject_id = b.subject_id
      WHERE b.pubkey = ?3 AND b.unbound_at IS NULL AND s.classification_state = 'active' AND ${landed}
      ON CONFLICT(subject_id) DO UPDATE SET pubkey = excluded.pubkey, reason = excluded.reason,
        state = 'pending', created_at = excluded.created_at, updated_at = excluded.updated_at`)
      .bind(input.caseId, input.landedVersion, input.pubkey, input.now),
  ];
}
```
Each statement binds exactly as many values as its highest `?N`. If D1 rejects the bind count, the Step 5 run shows it; fix by binding exactly up to the highest index used.

- [ ] **Step 4: Wire the handler** in `worker/src/age-review.ts`

Import `approvalRegistryStatements` from `./protected-minors` and `setVerifiedMinor`, `type KeycastResult` from `./keycast-client`. Directly after the clear-resolution block added in Task 3, add:

```ts
  const approvingMinor = body.state === 'cleared' && body.resolution === 'approved_minor';
```

Replace the CAS execution:

```ts
  const casStatement = env.DB.prepare(
    `UPDATE age_review_cases SET ${updates.join(', ')} WHERE id = ? AND version = ?`
  ).bind(...binds, caseId, existing.version);

  // An approval records the protected-minor subject in the same transaction as the
  // CAS, so a case is never approved without its durable record (#192).
  let updateResult: D1Result;
  if (approvingMinor) {
    try {
      [updateResult] = await env.DB.batch([
        casStatement,
        ...approvalRegistryStatements(env.DB, {
          caseId,
          pubkey: existing.pubkey,
          landedVersion: existing.version + 1,
          now: new Date().toISOString(),
        }),
      ]);
    } catch (error) {
      console.error('[age-review] Approval batch failed; nothing was written:', error);
      return json({ success: false, error: 'Approval could not be recorded. Nothing was changed; retry.' }, 500, corsHeaders);
    }
  } else {
    updateResult = await casStatement.run();
  }
```
(the existing `if (updateResult.meta?.changes !== 1)` block follows unchanged).

In the enforcement section, add declarations beside the existing leg variables:

```ts
  let subjectActivate: EnforcementLegStatus = 'not_attempted';
  let keycastMinorSet: EnforcementLegStatus = 'not_attempted';
  let keycastMinorSetError: string | undefined;
```

Rename `minorClearActor` to `minorFlagActor` (it is now the actor for both directions; update its uses). Inside `if (requestedState !== undefined) {`, after the `markProjectionComplete` block for the deny path, add:

```ts
    // Approval (#192): the subject committed with the CAS above. Project it onto
    // keycast now; anything a retry could still fix stays pending for the cron.
    if (approvingMinor) subjectActivate = 'ok';
    let minorSetResult: KeycastResult | undefined;
    const minorSetLeg = await runStatusLeg('Keycast verified_minor set', () =>
      approvingMinor
        ? setVerifiedMinor(existing.pubkey, minorFlagActor, 'age_review_approved', env)
          .then((result) => { minorSetResult = result; return result; })
        : undefined);
    keycastMinorSet = minorSetLeg.status;
    keycastMinorSetError = minorSetLeg.error;
    // `unclaimed` is reported as failed (a human must look) but settled: keycast
    // refuses that row permanently, so a retry would only re-fail every tick.
    if (approvingMinor && (keycastMinorSet === 'ok' || keycastMinorSet === 'not_applicable' || minorSetResult?.unclaimed)) {
      try {
        await markProjectionComplete(env.DB, existing.pubkey, 'active');
      } catch (error) {
        console.error('[age-review] Failed to mark approval projection complete:', error);
      }
    }
```

Extend the response assembly:

```ts
  const enforcement: AgeReviewEnforcement = {
    relay, relayError, bulk, bulkError, keycast, keycastError,
    keycastMinorClear, keycastMinorClearError, subjectClear, subjectClearError,
    subjectActivate, keycastMinorSet, keycastMinorSetError,
  };
  const enforcementComplete = relay !== 'failed' && bulk !== 'failed' && keycast !== 'failed'
    && keycastMinorClear !== 'failed' && subjectClear !== 'failed' && keycastMinorSet !== 'failed';
```

Update the "Deliberately NOT on `cleared`" comment above the deny leg so it stays true: clearing the flag still happens only on deny/expiry; setting it now happens only on an explicit `approved_minor` Clear (see below); a `not_minor` Clear touches neither.

- [ ] **Step 5: Run to verify pass**

Run: `cd worker && npm run test:d1 && npx vitest run && npm run typecheck`
Expected: PASS.

- [ ] **Step 6: Mutation-check (one at a time)**

1. Delete `AND ${landed}` from the subject insert → only `writes nothing when the CAS missed` and `writes nothing for a case resolved as not_minor` fail (same guard, two inputs).
2. Delete `AND ${noActiveBinding}` from the subject and binding inserts → only `reuses an existing active subject` fails (via a unique-index 500 or a second subject).
3. Drop `|| minorSetResult?.unclaimed` → only the account_unclaimed test fails.
4. Make the set leg run on every Clear (`clearedCase` instead of `approvingMinor`) → only `not_minor makes no keycast set call` fails.
5. Drop `&& keycastMinorSet !== 'failed'` from `enforcementComplete` → only `keeps the job pending when keycast fails` fails.

- [ ] **Step 7: Commit**

```bash
git add worker/src/protected-minors.ts worker/src/age-review.ts worker/test/age-review-handler.d1.test.ts
git commit -m "feat(age-review): approving a 13-15 minor records a protected subject and sets verified_minor"
```

---

### Task 5: ReportWatcher auto-clears from the registry too

**Files:**
- Modify: `worker/src/ReportWatcher.ts` (`createAgeReviewCase` auto-clear block ~line 1379; import `resolveByPubkey`)
- Test: `worker/src/ReportWatcher.test.ts` (`describe('age review case creation')` ~line 2764)

**Interfaces:**
- Consumes: `resolveByPubkey(db, pubkey): Promise<{ subjectRef: string } | null>` (exists).

- [ ] **Step 1: Write the failing tests** (inside `describe('age review case creation')`, using `makeMockDb`, `sendUnderageReport`, `mockGetUserStatus`)

```ts
    function routeRegistryLookup(result: unknown | Error) {
      const prepare = ageEnv.DB!.prepare as ReturnType<typeof vi.fn>;
      const fallback = prepare.getMockImplementation();
      prepare.mockImplementation((sql: string) => {
        if (sql.includes('protected_minor_account_bindings')) {
          const first = result instanceof Error ? vi.fn().mockRejectedValue(result) : vi.fn().mockResolvedValue(result);
          return { bind: vi.fn().mockReturnValue({ first, run: mockDbRun }), first, run: mockDbRun };
        }
        return fallback ? fallback(sql) : { run: mockDbRun, first: mockDbFirst, bind: vi.fn().mockReturnValue({ run: mockDbRun, first: mockDbFirst }) };
      });
    }

    it('auto-clears an account with an active protected-minor subject without asking keycast', async () => {
      routeRegistryLookup({ subject_id: '11111111-1111-4111-8111-111111111111' });
      await sendUnderageReport('registry_hit_1', 'c'.repeat(64));
      const insertSql = (ageEnv.DB!.prepare as ReturnType<typeof vi.fn>).mock.calls
        .map((c) => String(c[0])).find((sql) => sql.includes('INSERT INTO age_review_cases'))!;
      expect(insertSql).toContain("'cleared'");
      // An auto-clear observes an existing approval; it is not a new decision, so it records no
      // clear_resolution (the latest-decision rule in pendingSubjectClears counts only explicit approvals).
      expect(insertSql).not.toContain("'approved_minor'");
      expect(mockGetUserStatus).not.toHaveBeenCalled();
    });

    it('falls back to keycast when the registry lookup throws', async () => {
      routeRegistryLookup(new Error('D1 unavailable'));
      mockGetUserStatus.mockResolvedValue({ success: true, status: 'active', verified_minor: true });
      await sendUnderageReport('registry_throw_1', 'd'.repeat(64));
      const insertSql = (ageEnv.DB!.prepare as ReturnType<typeof vi.fn>).mock.calls
        .map((c) => String(c[0])).find((sql) => sql.includes('INSERT INTO age_review_cases'))!;
      expect(insertSql).toContain("'cleared'");
      expect(mockGetUserStatus).toHaveBeenCalled();
    });

    it('opens a normal case when neither the registry nor keycast knows the account', async () => {
      routeRegistryLookup(null);
      mockGetUserStatus.mockResolvedValue({ success: true, status: 'active', verified_minor: false });
      await sendUnderageReport('registry_miss_1', 'e'.repeat(64));
      const insertSql = (ageEnv.DB!.prepare as ReturnType<typeof vi.fn>).mock.calls
        .map((c) => String(c[0])).find((sql) => sql.includes('INSERT INTO age_review_cases'))!;
      expect(insertSql).not.toContain("'cleared'");
    });
```
`makeMockDb` uses `prepare: vi.fn().mockReturnValue(stmtMock)`, so `getMockImplementation()` is undefined and the explicit fallback object in `routeRegistryLookup` is what non-registry SQL gets; it mirrors `stmtMock`.

- [ ] **Step 2: Run to verify failure**

Run: `cd worker && npx vitest run src/ReportWatcher.test.ts -t "age review case creation"`
Expected: the registry-hit test FAILS (keycast consulted, case not `approved_minor`).

- [ ] **Step 3: Implement** in `ReportWatcher.ts`

Import `resolveByPubkey` from `./protected-minors`. Add a private method near `createAgeReviewCase`:

```ts
  /**
   * An approved minor: an active protected-minor subject (#192; the durable record,
   * and the only one a self-custody account has) or keycast's verified_minor flag
   * (covers onboarding accounts and any projection still pending). The registry is
   * read first because it is local and survives a keycast outage.
   */
  private async isApprovedMinor(pubkey: string): Promise<boolean> {
    try {
      if (await resolveByPubkey(this.env.DB!, pubkey)) return true;
    } catch (err) {
      console.warn('[ReportWatcher] Protected-minor registry check failed; falling back to keycast:', err);
    }
    const keycastStatus = await getUserStatus(pubkey, this.env);
    return keycastStatus.success && keycastStatus.verified_minor === true;
  }
```

In the auto-clear block, replace

```ts
      const keycastStatus = await getUserStatus(reportedPubkey, this.env);
      if (keycastStatus.success && keycastStatus.verified_minor) {
```
with
```ts
      if (await this.isApprovedMinor(reportedPubkey)) {
```
Leave that block's `INSERT INTO age_review_cases` without a `clear_resolution` (NULL): an auto-clear observes an existing approval rather than deciding one, and Task 4's latest-decision rule in `pendingSubjectClears` must count only explicit approvals (controller ruling, see ledger). Update the block's leading comment to "Auto-clear: an approved minor (registry or keycast) is recorded as already cleared", and the `catch` warning to "Approved-minor check failed; proceeding with normal case".

- [ ] **Step 4: Run to verify pass**

Run: `cd worker && npx vitest run src/ReportWatcher.test.ts && npm run typecheck`
Expected: PASS, including the existing identity-capture tests (they assert the auto-clear INSERT's bind arity).

- [ ] **Step 5: Mutation-check** — remove the `resolveByPubkey` line → only the registry-hit test fails. Restore.

- [ ] **Step 6: Commit**

```bash
git add worker/src/ReportWatcher.ts worker/src/ReportWatcher.test.ts
git commit -m "feat(age-review): auto-clear reports against accounts in the protected-minor registry"
```

---

### Task 6: Moderator UI: two explicit actions

**Files:**
- Modify: `src/components/ConfirmDialog.tsx`
- Modify: `src/components/AgeReviewDetail.tsx` (header badge ~line 285; failure toast ~line 185; terminal actions ~line 580)
- Modify: `src/components/AgeReview.*.test.tsx` that click `{ name: 'Clear' }` (5 files)
- Test: `src/components/AgeReviewDetail.test.tsx`

**Interfaces:**
- Consumes: `ClearResolution`, `AgeReviewCase.clear_resolution`, `AgeReviewEnforcement.keycastMinorSet` (Task 3).
- Produces: `ConfirmDialog` prop `confirmVariant?: 'destructive' | 'approve'` (default `'destructive'`).

- [ ] **Step 1: Write the failing tests** (in `AgeReviewDetail.test.tsx`; follow the file's existing render helper — find it with `grep -n "function render\|renderDetail" src/components/AgeReviewDetail.test.tsx` and use it as `renderDetail(makeCase(...))` below)

```tsx
describe('clearing a case', () => {
  beforeEach(() => updateAgeReviewCase.mockClear());

  it('offers approval as a protected minor only on a 13-15 case', async () => {
    renderDetail(makeCase({ suspected_age_band: 'age_13_15' }));
    expect(await screen.findByRole('button', { name: /Approve as protected minor/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Clear: not a minor' })).toBeInTheDocument();
  });

  it('hides approval outside the 13-15 band', async () => {
    renderDetail(makeCase({ suspected_age_band: 'age_16_plus_claimed' }));
    await screen.findByRole('button', { name: 'Clear: not a minor' });
    expect(screen.queryByRole('button', { name: /Approve as protected minor/ })).not.toBeInTheDocument();
  });

  it('sends approved_minor only after the moderator confirms', async () => {
    renderDetail(makeCase({ suspected_age_band: 'age_13_15' }));
    fireEvent.click(await screen.findByRole('button', { name: /Approve as protected minor/ }));
    expect(updateAgeReviewCase).not.toHaveBeenCalled();
    fireEvent.click(await screen.findByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(updateAgeReviewCase).toHaveBeenCalledWith(
      'case-1', expect.objectContaining({ state: 'cleared', resolution: 'approved_minor' }),
    ));
  });

  it('cancelling the confirm sends nothing', async () => {
    renderDetail(makeCase({ suspected_age_band: 'age_13_15' }));
    fireEvent.click(await screen.findByRole('button', { name: /Approve as protected minor/ }));
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }));
    expect(updateAgeReviewCase).not.toHaveBeenCalled();
  });

  it('Clear: not a minor sends not_minor immediately', async () => {
    renderDetail(makeCase({ suspected_age_band: 'age_13_15' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Clear: not a minor' }));
    await waitFor(() => expect(updateAgeReviewCase).toHaveBeenCalledWith(
      'case-1', expect.objectContaining({ state: 'cleared', resolution: 'not_minor' }),
    ));
  });

  it('shows how a closed case was resolved', async () => {
    renderDetail(makeCase({ state: 'cleared', clear_resolution: 'approved_minor' }));
    expect(await screen.findByText('Approved minor')).toBeInTheDocument();
  });

  it('names a failed verified_minor set in the incomplete-enforcement toast', async () => {
    updateAgeReviewCase.mockResolvedValueOnce({
      success: false, enforcementComplete: false,
      enforcement: { relay: 'ok', bulk: 'ok', keycast: 'ok', subjectActivate: 'ok', keycastMinorSet: 'failed' },
    });
    renderDetail(makeCase({ suspected_age_band: 'age_13_15' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Clear: not a minor' }));
    await waitFor(() => expect(toast).toHaveBeenCalledWith(expect.objectContaining({
      description: expect.stringContaining('protected-minor account flag'),
    })));
  });
});
```
(`updateAgeReviewCase` is called as `api.updateAgeReviewCase(c.id, {...})`, two arguments, per the hook mock.)

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/components/AgeReviewDetail.test.tsx`
Expected: FAIL (no such buttons).

- [ ] **Step 3: Add the approval variant to `ConfirmDialog`**

```tsx
interface ConfirmDialogProps {
  ...
  isPending?: boolean;
  /** Confirm-button style. Destructive by default; `approve` for a positive, consequential action. */
  confirmVariant?: 'destructive' | 'approve';
}

const CONFIRM_CLASSES: Record<NonNullable<ConfirmDialogProps['confirmVariant']>, string> = {
  destructive: 'bg-destructive text-destructive-foreground hover:bg-destructive/90',
  approve: 'bg-green-600 text-white hover:bg-green-700',
};
```
Destructure `confirmVariant = 'destructive'` and use `className={CONFIRM_CLASSES[confirmVariant]}` on `AlertDialogAction`.

- [ ] **Step 4: Update `AgeReviewDetail`**

Import `ConfirmDialog` from `./ConfirmDialog`, `ShieldCheck` from `lucide-react` (add to the existing lucide import), and `type ClearResolution` from the shared module. Near `BAND_LABELS`:

```ts
const CLEAR_RESOLUTION_LABELS: Record<ClearResolution, string> = {
  approved_minor: 'Approved minor',
  not_minor: 'Not a minor',
};
```

Beside the state badge (`<Badge className={stateColor(c.state)}>{STATE_LABELS[c.state]}</Badge>`):

```tsx
            {c.clear_resolution && (
              <Badge variant="outline">{CLEAR_RESOLUTION_LABELS[c.clear_resolution]}</Badge>
            )}
```

In the failure toast list, after the `keycastMinorClear` line:

```ts
        if (enforcement?.keycastMinorSet === 'failed') failed.push('protected-minor account flag');
```

Replace the single green Clear `<Button>` in the terminal actions with:

```tsx
                {c.suspected_age_band === 'age_13_15' && (
                  <ConfirmDialog
                    trigger={
                      <Button
                        size="sm"
                        variant="default"
                        className="h-7 text-xs bg-green-600 hover:bg-green-700"
                        disabled={updateCase.isPending}
                      >
                        <ShieldCheck className="h-3 w-3 mr-1" />
                        Approve as protected minor (13-15)
                      </Button>
                    }
                    title="Approve as a protected minor?"
                    summary="This account is restored and marked as an approved 13-15 minor: minor DM limits apply, key export is blocked, and future under-16 reports clear automatically."
                    confirmLabel="Approve"
                    confirmVariant="approve"
                    onConfirm={async () => {
                      await updateCase.mutateAsync({
                        state: 'cleared',
                        resolution: 'approved_minor',
                        resolution_note: resolutionNote || undefined,
                      });
                    }}
                    isPending={updateCase.isPending}
                  />
                )}
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7 text-xs"
                  disabled={updateCase.isPending}
                  onClick={() => updateCase.mutate({
                    state: 'cleared',
                    resolution: 'not_minor',
                    resolution_note: resolutionNote || undefined,
                  })}
                >
                  <CheckCircle className="h-3 w-3 mr-1" />
                  Clear: not a minor
                </Button>
```

- [ ] **Step 5: Update the five queue tests**

In each of `AgeReview.handoff-mutation`, `AgeReview.midflight-switch`, `AgeReview.reentry`, `AgeReview.list-shadow`, `AgeReview.uninvalidate` `.test.tsx`, replace `{ name: 'Clear' }` with `{ name: 'Clear: not a minor' }`. Where a test asserts the exact PATCH body, add `resolution: 'not_minor'`. These tests cover cache behaviour after a terminal action, which is unchanged.

- [ ] **Step 6: Run to verify pass**

Run: `npx vitest run src/components && npx tsc -p tsconfig.app.json --noEmit`
Expected: PASS.

- [ ] **Step 7: Mutation-check** — remove the `c.suspected_age_band === 'age_13_15' &&` gate → only `hides approval outside the 13-15 band` fails. Restore.

- [ ] **Step 8: Visual check with Playwright** against the local stack from Task 7 (or `npx vite --port 8080` with a mocked case if the stack is not up yet): screenshot the detail panel for a 13-15 case (both buttons), the confirm dialog, and a 16+ case (Clear only), at 1280px wide. Save outside the repo; do not commit screenshots.

- [ ] **Step 9: Commit**

```bash
git add src/components
git commit -m "feat(age-review): separate approving a protected minor from dismissing a report"
```

---

### Task 7: Whole-branch verification and full local stack

**Files:**
- Modify (only if a test reveals a defect): the file that owns it, with a regression test first.
- Modify: `docs/` user docs only if the repo documents the Clear button (`grep -rn "Clear" docs/*.md | grep -i "age"`); describe both actions.

- [ ] **Step 1: Full automated gate**

```bash
npx tsc -p tsconfig.app.json --noEmit && (cd worker && npm run typecheck) \
  && (cd worker && npx vitest run) && (cd worker && npm run test:d1) \
  && npx vitest run && npx vite build
```
Expected: all green. Record counts against the baseline (worker 819, d1 112, frontend 1044 + 1 skipped).

- [ ] **Step 2: Verify the built bundle has the CF Access client id** (a worktree build without `.env.local` ships broken): `grep -l "$(grep VITE_CF_ACCESS_CLIENT_ID .env.local | cut -d= -f2)" dist/assets/*.js` returns a file.

- [ ] **Step 3: Bring up the full local stack**

1. Keycast with the new route: from a keycast checkout of branch `feat/set-verified-minor`, `bun run deps:up`, migrate the dev DB (`bun run db:migrate`), then run the API server per `docs/DEVELOPMENT.md` with `KEYCAST_SERVICE_TOKEN=local-service-token` and its dev `SERVER_NSEC`/`ALLOWED_PUBKEYS` from `package.json` scripts. Note the port.
2. Funnelcake relay: `cd ~/code/divine-relay-test && ./scripts/relays/setup-funnelcake.sh`.
3. moderation-service: `cd ~/code/divine-moderation-service && npx wrangler dev --port 8789 --local`.
4. relay-manager: in this worktree, `worker/.dev.vars` needs `NOSTR_NSEC`, `ADMIN_API_KEY`, `KEYCAST_SERVICE_TOKEN=local-service-token`, and `KEYCAST_URL=http://127.0.0.1:<keycast port>` (local only; AGENTS.md forbids deployed URLs there). Then `./scripts/dev-local.sh`.
5. Confirm no deployed host appears in the worker's startup config output.

- [ ] **Step 4: Exercise the feature end to end**

1. Create a keycast account with credentials (headless register on the local keycast), note its pubkey.
2. Publish a kind 1984 `NS-underageUser` report against it to the local relay (`nak event -k 1984 -t p=<pubkey> -t l=NS-underageUser ...`). Confirm a case opens in the Age Review tab.
3. Approve it as a protected minor through the UI. Confirm: case `cleared` with "Approved minor"; `SELECT verified_minor FROM users WHERE pubkey=...` on local keycast is TRUE; local D1 has an active subject bound to the pubkey and its projection job `complete`.
4. Publish a second report. Confirm the new case is auto-cleared with note "Auto-cleared: previously verified minor".
5. Stop keycast. Approve a second account's case. Confirm a 207 toast naming "protected-minor account flag", and the job `pending`. Restart keycast, run the cron (`curl "http://localhost:8787/__scheduled?cron=*/5+*+*+*+*"` under `wrangler dev --test-scheduled`, or wait a tick) and confirm the flag is TRUE and the job `complete`.
6. Report and approve a self-custody pubkey (no keycast account). Confirm `not_applicable` and an active subject; re-report and confirm auto-clear.
7. Revocation after approval: insert a new `open_reported` case for the step-3 account directly into local D1 (a report would auto-clear), move it to restricted in the UI, then deny it. Confirm the subject is `cleared`, its projection job was re-armed to `pending` and then `complete`, and keycast `verified_minor` is FALSE.
8. Clear a 13-15 case with "Clear: not a minor". Confirm no subject and no keycast change.

- [ ] **Step 5: Tear down** the local stack processes started here. Leave the worktrees.

- [ ] **Step 6: Commit any doc change**

```bash
git add docs
git commit -m "docs(age-review): describe approving a protected minor versus clearing"
```

After this task: the adversarial self-review loop (superpowers:requesting-code-review plus a hostile read of the full diff in both repos, repeated until a pass finds nothing), then hand back to Matt for the push/PR go.

Deploy order to state in the hand-back (deploys need Matt's go too): keycast first; then the relay-manager worker and Pages bundle together. The PATCH now requires `resolution` on a Clear, so a frontend bundle older than the worker gets a 400 on Clear (safe, nothing changes) until Pages catches up.
