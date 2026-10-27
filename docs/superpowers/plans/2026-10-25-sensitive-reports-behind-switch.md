# Sensitive Reports Behind the Switch Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Put CSAM reports that the system didn't act on behind the existing "Pending review" switch, marked "Not hidden, needs review". This covers reports against profiles and lists, reports from other apps, and reports from old Divine builds. Also hide the reported account's images on sensitive reports, and make deep links turn the switch on.

**Architecture:**
- A pure shared classifier (`shared/report-classification.ts`) returns a display `category` and a separate `csamSignal`.
- A browser helper (`src/lib/sensitiveSwitch.ts`) computes switch membership from what `Reports.tsx` already loads.
- Everything else is wiring into existing components. There are no worker changes and no new writes.

**Tech Stack:** React 18, TypeScript, Vitest, Testing Library, TanStack Query.

**Spec:** `docs/superpowers/specs/2026-10-25-sensitive-reports-behind-switch-design.md`

## Global Constraints

- **Nothing is automated or written.** `csamSignal` never reaches D1, the relay, labels, or Zendesk, and nothing calls an API because of it. No worker file changes.
- **A bare NIP-56 `illegal` never sets `csamSignal`.**
- **The CSAM set is exactly** `sexual_minors`, `csam`, `NS-csam`, compared case-insensitively. `NS-childSafety` is not in it.
- **The free-text terms are exactly** `csam`, `child sexual abuse`, and `child porn`. The last one also matches "child pornography". They are matched case-insensitively and only against the report's own `content`.
- **The public repo carries no real report IDs, pubkeys, or case details.** Fixtures use synthetic 64-hex IDs, such as `'a'.repeat(64)`.
- **No em dashes** in user-facing copy.
- **Verification runs:**
  - `npx tsc -p tsconfig.app.json --noEmit`
  - `cd worker && npm run typecheck`
  - `npx eslint src/ shared/`
  - `npx vitest run`
  - `cd worker && npx vitest run`
- **Mutation check.** Every test that guards a behavior below must go red when that one guard is removed. Back up the file with `cp` before mutating, and restore from the backup, never with `git checkout`.
- **Fill in the TODO.** A `TODO(#NNN)` for moving the report watcher onto the shared classifier gets the issue number Matt files. Leave the literal `#NNN` and list it in the handback.

## Review Focus

1. **Labels in a different order.** A report carrying `NS-spam` before `NS-csam` (both `social.nos.ontology`) must still get category `NS-csam` and `csamSignal`. Test in Task 1.
2. **Uppercase values.** An `l` value `CSAM`, or a `Reason: CSAM` line, must still set `csamSignal`. Test in Task 1.
3. **Malformed input.** A tag missing its value (`['l']`, `['p']`) or a report with no `content` must not throw. It classifies as `other` with no signal. Test in Task 1.
4. **Turning the switch off after a deep link.** It must stay off, without the deep-link effect turning it back on. Test in Task 4.
5. **A target that is both auto-hidden and carries `csamSignal`.** It appears once, labelled "Hidden automatically", and counts once in the badge. Test in Task 3.

---

### Task 1: Shared report classifier

**Files:**
- Create: `shared/report-classification.ts`
- Test: `shared/report-classification.test.ts`
- Modify: `src/lib/constants.ts:67-72`. Re-export `HIGH_PRIORITY_CATEGORIES` from the shared module instead of defining it.

**Interfaces:**
- Produces:
  - `HIGH_PRIORITY_CATEGORIES: readonly string[]`, the same eight values as today, moved here.
  - `CSAM_CATEGORIES: readonly string[]` = `['sexual_minors', 'csam', 'NS-csam']`
  - `interface ReportClassification { category: string; csamSignal: boolean }`
  - `classifyReport(event: { tags?: unknown; content?: unknown }): ReportClassification`
  - `ageReviewCategory(event: { tags?: unknown }): string`

**Rules for `category`, in order:**
1. The first `report` tag with a non-empty `[1]`.
2. Among `l` tags with `[2] === 'social.nos.ontology'`, the first whose value is in `HIGH_PRIORITY_CATEGORIES`, else the first of those tags.
3. The first other `l` tag with a non-empty `[1]`.
4. The first `e` tag's `[2]`, else the first `p` tag's `[2]`.
5. `'other'`.

**Rules for `csamSignal`:** any one of these is enough.
- Any `report` tag value, or any `l` value in any namespace, is in `CSAM_CATEGORIES`, ignoring case.
- The content contains a line matching `/^\s*Reason:\s*(csam|sexual_minors)\s*$/im`.
- The content matches `/\b(csam|child sexual abuse)\b|\bchild porn/i`.

**`ageReviewCategory`** copies `ReportWatcher.ts` ~826-845 exactly:
`report[1] || l(social.nos.ontology)[1] || l(MOD)[1] || e[2] || p[2] || 'unknown'`

Put a comment saying it must match the worker. Add `// TODO(#NNN): move ReportWatcher onto classifyReport` beside it.

- [ ] **Step 1: Write the failing tests** in `shared/report-classification.test.ts`. Use fixtures shaped like the spec's observed reports, with `P = 'b'.repeat(64)` and `E = 'c'.repeat(64)`:
  - `it('routes a current Divine profile report')`. Tags are `['p',P,'illegal']`, `['L','social.nos.ontology']`, `['l','NS-csam','social.nos.ontology']`, `['t','user-report']`, `['client','Divine']`. Expect `{ category: 'NS-csam', csamSignal: true }`.
  - `it('routes an old-build report by its Reason line')`. Tags are `['e',E,'illegal']`, `['p',P,'illegal']`, `['client','diVine']`. The content is `'CONTENT REPORT - NIP-56\nReason: csam\nDetails: x\n'`. Expect `{ category: 'illegal', csamSignal: true }`.
  - `it('keeps a bare illegal report from another app out')`. Tags are `['e',E,'illegal']`, `['p',P]`, and the content is `'bad stuff'`. Expect `{ category: 'illegal', csamSignal: false }`.
  - `it('routes on free text')`. Same as the previous test but with content `'this account posts child pornography'`. Expect `csamSignal: true`. A second case with `'Child Sexual Abuse material'` also expects `true`.
  - `it('does not match csam inside another word')`. Content `'csamuel'` expects `csamSignal: false`.
  - `it('routes a CSAM label in another namespace')` with `['l','csam','MOD']`. Expect `csamSignal: true`.
  - `it('leaves child safety out of routing')` with `['l','NS-childSafety','social.nos.ontology']`. Expect `{ category: 'NS-childSafety', csamSignal: false }`.
  - Review Focus 1. `NS-spam` comes before `NS-csam`, both in `social.nos.ontology`. Expect `category: 'NS-csam'`.
  - Review Focus 2. Expect `csamSignal: true` for `['l','CSAM','MOD']`, and for content `'Reason: CSAM'`.
  - Review Focus 3. `classifyReport({ tags: [['l'], ['p']] })` and `classifyReport({})` both equal `{ category: 'other', csamSignal: false }`.
  - `it('falls back to the NIP-56 type on a p tag')` with `['p',P,'spam']`. Expect `category: 'spam'`.
  - `ageReviewCategory`. For tags `['l','NS-csam','social.nos.ontology']` and `['l','NS-underageUser','social.nos.ontology']`, expect `'NS-csam'` (first Divine label, the worker's order). For `[['p',P,'other']]`, expect `'other'`. For `[]`, expect `'unknown'`.

- [ ] **Step 2: Run them and confirm they fail.** `npx vitest run shared/report-classification.test.ts`. Expected: FAIL, because the module isn't found.
- [ ] **Step 3: Implement** the module per the rules above. Tolerate non-array `tags`, non-array tag entries, and non-string `content`, the same way `shared/report-target.ts` does.
- [ ] **Step 4: Run it and confirm it passes.** Run the same command, and also `npx vitest run src/lib/constants.test.ts`. Expected: PASS.
- [ ] **Step 5: Mutation-check each rule.** Remove each of these one at a time: the `Reason:` branch, the free-text branch, the case folding, the Divine-namespace preference, and the NIP-56 fallback. Confirm exactly the matching test goes red each time.
- [ ] **Step 6: Commit** with the message `feat(reports): shared report classifier with a separate CSAM routing signal`.

### Task 2: The browser uses the classifier everywhere

**Files:**
- Modify:
  - `src/lib/constants.ts:97-103`. `getReportCategory` returns `classifyReport(event).category`. Add `hasCsamSignal(reports: readonly { tags: string[][]; content?: string }[]): boolean`.
  - `src/components/ReporterCard.tsx:212-218`. Delete the local `getCategory` and use `getReportCategory`.
  - `src/components/Reports.tsx:255-260, 333-336`. In `ConsolidatedReportItem` and `IndividualReportItem`, set `isHighPriority` to the existing check `|| hasCsamSignal(...reports)`.
  - `src/components/ReportDetail.tsx`:
    - ~397-401: `hasHighPriorityReports` also returns true when `hasCsamSignal(allReportsForTarget)` does.
    - ~520: `isHighPriorityCategory` also covers `classifyReport(report).csamSignal`.
    - ~1343: `reportCategory={ageReviewCategory(report)}`
  - `src/components/EventDetail.tsx:689-695`. Same OR as ReportDetail.
- Test:
  - `src/lib/constants.test.ts`
  - a new `describe` in `src/components/Reports.test.tsx`

**Interfaces:**
- Consumes `classifyReport`, `ageReviewCategory`, and `HIGH_PRIORITY_CATEGORIES` from Task 1.
- Produces `hasCsamSignal`, exported from `@/lib/constants`.

- [ ] **Step 1: Write the failing tests.**
  - In `constants.test.ts`, `getReportCategory` on `[['p',P,'spam']]` returns `'spam'`, and `hasCsamSignal` on the old-build fixture returns `true`.
  - In `Reports.test.tsx`, `it('marks an old-build CSAM report as Priority in the list')`. Using the file's existing harness, load one old-build report with no auto-hide rows. Turn the switch on, because after Task 3 it lives behind it. For this task's commit, assert in the default view instead, and Task 3 updates the assertion. The row shows the `Priority` badge, and its category badge text is `Illegal`, not CSAM.
- [ ] **Step 2: Run them and confirm they fail.** Run `npx vitest run src/lib/constants.test.ts src/components/Reports.test.tsx`.
- [ ] **Step 3: Implement** the edits listed above.
- [ ] **Step 4: Run them and confirm they pass.** Run the same command, plus `npx tsc -p tsconfig.app.json --noEmit`.
- [ ] **Step 5: Mutation-check.** Drop the `|| hasCsamSignal` from `ConsolidatedReportItem` and confirm the Priority test goes red.
- [ ] **Step 6: Commit** with the message `feat(reports): classify NIP-56 types and treat a CSAM signal as high priority`.

### Task 3: Switch membership, count and labels

**Files:**
- Create: `src/lib/sensitiveSwitch.ts` and `src/lib/sensitiveSwitch.test.ts`
- Modify: `src/components/Reports.tsx`, at these places:
  - membership memo near `pendingReviewTargets` (~670)
  - filters (~885-890, ~965-977)
  - count (~1031)
  - switch label (~1558, ~1606)
  - rows (`ConsolidatedReportItem`, `IndividualReportItem`)
  - `<ReportDetail>` props (~1371)
- Modify: `src/components/ReportDetail.tsx`, the props (~74) and header badge row (~662)
- Test: `src/components/Reports.sensitive-switch.test.tsx`. Copy the mocking harness from `Reports.toggle.test.tsx`.

**Interfaces:**
- Consumes `hasCsamSignal` (Task 2), and `isConsolidatedReportResolved` (`src/lib/reportResolution.ts`).
- Consumes `AUTO_HIDE_ACTION` and `AutoHideStateRowLike` from `shared/autohide.ts`.
- Produces:
  - `type SwitchState = 'auto-hidden' | 'not-hidden'`
  - `humanHandledAutoHideTargets(states: readonly AutoHideStateRowLike[]): Set<string>`. These are keys with any `auto_hide_confirmed`, `auto_hide_restored` or `auto_hide_reversed` row.
  - `buildSwitchMembership(args: { consolidated: readonly { target: { type: 'event' | 'pubkey'; value: string }; authorPubkey?: string; reports: readonly { tags: string[][]; content?: string }[] }[]; pendingReview: ReadonlySet<string>; humanHandled: ReadonlySet<string>; resolvedTargets: Set<string>; bannedPubkeys: Set<string> }): Map<string, SwitchState>`
- `ReportDetail` gains the prop `switchState?: SwitchState`.

**Membership:**
- Every key in `pendingReview` maps to `'auto-hidden'`.
- A consolidated target not in `pendingReview` maps to `'not-hidden'` when all three hold: `hasCsamSignal(c.reports)`, the key is not in `humanHandled`, and `!isConsolidatedReportResolved(c, resolvedTargets, bannedPubkeys)`.
- This does not depend on `hideResolved`. While a resolution source is still loading, `resolvedTargets` is partial, so the target stays in. That is the intended safe direction.

**Copy (exact):**
- The switch label: `Pending review (sensitive)`. This keeps the "Pending review" prefix that existing selectors and the "unavailable while Pending review is on" note rely on.
- Row and pane labels: `Hidden automatically` and `Not hidden, needs review`. For `auto_hide_unresolved` or `auto_hide_restore_failed`, use `Hide not confirmed`. That needs the latest state per key, so `pendingReviewTargets` becomes a `Map<string, latestAction>`, built with the same `getLatestAutoHideState` logic.

- [ ] **Step 1: Write the failing unit tests** in `sensitiveSwitch.test.ts`. Each one builds args directly.
  - A profile target with a CSAM report maps to `'not-hidden'`.
  - A bare-illegal target is absent.
  - The same CSAM target is absent when it's in `resolvedTargets`.
  - It's absent when it's in `humanHandled`.
  - It's absent when its event's author is in `bannedPubkeys`.
  - Review Focus 5: a key in `pendingReview` that also has a CSAM report maps once, to `'auto-hidden'`.
  - A `pendingReview` key with no loaded reports is still present as `'auto-hidden'`.
  - `humanHandledAutoHideTargets` returns only keys with a confirmed, restored or reversed row.
- [ ] **Step 2: Write the failing screen tests** in `Reports.sensitive-switch.test.tsx`:
  - `it('keeps a profile CSAM report out of the default view and shows it behind the switch')`. With no auto-hide rows, the target's `npub1…` is absent from the default view. The switch reads `Pending review (sensitive)` with badge `1`. With the switch on, the row is present with the text `Not hidden, needs review`.
  - `it('leaves a bare illegal report from another app in the default view')`.
  - `it('counts auto-hidden and not-hidden together')`. One `auto_hidden` target with a loaded report, plus one profile CSAM target, gives badge `2`. With the switch on, the rows carry `Hidden automatically` and `Not hidden, needs review` respectively.
  - `it('keeps a CSAM target behind the switch while resolution labels are still loading')`. Hold `/api/resolution-label-targets` pending, with the target only resolved by a label. It's absent from the default view.
  - `it('drops a resolved CSAM target out of the switch')`. Once the label read resolves with the target, the switch is absent (badge 0).
  - Update the Task 2 Priority test to turn the switch on first.
- [ ] **Step 3: Run them and confirm they fail.** Run `npx vitest run src/lib/sensitiveSwitch.test.ts src/components/Reports.sensitive-switch.test.tsx`.
- [ ] **Step 4: Implement** `src/lib/sensitiveSwitch.ts`, then wire it into `Reports.tsx`:
  - Compute `switchMembership` from `allConsolidated`.
  - Replace both `pendingReviewTargets.has(...)` filter checks with `switchMembership.has(...)`.
  - `pendingReviewCount` becomes `switchMembership.size`.
  - Pass `switchState` to rows and to `ReportDetail`, which renders it as an outline `Badge` beside the category badge.
- [ ] **Step 5: Run them and confirm they pass.** Also run the existing `Reports.toggle.test.tsx`, `Reports.test.tsx`, `Reports.deeplink.test.tsx` and `Reports.resolution-state.test.tsx`. All pass. If an existing test asserts the old label text, update only the string.
- [ ] **Step 6: Mutation-check, one at a time.**
  - Drop the `humanHandled` check.
  - Drop the resolved check.
  - Swap `switchMembership.has` back to `pendingReviewTargets.has` in the consolidated filter only.
  - Drop the `'auto-hidden'`-wins precedence.
  
  Each must turn exactly its own test red.
- [ ] **Step 7: Commit** with the message `feat(reports): put unhandled CSAM reports behind the pending-review switch`.

### Task 4: Deep links turn the switch on

**Files:**
- Modify: `src/components/Reports.tsx`:
  - the switch `onCheckedChange` (~1566-1587)
  - next to the resolved-unhide effect (~1060-1074)
- Test: add to `src/components/Reports.sensitive-switch.test.tsx`

**Interfaces:**
- Consumes `switchMembership` from Task 3.
- Produces two local functions, `enterPendingReview()` and `leavePendingReview()`, which hold the existing toggle bodies unchanged. `onCheckedChange` calls them.
- `leavePendingReview` also sets `deepLinkSelectedRef.current = false`, so turning the switch off after a deep link spends the courtesy, the same way the Hide resolved handler does at ~1617.

**New effect:**
- When `!showPendingReview && selectedReport && deepLinkSelectedRef.current`, and the selected report's target key is in `switchMembership`, call `enterPendingReview()`.
- Dependencies are `[showPendingReview, selectedReport, switchMembership]`.

- [ ] **Step 1: Write the failing tests:**
  - `?event=<auto-hidden target>`, with the report in the bulk list, leaves the switch checked and the row present.
  - `?pubkey=<profile CSAM target>` leaves the switch checked and the row present.
  - `?event=<target not in bulk>`, resolved by targeted lookup, leaves the switch checked.
  - Arriving at `/reports/<report id>` directly leaves the switch checked.
  - Clicking a behind-the-switch row while the switch is on, then turning it off, leaves it off.
  - Review Focus 4: after arriving by deep link, turning the switch off leaves it unchecked after the next poll (advance timers past 15s), and Hide resolved returns to its prior value.
- [ ] **Step 2: Run them and confirm they fail.**
- [ ] **Step 3: Implement** the extraction, the effect, and the courtesy reset.
- [ ] **Step 4: Run them and confirm they pass.** Run the whole `src/components/Reports.*.test.tsx` set.
- [ ] **Step 5: Mutation-check.** Remove the effect, which turns the deep-link tests red. Separately, remove the `deepLinkSelectedRef.current = false` in `leavePendingReview`, which turns Review Focus 4 red.
- [ ] **Step 6: Commit** with the message `fix(reports): open the pending-review switch when a link lands on a report behind it`.

### Task 5: Hide the reported account's images on sensitive reports

**Files:**
- Modify:
  - `src/components/MediaPreview.tsx:394-403`. `InlineMediaPreview` gains `showByDefault?: boolean` (default `true`) and seeds `useState(showByDefault)`.
  - `src/components/UserProfileCard.tsx`:
    - props (~45-56): add `hideMediaByDefault?: boolean`, default `false`
    - avatar (~131-135): when hidden, render only `AvatarFallback`, plus a small "Show" control that reveals `AvatarImage`. Reuse `EyeOff`/`Eye` from lucide like `MediaPreview`.
    - `RecentPostsSection` (~250, ~330): thread the flag to `<InlineMediaPreview showByDefault={!hideMediaByDefault}>`
  - `src/components/ReportDetail.tsx:1029`. Pass `hideMediaByDefault={hasHighPriorityReports !== false}`. While it's loading (`undefined`), hide.
- Test: `src/components/UserProfileCard.test.tsx`. Create it if absent, following existing component-test setup.

**Interfaces:**
- Consumes `hasHighPriorityReports` from ReportDetail, which already includes `csamSignal` after Task 2.

- [ ] **Step 1: Write the failing tests:**
  - With `hideMediaByDefault` set and `profile={{ picture: 'https://example.invalid/a.png' }}`, no `img` has that `src`. Clicking `Show` renders it.
  - Without the flag, the image is present. This is existing behavior.
  - With the flag, a recent post whose content holds `https://example.invalid/v.mp4` renders no `video` or `img` until its own show control is clicked.
- [ ] **Step 2: Run them and confirm they fail.**
- [ ] **Step 3: Implement** the edits listed above.
- [ ] **Step 4: Run them and confirm they pass.** Also run `npx vitest run src/components` and `npx tsc -p tsconfig.app.json --noEmit`.
- [ ] **Step 5: Mutation-check.** Revert the avatar gate, and separately the `showByDefault` threading. Each turns its own test red.
- [ ] **Step 6: Commit** with the message `fix(reports): hide the reported account's images on sensitive reports`.

### Task 6: Whole-branch verification

- [ ] **Step 1: Run each check.** All must pass with zero errors.
  - `npx tsc -p tsconfig.app.json --noEmit`
  - `cd worker && npm run typecheck`
  - `npx eslint src/ shared/`
  - `npx vitest run`
  - `cd worker && npx vitest run`
  - `npx vite build`, with `.env.local` copied into the worktree
- [ ] **Step 2: Check the diff for anything forbidden.**
  - `git diff origin/main --stat` must touch no `worker/` file.
  - `git diff origin/main | grep -n -E '[0-9a-f]{64}'` must show only synthetic repeated-character IDs.
  - `grep -rn '—'` over changed files must find no em dash in copy.
- [ ] **Step 3:** Commit the spec and plan under `docs/superpowers/` with the message `docs: sensitive reports behind the switch design and plan`.
