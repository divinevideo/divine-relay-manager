# Timed Suspensions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task (execution method chosen by Matt, 2026-11-20). Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Moderators can suspend an account for N hours or N days (or with no end date) and change that end date later. The account comes back on its own within one scheduler tick of the end time, through the same path as a manual Unsuspend.

**Architecture:** Two independent PRs, not stacked.
- **Part A (divine-moderation-service):** `/api/v1/notify` accepts an optional `endsAt`, and there is a new "end date changed" message.
- **Part B (divine-relay-manager):**
  - stores one D1 record per suspended pubkey, written when a moderator suspends through `/api/relay-rpc`;
  - adds a change-end-date endpoint and a read endpoint;
  - lifts due records from the existing 5-minute cron;
  - makes unban ask what happens to a running suspension;
  - shows the end time to moderators.

Part B works against the old service too.

**Tech Stack:** Cloudflare Workers, D1 (SQLite), Vitest with Miniflare D1, React 18, TanStack Query 5, shadcn/ui. moderation-service is ESM JavaScript with Vitest.

**Spec:** `docs/superpowers/specs/2026-11-20-timed-suspension-design.md` (approved by Matt Bradley, 2026-11-20). Its numbered Decisions are binding. Read it before any task.

## Global Constraints

- No new dependencies in either repo.
- AGENTS.md "Integration Contracts":
  - The relay call is critical: await it, return its error, run no side effects after a failure.
  - Everything after it is best-effort: await it inside try/catch, log, continue.
  - No fire-and-forget. Every promise is awaited or handed to `ctx.waitUntil`.
- Schema changes go in `ensureSchema()` (`worker/src/db.ts`) AND a matching `worker/migrations/00NN_*.sql`, kept in sync by hand.
- Colocated tests:
  - worker unit tests: `worker/src/*.test.ts`
  - D1 tests: `worker/test/*.d1.test.ts`
  - frontend: beside the component or hook
  - shared: `shared/*.test.ts`
  - moderation-service: `src/**/*.test.mjs`
- relay-manager gates, required before every commit:

  | Gate | Command |
  |---|---|
  | Frontend type-check | `npx tsc -p tsconfig.app.json --noEmit` (bare `tsc --noEmit` checks nothing) |
  | Root lint | `npx eslint .` |
  | Root tests | `npx vitest run --exclude src/App.login-prompt.test.tsx` (that file OOMs on Node 26, issue #424) |
  | Worker unit tests | `cd worker && npx vitest run` |
  | Worker type-check | `cd worker && npm run typecheck` |
  | Worker D1 tests | `cd worker && npm run test:d1` |

  On macOS a full `test:d1` can fail about 33 tests with EADDRNOTAVAIL. If it does, run the task's own D1 files alone (`npx vitest run --config vitest.d1.config.ts test/<file>`) and say so.
- moderation-service gates: `npm run lint`, `npm test`.
- Mutation-check every guard a task adds, one guard at a time:
  - remove the guard and watch exactly its test go red;
  - restore it from a `cp` backup, never `git checkout`.
- No em dashes in user-facing copy (moderator UI strings and user DMs). All copy here is proposed; Matt approves final copy in PR review.
- Decision-history action names use the existing verb_object form (`suspend_user`, `ban_user`).
- Full 64-char hex for pubkeys in logs and alerts.
- No production or staging access, no `pkill`/`killall`, no Co-Authored-By or session trailers on commits.

## Backward compatibility (verified in moderation-service origin/main a50f782)

- **The old service ignores `endsAt`.** The notify route (`src/index.mjs` ~4623) destructures only `{ recipientPubkey, action, reason, sha256, eventId }`, so it sends today's ACCOUNT_SUSPENDED wording. The worker therefore sends `endsAt` whenever it has a recorded end; no capability check is needed.
- **The old service rejects the new message.** `validNotifyActions` (~4640) is an allowlist, so `ACCOUNT_SUSPENSION_CHANGED` gets a 400. `notifyModerationService` logs non-OK responses and moves on, so the edit succeeds and the message is not delivered. The old service never states an end time, so nobody is told a false one.
- **Deploy order:**
  1. Part A (moderation-service).
  2. Part B worker, staging.
  3. Part B worker, prod.
  4. Part B Pages.

  Pages must not go before the worker: the new frontend stops writing the browser-side `suspend_user` row because the worker writes it (Task B4).

## Review Focus

1. **An end time earlier the same UTC day.** A lexical compare of ISO `ends_at` against `datetime('now')` delays expiry to midnight (the age-review cron bug). Expected: a record that ended a minute ago is due. Pinned in Task B2 and Task B6.
2. **A ban that lands after the read, or a ban list that can't be read.** Expected: no lift, no message, no Keycast change. "Unreadable" counts as a failed attempt, never as "not banned". Pinned in Task B6, including the Keycast-retry phase.
3. **A moderator acting mid-tick** (edit, unsuspend, re-suspend). Expected: the moderator wins, the person gets exactly one message, and an edit during a lift is refused, not silently overridden. Pinned in Task B5 and Task B6.
4. **The end-time read failing in the UI.** Expected: "End date unavailable", never "no end date". Pinned in Task B9.
5. **Duration edge input:** 0, negatives, `1.5`, `"3"`, `366` days, `8761` hours, a missing or unknown unit. Expected: confirm stays disabled, and the worker answers 400 before touching the relay. Pinned in Task B1 and Task B4.

## Out of scope

- **Age-review clear lifts any suspension (pre-existing, not in this plan).** Clearing any case runs `unsuspendPubkey`, even a case that never restricted the account (`age-review.ts` ~552, `clearedCase = requestedState === 'cleared'`). So clearing an unrelated case ends a moderator's timed or open-ended suspension early. Matt is holding this as a separate decision. This plan keeps today's behavior: the timer later finds the account unsuspended and marks itself done (decision 12).

---

## Part A: divine-moderation-service (its own PR; land and deploy first)

Work in a fresh worktree of `/Users/mjb/code/divine-moderation-service` branched from current `origin/main`; the local `main` is behind. Read its `AGENTS.md`. Line numbers are from a50f782.

### Task A1: End-time messages in the DM templates

**Files:**
- Modify: `src/nostr/dm-sender.mjs` (TEMPLATES ~47-90, `selectTemplate` ~139, `sendModerationDM` ~629)
- Test: `src/nostr/dm-sender.test.mjs`

**Interfaces:**
- Produces:
  - `export function formatEndTime(iso: string): string | null`, which returns null when the value doesn't parse.
  - Account templates take `endsAt` as their 5th parameter, `(_reason, _sha256, _title, _publishedAt, endsAt)`. (planner's call: `getMessageForAction` passes 4 args, so it keeps today's wording instead of formatting the reason as a date.)
  - `selectTemplate(action, reason, categories, sha256, title = null, publishedAt = null, endsAt = null)`. Its `ACCOUNT_` branch calls `accountTemplate(null, null, null, null, endsAt)`.
  - `sendModerationDM` passes `options.endsAt` through to `selectTemplate`.
  - New key `ACCOUNT_SUSPENSION_CHANGED`. It returns null without a valid `endsAt`.

- [ ] **Step 1: Write the failing tests**

```js
describe('timed suspension messages', () => {
  const END = '2026-11-24T14:00:00.000Z';
  it('formats an end time in UTC with the date written out', () => {
    expect(formatEndTime(END)).toBe('Tuesday 24 November 2026 at 14:00 UTC');
    expect(formatEndTime('2026-03-05T00:05:00.000Z')).toBe('Thursday 5 March 2026 at 00:05 UTC');
    expect(formatEndTime('not a date')).toBeNull();
  });
  it('ACCOUNT_SUSPENDED states the end time when given', () => {
    const msg = selectTemplate('ACCOUNT_SUSPENDED', null, null, null, null, null, END);
    expect(msg).toContain('Your account has been suspended until Tuesday 24 November 2026 at 14:00 UTC for violating');
    expect(msg).toContain('reply to this message to appeal');
  });
  it('ACCOUNT_SUSPENDED keeps today\'s wording without an end time', () => {
    const today = selectTemplate('ACCOUNT_SUSPENDED', null, null, null);
    expect(today).toContain('Your account has been suspended for violating');
    expect(getMessageForAction('ACCOUNT_SUSPENDED')).toBe(today);
  });
  it('ACCOUNT_SUSPENSION_CHANGED states the new end time', () => {
    const msg = selectTemplate('ACCOUNT_SUSPENSION_CHANGED', null, null, null, null, null, END);
    expect(msg?.startsWith('Your suspension now ends on Tuesday 24 November 2026 at 14:00 UTC.')).toBe(true);
    expect(msg).not.toContain('divine.video/video/');
  });
  it('ACCOUNT_SUSPENSION_CHANGED has no message without a valid end time', () => {
    expect(selectTemplate('ACCOUNT_SUSPENSION_CHANGED', null, null, null)).toBeNull();
    expect(selectTemplate('ACCOUNT_SUSPENSION_CHANGED', null, null, null, null, null, 'garbage')).toBeNull();
  });
  it('keeps the new template out of the manual compose list', () => {
    expect(COMPOSE_TEMPLATES.map(t => t.key)).not.toContain('ACCOUNT_SUSPENSION_CHANGED');
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run src/nostr/dm-sender.test.mjs -t "timed suspension"`
Expected: FAIL, `formatEndTime` not exported.

- [ ] **Step 3: Implement**

`formatEndTime` uses `getUTC*` getters with fixed English weekday and month names, not `Intl`. (planner's call: ICU separators vary between runtimes. Day, month written out, year is unambiguous to any reader.)

The copy, fixed here for Matt's approval:

```js
ACCOUNT_SUSPENDED: (_r, _s, _t, _p, endsAt) => {
  const when = endsAt ? formatEndTime(endsAt) : null;
  return `Your account has been suspended${when ? ` until ${when}` : ''} for violating Divine's content policies.\n\nIf you believe this was a mistake, you can reply to this message to appeal.\n\n${FOOTER}`;
},
ACCOUNT_SUSPENSION_CHANGED: (_r, _s, _t, _p, endsAt) => {
  const when = endsAt ? formatEndTime(endsAt) : null;
  return when ? `Your suspension now ends on ${when}.\n\nIf you believe this was a mistake, you can reply to this message to appeal.\n\n${FOOTER}` : null;
},
```

- Do not add the new key to `COMPOSE_TEMPLATES`. (planner's call: a hand-composed message has no end time.)
- Update the action lists in the JSDoc.

- [ ] **Step 4: Run** `npx vitest run src/nostr/dm-sender.test.mjs && npm run lint`. Expected: PASS, with the pre-existing ACCOUNT_* and COMPOSE_TEMPLATES tests unchanged.

- [ ] **Step 5: Mutation-check** the `when ?` fallback and the `null` return, one at a time.

- [ ] **Step 6: Commit**

```bash
git add src/nostr/dm-sender.mjs src/nostr/dm-sender.test.mjs
git commit -m "feat(dm): state a suspension's end time and add an end-date-changed message"
```

### Task A2: Accept `endsAt` on `/api/v1/notify`

**Files:**
- Modify: `src/index.mjs` (`/api/v1/notify` ~4615-4683)
- Test: `src/index.test.mjs` (`describe('POST /api/v1/notify')` ~6124)
- Create: `src/notify-ends-at.test.mjs`

**Interfaces:**
- Consumes: `sendModerationDM(recipientPubkey, sha256, action, reason, env, ctx, { endsAt })` (A1).
- Produces (the HTTP contract the worker relies on):
  - An optional `endsAt` field: an ISO-8601 string that `Date.parse` accepts.
  - `ACCOUNT_SUSPENSION_CHANGED` added to `validNotifyActions`; it requires `endsAt`.
  - 400 `{ error: 'endsAt must be an ISO-8601 date' }` when `endsAt` is present but not a parseable string, on any action.
  - 400 `{ error: 'endsAt required for ACCOUNT_SUSPENSION_CHANGED' }` when that action comes without it.
  - Validation runs before the `NOSTR_PRIVATE_KEY` check.
  - `endsAt` is forwarded only for ACCOUNT_SUSPENDED and ACCOUNT_SUSPENSION_CHANGED.
  - (planner's call: refuse rather than send a message with no date or a wrong one. The worker always sends a valid value, so a 400 is a caller bug and shows in its logs.)

- [ ] **Step 1: Write the failing endpoint tests** in the existing describe. Use `NOSTR_PRIVATE_KEY: undefined`, so a passing request ends in the 200 "not configured" response:
  - `accepts ACCOUNT_SUSPENSION_CHANGED with endsAt`: 200.
  - `rejects ACCOUNT_SUSPENSION_CHANGED without endsAt`: 400, error contains `endsAt required`.
  - `rejects an unparseable endsAt`: `'next tuesday'` and the number `1732456800000` on ACCOUNT_SUSPENDED each give 400, error contains `ISO-8601`.
  - `accepts ACCOUNT_SUSPENDED without endsAt`: 200.

- [ ] **Step 2: Write the failing pass-through test** in a new `src/notify-ends-at.test.mjs`.
  - `vi.mock('./nostr/dm-sender.mjs')` captures `sendModerationDM`; set `NOSTR_PRIVATE_KEY`.
  - Copy only the `createEnv` helper and the module mocks that importing `./index.mjs` needs.
  - It is a separate file so the mock can't leak into the main suite.

```js
it('passes endsAt through to the DM sender', async () => {
  await post({ recipientPubkey: PK, action: 'ACCOUNT_SUSPENDED', endsAt: '2026-11-24T14:00:00.000Z' });
  expect(sendModerationDM).toHaveBeenCalledWith(PK, null, 'ACCOUNT_SUSPENDED', null, expect.anything(), null,
    expect.objectContaining({ endsAt: '2026-11-24T14:00:00.000Z' }));
});
it('does not pass endsAt for a non-suspension action', async () => {
  await post({ recipientPubkey: PK, action: 'ACCOUNT_RESTORED', endsAt: '2026-11-24T14:00:00.000Z' });
  expect(sendModerationDM.mock.calls[0][6]?.endsAt).toBeUndefined();
});
```

- [ ] **Step 3: Run** `npx vitest run src/index.test.mjs -t "api/v1/notify" && npx vitest run src/notify-ends-at.test.mjs`. Expected: FAIL.

- [ ] **Step 4: Implement.** Log whether `endsAt` was present (a boolean), not its value.

- [ ] **Step 5: Run** `npm test && npm run lint`. Expected: PASS.

- [ ] **Step 6: Mutation-check** the required-endsAt guard, the parse guard and the forwarding action filter, one at a time.

- [ ] **Step 7: Commit**

```bash
git add src/index.mjs src/index.test.mjs src/notify-ends-at.test.mjs
git commit -m "feat(notify): accept an optional suspension end time"
```

**Part A PR:**
- Title: `feat(notify): timed suspension end times in account messages`.
- The description says the field is optional and the old relay-manager sends none, so today's wording is unchanged until Part B ships.
- It carries PR_REVIEW.md's model-identity block.
- Open as a draft. Deploy after merge, before Part B.

---

## Part B: divine-relay-manager

### Before Task B1

- [ ] Rebase the branch: `git fetch origin && git rebase origin/main` on `feat/263-timed-suspensions`. Main was 80fef668 at plan time; PR #430 touched `age-review.ts`, `keycast-client.ts` and `retention.ts`.
- [ ] Confirm `git diff origin/main --stat` shows only the spec and this plan.
- [ ] In a fresh worktree, install both trees: `npm ci` at the root, and `cd worker && npm ci --legacy-peer-deps`. Without the worker install, every D1 test fails on missing `miniflare`.
- [ ] Take the next free migration number after the rebase. This plan assumes `0021`.

### Decisions this plan makes (planner's calls, one line each)

1. **Records:** every suspend through `/api/relay-rpc` writes one, with `ends_at` NULL when open-ended. Reason: "re-suspend replaces" holds uniformly, and age review's direct `nip86` suspends never create one.
2. **Rows and statuses:** one row per pubkey, replaced in place. Statuses: `active`, `lifting`, `keycast_pending`, `lifted`, `already_lifted`, `cancelled_unsuspend`, `cancelled_ban`. "In force" means `active` or `cancelled_ban`. The spec's "superseded" is never stored, because a replace overwrites the row and `moderation_decisions` keeps the history.
3. **Duration:** a whole number from 1 hour to 365 days (8760 hours). The worker computes the end and rounds it up to the minute. Reason: a year covers any policy suspension, and the stated minute is never before the true end.
4. **Change end date** takes a length from now, the same input as Suspend. The spec's "a past end time means lift now" can't arise from it; ending now is Unsuspend (decision 11).
5. **Decision rows** for set, change, unban choices, lift and timer cancel are written by the worker, so a closed tab can't lose them. The browser stops writing `suspend_user` for suspends made through the dialog.
6. **Timer rows:** `auto_unsuspend_user` (the lift) and `cancel_suspension_timer` (banned, or already lifted elsewhere), `moderator_pubkey` NULL, never `auto`. They count as automated decisions, so reports filed during a suspension aren't marked handled when the timer lifts it (#332).
7. **Alerts:** after 3 consecutive failed attempts in either phase, re-sent at most every 12 hours per record. A `lifting` claim older than 15 minutes is recovered and alerted. Reason: 3 ticks rides out a blip, and 12 hours matches age review.
8. **Shared lift:** both paths call relay `unsuspendpubkey`, then `restoreAfterLift()` (ACCOUNT_RESTORED, then Keycast active). The manual path hands it to `ctx.waitUntil`; the tick awaits it, because decision 14 needs the Keycast result.
9. **I/O is injected** as `SuspensionIo`, built in `index.ts`. `notifyModerationService` lives there, so importing it would be circular, and the tick needs to run against fakes in tests.
10. **Fresh reads, fail closed:** the relay ban list, relay suspended list and Keycast status are read per row, uncached. "Unknown" counts as a failed attempt, including Keycast "not configured".
11. **No lift on an `age_review` row:** the timer never lifts a relay suspended row with that reason, even with no open case. It counts as a failed attempt and alerts (anti-goal guard).
12. **Batch size:** at most 25 records per phase per tick, oldest end first.
13. **Unban** reads the relay suspended list fresh after the relay unban:
    - not suspended: today's behavior (Keycast active);
    - suspended: the choice applies, default `resume`, with Keycast set to `suspended`;
    - unreadable: Keycast is left as it is.
14. **Unban prompt placement:** UserActions Unban, and UserManagement's Banned-tab unban. Allow, EventDetail, DebugPanel, moderation-service `allow_pubkey` and Coop get the server default.
15. **The prompt also covers open-ended suspensions** ("keep suspended" or "end now"): they have the same Keycast-active bug, and covering them costs nothing extra.
16. **Unban messages:**
    - resume with an end still ahead: ACCOUNT_SUSPENSION_CHANGED;
    - open_ended: ACCOUNT_SUSPENDED with no date;
    - end_now: ACCOUNT_RESTORED;
    - otherwise: none.

    After a "banned, permanent" message, the person must not keep believing a stale end.
17. **Edit refusals:** an edit is refused during an open age-review case, while relay-banned, and when no longer relay-suspended. Each would send an untrue "now ends on X".
18. **A record write that fails after the relay suspend** is reported, not hidden: the suspend returns success with `recorded: false`, the message carries no date, and the UI says the end date wasn't saved.
19. **Moderator display:** UTC, `Tue 24 Nov 2026, 14:00 UTC`. The report pane's account status is its existing `UserActions` block; no extra line goes in `UserProfileCard`.
20. **Reads:** one `GET /api/suspensions` returns all in-force records, and the UI uses one cache key.

**New decision-history actions (verb_object):**

| Action | Written by | Counts as human handling | Purpose |
|---|---|---|---|
| `auto_unsuspend_user` | timer | no | a timed lift |
| `cancel_suspension_timer` | timer | no | banned, or already lifted elsewhere |
| `change_suspension_end` | moderator | yes | an edit; also the unban resume and open_ended choices |

They reuse `suspend_user` (set) and `unsuspend_user` (unban end_now). None collides with `AUTO_HIDE_ACTIONS` (`auto_hidden`, `auto_hide_*`), and nothing in the codebase matches on an `auto` prefix. Keep it that way: `isAutomatedDecision` returns false for auto-hide actions, so a timer action placed in that list would read as human.

### Task B1: Shared suspension vocabulary

**Files:**
- Create: `shared/suspension.ts`, `shared/suspension.test.ts`
- Modify: `shared/automated-decision.ts`, `shared/automated-decision.test.ts`, `shared/handling.test.ts`

**Interfaces:**
- Produces (`shared/suspension.ts`):

```ts
export type SuspensionUnit = 'hours' | 'days';
export interface SuspensionDuration { value: number; unit: SuspensionUnit }
export const MAX_SUSPENSION_DAYS = 365;
export const DURATION_ERROR = 'Enter a whole number from 1 hour up to 365 days';
export function checkSuspensionDuration(input: unknown):
  { ok: true; duration: SuspensionDuration } | { ok: false; error: typeof DURATION_ERROR };
export function suspensionEndsAt(duration: SuspensionDuration, now: Date): string; // ISO, ceil to the minute
export function formatSuspensionEnd(iso: string): string; // 'Tue 24 Nov 2026, 14:00 UTC'
export type UnbanSuspensionChoice = 'resume' | 'end_now' | 'open_ended';
export function isUnbanSuspensionChoice(v: unknown): v is UnbanSuspensionChoice;
export type UnbanSuspensionState = 'not_suspended' | 'unknown' | 'resumed' | 'open_ended' | 'ended' | 'end_failed';
export const SUSPENSION_ACTIONS = {
  set: 'suspend_user', change: 'change_suspension_end', unsuspend: 'unsuspend_user',
  autoUnsuspend: 'auto_unsuspend_user', cancelTimer: 'cancel_suspension_timer',
} as const;
export const TIMER_DECISION_ACTIONS: readonly string[]; // [autoUnsuspend, cancelTimer]
export interface TimedSuspensionView {
  pubkey: string; endsAt: string | null; status: 'active' | 'cancelled_ban';
  setBy: string | null; setAt: string; changedAt: string | null;
}
```

- `isAutomatedDecision(row)` also returns true when `row.action` is in `TIMER_DECISION_ACTIONS`, whatever the moderator field holds.

- [ ] **Step 1: Write the failing tests**

```ts
it.each([[{ value: 1, unit: 'hours' }], [{ value: 365, unit: 'days' }], [{ value: 8760, unit: 'hours' }]])(
  'accepts %j', (d) => expect(checkSuspensionDuration(d)).toEqual({ ok: true, duration: d }));
it.each([0, -1, 1.5, '3', NaN, Infinity].map(v => [{ value: v, unit: 'days' }])
  .concat([[{ value: 366, unit: 'days' }], [{ value: 8761, unit: 'hours' }], [{ value: 3, unit: 'weeks' }],
           [{ value: 3 }], [null], ['3 days']]))(
  'refuses %j', (d) => expect(checkSuspensionDuration(d)).toEqual({ ok: false, error: DURATION_ERROR }));
it('rounds the end up to the next whole minute', () => {
  expect(suspensionEndsAt({ value: 1, unit: 'hours' }, new Date('2026-11-20T10:00:30.500Z'))).toBe('2026-11-20T11:01:00.000Z');
  expect(suspensionEndsAt({ value: 2, unit: 'days' }, new Date('2026-11-20T10:00:00.000Z'))).toBe('2026-11-22T10:00:00.000Z');
});
it('formats in UTC whatever the local zone', () => {
  // root vitest pins TZ=America/Los_Angeles, where this instant is still 24 Nov
  expect(formatSuspensionEnd('2026-11-25T02:00:00.000Z')).toBe('Wed 25 Nov 2026, 02:00 UTC');
});
it('treats the timer\'s rows as automated, and a person\'s unsuspend as human', () => {
  expect(isAutomatedDecision({ action: 'auto_unsuspend_user', moderator_pubkey: null })).toBe(true);
  expect(isAutomatedDecision({ action: 'cancel_suspension_timer', moderator_pubkey: null })).toBe(true);
  expect(isAutomatedDecision({ action: 'unsuspend_user', moderator_pubkey: null })).toBe(false);
  expect(isAutomatedDecision({ action: 'change_suspension_end', moderator_pubkey: null })).toBe(false);
});
it('timer actions are not auto-hide actions', () => {
  for (const a of TIMER_DECISION_ACTIONS) expect(AUTO_HIDE_ACTIONS).not.toContain(a);
});
```

In `shared/handling.test.ts`, add one test with two dated targets:
- a pubkey target whose only row is `auto_unsuspend_user` is absent from `handlingByTarget`;
- the same with `unsuspend_user` instead is present.

- [ ] **Step 2: Run** `npx vitest run shared/suspension.test.ts shared/automated-decision.test.ts shared/handling.test.ts`. Expected: FAIL, module missing.

- [ ] **Step 3: Implement.** Check `value` with `Number.isInteger`. Check the range in hours, with days multiplied by 24.

- [ ] **Step 4: Run the root gates.** Expected: PASS.

- [ ] **Step 5: Mutation-check**, one at a time: the integer check, the upper bound, the minute ceiling, the `TIMER_DECISION_ACTIONS` clause.

- [ ] **Step 6: Commit**

```bash
git add shared/suspension.ts shared/suspension.test.ts shared/automated-decision.ts shared/automated-decision.test.ts shared/handling.test.ts
git commit -m "feat(suspensions): shared duration rules and timer decision actions"
```

### Task B2: Suspension record store

**Files:**
- Modify: `worker/src/db.ts` (append after `report_arrivals`), `AGENTS.md` (add a `timed_suspensions` row to the "D1 Schema" table)
- Create: `worker/migrations/0021_timed_suspensions.sql`, `worker/src/timed-suspensions.ts` (store section), `worker/test/timed-suspensions-store.d1.test.ts`

**Interfaces:**
- Consumes: `SUSPENSION_ACTIONS`, `TimedSuspensionView` (B1); `markHumanReviewed` (`worker/src/human-decision.ts`).
- Produces (`worker/src/timed-suspensions.ts`):

```ts
export type SuspensionRecordStatus = 'active' | 'lifting' | 'keycast_pending' | 'lifted'
  | 'already_lifted' | 'cancelled_unsuspend' | 'cancelled_ban';
export interface SuspensionRecord {
  pubkey: string; ends_at: string | null; status: SuspensionRecordStatus;
  set_by: string | null; set_at: string; changed_by: string | null; changed_at: string | null;
  version: number; attempts: number; last_error: string | null; last_attempt_at: string | null;
  last_alerted_at: string | null; claimed_at: string | null;
}
export async function getSuspensionRecord(db: D1Database, pubkey: string): Promise<SuspensionRecord | null>;
export async function listInForceSuspensions(db: D1Database): Promise<SuspensionRecord[]>;
export async function replaceSuspensionRecord(db: D1Database, a: { pubkey: string; endsAt: string | null; moderator: string | null }): Promise<void>;
export async function endSuspensionRecord(db: D1Database, pubkey: string, status: 'cancelled_unsuspend' | 'already_lifted'): Promise<boolean>;
export type ChangeEndResult = { kind: 'changed'; previousEndsAt: string | null; created: boolean } | { kind: 'ending' } | { kind: 'conflict' };
export async function changeSuspensionEnd(db: D1Database, a: { pubkey: string; endsAt: string | null; moderator: string | null }): Promise<ChangeEndResult>;
export async function casSuspensionRecord(db: D1Database, pubkey: string, expectedVersion: number,
  set: Partial<Pick<SuspensionRecord, 'status' | 'attempts' | 'last_error' | 'last_attempt_at' | 'last_alerted_at' | 'claimed_at'>>): Promise<boolean>;
export async function recordSuspensionDecision(db: D1Database, a: { pubkey: string; action: string; reason: string; moderator: string | null; human: boolean }): Promise<boolean>;
export function toSuspensionView(r: SuspensionRecord): TimedSuspensionView;
```

Schema (the same text in `ensureSchema` and the migration):

```sql
CREATE TABLE IF NOT EXISTS timed_suspensions (
  pubkey TEXT PRIMARY KEY,
  ends_at TEXT,                       -- ISO-8601 UTC; NULL = no end date
  status TEXT NOT NULL CHECK (status IN ('active','lifting','keycast_pending','lifted','already_lifted','cancelled_unsuspend','cancelled_ban')),
  set_by TEXT, set_at TEXT NOT NULL,
  changed_by TEXT, changed_at TEXT,
  version INTEGER NOT NULL DEFAULT 0,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT, last_attempt_at TEXT, last_alerted_at TEXT, claimed_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_timed_suspensions_due ON timed_suspensions(status, ends_at);
```

Semantics (each one gets a test):
- Every write bumps `version`.
- `replaceSuspensionRecord` upserts the row as `active`, sets `set_by`/`set_at`, and clears the change, attempt, alert and claim fields.
- `endSuspensionRecord` changes only rows in `active | lifting | keycast_pending | cancelled_ban`.
- `changeSuspensionEnd` reads the row, then:

  | Row found | Result |
  |---|---|
  | `lifting` or `keycast_pending` | `ending` |
  | `active` or `cancelled_ban` | CAS on the read version, setting `ends_at`, `changed_by`, `changed_at`, status `active`, `attempts = 0` and `last_error = NULL` |
  | absent, or `lifted` / `already_lifted` / `cancelled_unsuspend` | a fresh `active` row with `set_by = moderator`, written under a version guard (`created: true`) |
  | zero rows changed | `conflict` |

- `recordSuspensionDecision` inserts a `target_type = 'pubkey'` row. It calls `markHumanReviewed` only when `human` is true. On any failure it catches, logs and returns false.
- Every `ends_at` comparison uses `datetime(ends_at)`.

- [ ] **Step 1: Write the failing D1 tests.** Use the Miniflare harness from `worker/test/report-arrivals.d1.test.ts`. One test per semantic above, plus:
  - `ensureSchema` is idempotent;
  - running the migration file's SQL on a second, fresh Miniflare database gives the same `PRAGMA table_info(timed_suspensions)` (names, types, NOT NULL) as `ensureSchema`;
  - Review Focus 1: a row with `ends_at` one minute ago today satisfies `datetime(ends_at) <= datetime('now')`, and the lexical `ends_at <= datetime('now')` does not;
  - `listInForceSuspensions` returns only `active` and `cancelled_ban` rows.

- [ ] **Step 2: Run** `cd worker && npx vitest run --config vitest.d1.config.ts test/timed-suspensions-store.d1.test.ts`. Expected: FAIL.

- [ ] **Step 3: Implement.** Mark the schema with a `// Keep in sync with migration 0021` comment.

- [ ] **Step 4: Run the worker gates.** Expected: PASS.

- [ ] **Step 5: Mutation-check**, one at a time: the `endSuspensionRecord` status filter, the `changeSuspensionEnd` `ending` branch and its version guard, and the `human` gate in `recordSuspensionDecision`.

- [ ] **Step 6: Commit**

```bash
git add worker/src/db.ts worker/migrations/0021_timed_suspensions.sql worker/src/timed-suspensions.ts worker/test/timed-suspensions-store.d1.test.ts AGENTS.md
git commit -m "feat(suspensions): timed suspension record store"
```

### Task B3: Fresh relay reads that can say "unknown"

**Files:**
- Modify: `worker/src/nip86.ts` (`isPubkeyOnBanList` ~322), `worker/src/suspended-content.ts` (`readAuthorSuspension` ~146)
- Test: `worker/src/nip86.test.ts`, `worker/src/suspended-content.test.ts`

**Interfaces:**
- Produces:

```ts
// nip86.ts
export async function readPubkeyBan(pubkey: string, env: Nip86Env): Promise<boolean | 'unknown'>;
// suspended-content.ts
export type SuspensionEntry = { suspended: false } | { suspended: true; reason: string | null };
export async function readSuspensionEntry(pubkey: string, env: Nip86Env): Promise<SuspensionEntry | 'unknown'>;
```

- `readPubkeyBan`:
  - reads `listbannedpubkeys` with `BAN_CONFIRM_TIMEOUT_MS`;
  - matches exactly, accepting bare strings or `{ pubkey }` objects;
  - answers `'unknown'` when the read fails, throws or returns a non-array.

  `isPubkeyOnBanList` becomes `(await readPubkeyBan(...)) === true`, which leaves `banPubkey` unchanged.
- `readSuspensionEntry`:
  - always reads fresh, never from the per-isolate cache;
  - matches case-insensitively, like `readAuthorSuspension`;
  - shares one extracted list-parsing helper with `readAuthorSuspension`.

- [ ] **Step 1: Write the failing tests**
  - `readPubkeyBan`:
    - listed as an object → `true`;
    - listed as a bare string → `true`;
    - absent → `false`;
    - RPC error, a thrown fetch, or a result of `{}` → `'unknown'`.
  - `readSuspensionEntry`:
    - an entry with reason `age_review` → `{ suspended: true, reason: 'age_review' }`;
    - no reason → `reason: null`;
    - absent → `{ suspended: false }`;
    - an entry without a pubkey before the match → `'unknown'`;
    - an uppercase listed value still matches;
    - two calls make two relay reads, even right after a cached `readAuthorSuspension(..., { maxAgeMs: 30_000 })`.

- [ ] **Step 2: Run** `cd worker && npx vitest run src/nip86.test.ts src/suspended-content.test.ts`. Expected: FAIL.

- [ ] **Step 3: Implement.**

- [ ] **Step 4: Run the worker gates.** The existing `banPubkey` and `readAuthorSuspension` tests stay unchanged.

- [ ] **Step 5: Mutation-check**, one at a time: each function's non-array → `'unknown'` branch, and the no-cache read in `readSuspensionEntry`.

- [ ] **Step 6: Commit**

```bash
git add worker/src/nip86.ts worker/src/nip86.test.ts worker/src/suspended-content.ts worker/src/suspended-content.test.ts
git commit -m "feat(relay): ban and suspension reads that report an unreadable list"
```

### Task B4: Suspend with an end time; manual unsuspend cancels the timer

**Files:**
- Modify: `worker/src/index.ts` (`RelayRpcBody` ~1649, `runRelayRpc` ~1691-1899, `notifyModerationService` ~219, `notifyAccountState` ~280), `worker/src/timed-suspensions.ts`
- Create: `worker/src/timed-suspensions-io.ts`, `worker/src/test-helpers/management-fake.ts`, `worker/test/timed-suspensions-routes.d1.test.ts`
- Modify: `worker/src/index.test.ts`, only where the fake relay must answer new reads

**Interfaces:**
- Consumes: `checkSuspensionDuration`, `suspensionEndsAt`, `SUSPENSION_ACTIONS` (B1); the store (B2); `readPubkeyBan`, `readSuspensionEntry` (B3).
- Produces:

```ts
// timed-suspensions.ts
export type AccountNoticeAction = 'ACCOUNT_SUSPENDED' | 'ACCOUNT_BANNED' | 'ACCOUNT_RESTORED' | 'ACCOUNT_SUSPENSION_CHANGED';
export type KeycastStatusRead = 'active' | 'suspended' | 'banned' | 'none' | 'unknown';
export interface SuspensionIo {
  readBan(pubkey: string): Promise<boolean | 'unknown'>;
  readSuspension(pubkey: string): Promise<SuspensionEntry | 'unknown'>;
  readKeycastStatus(pubkey: string): Promise<KeycastStatusRead>;
  hasOpenAgeReviewCase(pubkey: string): Promise<boolean>; // throws when it cannot tell
  relayUnsuspend(pubkey: string): Promise<{ success: boolean; error?: string }>;
  keycastActivate(pubkey: string, actor?: string): Promise<KeycastResult>;
  keycastSuspend(pubkey: string, actor?: string): Promise<KeycastResult>;
  notify(pubkey: string, action: AccountNoticeAction, reason: string, endsAt?: string): Promise<void>;
  alert(text: string): Promise<boolean>;
}
export type KeycastLeg = 'ok' | 'not_applicable' | 'failed';
export async function restoreAfterLift(io: SuspensionIo, pubkey: string, a: { reason: string; moderator?: string }): Promise<KeycastLeg>;
// timed-suspensions-io.ts
export type SuspensionIoEnv = AgeReviewEnv & { ENVIRONMENT?: string }; // AgeReviewEnv covers Nip86Env, KeycastEnv, DB, SLACK_WEBHOOK_URL
export function liveSuspensionIo(env: SuspensionIoEnv, notify: SuspensionIo['notify']): SuspensionIo;
// index.ts
type RelayRpcBody = { method: string; params?: (string | number | undefined)[];
  suspension?: { duration: unknown }; suspensionChoice?: unknown };
// notifyModerationService gains a 7th parameter `endsAt?: string`, sent as `...(endsAt && { endsAt })`.
// notifyAccountState(env, pubkey, action: AccountNoticeAction, reason, ctx?, endsAt?)
```

- `restoreAfterLift` awaits `io.notify(pubkey, 'ACCOUNT_RESTORED', reason)` in its own try/catch, then `io.keycastActivate`. It maps the Keycast result `success` → `ok`, `notFound` → `not_applicable`, anything else or a throw → `failed`. It never throws.
- `liveSuspensionIo`:
  - **Keycast status:** `getUserStatus` success with `active`, `suspended` or `banned` → that status; `notFound` → `none`; anything else, including "not configured" → `unknown`.
  - **Age review:** `hasOpenAgeReviewCase` = `getActiveAgeReviewCase(...) !== null`.
  - **Alerts:** `alert` posts `{ text }` to `SLACK_WEBHOOK_URL`. It returns false when the webhook is unset or answers non-OK, and logs only `errorNameOnly` on a throw.
- `runRelayRpc` builds `liveSuspensionIo(env, notifier)` once per account-state call. The notifier is `(pk, action, reason, endsAt) => notifyModerationService(env, pk, action, reason, undefined, undefined, endsAt)`.

**`suspendpubkey`:**
1. After the existing pubkey and age-review checks, and before the relay call: if `body.suspension` is present and its duration isn't `null`, run `checkSuspensionDuration`. Invalid → 400 `{ success: false, error: DURATION_ERROR, code: 'invalid_duration' }`, with no relay call.
2. Relay call unchanged.
3. On success, write the record for every suspend, field or not: `replaceSuspensionRecord` with `endsAt` (or null) and `moderator ?? null`, awaited in try/catch. The outcome is `recorded`.
4. Only when `body.suspension` was present, write the decision → `decisionRecorded`: `recordSuspensionDecision({ action: 'suspend_user', reason: 'Suspended by moderator' + (endsAt ? \` until ${endsAt}\` : ', no end date'), moderator, human: true })`.
5. Keycast suspend unchanged. The message: `notifyAccountState(..., 'ACCOUNT_SUSPENDED', ..., ctx, recorded && endsAt ? endsAt : undefined)`.
6. Only when the field was present, the response adds `suspension: { endsAt: recorded ? endsAt : null, recorded, decisionRecorded }`. Legacy responses are unchanged.

**`unsuspendpubkey`** on relay success:
- `ctx.waitUntil(restoreAfterLift(io, pubkey, { reason, moderator }))` replaces the `enforceKeycastState('unsuspend')` + `notifyAccountState('ACCOUNT_RESTORED')` pair. Without a ctx, warn and skip, as today.
- Then `await endSuspensionRecord(db, pubkey, 'cancelled_unsuspend')` in try/catch. A lost cancel is harmless: the tick later sees the account unsuspended and marks `already_lifted` silently.

**`management-fake.ts`** (test-only): a `fetch` spy over mutable state `{ banned: Set<string>; suspended: Map<string, string | null>; keycast: Map<string, string>; fail?: Partial<Record<string, true>> }`. It:
- answers NIP-86 calls by the body's `method`;
- answers Keycast `GET`/`PUT /api/admin/users/:pk/status`;
- records `/api/v1/notify` bodies.

Tasks B5 and B7 reuse it.

- [ ] **Step 1: Write the failing route tests** in `worker/test/timed-suspensions-routes.d1.test.ts`. Drive them with `worker.fetch` and Miniflare D1, as in `worker/test/moderate-media-lift-guard.d1.test.ts`.
  - `suspend with 3 days stores the end, writes the decision, and states the end in the message`. Assert:
    - `suspension.endsAt` lies between `suspensionEndsAt({value:3,unit:'days'}, before)` and the same for `after`. Use no fake timers, which can stall Miniflare I/O.
    - The record is `active` with that `ends_at`.
    - There is one `suspend_user` row whose reason contains the end.
    - The notify body has `ACCOUNT_SUSPENDED` with that `endsAt`.
  - `suspend with duration null stores an open-ended record and sends no endsAt`.
  - `an invalid duration is refused before the relay is called` (Review Focus 5): `{value:0}`, `{value:1.5}` and `{value:366,unit:'days'}` each give 400 `invalid_duration`, with zero relay calls and no record.
  - `a legacy suspend (no field) replaces the record but writes no decision and adds no response field`.
  - `a record write failure keeps the suspend, reports recorded:false, and sends no endsAt` (drop the table after `ensureSchema`).
  - `manual unsuspend cancels an active record and sends one ACCOUNT_RESTORED`.
  - `a relay failure on suspend writes no record`.

- [ ] **Step 2: Run** `cd worker && npx vitest run --config vitest.d1.config.ts test/timed-suspensions-routes.d1.test.ts`. Expected: FAIL.

- [ ] **Step 3: Implement.**

- [ ] **Step 4: Run all worker gates.** The existing `index.test.ts` account-state tests must pass. If one depended on the old two-`waitUntil` shape, update the mechanics only, never the asserted behavior (one Keycast call, one notify).

- [ ] **Step 5: Mutation-check**, one at a time: validate-before-relay, the `recorded &&` gate on `endsAt`, the field-present gate on the decision, the unsuspend cancel.

- [ ] **Step 6: Commit**

```bash
git add worker/src/index.ts worker/src/index.test.ts worker/src/timed-suspensions.ts worker/src/timed-suspensions-io.ts worker/src/test-helpers/management-fake.ts worker/test/timed-suspensions-routes.d1.test.ts
git commit -m "feat(suspensions): suspend for a set time and cancel the timer on unsuspend"
```

### Task B5: Change end date and read suspensions

**Files:**
- Modify: `worker/src/index.ts` (routes next to `/api/relay-rpc`), `worker/src/timed-suspensions.ts` (handlers)
- Test: `worker/test/timed-suspensions-routes.d1.test.ts`

**Interfaces:**
- Consumes: B1, B2, B3, B4 (`SuspensionIo`, `liveSuspensionIo`); `ageReviewActiveGuard` (`worker/src/age-review.ts`).
- Produces:
  - `export async function handleListSuspensions(env, corsHeaders): Promise<Response>`, serving `GET /api/suspensions`:
    - success: `{ success: true, suspensions: TimedSuspensionView[] }` (the in-force records);
    - no DB, or a read failure: 503.
  - `export async function handleChangeSuspensionEnd(request, env, corsHeaders, ctx, moderator, io): Promise<Response>`, serving `POST /api/suspensions/end`:
    - body: `{ pubkey, duration }`;
    - success: 200 `{ success: true, endsAt, decisionRecorded }`.

    It is behind `needsModeratorLogin` (it's a POST) and not opened to `MOD_RELAY_ADMIN_KEY`.
  - Refusals, checked in this order:

    | Status | Code | When |
    |---|---|---|
    | 400 | `invalid_pubkey` | the pubkey isn't canonical |
    | 400 | `invalid_duration` | the duration fails `checkSuspensionDuration` |
    | 503 | none | no DB binding |
    | 409 or 503 | the guard's own | `ageReviewActiveGuard(..., { failClosed: true })` refuses |
    | 409 | `account_banned` | the relay ban list has the account |
    | 409 | `not_suspended` | the relay suspended list doesn't have it |
    | 503 | `status_unavailable` | either relay list read is `'unknown'` |
    | 409 | `suspension_ending` | the record is mid-lift |
    | 409 | `conflict` | the CAS lost |

  - On `changed`:
    1. Write `recordSuspensionDecision({ action: 'change_suspension_end', reason: \`Ends ${endsAt}; was ${previousEndsAt ?? 'no end date'}\`, moderator, human: true })`.
    2. Send the message with `ctx.waitUntil(io.notify(pubkey, 'ACCOUNT_SUSPENSION_CHANGED', 'Suspension end changed', endsAt).catch(log))`. It goes through `io.notify` because `notifyAccountState` is in `index.ts`, and calling it from here would be a circular import.
    3. Leave Keycast untouched.

- [ ] **Step 1: Write the failing route tests**: one per refusal row, plus:
  - `changes an active record's end, writes change_suspension_end, and sends ACCOUNT_SUSPENSION_CHANGED with the new end`;
  - `adds an end date to a suspended account with no record` (decision 7): an `active` record with `set_by` = the moderator, and one message;
  - `refuses while the record is lifting and leaves ends_at unchanged` (Review Focus 3);
  - `GET lists active and cancelled_ban records only, as TimedSuspensionView`;
  - `no message and no decision row on any refusal`.

- [ ] **Step 2: Run to verify they fail** (404s).

- [ ] **Step 3: Implement.**

- [ ] **Step 4: Run all worker gates.**

- [ ] **Step 5: Mutation-check**, one at a time: the age-review guard, the banned refusal, the not-suspended refusal, the `ending` refusal, and the `unknown` → 503 mapping.

- [ ] **Step 6: Commit**

```bash
git add worker/src/index.ts worker/src/timed-suspensions.ts worker/test/timed-suspensions-routes.d1.test.ts
git commit -m "feat(suspensions): change a suspension's end date and list timed suspensions"
```

### Task B6: The automatic lift (scheduler tick)

**Files:**
- Modify: `worker/src/timed-suspensions.ts` (the tick), `worker/src/index.ts` (`scheduled()` ~1043, after the age-review deadline check)
- Create: `worker/test/timed-suspensions-tick.d1.test.ts`

**Interfaces:**
- Consumes: the B2 store, B4 `SuspensionIo` and `restoreAfterLift`, B1 `SUSPENSION_ACTIONS`.
- Produces:

```ts
export const LIFT_ALERT_AFTER_ATTEMPTS = 3;
export const STALE_CLAIM_MINUTES = 15;
export const TICK_BATCH = 25;
export interface TickSummary { lifted: number; alreadyLifted: number; cancelledByBan: number;
  waiting: number; failed: number; keycastSettled: number; recovered: number }
export async function runTimedSuspensionTick(
  env: { DB: D1Database; ENVIRONMENT?: string }, io: SuspensionIo, now?: Date): Promise<TickSummary>;
```

- `scheduled()` calls it:
  - inside its own try/catch, under the existing `if (env.DB)`;
  - after `ensureSchemaOnce`, with `liveSuspensionIo(env, notifier)`;
  - and logs the summary when anything changed.

**The algorithm** (the signature doesn't determine it, so it's written out):
- Each row runs in its own try/catch; a throw is a failed attempt for that row only.
- **"Fail"** means: a CAS on the read version, setting `attempts + 1`, `last_error` and `last_attempt_at`, with the status unchanged.

**Phase 0, recover stale claims.** Rows with `status = 'lifting' AND datetime(claimed_at) < datetime(now, '-15 minutes')`. Read the relay suspension:
- still suspended → CAS back to `active`;
- not suspended → CAS to `keycast_pending` with `attempts = 0`. The alert notes the restored message may not have gone out;
- unknown → fail.

**Phase 1, due lifts.** Rows with `status = 'active' AND ends_at IS NOT NULL AND datetime(ends_at) <= datetime(now)`, ordered by `ends_at`, `LIMIT 25`. For a row read at version `v`:
1. Call `io.readBan` and `io.readKeycastStatus`.
   - If either says banned: CAS to `cancelled_ban`, write a `cancel_suspension_timer` row (reason `Account is banned`, human false), and stop.
   - Otherwise, if either is `'unknown'`: fail.
2. `io.hasOpenAgeReviewCase`:
   - true → leave the row (`waiting`; no attempt, no alert);
   - a throw → fail.
3. `io.readSuspension`:
   - `'unknown'` → fail;
   - not suspended → CAS to `already_lifted` and write `cancel_suspension_timer` (reason `Account was no longer suspended`), with no message and no Keycast change;
   - reason `age_review` → fail with `last_error = 'age_review row'`.
4. Claim: CAS `active` → `lifting` with `claimed_at = now`. If zero rows change, skip: a moderator acted first.
5. Call `io.relayUnsuspend`. On failure, or on a throw from here back, CAS `lifting` → `active` with `attempts + 1` and `last_error`.
6. CAS `lifting` → `keycast_pending` with `attempts = 0`. If zero rows change, stop with no message: a manual unsuspend landed and sent its own.
7. Write `auto_unsuspend_user` (reason `Timed suspension ended`, moderator null, human false).
8. `restoreAfterLift(io, pubkey, { reason: 'Timed suspension ended' })` sends the one ACCOUNT_RESTORED, then sets Keycast active.
   - `ok` or `not_applicable` → CAS to `lifted`;
   - `failed` → fail (the row stays `keycast_pending`).

**Phase 2, Keycast retry.** Rows with `status = 'keycast_pending'`, `LIMIT 25`. This phase never sends a message (decision 14).
1. `io.readBan`:
   - true → CAS to `lifted` with no Keycast change;
   - `'unknown'` → fail.
2. Open age-review case → leave the row; a throw → fail.
3. `io.readKeycastStatus`:
   - `active`, `banned` or `none` → `lifted`, no call;
   - `'unknown'` → fail;
   - `suspended` → `io.keycastActivate`. Success or `notFound` → `lifted`; otherwise fail.

**Phase 3, alert.** Rows with `status IN ('active','lifting','keycast_pending') AND attempts >= 3 AND (last_alerted_at IS NULL OR datetime(last_alerted_at) < datetime(now, '-12 hours'))`, plus any rows recovered in Phase 0.
- One `io.alert` per tick:

  ```
  :rotating_light: [<ENVIRONMENT>] <n> timed suspension(s) not lifting
  • <full hex pubkey>: <relay|keycast> step, <attempts> attempts, last error: <first 200 chars>
  ```

- Set `last_alerted_at` only when `alert` returned true.
- With no webhook set, `console.error` the same text, so a failure always leaves a trace.

- [ ] **Step 1: Write the failing D1 tests** against a fake `SuspensionIo` (`vi.fn`s, with an explicit `now`):
  - `lifts a record that ended one minute ago today` (Review Focus 1). Assert:
    - `relayUnsuspend` is called once;
    - one notify, `ACCOUNT_RESTORED`;
    - one `keycastActivate`;
    - the status is `lifted`;
    - there is one `auto_unsuspend_user` row with `moderator_pubkey IS NULL`.
  - `leaves a record ending one minute from now alone`.
  - Ban checks (Review Focus 2):
    - `a ban on the relay, or in Keycast, cancels the timer with no lift, message or Keycast change` (two cases);
    - `an unreadable ban list, Keycast status or suspended list counts an attempt and lifts nothing` (three cases).
  - Holds and already-lifted:
    - `waits while an age-review case is open, with no attempt counted`;
    - `marks a record already lifted when the relay no longer suspends the account, with no message or Keycast change` (decision 12);
    - `never lifts a suspended row whose reason is age_review`.
  - Moderator races (Review Focus 3):
    - `skips the row when its version moved between read and claim` (bump the version inside the fake's `hasOpenAgeReviewCase`);
    - `sends no message when a manual unsuspend lands between the relay lift and the post-lift CAS` (the fake's `relayUnsuspend` runs `endSuspensionRecord(..., 'cancelled_unsuspend')` before resolving).
  - Failures and retries:
    - `a relay failure returns the record to active with attempts + 1`;
    - `a Keycast failure after the lift leaves keycast_pending, and three ticks send exactly one message, the third succeeding`;
    - `the Keycast retry does not activate a newly banned account` (Review Focus 2).
  - Recovery and alerts:
    - `recovers a stale lifting claim` (both branches);
    - `alerts once at 3 attempts, not again within 12 hours, again after`;
    - `does not mark alerted when the alert fails`.
  - Isolation: `one row throwing does not stop the next row`.

- [ ] **Step 2: Run** `cd worker && npx vitest run --config vitest.d1.config.ts test/timed-suspensions-tick.d1.test.ts`. Expected: FAIL.

- [ ] **Step 3: Implement**, and wire up `scheduled()`.

- [ ] **Step 4: Run all worker gates.**

- [ ] **Step 5: Mutation-check** each guard separately: `datetime()` on `ends_at`, the relay ban check, the Keycast-banned check, the age-review wait, the not-suspended branch, the `age_review` reason check, the claim CAS, the post-lift CAS, the Phase 2 ban re-check, the attempts threshold, the 12-hour throttle.

- [ ] **Step 6: Commit**

```bash
git add worker/src/timed-suspensions.ts worker/src/index.ts worker/test/timed-suspensions-tick.d1.test.ts
git commit -m "feat(suspensions): lift timed suspensions from the scheduler, failing closed"
```

### Task B7: Unban asks what happens to a running suspension

**Files:**
- Modify: `worker/src/index.ts` (`runRelayRpc` unban side effects ~1876), `worker/src/timed-suspensions.ts`
- Modify: `worker/src/index.test.ts` (in the existing unban tests, the fake relay answers `listsuspendedpubkeys` with `[]`)
- Test: `worker/test/timed-suspensions-routes.d1.test.ts`

**Interfaces:**
- Consumes: B1 `isUnbanSuspensionChoice`, `UnbanSuspensionState`; the B2 store; B4 `SuspensionIo`, `restoreAfterLift`.
- Produces:

```ts
export async function applyUnbanChoice(db: D1Database | undefined, io: SuspensionIo, pubkey: string,
  choice: UnbanSuspensionChoice | undefined, a: { moderator?: string; now: Date }):
  Promise<{ state: UnbanSuspensionState; endsAt?: string | null; decisionRecorded?: boolean; waitUntil: Promise<unknown>[] }>;
```

- `runRelayRpc` rejects a present but invalid `suspensionChoice` with 400 `invalid_suspension_choice`, before the relay call.
- After a successful relay unban, it:
  1. awaits `applyUnbanChoice`;
  2. hands each `waitUntil` promise to `ctx.waitUntil`;
  3. adds `suspension: { state, endsAt }` to the response.

  This replaces today's unconditional Keycast-active mirror for unban.

What `applyUnbanChoice` does, by what `io.readSuspension(pubkey)` returns:

| Relay read | Choice | What happens | State |
|---|---|---|---|
| `'unknown'` | any | Keycast untouched, no record change | `unknown` |
| not suspended | any | Keycast activate (today's behavior); in try/catch, `endSuspensionRecord(..., 'already_lifted')` | `not_suspended` |
| suspended | `resume` (also the default when no choice is sent) | Record in force with an `ends_at`: `changeSuspensionEnd` with that same `ends_at` (sets `active`), then Keycast suspend, and ACCOUNT_SUSPENSION_CHANGED if the end is still ahead. No record, or `ends_at` null: Keycast suspend only. | `resumed` |
| suspended | `open_ended` | `changeSuspensionEnd` with `endsAt: null` (or replace when there is no record); Keycast suspend; ACCOUNT_SUSPENDED with no `endsAt` | `open_ended` |
| suspended | `end_now` | `io.relayUnsuspend`. Success: `endSuspensionRecord(..., 'cancelled_unsuspend')` and `restoreAfterLift`. Failure: Keycast suspend, record untouched, still HTTP 200, because the unban happened. | `ended` / `end_failed` |

When a choice was sent explicitly, also write a moderator decision (human true). With no choice, write none:

| Choice | Action | Reason |
|---|---|---|
| `resume` | `change_suspension_end` | `Unbanned; suspension resumed until <end>` (or `, no end date`) |
| `open_ended` | `change_suspension_end` | `Unbanned; suspended with no end date` |
| `end_now` | `unsuspend_user` | `Unbanned; suspension ended` |

- [ ] **Step 1: Write the failing route tests**
  - Not suspended → Keycast `active`, `state: 'not_suspended'`, and an in-force record goes `already_lifted`.
  - Unreadable list → no Keycast call, `state: 'unknown'`.
  - Default resume: a suspended account with a future end and no choice → Keycast `suspended`, record `active`, ACCOUNT_SUSPENSION_CHANGED with the original end, and no decision row.
  - Resuming a `cancelled_ban` record → `active`, with the same `ends_at`. When that end is already past, no message is sent.
  - `open_ended` → `ends_at` null, ACCOUNT_SUSPENDED with no `endsAt`, and a `change_suspension_end` row.
  - `end_now` → relay unsuspend, record `cancelled_unsuspend`, exactly one ACCOUNT_RESTORED, Keycast `active`, and an `unsuspend_user` row.
  - `end_now` where the relay unsuspend fails → 200, `state: 'end_failed'`, Keycast `suspended`, record still in force.
  - `suspensionChoice: 'bogus'` → 400 before the relay call.
  - The age-review guard still refuses an unban with an open case (the existing test passes unchanged).

- [ ] **Step 2: Run to verify they fail.**

- [ ] **Step 3: Implement.** Then update the fake relay in the existing `index.test.ts` unban tests. Their asserted behavior (Keycast `active`, no DM) doesn't change.

- [ ] **Step 4: Run all worker gates.**

- [ ] **Step 5: Mutation-check**, one at a time: the relay-suspended gate, the default resume's Keycast suspend, the `end_now` relay-failure branch, the "still ahead" message check, the explicit-choice gate on the decision.

- [ ] **Step 6: Commit**

```bash
git add worker/src/index.ts worker/src/index.test.ts worker/src/timed-suspensions.ts worker/test/timed-suspensions-routes.d1.test.ts
git commit -m "feat(suspensions): apply the moderator's choice to a suspension on unban"
```

### Task B8: Frontend API layer and the suspensions hook

**Files:**
- Modify: `src/lib/adminApi.ts` (`callRelayRpc` ~357, `unbanPubkey` ~504, `suspendPubkey` ~538), `src/hooks/useAdminApi.ts`
- Create: `src/hooks/useTimedSuspensions.ts`, `src/hooks/useTimedSuspensions.test.tsx`
- Test: `src/hooks/useAdminApi.test.ts`, `src/hooks/useAdminApi.attribution.test.ts`

**Interfaces:**
- Consumes: the B1 types; the HTTP contracts from B4, B5 and B7.
- Produces:

```ts
// adminApi.ts
export interface SuspendOutcome { endsAt: string | null; recorded: boolean; decisionRecorded: boolean }
export async function suspendPubkey(apiUrl: string, pubkey: string, reason?: string,
  opts?: LoginOpts & { duration?: SuspensionDuration | null }): Promise<SuspendOutcome>;
export interface UnbanOutcome { suspension: { state: UnbanSuspensionState | 'none'; endsAt?: string | null } }
export async function unbanPubkey(apiUrl: string, pubkey: string,
  opts?: LoginOpts & { suspensionChoice?: UnbanSuspensionChoice }): Promise<UnbanOutcome>;
export async function changeSuspensionEnd(apiUrl: string, pubkey: string, duration: SuspensionDuration,
  opts?: LoginOpts): Promise<{ endsAt: string; decisionRecorded: boolean }>;
export async function listTimedSuspensions(apiUrl: string): Promise<TimedSuspensionView[]>;
// useAdminApi.ts
//   attribution: suspendPubkey(pubkey, reason?, duration?), unbanPubkey(pubkey, suspensionChoice?), changeSuspensionEnd(pubkey, duration)
//   read:        listTimedSuspensions()
// useTimedSuspensions.ts
export const TIMED_SUSPENSIONS_KEY = ['timed-suspensions'] as const;
export function useTimedSuspensions(): UseQueryResult<TimedSuspensionView[]>; // staleTime 30_000, retry 1
export function useTimedSuspension(pubkey: string | null | undefined):
  { record: TimedSuspensionView | null | undefined; isError: boolean; isLoading: boolean };
```

- `callRelayRpc` refactor: extract its fetch-and-parse half into a private `postRelayRpc<T>(apiUrl, body: object, opts): Promise<ApiResponse<T>>`, which keeps the structured `ApiError` with its `code`. `callRelayRpc` returns `.result`; `suspendPubkey` and `unbanPubkey` read their extra fields.
- `ApiResponse` gains `suspension?: unknown`.
- `suspendPubkey`: `duration: undefined` sends no field; `null` sends `{ duration: null }`.
- A response without `suspension` (an old worker) maps to `{ endsAt: null, recorded: false, decisionRecorded: false }`, or `{ state: 'none' }` for unban.
- `changeSuspensionEnd` throws an `ApiError` carrying the body's `code`, because `useAgeReviewGuardRedirect` reads it.
- `useTimedSuspension`:
  - `undefined` while loading;
  - `null` when the list has answered without this pubkey;
  - `isError` when the read failed and there is no data;
  - matches case-insensitively (`sameHex`).

- [ ] **Step 1: Write the failing tests.** They run the real wrappers down to `fetch`, because a wrapper that forgets a new argument passes tsc and the component tests.
  - `suspendPubkey`:
    - `(PK, 'r', { value: 3, unit: 'days' })` posts `suspension: { duration: { value: 3, unit: 'days' } }`;
    - `(PK, 'r', null)` posts `{ duration: null }`;
    - `(PK, 'r')` posts no `suspension` key.
  - `unbanPubkey`: `(PK, 'end_now')` posts `suspensionChoice: 'end_now'`; `(PK)` posts none.
  - `changeSuspensionEnd(PK, { value: 12, unit: 'hours' })` posts to `/api/suspensions/end`. A 409 `account_banned` rejects with `error.code === 'account_banned'`.
  - The attribution table gets a row for `changeSuspensionEnd`.
  - `useTimedSuspension`: `undefined`, then `null` or the record; `isError` on a rejected read.

- [ ] **Step 2: Run** `npx vitest run src/hooks/useAdminApi.test.ts src/hooks/useAdminApi.attribution.test.ts src/hooks/useTimedSuspensions.test.tsx`. Expected: FAIL.

- [ ] **Step 3: Implement.**

- [ ] **Step 4: Run the root gates.** Existing callers of `unbanPubkey` and `suspendPubkey` still type-check.

- [ ] **Step 5: Mutation-check**, one at a time: each wrapper's forwarding of its new argument, and the `undefined` vs `null` split.

- [ ] **Step 6: Commit**

```bash
git add src/lib/adminApi.ts src/hooks/useAdminApi.ts src/hooks/useAdminApi.test.ts src/hooks/useAdminApi.attribution.test.ts src/hooks/useTimedSuspensions.ts src/hooks/useTimedSuspensions.test.tsx
git commit -m "feat(suspensions): admin API calls and hook for timed suspensions"
```

### Task B9: Suspend dialog, end-time line and Change end date

**Files:**
- Create: `src/components/SuspensionDurationDialog.tsx` + `.test.tsx`, `src/components/SuspensionEndLine.tsx` + `.test.tsx`, `src/hooks/useChangeSuspensionEnd.ts`
- Modify: `src/components/UserActions.tsx` (suspend mutation ~169, render ~387-410), `src/components/UserActions.test.tsx` (add `changeSuspensionEnd` and `listTimedSuspensions` to the hoisted api mock)

**Interfaces:**
- Consumes: B1 (`checkSuspensionDuration`, `suspensionEndsAt`, `formatSuspensionEnd`, `DURATION_ERROR`); B8.
- Produces:

```ts
export function SuspensionDurationDialog(p: { open: boolean; onOpenChange(o: boolean): void;
  mode: 'suspend' | 'change'; currentEndsAt?: string | null; isPending: boolean;
  onConfirm(duration: SuspensionDuration | null): void | Promise<void> }): JSX.Element;
export function suspensionEndText(a: { record: TimedSuspensionView | null | undefined; isError: boolean;
  banned: boolean; now: Date }): string;
export function SuspensionEndLine(p: { pubkey: string; banned?: boolean }): JSX.Element;
export function useChangeSuspensionEnd(): UseMutationResult<{ endsAt: string; decisionRecorded: boolean }, Error,
  { pubkey: string; duration: SuspensionDuration }>; // owns its toasts and invalidation
```

Copy (Matt approves):

- **Dialog.**
  - Titles: `Suspend account` / `Change end date`. In change mode, a `Currently: <end or "no end date">` line.
  - Fields: `Length` (a number input), a unit select `Hours` / `Days` (default Days), and, in suspend mode only, a `No end date` checkbox that disables the length fields.
  - Preview: `Ends <formatted>`. Invalid input shows `DURATION_ERROR` and disables confirm.
  - Confirm: `Suspend` / `Change end date`; pending: `Suspending...` / `Saving...`.
  - Use the existing `components/ui` dialog primitives.
- **`suspensionEndText`**, first match wins:
  1. loading → `Checking suspension end date`;
  2. `isError` → `Suspended. End date unavailable`;
  3. banned with a dated record → `Banned. The timed suspension will not lift while the ban stands`;
  4. end in the future → `Suspended until <formatted>`;
  5. end in the past → `End time passed (<formatted>). Lifts at the next check`;
  6. otherwise → `Suspended, no end date`.
- **Suspend toasts:**
  - `User suspended until <formatted>`, or `User suspended, no end date`.
  - If the end date wasn't saved: `User suspended, but the end date was not saved`, with description `Use Change end date to set it.`. This takes priority over `Action applied; audit log not recorded`.
- **Change toasts:** `End date changed to <formatted>`. Refusals by code:
  - `account_banned` → `This account is banned. Unban it first.`
  - `not_suspended` → `This account is no longer suspended.`
  - `suspension_ending` → `This suspension is ending now. Check again in a few minutes.`
  - `conflict` → `Someone changed this suspension at the same time. Try again.`
  - `status_unavailable` → `Could not check the account's status. Try again.`
  - `age_review_active` → `redirectIfGuarded`.

UserActions:
- **Suspend** opens the dialog. The mutation takes `{ target, duration }` and calls `act.suspendPubkey(target, 'Suspended by moderator', duration)` inside `runHidingAction`.
  - It no longer calls `logAudit` for suspend.
  - On success it invalidates `['decisions']`, the resolution state and `TIMED_SUSPENSIONS_KEY`.
- **When `isSuspended === true`**: render `<SuspensionEndLine pubkey={pubkey} />`, Unsuspend, and a `Change end date` button that opens the dialog in change mode.
- **Unsuspend** also invalidates `TIMED_SUSPENSIONS_KEY`.

- [ ] **Step 1: Write the failing tests**
  - Dialog:
    - confirm is disabled for `0`, `1.5`, `-2` and `366` days, and enabled for `3` days;
    - `No end date` confirms with `null`;
    - change mode has no `No end date`.
  - `suspensionEndText` (with a fixed `now`): every case. Specifically, `isError` gives `Suspended. End date unavailable`, never `no end date` (Review Focus 4).
  - UserActions:
    - `Suspend → 3 days → Suspend` calls `api.suspendPubkey(PUBKEY, 'Suspended by moderator', { value: 3, unit: 'days' })`, and there is no `logDecision` with `suspend_user`;
    - `recorded: false` with a duration shows the not-saved toast;
    - with a mocked `listTimedSuspensions`, a suspended account shows `Suspended until Tue 24 Nov 2026, 14:00 UTC`;
    - a rejected `listTimedSuspensions` shows `Suspended. End date unavailable`;
    - `Change end date → 12 hours` calls `api.changeSuspensionEnd(PUBKEY, { value: 12, unit: 'hours' })`;
    - a rejection with code `account_banned` toasts its copy.

- [ ] **Step 2: Run** `npx vitest run src/components/SuspensionDurationDialog.test.tsx src/components/SuspensionEndLine.test.tsx src/components/UserActions.test.tsx`. Expected: FAIL.

- [ ] **Step 3: Implement.**

- [ ] **Step 4: Run the root gates.** Then a visual check with Playwright against the local stack only: the harness blocks production HTTP and WebSocket and forces the Local environment. Take screenshots for the PR.

- [ ] **Step 5: Mutation-check**, one at a time: the dialog's validity gate, the order of the `isError` branch, the removal of the suspend `logAudit`, the not-saved toast condition.

- [ ] **Step 6: Commit**

```bash
git add src/components/SuspensionDurationDialog.tsx src/components/SuspensionDurationDialog.test.tsx src/components/SuspensionEndLine.tsx src/components/SuspensionEndLine.test.tsx src/hooks/useChangeSuspensionEnd.ts src/components/UserActions.tsx src/components/UserActions.test.tsx
git commit -m "feat(suspensions): suspend for a set time and change the end date from account actions"
```

### Task B10: Unban prompt and the Suspended tab

**Files:**
- Create: `src/components/UnbanSuspensionDialog.tsx` + `.test.tsx`
- Modify: `src/components/UserActions.tsx` (unban ~236), `src/components/UserManagement.tsx` (unban ~230, suspended cards ~536, `invalidateUserQueries` ~66), `src/components/BannedUserCard.tsx` (props ~33), `UserActions.test.tsx`, `UserManagement.test.tsx`

**Interfaces:**
- Consumes: B8 (`unbanPubkey(pubkey, choice?)`, `useTimedSuspension`); B9 (`SuspensionEndLine`, `SuspensionDurationDialog`, `useChangeSuspensionEnd`).
- Produces:

```ts
export function UnbanSuspensionDialog(p: { open: boolean; onOpenChange(o: boolean): void;
  record: TimedSuspensionView | null | undefined; isPending: boolean; now?: Date;
  onConfirm(choice: UnbanSuspensionChoice): void | Promise<void> }): JSX.Element;
// BannedUserCard gains: statusLine?: React.ReactNode  (rendered under the reason)
export function unbanOutcomeToast(o: UnbanOutcome): { title: string; description?: string; variant?: 'destructive' };
```

Copy (Matt approves):

- **Dialog.**
  - Title: `Unban account`.
  - Description: `This account is also suspended. Choose what happens to the suspension when the ban is lifted.`
  - Confirm: `Unban` / `Unbanning...`.
  - Options, with the default first:
    - end still ahead: `Resume until <formatted>` (resume), `End the suspension now` (end_now), `Keep suspended with no end date` (open_ended);
    - end already past: `Resume. The end date has passed, so it lifts at the next check` (resume), then the other two;
    - no record, or no end: `Keep suspended with no end date` (open_ended), `End the suspension now` (end_now).
- **`unbanOutcomeToast`:**

  | State | Toast |
  |---|---|
  | `ended` | `User unbanned and unsuspended` |
  | `end_failed` | destructive: `User unbanned, but the suspension could not be lifted` / `It is still suspended. Try Unsuspend.` |
  | `resumed` | `User unbanned. Still suspended until <formatted>`, or `User unbanned. Still suspended, no end date` |
  | `open_ended` | `User unbanned. Still suspended, no end date` |
  | `unknown` | `User unbanned, but the suspension status could not be checked` / `Check the account before acting again.` |
  | `not_suspended`, `none` | `User unbanned` |

Wiring:
- **UserActions.** Unban opens the dialog when `isSuspended !== false`; otherwise it unbans directly with no choice, as today. The browser's `unban_user` row stays.
- **UserManagement:**
  - The Banned-tab unban opens the dialog when the pubkey is in `suspendedUsers`; otherwise it's today's flow.
  - Suspended-tab cards get `statusLine={<SuspensionEndLine pubkey={user.pubkey} banned={bannedUsers?.some(...)} />}`, with Unsuspend plus `Change end date` in the action area.
  - `invalidateUserQueries` adds `TIMED_SUSPENSIONS_KEY`.

- [ ] **Step 1: Write the failing tests**
  - Dialog: each record case renders its options with the right default, and confirm passes the selected choice.
  - `unbanOutcomeToast`: every state.
  - UserActions:
    - banned and suspended → Unban opens the dialog, and `End the suspension now` calls `api.unbanPubkey(PUBKEY, 'end_now')`;
    - banned, not suspended → `api.unbanPubkey(PUBKEY)` with no dialog;
    - `isSuspended: null` → the dialog is shown.
  - UserManagement:
    - a suspended card shows `Suspended until …`, and a card also in the banned list shows the banned line;
    - the Banned-tab unban of a suspended account opens the dialog, and `Keep suspended with no end date` calls `unbanPubkey(pk, 'open_ended')`;
    - the card's `Change end date` calls `changeSuspensionEnd`.

- [ ] **Step 2: Run** `npx vitest run src/components/UnbanSuspensionDialog.test.tsx src/components/UserActions.test.tsx src/components/UserManagement.test.tsx`. Expected: FAIL.

- [ ] **Step 3: Implement.**

- [ ] **Step 4: Run the root gates.** Then a local-only Playwright check of the prompt and the Suspended tab, with screenshots for the PR.

- [ ] **Step 5: Mutation-check**, one at a time: the `isSuspended !== false` gate, the `suspendedUsers` gate, the card's `banned` prop.

- [ ] **Step 6: Commit**

```bash
git add src/components/UnbanSuspensionDialog.tsx src/components/UnbanSuspensionDialog.test.tsx src/components/UserActions.tsx src/components/UserActions.test.tsx src/components/UserManagement.tsx src/components/UserManagement.test.tsx src/components/BannedUserCard.tsx
git commit -m "feat(suspensions): ask on unban and show end dates on the Suspended tab"
```

### Task B11: Whole-branch verification and PR prep

**Files:**
- Modify: `AGENTS.md`. Add a short "Timed suspensions" subsection under "Integration Contracts":
  - the record write is best-effort, and its failure is reported, not hidden;
  - the scheduler lifts through `restoreAfterLift`;
  - unban applies a suspension choice, defaulting to resume for callers that send none (moderation-service `allow_pubkey`, Coop);
  - `auto_unsuspend_user` and `cancel_suspension_timer` do not count as human handling.

- [ ] **Step 1: Run every gate** from Global Constraints on a clean tree, and record the output. Run the four new D1 files alone if a full macOS run hits EADDRNOTAVAIL.
- [ ] **Step 2: Trial merge** (CI tests the merge result):
  1. `git fetch origin && git merge --no-commit --no-ff origin/main`
  2. Re-run the worker and root tests.
  3. `git merge --abort`
- [ ] **Step 3: Diff scope.** `git diff origin/main --stat` lists only files named in this plan.
- [ ] **Step 4: Local manual validation** (local stack only, per AGENTS.md "Local Development"). Without Keycast configured locally, the tick reads Keycast as `'unknown'` and fails closed by design; configure local Keycast to see a full lift.
  1. Suspend an account for 1 hour.
  2. Change its end to 1 hour from now.
  3. Move `ends_at` into the past with `wrangler d1 execute --local`.
  4. Run the cron: start `wrangler dev --test-scheduled`, then `curl "http://localhost:8787/__scheduled?cron=*/5+*+*+*+*"`.
  5. Confirm the account lifts with one restored notify.
  6. Repeat with the account banned, and confirm nothing lifts.
- [ ] **Step 5: Commit** `docs(agents): timed suspension contracts`.
- [ ] **Step 6: Hand back.**
  - PR title: `feat(suspensions): timed suspensions that lift on schedule`, linking support-trust-safety #263.
  - The description gives the intent and decisions, the deploy order (moderation-service, then worker staging → prod, then Pages), screenshots, PR_REVIEW.md's model-identity block, and the copy for Matt's approval.
  - Ask Matt whether to open it as a draft or ready.
